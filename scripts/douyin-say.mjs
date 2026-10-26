#!/usr/bin/env node
/**
 * 让她在抖音私信里说一句话（写进出站队列，由常驻的私信通道发出去）。
 *
 *   node scripts/douyin-say.mjs --to restart --text "主人，人家在抖音也能说话了"
 *
 * 设计：不直接开第二个浏览器（会跟桥接里的常驻浏览器抢同一个 profile），
 * 只往 data/douyin/outbox.jsonl 追加一行，下一个轮询周期（≤20 秒）发出去。
 */

import { appendFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';

const argv = process.argv.slice(2);
const option = (name, fallback) => {
  const index = argv.indexOf(name);
  return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback;
};

const to = option('--to', '');
const text = option('--text', '');
if (!to || !text) {
  console.error('用法：node scripts/douyin-say.mjs --to <会话名> --text "内容"');
  process.exit(1);
}

const file = resolve(import.meta.dirname, '..', 'data/douyin/outbox.jsonl');
await mkdir(resolve(file, '..'), { recursive: true });
await appendFile(file, `${JSON.stringify({ to, text, at: Date.now() })}\n`, 'utf8');
console.log(`已排入队列：${to} ← ${text}`);
