#!/usr/bin/env node
/**
 * 给指定 QQ 用户发一张表情包（图片走 base64，NapCat 不用管本机路径）。
 *
 *   node scripts/send-sticker.mjs --to 123456789 --file data/stickers/02-饭饭呢.png
 *   node scripts/send-sticker.mjs --to 123456789 --file a.png --file b.gif
 */
import WebSocket from 'ws';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
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
const all = (name) => args.reduce((acc, v, i) => (args[i - 1] === `--${name}` ? [...acc, v] : acc), []);
const one = (name, fallback = '') => all(name)[0] ?? fallback;

const env = { ...loadEnv(join(root, '.env.qq')), ...process.env };
const wsUrl = one('url', env.QQ_WS_URL || 'ws://127.0.0.1:3001');
const token = one('token', env.QQ_WS_TOKEN || '');
const to = Number(one('to'));
const files = all('file').map((f) => resolve(f));

if (!to || files.length === 0) {
  console.error('用法：node scripts/send-sticker.mjs --to <QQ号> --file <图片路径> [--file ...]');
  process.exit(2);
}

const ws = new WebSocket(wsUrl, {
  headers: token ? { Authorization: `Bearer ${token}` } : {},
  handshakeTimeout: 10_000,
});

let seq = 0;
let failed = 0;

function send(echoId, params) {
  return new Promise((res, rej) => {
    const onMessage = (raw) => {
      let data;
      try {
        data = JSON.parse(raw.toString('utf8'));
      } catch {
        return;
      }
      if (data?.echo !== echoId) return;
      ws.off('message', onMessage);
      res(data);
    };
    ws.on('message', onMessage);
    ws.send(JSON.stringify({ action: 'send_private_msg', params, echo: echoId }));
    setTimeout(() => rej(new Error(`超时：${echoId}`)), 30_000);
  });
}

ws.on('error', (error) => {
  console.error(`连接失败：${error.message}`);
  process.exit(1);
});

ws.on('open', async () => {
  for (const file of files) {
    seq += 1;
    const echoId = `sticker-${seq}`;
    const b64 = readFileSync(file).toString('base64');
    try {
      const data = await send(echoId, { user_id: to, message: `[CQ:image,file=base64://${b64}]` });
      const ok = data?.retcode === 0 || data?.status === 'ok';
      if (!ok) failed += 1;
      console.log(`${ok ? '已发送' : '发送失败'} ${file} -> ${JSON.stringify(data?.retcode ?? data?.status)}`);
    } catch (error) {
      failed += 1;
      console.error(`发送失败 ${file}: ${error.message}`);
    }
  }
  ws.close();
  process.exit(failed ? 1 : 0);
});