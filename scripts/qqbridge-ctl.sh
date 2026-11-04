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
ROOM_LABEL=local.chat-agent-bridge.room
MC_LABEL=local.chat-agent-bridge.mcserver
MC_BODY_LABEL=local.chat-agent-bridge.mcbody
ROOM_PORT=${ROOM_PORT:-8770}
MC_PORT=${MC_PORT:-25565}
MC_BODY_PORT=${MC_BODY_PORT:-8772}
TTS_PORT=${TTS_PORT:-9880}
TTS_DIR=${TTS_DIR:-$HOME/Documents/deepseek/tts/GPT-SoVITS}
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
# 按端口认房间进程，别把调试用的另一个端口认成它
room_pid()   { lsof -nP -tiTCP:"$ROOM_PORT" -sTCP:LISTEN 2>/dev/null | head -1; }
# 声音复刻服务也按端口认（它加载模型要几十秒，pid 文件不一定写得及时）
tts_pid()    { lsof -nP -tiTCP:"$TTS_PORT" -sTCP:LISTEN 2>/dev/null | head -1; }
# 「她自己的时间」是个独立 node 进程，没有端口，按命令行认
mind_pid()   { ps -axo pid=,args= | awk '$2=="node" && /scripts\/mind-run\.mjs/ {print $1; exit}'; }
# 她的 Minecraft：服务端和身体都按端口认
mc_server_pid() { lsof -nP -tiTCP:"$MC_PORT" -sTCP:LISTEN 2>/dev/null | head -1; }
mc_body_pid()   { lsof -nP -tiTCP:"$MC_BODY_PORT" -sTCP:LISTEN 2>/dev/null | head -1; }

running() { [ -n "$(node_pid)" ]; }
not_running() { ! running; }
remind_running() { [ -n "$(remind_pid)" ]; }
watch_running() { [ -n "$(watch_pid)" ]; }
room_running() { [ -n "$(room_pid)" ]; }
tts_running() { [ -n "$(tts_pid)" ]; }
mind_running() { [ -n "$(mind_pid)" ]; }
not_mind_running() { ! mind_running; }
not_tts_running() { ! tts_running; }
not_remind_running() { ! remind_running; }
not_watch_running() { ! watch_running; }
not_room_running() { ! room_running; }
mc_server_running() { [ -n "$(mc_server_pid)" ]; }
mc_body_running() { [ -n "$(mc_body_pid)" ]; }
mc_running() { mc_server_running && mc_body_running; }
not_mc_running() { ! mc_running; }

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

start_tts() {
  if tts_running; then
    log "声音复刻服务已经在跑：http://127.0.0.1:$TTS_PORT"
    return 0
  fi
  if [ ! -x "$TTS_DIR/.venv/bin/python" ]; then
    log "跳过声音复刻：没装 GPT-SoVITS（$TTS_DIR）"
    return 0
  fi
  set -m
  ( cd "$TTS_DIR" && nohup .venv/bin/python api_v2.py -a 127.0.0.1 -p "$TTS_PORT" \
      -c GPT_SoVITS/configs/tts_infer.yaml >> "$OLDPWD/logs/tts.log" 2>&1 & )
  # 加载 v2Pro 模型在 M1 上要 40-70 秒
  if wait_until tts_running 100; then
    echo "$(tts_pid)" > logs/tts.pid
    log "声音复刻服务已启动（CPU，加载完模型才响应）：http://127.0.0.1:$TTS_PORT"
    return 0
  fi
  log "声音复刻没起来，看 logs/tts.log"
  return 1
}

stop_tts() {
  _p=$(tts_pid)
  if [ -n "$_p" ]; then
    kill -TERM "$_p" 2>/dev/null
    wait_until not_tts_running 15
    rm -f logs/tts.pid
    log "声音复刻服务已停止。"
  else
    rm -f logs/tts.pid
    log "声音复刻服务本来就没在跑。"
  fi
}

# 她自己的时间：没人说话时她自己想事。开关在 .env.qq（QQ_MIND_ENABLED）
start_mind() {
  if mind_running; then
    log "她自己的时间已经在跑（node $(mind_pid)）"
    return 0
  fi
  _enabled=$(grep -E '^QQ_MIND_ENABLED=' .env.qq 2>/dev/null | tail -1 | cut -d= -f2 | tr -d ' "'"'"'')
  case "$_enabled" in
    1|true|yes|on) ;;
    *)
      log "跳过「她自己的时间」：.env.qq 里 QQ_MIND_ENABLED 没开"
      return 0
      ;;
  esac
  set -m
  nohup node --env-file-if-exists=.env.qq scripts/mind-run.mjs >> logs/mind.log 2>&1 &
  echo $! > logs/mind.pid
  if wait_until mind_running 5; then
    log "她自己的时间已启动（约 10 分钟想一次，日志 logs/mind.log）"
    return 0
  fi
  log "「她自己的时间」没起来，看 logs/mind.log"
  return 1
}

stop_mind() {
  _p=$(mind_pid)
  if [ -n "$_p" ]; then
    kill -TERM "$_p" 2>/dev/null
    wait_until not_mind_running 15
    rm -f logs/mind.pid
    log "「她自己的时间」已停止。"
  else
    rm -f logs/mind.pid
    log "「她自己的时间」本来就没在跑。"
  fi
}

