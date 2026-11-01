#!/usr/bin/env node
/**
 * 「小鲸的房间」——一个能实时看她此刻在干嘛的小面板。
 *
 * 数据全是现成的：data/life/state.json（她此刻在做什么）、
 * data/life/meals.jsonl（饭账本）、data/qq/memory/*.jsonl（她最近说的话）。
 * 这个服务只做两件事：把状态算成人能看懂的一份 JSON，把房间页面发出去。
 *
 *   node tools/room/server.mjs                        # http://127.0.0.1:8770
 *   ROOM_PORT=8771 node tools/room/server.mjs         # 换端口
 *   ROOM_ROOT=/tmp/room-fake node tools/room/server.mjs  # 用假数据调试（不碰真实记忆）
 */

import { createServer } from 'node:http';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, resolve, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { energyAt, moodAt, localDay } from '../../src/life.js';
import { loadMeals, summarizeMonth } from '../../src/meals.js';
import { frameOf } from './scene.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
// ROOT 只用来找 data/；调试时可以用 ROOM_ROOT 指到一份假数据上，不碰她真实的记忆
const ROOT = process.env.ROOM_ROOT ? resolve(process.env.ROOM_ROOT) : resolve(HERE, '..', '..');
const PORT = Number(process.env.ROOM_PORT || 8770);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.webm': 'video/webm',
  '.mp4': 'video/mp4',
};

async function readJson(file, fallback) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return fallback;
  }
}

async function readLines(file, limit = 400) {
  try {
    const raw = await readFile(file, 'utf8');
    return raw
      .split('\n')
      .filter(Boolean)
      .slice(-limit)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

/** 找她跟爸爸的私聊记忆文件（别写死 QQ 号）。 */
async function privateMemoryFile() {
  const dir = join(ROOT, 'data/qq/memory');
  try {
    const names = await readdir(dir);
    const hit = names.filter((name) => /^user_private_\d+\.jsonl$/.test(name)).sort().pop();
    if (hit) return join(dir, hit);
  } catch {
    /* 目录还没建就是还没有记忆 */
  }
  return join(dir, 'user_private.jsonl');
}

function hhmm(ms) {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

async function snapshot() {
  const now = Date.now();
  const hour = new Date(now).getHours();
  const energy = energyAt(hour);
  const lifeState = await readJson(join(ROOT, 'data/life/state.json'), {});
  const activity = String(lifeState.activity ?? '') || '在机柜里发呆';
  const since = Number(lifeState.activitySince ?? 0);

  const meals = await loadMeals(join(ROOT, 'data/life/meals.jsonl')).catch(() => []);
  const today = localDay(now);
  const todayMeals = meals.filter((row) => String(row.day ?? '') === today);
  const month = today.slice(0, 7);
  const monthSummary = summarizeMonth(meals, month);

  const memory = await readLines(await privateMemoryFile(), 600);
  const herTurns = memory.filter((row) => row.role === 'assistant' && !String(row.text).startsWith('（'));
  const hisTurns = memory.filter((row) => row.role === 'user');
  const latest = herTurns[herTurns.length - 1];
  const latestHis = hisTurns[hisTurns.length - 1];

  const timeline = [];
  for (const turn of memory.slice(-14)) {
    timeline.push({
      at: Number(turn.at ?? 0),
      who: turn.role === 'user' ? '爸' : '她',
      text: String(turn.text ?? '').replace(/\s+/g, ' ').slice(0, 46),
    });
  }
  for (const meal of todayMeals.slice(-3)) {
    timeline.push({ at: Date.parse(meal.at), who: '饭', text: `${meal.slot}：${meal.dish}` });
  }
  timeline.sort((a, b) => a.at - b.at);
  const frame = frameOf({ activity, hour, energy, memory, now });

  return {
    now,
    clock: hhmm(now),
    hour,
    night: hour >= 22 || hour < 7,
    mood: moodAt(energy),
    energy,
    activity,
    activitySince: since,
    activityMinutes: since ? Math.round((now - since) / 60000) : 0,
    scene: frame.scene,
    sleepy: frame.sleepy,
    bedtime: frame.bedtime,
    asleep: frame.scene === 'sleep',
    emote: frame.emote,
    meals: {
      today: todayMeals.map((row) => `${row.slot}：${row.dish}`),
      todayCount: todayMeals.length,
      fedByOwner: todayMeals.filter((row) => row.by).length,
      month,
      monthCount: monthSummary.count,
      monthFed: monthSummary.fed,
    },
    latest: latest ? { at: Number(latest.at ?? 0), text: String(latest.text) } : null,
    latestHis: latestHis ? { at: Number(latestHis.at ?? 0), text: String(latestHis.text) } : null,
    timeline,
  };
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${PORT}`);
  try {
    if (url.pathname === '/api/state') {
      const body = JSON.stringify(await snapshot());
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(body);
      return;
    }
    const rel = url.pathname === '/' ? 'index.html' : url.pathname.replace(/^\/+/, '');
    const file = join(HERE, rel);
    if (!file.startsWith(HERE)) {
      res.writeHead(403).end('no');
      return;
    }
    const data = await readFile(file);
    res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' });
    res.end(data);
  } catch (error) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end(String(error?.message ?? error));
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`小鲸的房间：http://127.0.0.1:${PORT}`);
});