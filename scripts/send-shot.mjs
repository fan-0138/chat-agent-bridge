#!/usr/bin/env node
/**
 * 把本地图片发给主人（QQ 私聊）。
 *
 *   node scripts/send-shot.mjs /path/to/shot.png "给你看我在游戏里"
 *
 * 为什么不直接 CQ 码：SnowLuma 跑在 Docker 里看不到宿主机路径，图得用 base64 塞进去。
 * 和桥接里发表情包是同一套写法，只是这个走命令行，她自己在 bash 里就能用。
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

const env = { ...loadEnv(join(root, '.env.qq')), ...process.env };
const wsUrl = env.QQ_WS_URL || 'ws://127.0.0.1:3001';
const token = env.QQ_WS_TOKEN || '';
const owner = String(env.QQ_ALLOW_LIST || '').split(',')[0].trim();
const file = process.argv[2];
const caption = process.argv[3] || '';

if (!file) {
  console.error('用法：send-shot.mjs <图片路径> [一句话]');
  process.exit(1);
}
if (!owner) {
  console.error('不知道发给谁：.env.qq 里没有 QQ_ALLOW_LIST');
  process.exit(1);
}

let base64;
try {
  base64 = readFileSync(file).toString('base64');
} catch (error) {
  console.error(`读不到图片：${error.message}`);
  process.exit(1);
}

const ws = new WebSocket(`${wsUrl}${token ? `?access_token=${token}` : ''}`);
let id = 0;
const pending = new Map();

function call(action, params) {
  const echo = `send-shot-${++id}`;
  return new Promise((resolve, reject) => {
    pending.set(echo, { resolve, reject });
    ws.send(JSON.stringify({ action, params, echo }));
    setTimeout(() => {
      if (pending.has(echo)) {
        pending.delete(echo);
        reject(new Error('等回包超时'));
      }
    }, 15_000).unref();
  });
}

ws.on('message', (raw) => {
  let msg;
  try {
    msg = JSON.parse(String(raw));
  } catch {
    return;
  }
  const waiter = msg.echo ? pending.get(msg.echo) : null;
  if (!waiter) return;
  pending.delete(msg.echo);
  if (msg.retcode && msg.retcode !== 0) waiter.reject(new Error(`retcode=${msg.retcode} ${msg.message || msg.wording || ''}`));
  else waiter.resolve(msg);
});

ws.on('open', async () => {
  try {
    if (caption) {
      await call('send_private_msg', { user_id: Number(owner), message: caption });
    }
    const res = await call('send_private_msg', {
      user_id: Number(owner),
      message: [{ type: 'image', data: { file: `base64://${base64}` } }],
    });
    console.log(JSON.stringify(res, null, 2));
    ws.close();
    process.exit(0);
  } catch (error) {
    console.error(`发图失败：${error.message}`);
    ws.close();
    process.exit(2);
  }
});

ws.on('error', (error) => {
  console.error(`连不上网关：${error.message}`);
  process.exit(2);
});