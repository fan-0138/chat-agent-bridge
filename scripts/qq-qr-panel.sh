#!/bin/sh
# 把容器里 QQ 登录窗口的二维码抓成「浏览器里自动刷新的页面」，对着屏幕随时扫。
# 只在二维码真的过期后才点「刷新」—— 无条件刷新会把正要扫的那张作废。
# 宽版布局默认坐标；窄版布局用环境变量覆盖：
#   QQ_QR_CROP=crop=230:230:848:432 QQ_QR_BTN_X=955 QQ_QR_BTN_Y=577 ./scripts/qq-qr-panel.sh
set -u
cd "$(dirname "$0")/.." || exit 1

OUT=data/qq/qr
CONTAINER=${QQ_CONTAINER:-snowluma}
QR_CROP=${QQ_QR_CROP:-crop=180:180:1070:400}
BTN_X=${QQ_QR_BTN_X:-1152}
BTN_Y=${QQ_QR_BTN_Y:-502}
EXPIRED_YAVG=${QQ_QR_EXPIRED_YAVG:-216}
COOLDOWN=${QQ_QR_COOLDOWN:-20}
DEADLINE=$(( $(date +%s) + 1800))

mkdir -p "$OUT"

shot() {
  docker exec "$CONTAINER" ffmpeg -hide_banner -loglevel error -f x11grab \
    -video_size 1920x1080 -i :1 -frames:v 1 -y /tmp/qr-shot.png >/dev/null 2>&1 &&
    docker cp "$CONTAINER:/tmp/qr-shot.png" "$OUT/screen.png" >/dev/null 2>&1
}

stat_of() {
  ffmpeg -hide_banner -i "$OUT/screen.png" -vf "$QR_CROP,signalstats,metadata=print" -f null - 2>&1 |
    grep -oE "$1=[0-9.]+" | head -1 | cut -d= -f2
}

click_refresh() {
  docker exec -e DISPLAY=:1 "$CONTAINER" xdotool mousemove "$BTN_X" "$BTN_Y" click 1 >/dev/null 2>&1
  docker exec -e DISPLAY=:1 "$CONTAINER" xdotool mousemove 5 5 >/dev/null 2>&1
}

write_page() {
  [ -f "$OUT/latest.png" ] || return 0
  B64=$(base64 < "$OUT/latest.png" | tr -d '\n')
  cat > "$OUT/index.html.tmp" <<HTML
<!doctype html><meta charset="utf-8"><title>QQ 登录</title>
<meta http-equiv="refresh" content="6">
<body style="margin:0;background:#111;display:grid;place-items:center;height:100vh">
<img src="data:image/png;base64,$B64" style="width:460px;image-rendering:pixelated">
<script>setInterval(function(){location.replace(location.href.split("?")[0]+"?t="+Date.now())},3000)</script>
<div style="position:fixed;bottom:10px;left:0;right:0;text-align:center;color:#777;font:12px -apple-system,sans-serif">
每 3 秒自动刷新 · 最近一次 $(date '+%H:%M:%S') · 扫完在手机上点「确认登录」
</div></body>
HTML
  mv "$OUT/index.html.tmp" "$OUT/index.html"
}

last_click=0
hits=0
echo "[qr] $(date '+%H:%M:%S') 开始（crop=$QR_CROP 按钮=$BTN_X,$BTN_Y）" >&2

while [ "$(date +%s)" -lt "$DEADLINE" ]; do
  if node scripts/qq-action.mjs --action get_login_info --params '{}' >/dev/null 2>&1; then
    echo "[qr] $(date '+%H:%M:%S') QQ 已登录，收工" >&2
    break
  fi
  if ! shot; then sleep 3; continue; fi
  now=$(date +%s)
  Y=$(stat_of YAVG)
  if [ -n "$Y" ] && [ "${Y%.*}" -gt "$EXPIRED_YAVG" ] 2>/dev/null; then
    hits=$((hits+1))
  else
    hits=0
  fi
  if [ "$hits" -ge 2 ] && [ $((now - last_click)) -ge "$COOLDOWN" ]; then
    echo "[qr] $(date '+%H:%M:%S') 过期（YAVG=$Y），刷新" >&2
    click_refresh
    last_click=$now
    hits=0
    sleep 2
    shot || true
  fi
  if [ -f "$OUT/screen.png" ]; then
    ffmpeg -hide_banner -loglevel error -i "$OUT/screen.png" \
      -vf "$QR_CROP,scale=480:480:flags=neighbor" -y "$OUT/latest.png" >/dev/null 2>&1
    write_page
  fi
  sleep 4
done
echo "[qr] $(date '+%H:%M:%S') 循环结束" >&2
