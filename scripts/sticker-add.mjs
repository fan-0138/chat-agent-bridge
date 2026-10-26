#!/usr/bin/env node
/**
 * 存表情包。
 *
 *   node scripts/sticker-add.mjs --search "蓝鲸 表情包" --count 4   # 搜图 → 验图 → 入库
 *   node scripts/sticker-add.mjs --search "猫猫 表情包" --subject 猫 --count 3
 *   node scripts/sticker-add.mjs --url https://xxx.png
 *   node scripts/sticker-add.mjs --file ~/Downloads/whale.png
 *   node scripts/sticker-add.mjs --list
 *
 * 规则（防止存一堆垃圾）：
 *  - 只收真图片（看文件头，不看后缀）；
 *  - 单张 ≤ 3MB，内容重复的不再存；
 *  - 搜来的图先用看图工具确认「图里真有要的主体」（--subject，默认鲸鱼），带图库水印的直接丢；
 *  - 命名沿用现有风格：16-<内容指纹>.png
 */

import { createHash } from 'node:crypto';
import { readdir, readFile, writeFile, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { imageSize, imageType, judgeSubject, nextIndex, parseBingImageUrls, parseVision } from './lib/sticker-files.js';
import { createVision, resolveVisionCli } from '../src/vision.js';

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const option = (name, fallback) => {
  const index = argv.indexOf(name);
  return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback;
};

const dir = resolve(process.cwd(), process.env.QQ_STICKER_DIR || 'data/stickers');
const MAX_BYTES = 3 * 1024 * 1024;
const IMAGE_NAME = /\.(png|jpe?g|gif|webp)$/i;
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36';

import { copyFile } from 'node:fs/promises';

function makeVision() {
  return createVision({
    cli: resolveVisionCli(process.env),
    // 搜图时是批量验图、几张一起跑，单张不用等太久
    timeoutMs: Number(process.env.STICKER_VISION_TIMEOUT_MS || process.env.VISION_TIMEOUT_MS || 25_000),
    enabled: process.env.VISION_ENABLED !== '0',
    log: { info() {}, warn() {}, error() {} },
  });
}

const WATERMARK_SITES = /摄图网|699pic|千图网|昵图网|视觉中国|站酷|pngtree|shutterstock|gettyimages|dreamstime|istockphoto|616pic|图精灵/i;

/** 直接按网址先剔掉图库站，省下一次下载 + 一次验图 */
const STOCK_HOST =
  /(699pic|58pic|588ku|tukuppt|zhitu|pngtree|shutterstock|gettyimages|dreamstime|istockphoto|zcool|vcg\.com|hellorf|tuchong|616pic|摄图|图精灵)/i;

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

/**
 * 并发跑一组任务，最多 limit 个同时进行。
 * @template T, R
 * @param {T[]} items
 * @param {number} limit
 * @param {(item: T, index: number) => Promise<R>} fn
 * @returns {Promise<R[]>}
 */
async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await fn(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

/** 上一次被超时打断时可能留下 .probe-* 临时图，开跑前清掉 */
async function cleanupProbes() {
  const names = await readdir(dir).catch(() => []);
  await Promise.all(
    names
      .filter((name) => name.startsWith('.probe-'))
      .map((name) => unlink(resolve(dir, name)).catch(() => {})),
  );
}

/** 问法要收紧：以前问「有没有鲸鱼娘」，模型看到动漫妹子就点头，存进来一张 2B */
function subjectPrompt(subject) {
  const noun = subject === '鲸' ? '鲸鱼' : subject;
  const detail = subject === '鲸'
    ? '画面里能直接看到鲸鱼的身体、尾巴、喷水或明显的鲸鱼图案。'
    : `画面里能直接看到${noun}本身（不是只提到字，也不是别的东西当主角）。`;
  return `图里有没有${noun}？标准：${detail}` +
    `只画了个动漫人物、没有${noun}本身，算"没有"。只回答"有"或"没有"，再用一句话说明图里是什么。`;
}

/**
 * 存之前用看图工具过一遍。只问一个问题 —— 一次问两件事模型会答串。
 *
 * 注意 available 和 whale===null 的区别：
 *  - available=false：本来就没验图（--no-verify），照存；
 *  - available=true 但 whale===null：看着图但没看清（超时/失败），**不能照存**——
 *    之前放行过一次，结果存进来一张白毛动漫妹子。
 * @returns {Promise<{available: boolean, whale: boolean|null, watermark: boolean}>}
 */
async function inspectSticker(vision, path, subject = '鲸') {
  if (!vision.available) return { available: false, whale: null, watermark: false };
  const evidence = await vision.analyze(path, subjectPrompt(subject));
  if (!evidence) return { available: true, whale: null, watermark: false };
  const { summary, ocr } = parseVision(evidence);
  return {
    available: true,
    whale: judgeSubject(summary, subject),
    watermark: WATERMARK_SITES.test(`${summary}\n${ocr}`),
  };
}

async function listImages() {
  return (await readdir(dir).catch(() => []))
    .filter((name) => IMAGE_NAME.test(name) && !name.startsWith('.probe-'))
    .sort();
}

async function list() {
  const names = await listImages();
  console.log(`表情包 ${names.length} 张：${dir}`);
  console.log(names.join('\n'));
}

async function hashesOf(names) {
  const set = new Set();
  for (const name of names) {
    try {
      const buf = await readFile(resolve(dir, name));
      set.add(createHash('sha1').update(buf).digest('hex').slice(0, 10));
    } catch {
      /* 读不了就跳过 */
    }
  }
  return set;
}

async function saveOne(buf, label) {
  if (buf.length > MAX_BYTES) return { ok: false, reason: `太大（${(buf.length / 1024 / 1024).toFixed(1)}MB > 3MB）` };
  const type = imageType(buf);
  if (!type) return { ok: false, reason: `不是图片（文件头不对）：${label}` };
  const size = imageSize(buf);
  if (size && (Math.min(size.width, size.height) < 120 || Math.max(size.width, size.height) > 2_400)) {
    return { ok: false, reason: `尺寸不合适（${size.width}×${size.height}）` };
  }
  const hash = createHash('sha1').update(buf).digest('hex').slice(0, 10);
  const names = await listImages();
  const existing = await hashesOf(names);
  if (existing.has(hash)) return { ok: false, reason: '已经有一模一样的了' };
  const target = resolve(dir, `${nextIndex(names)}-${hash}.${type.ext}`);
  await writeFile(target, buf);
  return { ok: true, path: target, bytes: buf.length };
}

async function search(keyword, count) {
  const started = Date.now();
  // 整条命令必须有上限：以前串行验图能跑三五分钟，聊天那边超时了人还在等
  const deadlineMs = Math.max(
    15_000,
    Number(process.env.QQ_STICKER_DEADLINE_MS || option('--deadline', '75000')) || 75_000,
  );
  const deadline = started + deadlineMs;
  await cleanupProbes();

  const query = encodeURIComponent(keyword);
  const url = `https://cn.bing.com/images/async?q=${query}&first=0&count=35&mkt=zh-CN`;
  const response = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'text/html' } }).catch((error) => ({ ok: false, error }));
  if (!response.ok) {
    console.error(`搜图失败：${response.status ?? response.error}`);
    return 2;
  }
  const found = parseBingImageUrls(await response.text(), 40);
  const urls = found.filter((item) => !STOCK_HOST.test(item));
  if (urls.length === 0) {
    console.error('搜到 0 个图片地址（可能被拦了，换个词试试）');
    return 2;
  }
  if (flag('--dry')) {
    console.log(`搜到 ${urls.length} 个候选：`);
    urls.slice(0, count).forEach((item, i) => console.log(`${i + 1}. ${item.slice(0, 100)}`));
    return 0;
  }

  const vision = flag('--no-verify') ? { available: false } : makeVision();
  const seen = new Set(await hashesOf(await listImages()));

  // 一、并发下载：不验图先囤货，网速快、几乎不花时间
  const pool = urls.slice(0, Math.min(30, count * 6 + 6));
  console.log(`搜到 ${urls.length} 个候选，先下 ${pool.length} 个看看。`);
  const downloaded = await mapLimit(pool, 8, async (item) => {
    try {
      const res = await fetch(item, {
        headers: { 'User-Agent': UA, Referer: 'https://cn.bing.com/' },
        redirect: 'follow',
      });
      if (!res.ok) return null;
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length < 1_000 || buf.length > MAX_BYTES) return null;
      const type = imageType(buf);
      if (!type) return null;
      const hash = createHash('sha1').update(buf).digest('hex').slice(0, 10);
      if (seen.has(hash)) return null;
      seen.add(hash); // 同一张图别验两遍
      return { url: item, buf, hash, ext: type.ext };
    } catch {
      return null;
    }
  });
  const candidates = downloaded.filter(Boolean);
  if (candidates.length === 0) {
    console.error('候选图一张都没下下来（链接多半失效了）。');
    return 2;
  }

  // 二、并发验图：一批几张一起看，一边看一边存，凑够就停
  const batchSize = Math.max(1, Math.min(8, Number(process.env.QQ_STICKER_VERIFY_CONCURRENCY || 6)));
  let saved = 0;
  let rejected = 0;
  let checked = 0;
  for (let i = 0; i < candidates.length && saved < count; i += batchSize) {
    if (Date.now() > deadline) {
      console.log(`（到时间上限了，剩下的没来得及看）`);
      break;
    }
    const batch = candidates.slice(i, i + batchSize);
    const verdicts = await Promise.all(
      batch.map(async (item) => {
        const tmpPath = resolve(dir, `.probe-${item.hash}.${item.ext}`);
        try {
          await writeFile(tmpPath, item.buf);
          const check = await inspectSticker(vision, tmpPath, subject);
          return { item, check };
        } catch {
          return { item, check: { whale: null, watermark: false } };
        } finally {
          await unlink(tmpPath).catch(() => {});
        }
      }),
    );
    checked += verdicts.length;

    for (const { item, check } of verdicts) {
      if (saved >= count) break;
      const unknown = check.available && check.whale === null;
      if (check.watermark || check.whale === false || unknown) {
        rejected += 1;
        console.log(
          `跳过：${check.watermark ? '带图库水印' : unknown ? '看图没看清（宁可不存）' : '图里没有' + subject}（${item.url.slice(0, 60)}）`,
        );
        continue;
      }
      const result = await saveOne(item.buf, item.url);
      if (!result.ok) {
        console.log(`跳过：${result.reason}`);
        continue;
      }
      saved += 1;
      const seconds = ((Date.now() - started) / 1000).toFixed(0);
      console.log(
        `存好：${basename(result.path)}（${(result.bytes / 1024).toFixed(0)}KB）${check.whale === null ? '（没验图）' : '（确认有' + subject + '）'} ${seconds}s`,
      );
    }
  }

  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  if (saved === 0) {
    console.log(`\n一张都没存下来（看了 ${checked} 张，用了 ${seconds}s）。`);
    return 3;
  }
  console.log(`\n一共存了 ${saved} 张${rejected > 0 ? `，跳过 ${rejected} 张` : ''}，用了 ${seconds}s。`);
  return 0;
}

