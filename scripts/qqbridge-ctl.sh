#!/bin/sh
# QQ 桥接开关。
#
# 两种跑法，自动选：
#   1) launchd 托管（装了任务就用）：父进程是 launchd，关 DSH / 关终端 / 重启电脑都能自己回来；
#   2) 脱钩方式（退路）：单独开一个进程组跑，父进程（DSH、终端）退出不会连坐。
#
# 为什么要有第 2 种：macOS 的 TCC 隐私保护不允许 launchd 起的后台任务读 ~/Documents，
# 而这个项目就在 ~/Documents 下面。真撞上了，launchd 拉不起来，就自动走脱钩方式——
# 一样能扛住「关掉 DSH」，只是电脑重启后要再手动启动一次。
#
#   ./scripts/qqbridge-ctl.sh start      启动（含定时提醒、网络看门狗）
#   ./scripts/qqbridge-ctl.sh stop       停止
#   ./scripts/qqbridge-ctl.sh restart    重启
#   ./scripts/qqbridge-ctl.sh status     看状态
#   ./scripts/qqbridge-ctl.sh start-all / stop-all
set -u
cd "$(dirname "$0")/.." || exit 1

UID_=$(id -u)
DOMAIN="gui/$UID_"
LA="$HOME/Library/LaunchAgents"
LABEL=local.chat-agent-bridge.qqbridge
REMIND_LABEL=local.chat-agent-bridge.remind
NETWATCH_LABEL=local.chat-agent-bridge.netwatch
PLIST="$LA/$LABEL.plist"
PIDFILE=logs/qq-bridge.pid
CAFFFILE=logs/qq-caffeinate.pid

log() { printf '%s\n' "$*"; }

# 精确找进程：只认「命令名就是 node / sh」的那种，别被 `bash -c "... src/index-qq.js ..."`
# 这类命令行里的关键字骗到（作者踩过这个坑：pid 文件里写进去的是个 shell）
node_pid() { ps -axo pid=,args= | awk '$2=="node" && /src\/index-qq\.js/ {print $1; exit}'; }
sup_pid()  { ps -axo pid=,args= | awk '$2=="/bin/sh" && $3 ~ /supervise-qq\.sh$/ {print $1; exit}'; }
remind_pid() { ps -axo pid=,args= | awk '$2=="node" && /qq-remind\.mjs --daemon/ {print $1; exit}'; }
remind_sup_pid() { ps -axo pid=,args= | awk '$2=="/bin/sh" && $3 ~ /supervise-remind\.sh$/ {print $1; exit}'; }
watch_pid()  { ps -axo pid=,args= | awk '$2=="/bin/sh" && $3 ~ /net-watch\.sh$/ {print $1; exit}'; }

running() { [ -n "$(node_pid)" ]; }
not_running() { ! running; }
remind_running() { [ -n "$(remind_pid)" ]; }
watch_running() { [ -n "$(watch_pid)" ]; }
not_remind_running() { ! remind_running; }
not_watch_running() { ! watch_running; }

loaded() { launchctl print "$DOMAIN/$1" >/dev/null 2>&1; }
job_pid() { launchctl print "$DOMAIN/$1" 2>/dev/null | awk '/^[[:space:]]*pid = /{print $3; exit}'; }

# wait_until <函数名> <最多几秒>
wait_until() {
  _i=0
  while [ "$_i" -lt "$2" ]; do
    "$1" && return 0
    sleep 1
    _i=$((_i + 1))
  done
  return 1
}

write_pidfile() {
  _p=$(sup_pid)
  [ -z "$_p" ] && _p=$(node_pid)
  [ -n "$_p" ] && echo "$_p" > "$PIDFILE"
}

start_caffeinate() {
  _sup=$(sup_pid)
  [ -z "$_sup" ] && return 0
  # 已经在看着这个进程了就别重复开
  if ps -axo pid=,args= | awk -v p="$_sup" '$2=="caffeinate" && $0 ~ ("-w " p "$")' | grep -q .; then
    return 0
  fi
  set -m
  nohup caffeinate -i -m -s -w "$_sup" >/dev/null 2>&1 &
  echo $! > "$CAFFFILE"
}

