#!/usr/bin/env node
/**
 * 通用 OneBot / SnowLuma 动作调用器（给 agent 用 bash 调用）。
 *
 *   node scripts/qq-action.mjs --action get_login_info
 *   node scripts/qq-action.mjs --action get_qzone_feeds --params '{"count":5}'
 *   node scripts/qq-action.mjs --action send_qzone_msg --params '{"content":"今天也是摸鱼的一天"}'
 *
 * 连接参数从 .env.qq 读（QQ_WS_URL / QQ_WS_TOKEN），也可以命令行覆盖。
 * 输出 JSON（SnowLuma 的原始回包），失败返回非 0。
 */
import WebSocket from 'ws';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

function loadEnv(file) {
  const env = {};
  try {
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
      if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch {}
  return env;
}

const args = process.argv.slice(2);
const arg = (name, fallback = '') => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] ?? fallback : fallback;
};

const envFile = arg('env', join(root, '.env.qq'));
const env = { ...loadEnv(envFile), ...process.env };
const wsUrl = arg('url', env.QQ_WS_URL || 'ws://127.0.0.1:3001');
const token = arg('token', env.QQ_WS_TOKEN || '');
const action = arg('action');
let params = {};
try {
  const raw = arg('params', '{}');
  params = raw ? JSON.parse(raw) : {};
} catch (error) {
  console.error(`--params 不是合法 JSON：${error.message}`);
  process.exit(2);
}
if (!action) {
  console.error('用法：node scripts/qq-action.mjs --action <动作名> [--params <JSON>]');
  process.exit(2);
}

const ws = new WebSocket(wsUrl, {
  headers: token ? { Authorization: `Bearer ${token}` } : {},
  handshakeTimeout: 10_000,
});

const timer = setTimeout(() => {
  console.error('超时：网关没有回包');
  ws.close();
  process.exit(1);
}, 20_000);

ws.on('open', () => {
  ws.send(JSON.stringify({ action, params, echo: 'cli-1' }));
});

ws.on('message', (raw) => {
  let data;
  try {
    data = JSON.parse(raw.toString('utf8'));
  } catch {
    return;
  }
  if (data?.echo !== 'cli-1') return;
  clearTimeout(timer);
  console.log(JSON.stringify(data, null, 2));
  ws.close();
  process.exit(data?.retcode === 0 || data?.status === 'ok' ? 0 : 1);
});

ws.on('error', (error) => {
  console.error(`连接失败：${error.message}`);
  process.exit(1);
});
