#!/usr/bin/env node
/**
 * 在一条视频的评论区里找「@ 了她」的评论（通知接口漏掉时用）。
 *
 *   node scripts/douyin-find-mentions.mjs --url https://www.douyin.com/video/xxx
 *   node scripts/douyin-find-mentions.mjs --url xxx --add     # 找到就塞进她的收件箱，下一轮她会去回
 *   node scripts/douyin-find-mentions.mjs --url xxx --max 600 # 最多翻多少条评论（默认 300）
 *
 * 为什么需要：抖音的互动通知接口有时候不给 @ 通知（比如评论被折叠、@ 没选中账号、
 * 或者单纯没推），但评论本身是在的。这个脚本直接翻评论，按她的抖音昵称/uid 匹配。
 */

import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const argv = process.argv.slice(2);
const arg = (name, fallback = '') => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? (argv[i + 1] ?? fallback) : fallback;
};
const has = (name) => argv.includes(`--${name}`);

const HER_UIDS = new Set(['1000000000000000']); // 吃白饭的机器人账号
const HER_NAMES = ['吃白饭的机器人账号', '机器人账号'];

function videoIdOf(input) {
  const text = String(input ?? '');
  const m = text.match(/(?:video|note|slides)\/(\d+)/) || text.match(/^(\d{6,})$/);
  return m ? m[1] : '';
}

const rawUrl = arg('url');
const awemeId = videoIdOf(rawUrl);
if (!awemeId) {
  console.error('用法：node scripts/douyin-find-mentions.mjs --url <视频链接或 id> [--add] [--max 300]');
  process.exit(2);
}

const { chromium } = await import('playwright');

async function fetchPage(page, cursor) {
  const q = new URLSearchParams({
    aweme_id: awemeId,
    cursor,
    count: '50',
    item_type: '0',
    device_platform: 'webapp',
    aid: '6383',
    channel: 'channel_pc_web',
    pc_client_type: '1',
    version_code: '190500',
    version_name: '19.5.0',
    cookie_enabled: 'true',
    screen_width: '1920',
    screen_height: '1080',
    browser_language: 'zh-CN',
    browser_platform: 'Win32',
    browser_name: 'Chrome',
    browser_version: '141.0.0.0',
    engine_name: 'Blink',
    engine_version: '141.0.0.0',
    os_name: 'Windows',
    os_version: '10',
    platform: 'PC',
  });
  return page
    .evaluate(async (url) => {
      try {
        const res = await fetch(url, { credentials: 'include', headers: { accept: 'application/json' } });
        const text = await res.text();
        try {
          return JSON.parse(text);
        } catch {
          return { raw: text.slice(0, 120) };
        }
      } catch (error) {
        return { error: String(error?.message ?? error) };
      }
    }, `/aweme/v1/web/comment/list/?${q}`)
    .catch((error) => ({ error: String(error?.message ?? error) }));
}

const browser = await chromium.connectOverCDP(process.env.DOUYIN_CDP || 'http://127.0.0.1:9223').catch(() => null);
if (!browser) {
  console.error('连不上抖音浏览器（CDP 9223 不在）。先让桥接/她的浏览器起来。');
  process.exit(1);
}
const context = browser.contexts()[0];
const page = context.pages().find((p) => p.url().includes('douyin')) ?? (await context.newPage());
if (!page.url().includes('douyin')) await page.goto('https://www.douyin.com/', { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => {});

const max = Math.max(50, Math.min(2_000, Number(arg('max', '300')) || 300));
const all = [];
let cursor = '0';
for (let i = 0; i < Math.ceil(max / 50); i += 1) {
  const data = await fetchPage(page, cursor);
  const list = data?.comments ?? [];
  all.push(...list);
  if (!list.length || !data?.has_more) break;
  cursor = String(data.cursor ?? '');
}
await page.close().catch(() => {});
await browser.close().catch(() => {});

const hits = all.filter((c) => {
  const uid = String(c?.user?.uid ?? '');
  const text = String(c?.text ?? '');
  const nick = String(c?.user?.nickname ?? '');
  if (HER_UIDS.has(uid)) return false;
  const mentioned = HER_NAMES.some((name) => text.includes(`@${name}`) || text.includes(name));
  return mentioned || nick.includes('机器人账号');
});

console.log(`视频 ${awemeId}：翻了 ${all.length} 条评论，命中 ${hits.length} 条提到她的`);
for (const c of hits) {
  const when = c?.create_time ? new Date(c.create_time * 1000).toLocaleString('zh-CN', { hour12: false }) : '?';
  console.log(`  ${when}  ${c?.user?.nickname ?? ''}（uid ${c?.user?.uid ?? '?'}）：${String(c?.text ?? '').slice(0, 100)}`);
  console.log(`    cid=${c?.cid}`);
}

if (has('add') && hits.length > 0) {
  const inbox = resolve(process.cwd(), 'data/douyin/at-inbox.jsonl');
  await mkdir(dirname(inbox), { recursive: true });
  const now = Date.now();
  const lines = hits.map((c) =>
    JSON.stringify({
      type: 45,
      typeName: '@了你（评论区）',
      nid: String(c.cid),
      createTime: Number(c.create_time ?? Math.floor(now / 1000)),
      nickname: c?.user?.nickname ?? '',
      uid: String(c?.user?.uid ?? ''),
      content: String(c?.text ?? ''),
      awemeId,
      commentId: String(c.cid ?? ''),
      videoUrl: `https://www.douyin.com/video/${awemeId}`,
      commentUrl: `https://www.douyin.com/video/${awemeId}?comment_id=${c.cid}`,
      atMe: true,
      replyable: true,
      source: 'scan',
      seenAt: now,
    }),
  );
  await appendFile(inbox, `${lines.join('\n')}\n`, 'utf8');
  console.log(`已把 ${lines.length} 条塞进她的收件箱（${inbox}），她下一轮想事时会看到。`);
}