start_one() { # start_one <label>：已经在 launchd 里就踢一脚，没登记就登记
  _label=$1
  _plist="$LA/$_label.plist"
  if loaded "$_label"; then
    [ -n "$(job_pid "$_label")" ] && return 0
    launchctl kickstart -k "$DOMAIN/$_label" >/dev/null 2>&1 && return 0
  fi
  [ -f "$_plist" ] || return 1
  launchctl bootstrap "$DOMAIN" "$_plist" >/dev/null 2>&1 && return 0
  launchctl kickstart -k "$DOMAIN/$_label" >/dev/null 2>&1 && return 0
  return 1
}

start_detached() {
  # set -m：让后台任务单独占一个进程组。不这么做的话它跟当前 shell 同组，
  # DSH / 终端一退出，整组收到 SIGTERM 一起死（今晚 23:55 就是这么掉的）
  set -m
  nohup ./scripts/supervise-qq.sh >> logs/qq-bridge.log 2>&1 &
  wait_until running 30 || { log "没起来，看 logs/qq-bridge.log"; return 1; }
  write_pidfile
  start_caffeinate
  _ppid=$(ps -o ppid= -p "$(sup_pid)" 2>/dev/null | tr -d ' ')
  log "QQ 桥接已启动（脱钩方式，node PID $(node_pid)，守护父进程 ${_ppid:-?}）。"
  [ "${_ppid}" != "1" ] && log "（父进程现在还不是 launchd，是启动它的 shell；那个 shell 退出后会自动转交给 launchd，不影响她。）"
  return 0
}

start_bridge() {
  if running; then
    log "QQ 桥接已经在跑（node PID $(node_pid)），不重复启动。"
    write_pidfile
    return 0
  fi

  # 1) 有 launchd 任务就先试它
  if [ -f "$PLIST" ]; then
    if start_one "$LABEL" && wait_until running 20; then
      write_pidfile
      start_caffeinate
      log "QQ 桥接已启动（launchd 托管，node PID $(node_pid)）。"
      return 0
    fi
    log "launchd 20 秒内没拉起来（大概率是 TCC 不让后台任务读 ~/Documents），改用脱钩方式。"
    launchctl bootout "$DOMAIN/$LABEL" >/dev/null 2>&1
  fi

  # 2) 脱钩方式（永远能用）
  start_detached
}

start_remind() {
  if remind_running; then log "定时提醒守护已经在跑。"; return 0; fi
  if [ -f "$LA/$REMIND_LABEL.plist" ]; then
    if start_one "$REMIND_LABEL" && wait_until remind_running 15; then
      log "定时提醒守护已启动（launchd）。"
      return 0
    fi
    launchctl bootout "$DOMAIN/$REMIND_LABEL" >/dev/null 2>&1
  fi
  set -m
  nohup ./scripts/supervise-remind.sh >> logs/qq-remind.log 2>&1 &
  echo $! > logs/qq-remind.pid
  log "定时提醒守护已启动（脱钩方式）。"
}

start_watch() {
  if watch_running; then log "网络看门狗已经在跑。"; return 0; fi
  if [ -f "$LA/$NETWATCH_LABEL.plist" ]; then
    if start_one "$NETWATCH_LABEL" && wait_until watch_running 15; then
      log "网络看门狗已启动（launchd）。"
      return 0
    fi
    launchctl bootout "$DOMAIN/$NETWATCH_LABEL" >/dev/null 2>&1
  fi
  set -m
  nohup ./scripts/net-watch.sh >> logs/net-watch.log 2>&1 &
  echo $! > logs/net-watch.pid
  log "网络看门狗已启动（脱钩方式）。"
}

