#!/usr/bin/env node
/**
 * 打开一条抖音视频，把「它到底在讲什么」读出来：标题、作者、热评，带一张截图。
 *
 *   node scripts/douyin-video-context.mjs --url https://www.douyin.com/video/xxx
 *   node scripts/douyin-video-context.mjs --url ... --shot    # 顺便截图（默认不截）
 *
 * 输出一行 JSON：{ ok, url, desc, author, comments: [...], shot }
 * 给「她回别人评论 / 去评论区说话」之前用——先看过视频再开口，别已读乱回。
 */
import { resolve } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { openBrowser, closeBrowser, stealth } from './lib/douyin-browser.mjs';
import { readVideoSummary, extractDouyinVideo } from './lib/douyin-video.js';

const argv = process.argv.slice(2);
const option = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};

const root = resolve(import.meta.dirname, '..');
const urlArg = option('--url', '');
const wantShot = argv.includes('--shot');
const video = extractDouyinVideo(urlArg);
const url = video?.url || urlArg;

if (!url) {
  console.error('用法：douyin-video-context.mjs --url <视频链接> [--shot]');
  process.exit(1);
}

const started = Date.now();
let browser = null;
try {
  browser = await openBrowser({ offscreen: true });
  const { context, remote } = browser;
  const page = remote ? await context.newPage() : (context.pages()[0] ?? (await context.newPage()));
  await stealth(page);

  const summary = await readVideoSummary(page, url);
  let shot = '';
  if (wantShot) {
    try {
      const dir = resolve(root, 'data/douyin/shots');
      await mkdir(dir, { recursive: true });
      const id = video?.id || String(Date.now());
      shot = resolve(dir, `context-${id}.png`);
      await page.screenshot({ path: shot, type: 'png' }).catch(() => {
        shot = '';
      });
    } catch {
      shot = '';
    }
  }

  const result = {
    ok: Boolean(summary),
    url,
    desc: String(summary?.desc ?? '').slice(0, 200),
    author: String(summary?.author ?? '').slice(0, 40),
    comments: Array.isArray(summary?.comments) ? summary.comments.slice(0, 6) : [],
    shot,
    ms: Date.now() - started,
  };
  console.log(JSON.stringify(result));
  process.exitCode = result.ok ? 0 : 2;
} catch (error) {
  console.log(JSON.stringify({ ok: false, url, reason: String(error?.message ?? error), ms: Date.now() - started }));
  process.exitCode = 2;
} finally {
  if (browser) await closeBrowser(browser.context, browser.remote, browser.preexisting).catch(() => {});
}