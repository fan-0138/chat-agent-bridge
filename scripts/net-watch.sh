#!/bin/sh
# 网络变化看门狗：电脑换 WiFi / 连热点之后，QQ 客户端那条「收消息」的长连接会静默死掉
# （能发不能收，看起来像她不理人）。这个脚本负责发现它并自动把一切恢复回来。
#
#   发现网关或本机 IP 变了
#     → 先在 QQ 上戳一句（这条通常发得出去），顺便算打个招呼
#     → 等 120 秒：如果你回话了（说明收消息通道还活着）就什么都不做
#     → 没回话 → 停桥接、重启 QQ 客户端、等登录
#          · 自己能登回来 → 自动把桥接拉起来
#          · 登不回来（需要扫码）→ 弹出会自动刷新的二维码窗口 + 系统通知，你扫一下就好
#
# 用法：
#   ./scripts/net-watch.sh              常驻
#   NET_WATCH_DRY=1 ./scripts/net-watch.sh   只观察不动手（调试用）
set -u
cd "$(dirname "$0")/.." || exit 1

LOG=logs/net-watch.log
PIDFILE=logs/net-watch.pid
CONTAINER=${QQ_CONTAINER:-snowluma}
POLL=${NET_WATCH_POLL:-15}
SETTLE=${NET_WATCH_SETTLE:-20}
REPLY_WAIT=${NET_WATCH_REPLY_WAIT:-120}
LOGIN_WAIT=${NET_WATCH_LOGIN_WAIT:-600}
COOLDOWN=${NET_WATCH_COOLDOWN:-600}
DRY=${NET_WATCH_DRY:-0}
OWNER=$(grep -E '^QQ_ALLOW_LIST=' .env.qq 2>/dev/null | head -1 | cut -d= -f2- | cut -d, -f1)
mkdir -p logs

log() { printf '[%s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" >> "$LOG"; }
notify() { osascript -e "display notification \"$1\" with title \"小鲸\" sound name \"Ping\"" >/dev/null 2>&1 || true; }
say_qq() { node scripts/qq-action.mjs --action send_private_msg --params "{\"user_id\":${OWNER},\"message\":\"$1\"}" >/dev/null 2>&1; }
logged_in() { node scripts/qq-action.mjs --action get_login_info --params '{}' >/dev/null 2>&1; }
inbound_count() { grep -c "收到 private_" logs/qq-bridge.log 2>/dev/null || echo 0; }

sig() {
  if [ -n "${NET_WATCH_SIG_CMD:-}" ]; then sh -c "$NET_WATCH_SIG_CMD"; return; fi
  GW=$(route -n get default 2>/dev/null | awk '/gateway:/{print $2}')
  IF=$(route -n get default 2>/dev/null | awk '/interface:/{print $2}')
  IP=$(ipconfig getifaddr "${IF:-en0}" 2>/dev/null || echo '-')
  printf '%s|%s|%s' "${IF:-?}" "${GW:-?}" "${IP:-?}"
}

echo $$ > "$PIDFILE"
trap 'rm -f "$PIDFILE"; log "收到退出信号，停止"; exit 0' TERM INT
log "看门狗启动 pid=$$ dry=$DRY 当前网络：$(sig)"

prev=$(sig)
last_recover=0

while :; do
  sleep "$POLL"
  cur=$(sig)
  [ "$cur" = "$prev" ] && continue

  # 等它稳定下来再看（热点切换/重连中途会跳好几次）
  sleep "$SETTLE"
  stable=$(sig)
  log "网络变化：$prev → $stable"
  prev=$stable
  [ "$stable" = "$cur" ] || continue

  if [ "$DRY" = "1" ]; then log "[dry] 本该进入恢复流程"; continue; fi

  now=$(date +%s)
  if [ $((now - last_recover)) -lt "$COOLDOWN" ]; then
    log "距上次恢复不到 $((COOLDOWN/60)) 分钟，先不动"
    continue
  fi

  before=$(inbound_count)
  say_qq "爸爸，人家这边网络好像换了，不确定还收不收得到消息。你随便回一句？"
  notify "网络换了，我在试试还能不能收到消息"
  log "已戳一句，等 ${REPLY_WAIT}s 看有没有回话（基线 inbound=$before）"

  i=0
  healthy=0
  while [ "$i" -lt "$REPLY_WAIT" ]; do
    sleep 10
    i=$((i+10))
    after=$(inbound_count)
    if [ "$after" -gt "$before" ]; then healthy=1; break; fi
  done

  if [ "$healthy" = "1" ]; then
    log "收到回话，收消息通道正常，不做任何处理"
    notify "没事，网络换了她还能收到消息"
    continue
  fi

  last_recover=$(date +%s)
  log "没有回话，判断收消息通道已死，开始恢复"
  notify "收不到消息了，正在重启 QQ 客户端"

  # 1) 停桥接，别让它对着没登录的网关狂重连
  if [ -f logs/qq-bridge.pid ]; then
    old=$(cat logs/qq-bridge.pid)
    kill -TERM -- "-$old" 2>/dev/null || kill -TERM "$old" 2>/dev/null
    sleep 1
    kill -9 -- "-$old" 2>/dev/null
    # 进程组可能没建成，兜底按命令行杀干净，别留个孤儿在那儿狂重连
    pkill -f "src/index-qq.js" 2>/dev/null
    pkill -f "scripts/supervise-qq.sh" 2>/dev/null
    rm -f logs/qq-bridge.pid logs/qq-caffeinate.pid
    log "已停桥接 pid=$old"
  fi

  # 2) 重启 QQ 客户端
  docker restart "$CONTAINER" >/dev/null 2>&1 && log "容器已重启" || log "容器重启失败"

  # 3) 等自动登录
  i=0; ok=0
  while [ "$i" -lt 120 ]; do
    sleep 3; i=$((i+3))
    if logged_in; then ok=1; break; fi
  done

  if [ "$ok" = "0" ]; then
    log "没有自动登录，弹二维码窗口（需要人扫一下）"
    notify "QQ 要重新登录，扫一下弹出的二维码"
    pkill -f "qq-qr-panel.sh" 2>/dev/null
    nohup ./scripts/qq-qr-panel.sh >> logs/qq-qr.log 2>&1 &
    sleep 8
    open "data/qq/qr/index.html" >/dev/null 2>&1 || true
    log "二维码窗口已弹出，等扫码（最多 ${LOGIN_WAIT}s）"
    i=0
    while [ "$i" -lt "$LOGIN_WAIT" ]; do
      sleep 5; i=$((i+5))
      if logged_in; then ok=1; break; fi
    done
  fi

  if [ "$ok" = "0" ]; then
    log "等不到登录，放弃本轮（桥接保持停止，等人处理）"
    notify "还是没登录上，可能要你手动看下"
    continue
  fi

  log "QQ 已登录，拉起桥接"
  nohup ./scripts/supervise-qq.sh >> logs/qq-bridge.log 2>&1 &
  newpid=$!
  echo "$newpid" > logs/qq-bridge.pid
  if command -v caffeinate >/dev/null 2>&1; then
    nohup caffeinate -i -m -s -w "$newpid" >/dev/null 2>&1 &
    echo $! > logs/qq-caffeinate.pid
  fi
  sleep 12
  if tail -30 logs/qq-bridge.log | grep -q "已连上网关"; then
    log "恢复完成：桥接已连上网关"
    notify "恢复了，可以跟她说话啦"
  else
    log "桥接起来了但没看到「已连上网关」，需要人工看一眼"
  fi
done
