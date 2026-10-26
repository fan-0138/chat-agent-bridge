#!/bin/sh
# QQ 定时提醒守护循环：qq-remind.mjs --daemon 挂了就拉起来。
#
# 这个进程只负责「活着」；真正的到点判断和发送在 qq-remind.mjs 里（每 15 秒看一次表）。
# 和 QQ 桥接分开跑：桥接重启（改代码/掉线重连）不该把已经排好的提醒搞丢。
cd "$(dirname "$0")/.." || exit 1

CHILD=

stop() {
  [ -n "$CHILD" ] && kill -TERM "$CHILD" 2>/dev/null
  echo "[remind] $(date '+%Y-%m-%d %H:%M:%S') 已停止" >&2
  exit 0
}
trap stop TERM INT

while :; do
  node scripts/qq-remind.mjs --daemon &
  CHILD=$!
  wait "$CHILD"
  code=$?

  # 3 = 已经有一个 daemon 在跑（说明重复启动了），守护也跟着退，别互相打
  if [ "$code" -eq 3 ]; then
    echo "[remind] $(date '+%Y-%m-%d %H:%M:%S') 已有 daemon 在跑，守护退出" >&2
    exit 0
  fi

  echo "[remind] $(date '+%Y-%m-%d %H:%M:%S') daemon 退出（code=$code），5s 后重启" >&2
  sleep 5
done