#!/bin/sh
# launchd 的主进程：防休眠 + 守护循环，谁挂都把另一个带走，退出码原样透传。
#
# 单独一层的原因：launchd 只看主进程的退出码决定要不要拉起来，而防休眠用的
# caffeinate 不能当主进程（它不会把子进程的退出码传回来）。所以这里当中间人。
cd "$(dirname "$0")/.." || exit 1
mkdir -p logs

SUP=""
CAFF=""

cleanup() {
  [ -n "$SUP" ] && kill -TERM "$SUP" 2>/dev/null
  [ -n "$CAFF" ] && kill -TERM "$CAFF" 2>/dev/null
}
trap 'cleanup; exit 0' TERM INT

./scripts/supervise-qq.sh &
SUP=$!

if command -v caffeinate >/dev/null 2>&1; then
  caffeinate -i -m -s -w "$SUP" >/dev/null 2>&1 &
  CAFF=$!
fi

wait "$SUP"
code=$?

[ -n "$CAFF" ] && kill -TERM "$CAFF" 2>/dev/null

# 78 = 守护自己判断「连续失败太多次，再重登要把号搞封了，停下来等人」。
# 这是故意收工，不是崩溃：转成 0 让 launchd 别再拉起来（重登次数就那么点，不能烧在两分钟内）。
if [ "$code" -eq 78 ]; then
  echo "[run] $(date '+%Y-%m-%d %H:%M:%S') 守护要求人工介入，本次不自动重启" >&2
  exit 0
fi

exit "$code"