if (flag('--list')) {
  await list();
  process.exit(0);
}

const subject = option('--subject', '鲸').trim() || '鲸';
const searchWord = option('--search', '').trim();
if (searchWord) {
  const count = Math.max(1, Math.min(20, Number(option('--count', 5)) || 5));
  process.exit(await search(searchWord, count));
}

const url = option('--url', '').trim();
const file = option('--file', '').trim();
if (!url && !file) {
  console.error('用法：sticker-add.mjs --search "关键词" [--count 4] | --url <图片地址> | --file <本地路径> | --list');
  process.exit(1);
}

let buf;
let label;
if (url) {
  const response = await fetch(url, { headers: { 'User-Agent': UA, Referer: url }, redirect: 'follow' }).catch((error) => ({ ok: false, error }));
  if (!response.ok) {
    console.error(`下载失败：${response.status ?? response.error}`);
    process.exit(2);
  }
  buf = Buffer.from(await response.arrayBuffer());
  label = basename(new URL(url).pathname) || 'remote';
} else {
  const path = resolve(file.replace(/^~/, process.env.HOME ?? ''));
  if (!existsSync(path)) {
    console.error(`文件不存在：${path}`);
    process.exit(2);
  }
  buf = await readFile(path);
  label = basename(path);
}

const result = await saveOne(buf, label);
if (!result.ok) {
  console.log(result.reason);
  process.exit(3);
}
console.log(`存好了：${result.path}（${(result.bytes / 1024).toFixed(0)}KB）`);
console.log(`现在一共 ${(await listImages()).length} 张。`);
