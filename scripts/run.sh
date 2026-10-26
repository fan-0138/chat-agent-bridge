#!/bin/sh
# 前台启动桥接（调试用）。开机自启用 launchd/com.dsh.wechat-bridge.plist。
set -eu
cd "$(dirname "$0")/.."
exec node --env-file-if-exists=.env src/index.js