start_room() {
  if [ ! -f tools/room/server.mjs ]; then
    log "跳过小鲸的小空间：这里没有 tools/room（自用功能，不在开源仓库里）"
    return 0
  fi
  if room_running; then
    log "小鲸的小空间已经在跑：http://127.0.0.1:$ROOM_PORT"
    return 0
  fi
  if [ -f "$LA/$ROOM_LABEL.plist" ]; then
    if start_one "$ROOM_LABEL" && wait_until room_running 20; then
      echo "$(room_pid)" > logs/room.pid
      log "小鲸的小空间已启动（launchd 托管）：http://127.0.0.1:$ROOM_PORT"
      return 0
    fi
    log "launchd 20 秒内没拉起房间服务（大概率是 TCC 不让后台任务读 ~/Documents），改用脱钩方式。"
    launchctl bootout "$DOMAIN/$ROOM_LABEL" >/dev/null 2>&1
  fi
  set -m
  nohup node tools/room/server.mjs >> logs/room.log 2>&1 &
  if wait_until room_running 10; then
    echo "$(room_pid)" > logs/room.pid
    log "小鲸的小空间已启动（脱钩方式，重启电脑后要再起一次）：http://127.0.0.1:$ROOM_PORT"
    return 0
  fi
  log "房间没起来，看 logs/room.log"
  return 1
}

stop_room() {
  _did=0
  stop_one "$ROOM_LABEL" && _did=1
  _p=$(room_pid)
  if [ -n "$_p" ]; then
    kill -TERM "$_p" 2>/dev/null
    wait_until not_room_running 10
    _did=1
  fi
  rm -f logs/room.pid
  [ "$_did" = "1" ] && log "小鲸的小空间已停止。" || log "小鲸的小空间本来就没在跑。"
}

start_mc() {
  if [ ! -f tools/mc/body.mjs ]; then
    log "跳过 Minecraft：这里没有 tools/mc（自用功能，不在开源仓库里）"
    return 0
  fi
  if mc_running; then
    log "小鲸的 Minecraft 已经在跑：http://127.0.0.1:$MC_BODY_PORT/view"
    return 0
  fi
  if loaded "$MC_LABEL" || loaded "$MC_BODY_LABEL"; then
    loaded "$MC_LABEL" || start_one "$MC_LABEL" >/dev/null 2>&1
    loaded "$MC_BODY_LABEL" || start_one "$MC_BODY_LABEL" >/dev/null 2>&1
    if wait_until mc_running 60; then
      log "小鲸的 Minecraft 已启动（launchd 托管）：http://127.0.0.1:$MC_BODY_PORT/view"
      return 0
    fi
    log "launchd 60 秒内没拉起来，改用脱钩方式。"
  fi
  sh tools/mc/mc-ctl.sh start >/dev/null 2>&1
  if wait_until mc_running 60; then
    log "小鲸的 Minecraft 已启动（脱钩方式，重启电脑后要再起一次）"
    return 0
  fi
  log "Minecraft 没起来，看 logs/mc-server.log / logs/mc-body.log"
  return 1
}

stop_mc() {
  _did=0
  stop_one "$MC_BODY_LABEL" && _did=1
  stop_one "$MC_LABEL" && _did=1
  if command -v sh >/dev/null 2>&1 && [ -f tools/mc/mc-ctl.sh ]; then
    sh tools/mc/mc-ctl.sh stop >/dev/null 2>&1
  fi
  _b=$(mc_body_pid); [ -n "$_b" ] && { kill -TERM "$_b" 2>/dev/null; _did=1; }
  _s=$(mc_server_pid); [ -n "$_s" ] && { kill -TERM "$_s" 2>/dev/null; _did=1; }
  wait_until not_mc_running 30
  [ "$_did" = "1" ] && log "小鲸的 Minecraft 已停止。" || log "小鲸的 Minecraft 本来就没在跑。"
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
  log "── 声音复刻（GPT-SoVITS） ──"
  if tts_running; then
    log "  运行中：http://127.0.0.1:$TTS_PORT（python $(tts_pid)）"
  else
    log "  没在跑"
  fi
  log "── 她自己的时间 ──"
  if mind_running; then
    log "  运行中：node $(mind_pid)（想法在 data/mind/stream.jsonl）"
  else
    log "  没在跑"
  fi
  log "── 小鲸的 Minecraft ──"
  if mc_server_running; then
    log "  服务端：运行中（端口 $MC_PORT）"
  else
    log "  服务端：没在跑"
  fi
  if mc_body_running; then
    log "  身体：运行中，看这里 http://127.0.0.1:$MC_BODY_PORT/view"
  else
    log "  身体：没在跑"
  fi
  log "── 小鲸的小空间 ──"
  if room_running; then
    log "  运行中：http://127.0.0.1:$ROOM_PORT（node $(room_pid)）"
    if loaded "$ROOM_LABEL"; then
      log "  ↳ launchd 托管：开机就在"
    else
      log "  ↳ 脱钩方式（重启电脑后要再起一次）"
    fi
  else
    log "  没在跑"
  fi
}

case "${1:-status}" in
  start)     start_bridge; start_tts; start_mind; start_room; start_mc ;;
  stop)      stop_bridge; stop_tts; stop_mind; stop_room; stop_mc ;;
  restart)   stop_bridge; stop_tts; stop_room; stop_mind; stop_mc; sleep 1; start_bridge; start_tts; start_mind; start_room; start_mc ;;
  status)    status ;;
  start-all) start_bridge; start_remind; start_watch; start_tts; start_mind; start_room; start_mc ;;
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
    stop_tts
    stop_mind
    stop_room
    stop_mc
    ;;
  *)
    log "用法：$0 {start|stop|restart|status|start-all|stop-all}（start/stop 会把声音复刻、她自己的时间、小鲸的小空间、她的 Minecraft 一起带上）"
    exit 2
    ;;
esac