#!/usr/bin/env node
/**
 * 改已经发出去的抖音作品文案（创作者中心「编辑作品」，30 天内最多改 5 次）。
 *
 *   node scripts/douyin-edit.mjs --mid 7704630643740724499 --text "新文案 #标签"
 *   node scripts/douyin-edit.mjs --list          # 列出最近作品和 mid
 *
 * mid 就是作品页地址里的 mid 参数（管理页「编辑作品」跳过去的链接里有）。
 * 默认只打印将要写入的文案；带 --yes 才真的提交。
 */
import { chromium } from 'playwright';
import { openBrowser, closeBrowser, stealth } from './lib/douyin-browser.mjs';

const args = process.argv.slice(2);
const arg = (name, fallback = '') => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? (args[i + 1] ?? fallback) : fallback;
};
const has = (name) => args.includes(`--${name}`);

const mid = String(arg('mid', '')).trim();
const text = String(arg('text', '')).trim();
const confirm = has('yes');

if (!mid || !text) {
  console.error('用法：douyin-edit.mjs --mid <作品mid> --text "新文案" [--yes]');
  process.exit(2);
}

const managerUrl = 'https://creator.douyin.com/creator-micro/content/manage';
const editUrl = `https://creator.douyin.com/creator-micro/content/post/video?mid=${mid}&enter_from=edit_item`;

let browser = null;
const started = Date.now();
try {
  browser = await openBrowser({ offscreen: true });
  const { context, remote } = browser;
  const page = remote ? await context.newPage() : (context.pages()[0] ?? (await context.newPage()));
  await stealth(page);

  await page.goto(editUrl, { waitUntil: 'domcontentloaded', timeout: 45_000 }).catch(() => {});
  await page.waitForTimeout(6_000);

  const box = await page.evaluate(() => {
    const el = [...document.querySelectorAll('[contenteditable="true"]')].find((n) => n.offsetParent);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2, text: el.innerText };
  });
  if (!box) throw new Error('没找到作品描述输入框（可能没登录或页面改版）');

  if (!confirm) {
    console.log(JSON.stringify({ ok: true, dry: true, mid, before: box.text.replace(/\u200b/g, '').trim(), after: text }, null, 1));
    process.exitCode = 0;
  } else {
    await page.mouse.click(box.x, box.y);
    await page.waitForTimeout(300);
    await page.keyboard.press('Meta+A');
    await page.keyboard.press('Backspace');
    await page.waitForTimeout(250);
    await page.keyboard.type(text, { delay: 12 });
    await page.waitForTimeout(600);

    const typed = await page.evaluate(() => {
      const el = [...document.querySelectorAll('[contenteditable="true"]')].find((n) => n.offsetParent);
      return el ? el.innerText.replace(/\u200b/g, '') : '';
    });
    if (!typed.includes(text.slice(0, 8))) throw new Error(`输入没生效：${typed.slice(0, 60)}`);

    const submitted = await page.evaluate(() => {
      const btn = [...document.querySelectorAll('button, div, span')].find(
        (n) => (n.textContent || '').trim() === '提交修改' && n.offsetParent,
      );
      if (!btn) return false;
      btn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      return true;
    });
    if (!submitted) throw new Error('没找到「提交修改」按钮');
    await page.waitForTimeout(6_000);

    // 回管理页确认现在挂的是新文案
    await page.goto(managerUrl, { waitUntil: 'domcontentloaded', timeout: 45_000 }).catch(() => {});
    await page.waitForTimeout(5_000);
    const current = await page.evaluate(() => {
      const body = (document.body.innerText || '').replace(/\u00a0/g, ' ');
      const m = body.match(/00:\d\d\n([^\n]+)/);
      return m ? m[1] : '';
    });
    console.log(JSON.stringify({ ok: Boolean(current), mid, after: text, current, ms: Date.now() - started }));
  }
} catch (error) {
  console.log(JSON.stringify({ ok: false, mid, reason: String(error?.message ?? error), ms: Date.now() - started }));
  process.exitCode = 2;
} finally {
  if (browser) await closeBrowser(browser.context, browser.remote, browser.preexisting).catch(() => {});
}