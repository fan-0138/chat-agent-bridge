#!/bin/sh
# 把「小鲸」这套后台进程交给 launchd 托管。
#
# 托管之后：
#   · 关掉 DSH / 关掉终端窗口 / 断掉 SSH —— 她都不受影响（父进程是 launchd，不是你的 shell）
#   · 进程真崩了，launchd 隔一会儿自动拉起来
#   · 电脑重启 / 重新登录后自动起来
#   · 顺手带一个 caffeinate：机器不合盖睡死，她才能一直在线
#
#   ./scripts/install-launchd.sh              安装并立即启动
#   ./scripts/install-launchd.sh --uninstall  卸载（只摘 launchd 任务，日志和数据都不动）
#
# 为什么要这么干：以前桥接是从 DSH 的 shell 里 nohup 起来的，进程组还挂在 DSH 上，
# 关掉 DSH 那一刻整组收到 SIGTERM —— 她会在 QQ 上说一句「爸爸我先睡啦」，然后就真没了。
set -u
cd "$(dirname "$0")/.." || exit 1
ROOT=$(pwd)
LA="$HOME/Library/LaunchAgents"
UID_=$(id -u)
DOMAIN="gui/$UID_"

BRIDGE_LABEL=local.chat-agent-bridge.qqbridge
REMIND_LABEL=local.chat-agent-bridge.remind
NETWATCH_LABEL=local.chat-agent-bridge.netwatch
ROOM_LABEL=local.chat-agent-bridge.room
ROOM_PORT=${ROOM_PORT:-8770}
NODE_BIN=$(command -v node || echo /opt/homebrew/bin/node)

PATH_ENV=/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin

say() { printf '%s\n' "$*"; }

mkdir -p logs "$LA"

loaded() { launchctl print "$DOMAIN/$1" >/dev/null 2>&1; }

# macOS 的 TCC 隐私保护：launchd 起的后台任务默认读不了 ~/Documents、桌面、下载。
# 这个项目正好在 ~/Documents 下面，所以装之前先实测一下——不然装了也是每 30 秒失败一次。
tcc_can_read() {
  _probe="/tmp/.qqbridge-tcc-$$.sh"
  _out="/tmp/.qqbridge-tcc-$$.log"
  cat > "$_probe" <<PROBE
#!/bin/sh
head -c 10 "$ROOT/scripts/supervise-qq.sh" >/dev/null 2>&1 && echo OK > "$_out" || echo DENIED > "$_out"
PROBE
  chmod +x "$_probe"
  launchctl submit -l local.chat-agent-bridge.tccprobe -- /bin/sh "$_probe" >/dev/null 2>&1
  _i=0
  while [ "$_i" -lt 10 ] && [ ! -s "$_out" ]; do sleep 0.5; _i=$((_i + 1)); done
  launchctl remove local.chat-agent-bridge.tccprobe >/dev/null 2>&1
  _res=$(cat "$_out" 2>/dev/null || echo DENIED)
  rm -f "$_probe" "$_out"
  [ "$_res" = "OK" ]
}

bootout_if_loaded() {
  if loaded "$1"; then
    launchctl bootout "$DOMAIN/$1" >/dev/null 2>&1
    i=0
    while [ "$i" -lt 10 ] && loaded "$1"; do sleep 0.5; i=$((i + 1)); done
  fi
}

# write_plist <label> <脚本相对路径> <日志名>
write_plist() {
  _label=$1
  _script=$2
  _log=$3
  _file="$LA/$_label.plist"
  cat > "$_file" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>$_label</string>
    <key>ProgramArguments</key>
    <array>
        <string>/bin/sh</string>
        <string>$ROOT/$_script</string>
    </array>
    <key>WorkingDirectory</key>
    <string>$ROOT</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <dict>
        <key>SuccessfulExit</key>
        <false/>
    </dict>
    <key>ThrottleInterval</key>
    <integer>30</integer>
    <key>ExitTimeOut</key>
    <integer>20</integer>
    <key>LimitLoadToSessionType</key>
    <string>Aqua</string>
    <key>ProcessType</key>
    <string>Interactive</string>
    <key>StandardOutPath</key>
    <string>$ROOT/logs/$_log</string>
    <key>StandardErrorPath</key>
    <string>$ROOT/logs/$_log</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>$PATH_ENV</string>
        <key>LANG</key>
        <string>zh_CN.UTF-8</string>
    </dict>
</dict>
</plist>
PLIST
  say "  写好 $_file"
}

