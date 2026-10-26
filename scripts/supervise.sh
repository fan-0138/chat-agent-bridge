#!/bin/sh
# 守护循环：node 退出（崩溃、iLink 会话过期等）后自动拉起。
# 由「启动微信桥接.command」在后台启动，不要直接双击本文件。
cd "$(dirname "$0")/.." || exit 1

while :; do
  node --env-file-if-exists=.env src/index.js
  code=$?
  echo "[supervisor] $(date '+%Y-%m-%d %H:%M:%S') node 退出（code=$code），5 秒后重启" >&2
  sleep 5
done
