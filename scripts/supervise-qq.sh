#!/bin/sh
# QQ 桥接守护循环。
#
# 和微信那条不同：这里**故意不是无限重启**。账号被风控/限制时，脚本反复重登
# 是最快把「临时冻结」升级成「永久封禁」的操作，所以：
#   - 正常退出（code 0，手动停）→ 不重启；
#   - 异常退出 → 间隔 5s / 15s / 60s 最多重试 3 次；
#   - 30 分钟内第 4 次异常 → 停下来等人工处理。
cd "$(dirname "$0")/.." || exit 1

MAX_RESTARTS=3
restarts=0
window_start=$(date +%s)

while :; do
  node --env-file-if-exists=.env.qq src/index-qq.js
  code=$?
  if [ "$code" -eq 0 ]; then
    echo "[supervisor] $(date '+%Y-%m-%d %H:%M:%S') 正常退出（code=0），不再重启" >&2
    exit 0
  fi

  now=$(date +%s)
  if [ $((now - window_start)) -gt 1800 ]; then
    restarts=0
    window_start=$now
  fi
  restarts=$((restarts + 1))

  if [ "$restarts" -gt "$MAX_RESTARTS" ]; then
    echo "[supervisor] $(date '+%Y-%m-%d %H:%M:%S') 30 分钟内连续失败 ${restarts} 次，停止自动重启。" >&2
    echo "[supervisor] 很可能是 QQ 掉线或被风控：请打开 NapCat 面板人工确认，别反复重登。" >&2
    exit 78
  fi

  case $restarts in
    1) delay=5 ;;
    2) delay=15 ;;
    *) delay=60 ;;
  esac
  echo "[supervisor] $(date '+%Y-%m-%d %H:%M:%S') node 退出（code=$code），${delay}s 后第 ${restarts} 次重试" >&2
  sleep "$delay"
done