install_one() {
  _label=$1
  _script=$2
  _log=$3
  bootout_if_loaded "$_label"
  write_plist "$_label" "$_script" "$_log"
  if launchctl bootstrap "$DOMAIN" "$LA/$_label.plist" >/dev/null 2>&1; then
    say "  已启动 $_label"
  else
    say "  ⚠️ $_label 登记失败，手动看一下：launchctl bootstrap $DOMAIN $LA/$_label.plist"
  fi
}

# 房间服务是 node 常驻（不是 shell 脚本），单独写一份 plist
write_room_plist() {
  _file="$LA/$ROOM_LABEL.plist"
  cat > "$_file" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>$ROOM_LABEL</string>
    <key>ProgramArguments</key>
    <array>
        <string>$NODE_BIN</string>
        <string>$ROOT/tools/room/server.mjs</string>
    </array>
    <key>WorkingDirectory</key>
    <string>$ROOT</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>ThrottleInterval</key>
    <integer>10</integer>
    <key>ExitTimeOut</key>
    <integer>10</integer>
    <key>LimitLoadToSessionType</key>
    <string>Aqua</string>
    <key>ProcessType</key>
    <string>Interactive</string>
    <key>StandardOutPath</key>
    <string>$ROOT/logs/room.log</string>
    <key>StandardErrorPath</key>
    <string>$ROOT/logs/room.log</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>$PATH_ENV</string>
        <key>LANG</key>
        <string>zh_CN.UTF-8</string>
        <key>ROOM_PORT</key>
        <string>$ROOM_PORT</string>
    </dict>
</dict>
</plist>
PLIST
  say "  写好 $_file"
}

install_room() {
  bootout_if_loaded "$ROOM_LABEL"
  write_room_plist
  if launchctl bootstrap "$DOMAIN" "$LA/$ROOM_LABEL.plist" >/dev/null 2>&1; then
    say "  已启动 $ROOM_LABEL（房间：http://127.0.0.1:$ROOM_PORT）"
  else
    say "  ⚠️ $ROOM_LABEL 登记失败，手动看一下：launchctl bootstrap $DOMAIN $LA/$ROOM_LABEL.plist"
  fi
}

if [ "${1:-}" = "--uninstall" ]; then
  say "卸载 launchd 任务（日志、数据、.env.qq 都不动）："
  for _l in "$BRIDGE_LABEL" "$REMIND_LABEL" "$NETWATCH_LABEL" "$ROOM_LABEL"; do
    if loaded "$_l"; then
      launchctl bootout "$DOMAIN/$_l" >/dev/null 2>&1 && say "  已停止 $_l"
    fi
    rm -f "$LA/$_l.plist" && say "  已删除 $LA/$_l.plist"
  done
  _room_pid=$(ps -axo pid=,args= | awk '$2=="node" && /tools\/room\/server\.mjs/ {print $1; exit}')
  [ -n "$_room_pid" ] && kill -TERM "$_room_pid" 2>/dev/null
  rm -f logs/qq-bridge.pid logs/qq-caffeinate.pid logs/net-watch.pid logs/qq-remind.pid logs/room.pid
  say ""
  say "她要还在跑，把上面几个进程收一下：pkill -f src/index-qq.js"
  exit 0
fi

