#!/usr/bin/env node
/**
 * 查她的作品有没有重复发（爸爸 2026-11-08：「她今天早上重复发了昨天的，我删掉了」）。
 *
 *   node scripts/douyin-dupes.mjs                 # 人看的：一条条列出来，有重复就红字提醒
 *   node scripts/douyin-dupes.mjs --json          # 给我 / 定时任务读的 JSON
 *   node scripts/douyin-dupes.mjs --count 50      # 多翻几条（默认 20）
 *
 * 判据跟发布脚本共用 src/douyin-publish-guard.js：
 *   - 文案（去掉话题标签、标点、表情）像到 0.62 以上 → 同一条
 *   - 片子长度差不到 0.3 秒 → 基本是同一个文件
 * 只在「已经发出去的作品」之间比，查的是结果；发之前的拦截在 douyin-publish.mjs 里。
 *
 * 退出码：0 = 没重复 / 4 = 查出重复 / 1 = 读不到作品列表
 */

import { chromium } from 'playwright';
import { findDuplicateWork } from '../src/douyin-publish-guard.js';
import { openOwnPage, readOwnWorks } from './lib/douyin-feed.mjs';

const args = process.argv.slice(2);
const arg = (name, fallback = '') => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? (args[i + 1] ?? fallback) : fallback;
};
const has = (name) => args.includes(`--${name}`);

const count = Math.max(2, Math.min(50, Number(arg('count', '20')) || 20));
const json = has('json');
const CDP = process.env.DOUYIN_CDP || 'http://127.0.0.1:9223';

const hhmm = (at) =>
  new Date(Number(at) || 0).toLocaleString('zh-CN', {
    timeZone: 'Asia/Shanghai',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });

const browser = await chromium.connectOverCDP(CDP).catch(() => null);
if (!browser) {
  const out = { ok: false, reason: `连不上抖音浏览器（${CDP}）`, dupes: [], works: [] };
  console.log(json ? JSON.stringify(out) : out.reason);
  process.exit(1);
}

const context = browser.contexts()[0];
const page = await openOwnPage(context).catch(() => null);
const feed = page ? await readOwnWorks(page, { count }) : { ok: false, works: [] };
await page?.close().catch(() => {});
await browser.close().catch(() => {});

if (!feed.ok) {
  const out = { ok: false, reason: '读不到她的作品列表（登录态掉了？）', dupes: [], works: [] };
  console.log(json ? JSON.stringify(out) : out.reason);
  process.exit(1);
}

const works = feed.works ?? [];
const dupes = [];
for (let i = 0; i < works.length; i += 1) {
  for (let j = i + 1; j < works.length; j += 1) {
    const hit = findDuplicateWork({
      works: [works[j]],
      title: works[i].desc,
      durationMs: works[i].durationMs,
    });
    if (!hit.dup) continue;
    dupes.push({
      newer: { id: works[i].id, at: works[i].at, desc: works[i].desc, durationMs: works[i].durationMs },
      older: { id: works[j].id, at: works[j].at, desc: works[j].desc, durationMs: works[j].durationMs },
      similarity: hit.dup.similarity,
      sameDuration: hit.dup.sameDuration,
      why: hit.dup.why,
    });
  }
}

const out = {
  ok: true,
  name: feed.name,
  count: works.length,
  dupes,
  works: works.map((row) => ({
    id: row.id,
    at: row.at,
    durationMs: row.durationMs,
    desc: String(row.desc ?? '').slice(0, 60),
  })),
};

if (json) {
  console.log(JSON.stringify(out));
} else {
  console.log(`${feed.name}：${works.length} 条作品`);
  for (const row of out.works) {
    console.log(`  ${hhmm(row.at)}  ${(row.durationMs / 1000).toFixed(1)}s  ${row.desc}`);
  }
  if (dupes.length === 0) {
    console.log('没查出重复。');
  } else {
    console.log(`\n⚠ 查出 ${dupes.length} 组重复：`);
    for (const dup of dupes) {
      console.log(`  新 ${hhmm(dup.newer.at)}「${dup.newer.desc}」`);
      console.log(`  旧 ${hhmm(dup.older.at)}「${dup.older.desc}」`);
      console.log(`  → ${dup.why}（文案像 ${dup.similarity}）`);
    }
  }
}

process.exit(dupes.length === 0 ? 0 : 4);