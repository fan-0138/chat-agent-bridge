#!/usr/bin/env node
/**
 * 把已经发出去的作品补进本地账本（data/douyin/published.jsonl）。
 *
 * 为什么要补（2026-11-08）：爸爸说她重复发了昨天的、他删掉了。被删掉的作品
 * 主页上就查不到了，所以「发之前别重复」这件事不能只靠查主页——
 * 得把每条作品的片子指纹攒在本地。以后哪怕作品没了，同一个片子再传也会被认出来。
 *
 *   node scripts/douyin-prints-backfill.mjs            # 补最近 20 条里没记过的
 *   node scripts/douyin-prints-backfill.mjs --dry      # 只看要补哪些，不下载
 *   node scripts/douyin-prints-backfill.mjs --force    # 已经记过的也重算一遍
 *
 * 做法：从主页接口拿 play_addr → 下到 /tmp → 算 sha256 / 时长 / 抽样帧 dHash → 记账 → 删临时文件。
 * （实测：抖音转码回来的片子和原文件抽样帧几乎完全一致，差 0~1 位，所以这套指纹认得出来。）
 */

import { chromium } from 'playwright';
import { appendFile, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { openOwnPage } from './lib/douyin-feed.mjs';
import { videoPrint } from './lib/video-print.mjs';

const args = process.argv.slice(2);
const arg = (name, fallback = '') => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? (args[i + 1] ?? fallback) : fallback;
};
const has = (name) => args.includes(`--${name}`);

const count = Math.max(1, Math.min(50, Number(arg('count', '20')) || 20));
const dry = has('dry');
const force = has('force');
const CDP = process.env.DOUYIN_CDP || 'http://127.0.0.1:9223';
const PUBLISHED_FILE = resolve('data/douyin/published.jsonl');
const TMP_DIR = resolve('/tmp/douyin-prints');

async function readRegistry() {
  try {
    const text = await readFile(PUBLISHED_FILE, 'utf8');
    return text
      .split('\n')
      .filter((line) => line.trim())
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

const browser = await chromium.connectOverCDP(CDP).catch(() => null);
if (!browser) {
  console.log(JSON.stringify({ ok: false, reason: `连不上抖音浏览器（${CDP}）` }));
  process.exit(1);
}

const context = browser.contexts()[0];
const page = await openOwnPage(context).catch(() => null);
if (!page) {
  console.log(JSON.stringify({ ok: false, reason: '打不开她的主页' }));
  process.exit(1);
}

// 主页接口：一次拿到 id / 文案 / 时长 / 播放地址
const feed = await page
  .evaluate(async (limit) => {
    const base = 'device_platform=webapp&aid=6383&channel=channel_pc_web';
    const call = async (url) => {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 20_000);
      try {
        const response = await fetch(url, { credentials: 'include', signal: ctl.signal });
        return await response.json();
      } catch (error) {
        return { error: String(error?.name ?? error) };
      } finally {
        clearTimeout(timer);
      }
    };
    const self = await call(`https://www.douyin.com/aweme/v1/web/user/profile/self/?${base}`);
    if (!self?.user?.sec_uid) return { error: 'no-self' };
    const qs = new URLSearchParams({ sec_user_id: self.user.sec_uid, count: String(limit), max_cursor: '0' });
    const posts = await call(`https://www.douyin.com/aweme/v1/web/aweme/post/?${qs}&${base}`);
    return {
      name: self.user.nickname,
      works: (posts?.aweme_list ?? []).map((row) => {
        const urls = row.video?.play_addr?.url_list ?? [];
        return {
          id: String(row.aweme_id),
          desc: String(row.desc ?? ''),
          at: Number(row.create_time ?? 0) * 1000,
          durationMs: Number(row.video?.duration ?? 0),
          playUrl: String(urls[urls.length - 1] ?? ''),
        };
      }),
    };
  }, count)
  .catch((error) => ({ error: String(error?.message ?? error) }));

await page.close().catch(() => {});

if (feed?.error) {
  console.log(JSON.stringify({ ok: false, reason: `读主页失败：${feed.error}` }));
  process.exit(1);
}

const registry = await readRegistry();
const known = new Set(registry.map((row) => String(row.id ?? '')));
const todo = (feed.works ?? []).filter((work) => force || !known.has(work.id));

const summary = { ok: true, name: feed.name, total: feed.works.length, known: registry.length, todo: todo.length, added: [], skipped: [], failed: [] };

if (dry) {
  summary.skipped = todo.map((work) => ({ id: work.id, desc: work.desc.slice(0, 30) }));
  console.log(JSON.stringify(summary));
  process.exit(0);
}

await mkdir(TMP_DIR, { recursive: true });
for (const work of todo) {
  const tmp = resolve(TMP_DIR, `${work.id}.mp4`);
  try {
    if (!work.playUrl) throw new Error('没有播放地址');
    const response = await fetch(work.playUrl, { headers: { referer: 'https://www.douyin.com/' } });
    if (!response.ok) throw new Error(`下载失败 HTTP ${response.status}`);
    await writeFile(tmp, Buffer.from(await response.arrayBuffer()));
    const print = await videoPrint(tmp);
    if (!print.frames.length) throw new Error('抽不出帧');
    const row = {
      at: work.at,
      id: work.id,
      title: work.desc,
      source: 'feed',
      sha256: print.sha256,
      durationMs: print.durationMs,
      frames: print.frames,
    };
    await mkdir(dirname(PUBLISHED_FILE), { recursive: true });
    await appendFile(PUBLISHED_FILE, `${JSON.stringify(row)}\n`, 'utf8');
    summary.added.push({ id: work.id, desc: work.desc.slice(0, 24), frames: print.frames.length });
  } catch (error) {
    summary.ok = false;
    summary.failed.push({ id: work.id, reason: String(error?.message ?? error) });
  } finally {
    await rm(tmp, { force: true }).catch(() => {});
  }
}

await browser.close().catch(() => {});
console.log(JSON.stringify(summary));