if [ "${1:-}" = "--room" ]; then
  say "只装房间服务（不动正在跑的 QQ 桥接）："
  if [ "${2:-}" != "--force" ] && ! tcc_can_read; then
    say "✗ macOS 不让 launchd 起的后台任务读 ~/Documents，房间的数据就在那下面，起了也是每 10 秒失败一次。"
    say "  授权一次就永久生效：系统设置 → 隐私与安全性 → 完全磁盘访问权限 → 点 + → ⌘⇧G 输入 /bin/sh → 打开开关，再跑一次。"
    say "  不想授权就先手动跑：./scripts/qqbridge-ctl.sh start（脱钩方式，重启电脑后要再起一次）"
    exit 1
  fi
  mkdir -p logs
  install_room
  sleep 2
  _pid=$(launchctl print "$DOMAIN/$ROOM_LABEL" 2>/dev/null | awk '/^[[:space:]]*pid = /{print $3; exit}')
  if [ -n "$_pid" ]; then
    say "  房间 pid=$_pid  打开 http://127.0.0.1:$ROOM_PORT"
  else
    say "  没起来，看 logs/room.log"
  fi
  exit 0
fi

if [ ! -f .env.qq ]; then
  say "没有 .env.qq，先 cp .env.qq.example .env.qq 填好再装。"
  exit 1
fi

chmod +x scripts/qqbridge-run.sh scripts/qqbridge-ctl.sh scripts/supervise-qq.sh scripts/supervise-remind.sh scripts/net-watch.sh 2>/dev/null

# 先实测 TCC：装之前就知道行不行，别装完让它每 30 秒失败一次
if [ "${1:-}" != "--force" ] && ! tcc_can_read; then
  say "✗ macOS 不让 launchd 起的后台任务读 ~/Documents（TCC 隐私保护），这个项目就在那下面。"
  say ""
  say "所以现在装 launchd 是装了个空气，每 30 秒失败一次。两条路选一条，弄完再跑本脚本："
  say ""
  say "  A. 授权（一次点击，之后永久生效）"
  say "     系统设置 → 隐私与安全性 → 完全磁盘访问权限 → 点 + → 按 ⌘⇧G 输入 /bin/sh → 加入后打开开关"
  say ""
  say "  B. 搬家（不用点任何权限，旧路径留软链，所有命令和路径都不用改）"
  say "     mv \"$ROOT\" \"\$HOME/$(basename "$ROOT")\""
  say "     ln -s \"\$HOME/$(basename "$ROOT")\" \"$ROOT\""
  say ""
  say "不想折腾也没关系：脱钩方式已经够用（关掉 DSH / 终端她都不掉），只是电脑重启后要手动启动一次。"
  say "     ./scripts/qqbridge-ctl.sh start"
  say ""
  say "确认要无视这个检查硬装：$0 --force"
  exit 1
fi

say "安装 launchd 任务（父进程变成 launchd，跟 DSH / 终端脱钩）："
install_one "$BRIDGE_LABEL"  scripts/qqbridge-run.sh     qq-bridge.log
install_one "$REMIND_LABEL"  scripts/supervise-remind.sh qq-remind.log
install_one "$NETWATCH_LABEL" scripts/net-watch.sh       net-watch.log
install_room

sleep 6
say ""
say "检查一下："
for _l in "$BRIDGE_LABEL" "$REMIND_LABEL" "$NETWATCH_LABEL"; do
  _pid=$(launchctl print "$DOMAIN/$_l" 2>/dev/null | awk '/^[[:space:]]*pid = /{print $3; exit}')
  if [ -n "$_pid" ]; then
    _ppid=$(ps -o ppid= -p "$_pid" 2>/dev/null | tr -d ' ')
    say "  $_l  pid=$_pid  父进程=$_ppid$([ "$_ppid" = "1" ] && echo '（launchd，脱钩成功）')"
  else
    say "  $_l  未在运行"
  fi
done
_roompid=$(launchctl print "$DOMAIN/$ROOM_LABEL" 2>/dev/null | awk '/^[[:space:]]*pid = /{print $3; exit}')
[ -n "$_roompid" ] && say "  $ROOM_LABEL  pid=$_roompid  房间 http://127.0.0.1:$ROOM_PORT"

if pgrep -f "src/index-qq.js" >/dev/null 2>&1; then
  pgrep -f "src/index-qq.js" | head -1 > logs/qq-bridge.pid
fi

say ""
say "以后开关用：./scripts/qqbridge-ctl.sh {start|stop|restart|status|stop-all}"
say "日志：logs/qq-bridge.log / logs/qq-remind.log / logs/net-watch.log / logs/room.log"
say "现在关掉 DSH 试试，她不会掉线。"