stop_bridge() {
  _did=0
  if loaded "$LABEL"; then
    launchctl bootout "$DOMAIN/$LABEL" >/dev/null 2>&1 && _did=1
  fi
  if running; then
    _sup=$(sup_pid)
    _pgid=""
    [ -n "$_sup" ] && _pgid=$(ps -o pgid= -p "$_sup" 2>/dev/null | tr -d ' ')
    # 给整个进程组发 TERM：守护和 node 都要收到，她才能照常道别、把 shutdown.json 写成「干净退出」。
    # 只杀守护的话 node 会变成孤儿，最后只能 -9，下次启动就会以为「上次被硬拔了」多补一句。
    if [ -n "$_pgid" ]; then
      kill -TERM -- "-$_pgid" 2>/dev/null
    else
      [ -n "$_sup" ] && kill -TERM "$_sup" 2>/dev/null
      _n=$(node_pid); [ -n "$_n" ] && kill -TERM "$_n" 2>/dev/null
    fi
    if ! wait_until not_running 15; then
      _n=$(node_pid); [ -n "$_n" ] && kill -9 "$_n" 2>/dev/null
      _sup=$(sup_pid); [ -n "$_sup" ] && kill -9 "$_sup" 2>/dev/null
    fi
    _did=1
  fi
  [ -f "$CAFFFILE" ] && kill "$(cat "$CAFFFILE")" 2>/dev/null
  rm -f "$PIDFILE" "$CAFFFILE"
  [ "$_did" = "1" ] && log "QQ 桥接已停止。" || log "QQ 桥接本来就没在跑。"
}

stop_one() { # stop_one <label>
  if loaded "$1"; then
    launchctl bootout "$DOMAIN/$1" >/dev/null 2>&1 && return 0
  fi
  return 1
}

status() {
  log "── QQ 桥接 ──"
  if running; then
    log "  运行中：node $(node_pid) / 守护 $(sup_pid)"
    if loaded "$LABEL"; then
      log "  ↳ launchd 托管：关掉 DSH、关掉终端、电脑重启都不影响她"
    else
      _ppid=$(ps -o ppid= -p "$(sup_pid)" 2>/dev/null | tr -d ' ')
      [ "${_ppid}" = "1" ] && log "  ↳ 已跟 DSH / 终端脱钩（关掉它们不影响她；重启电脑后要手动启动）"
    fi
  else
    log "  没在跑"
  fi
  log "── 定时提醒 ──"
  if remind_running; then log "  运行中：$(remind_pid)"; else log "  没在跑"; fi
  log "── 网络看门狗 ──"
  if watch_running; then log "  运行中：$(watch_pid)"; else log "  没在跑"; fi
}

case "${1:-status}" in
  start)     start_bridge ;;
  stop)      stop_bridge ;;
  restart)   stop_bridge; sleep 1; start_bridge ;;
  status)    status ;;
  start-all) start_bridge; start_remind; start_watch ;;
  stop-all)
    stop_bridge
    _stopped_remind=0
    stop_one "$REMIND_LABEL" && _stopped_remind=1
    # 顺序有讲究：先杀守护壳，不然它 5 秒后又把 daemon 拉起来
    _rs=$(remind_sup_pid); [ -n "$_rs" ] && { kill -TERM "$_rs" 2>/dev/null; _stopped_remind=1; }
    _r=$(remind_pid); [ -n "$_r" ] && { kill -TERM "$_r" 2>/dev/null; _stopped_remind=1; }
    wait_until not_remind_running 15
    [ "$_stopped_remind" = "1" ] && log "定时提醒守护已停止。"
    rm -f logs/qq-remind.pid
    _stopped_watch=0
    stop_one "$NETWATCH_LABEL" && _stopped_watch=1
    _w=$(watch_pid); [ -n "$_w" ] && { kill -TERM "$_w" 2>/dev/null; _stopped_watch=1; }
    # 看门狗睡在 sleep 里，TERM 要等它醒才处理，最多 POLL 那么久
    wait_until not_watch_running 20
    [ "$_stopped_watch" = "1" ] && log "网络看门狗已停止。"
    rm -f logs/net-watch.pid
    ;;
  *)
    log "用法：$0 {start|stop|restart|status|start-all|stop-all}"
    exit 2
    ;;
esac