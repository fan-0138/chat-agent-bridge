#!/usr/bin/env node
/**
 * 在她自己的作品评论区里，**在别人的评论底下回复**（楼中楼）。
 *
 *   node scripts/douyin-reply-ui.mjs --url https://www.douyin.com/video/xxx \
 *        --match "钓鱼钓鱼" --text "爸爸别钓了" [--dry-run]
 *
 * 为什么走 UI 不走接口：评论回复接口（reply_id/reply_to_reply_id）实测回 ok + cid，
 * 但评论区里查不到（2026-11-06 我核过三次：UI、评论列表、楼中楼接口都为空）。
 * 走界面「回复」→ 输入 → 回车，落地的就是楼中楼，看得见。
 *
 * 2026-11-06 修：回车之后的「发没发出去」原来只看页面文字，会误判（19:21 那次页面没刷新
 * 就判 false，其实真的没上去；再想补又没人管）。现在改成 **问服务器**：拉 comment/list，
 * 在目标评论的楼中楼里找自己那一条 —— 找得到才算成功，找不到自动重试一次。
 *
 * --match 是被回复那条评论的文字片段（我们手里只有 text，没有 UI 里的定位 id）。
 */
import { existsSync } from 'node:fs';
import { appendFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { CDP_URL, openBrowser, closeBrowser, stealth } from './lib/douyin-browser.mjs';

// 自己读 .env.qq：不读的话拿不到登录态相关配置，会误以为没浏览器去新起一个
if (existsSync('.env.qq') && typeof process.loadEnvFile === 'function') {
  try {
    process.loadEnvFile('.env.qq');
  } catch {
    /* 读不到就按默认来 */
  }
}

const argv = process.argv.slice(2);
const option = (name, fallback = '') => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const has = (name) => argv.includes(`--${name}`);

const root = resolve(import.meta.dirname, '..');
const url = option('--url');
const match = option('--match');
const text = option('--text');
const nid = option('--nid');
const why = option('--why');
const dry = has('dry-run');
const recordFile = resolve(root, 'data/mind/comments.jsonl');
const started = Date.now();
const awemeId = url.match(/\/video\/(\d+)/)?.[1] ?? '';

if (!url || !match || !text) {
  console.error('用法：douyin-reply-ui.mjs --url <视频> --match "被回复评论的片段" --text "回复内容" [--dry-run] [--nid 通知id] [--why 为什么]');
  process.exit(2);
}

const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const squeeze = (value) => String(value ?? '').replace(/\s+/g, '');
const needle = squeeze(match).slice(0, 10);
const mine = squeeze(text).slice(0, 8);

let browser = null;

try {
  browser = await openBrowser({ offscreen: true, cdpUrl: process.env.QQ_DOUYIN_CDP_URL?.trim() || CDP_URL || 'http://127.0.0.1:9223' });
  const { context, remote } = browser;
  const page = remote ? await context.newPage() : (context.pages()[0] ?? (await context.newPage()));
  await stealth(page);
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
  await pause(5_000);

  // 评论在右侧栏，滚一下让它加载
  await page.mouse.move(900, 500).catch(() => {});
  for (let i = 0; i < 3; i += 1) {
    await page.mouse.wheel(0, 380).catch(() => {});
    await pause(900);
  }

  /** 找到被回复那条评论的「回复」按钮 → 点开 → 返回输入框坐标 */
  const openReplyBox = async () => {
    const spot = await page.evaluate((needleText) => {
      const nodes = [...document.querySelectorAll('div,span,p')].filter(
        (n) => n.offsetParent && (n.textContent || '').replace(/\s+/g, '').includes(needleText),
      );
      const el = nodes.sort((a, b) => (a.textContent || '').length - (b.textContent || '').length)[0];
      if (!el) return null;
      el.scrollIntoView({ block: 'center' });
      const r = el.getBoundingClientRect();
      // 「回复」按钮就在这条评论下面那排里
      const btn = [...document.querySelectorAll('span,div')]
        .filter((n) => n.offsetParent && (n.innerText || '').trim() === '回复')
        .map((n) => {
          const b = n.getBoundingClientRect();
          return { x: b.x + b.width / 2, y: b.y + b.height / 2, top: b.y };
        })
        .filter((b) => b.top >= r.top - 12 && b.top <= r.bottom + 100)
        .sort((a, b) => a.top - b.top)[0];
      return btn ?? null;
    }, needle);

    if (!spot) throw new Error(`评论区里没找到「${match}」那条（可能在下面没加载出来）`);
    await page.mouse.click(spot.x, spot.y);
    await pause(1_500);

    const editor = await page.evaluate(() => {
      const els = [...document.querySelectorAll('[contenteditable="true"]')].filter((n) => n.offsetParent);
      // 回复框是带「回复@某人」占位的那一个；主评论框占位是「留下你的精彩评论吧」
      const el = els.find((n) => /回复\s*@/.test(n.getAttribute('data-placeholder') || n.getAttribute('placeholder') || (n.closest('div')?.innerText || ''))) ?? els[els.length - 1];
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    });
    if (!editor) throw new Error('点了「回复」但没出现输入框');
    await page.mouse.click(editor.x, editor.y);
    await pause(300);
    return editor;
  };

  /** 清掉回复框里的残留（重试时别把两次的字叠一起） */
  const clearEditor = async () => {
    await page
      .evaluate(() => {
        const els = [...document.querySelectorAll('[contenteditable="true"]')].filter((n) => n.offsetParent);
        const el = els[els.length - 1];
        if (!el) return;
        el.focus();
        const range = document.createRange();
        range.selectNodeContents(el);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
      })
      .catch(() => {});
    await page.keyboard.press('Backspace').catch(() => {});
    await pause(250);
  };

  const readEditors = () =>
    page
      .evaluate(() => {
        const els = [...document.querySelectorAll('[contenteditable="true"]')].filter((n) => n.offsetParent);
        return els.map((n) => (n.innerText || '').trim()).filter(Boolean).join(' | ');
      })
      .catch(() => '');

  /** 问服务器：目标评论的楼中楼里有没有我这条 → {cid} / {miss} / null */
  const findOnServer = () => {
    if (!awemeId) return Promise.resolve(null);
    return page
      .evaluate(
        async ({ awemeId: id, needleText, mineText }) => {
          const base = 'device_platform=webapp&aid=6383&channel=channel_pc_web';
          const q = new URLSearchParams({ aweme_id: id, count: '40', cursor: '0' });
          const ctl = new AbortController();
          const timer = setTimeout(() => ctl.abort(), 12_000);
          try {
            const res = await fetch(`https://www.douyin.com/aweme/v1/web/comment/list/?${q}&${base}`, {
              credentials: 'include',
              signal: ctl.signal,
            });
            const json = await res.json().catch(() => null);
            for (const c of json?.comments ?? []) {
              if (!(c.text || '').replace(/\s+/g, '').includes(needleText)) continue;
              const reps = Array.isArray(c.reply_comment) ? c.reply_comment : c.reply_comment ? [c.reply_comment] : [];
              const hit = reps.find((n) => (n.text || '').replace(/\s+/g, '').includes(mineText));
              if (hit) return { cid: String(hit.cid ?? ''), text: String(hit.text ?? ''), time: Number(hit.create_time ?? 0) };
              return { miss: true, replyTotal: Number(c.reply_comment_total ?? 0) };
            }
            return { noComment: true };
          } catch (error) {
            return { error: String(error?.name ?? error) };
          } finally {
            clearTimeout(timer);
          }
        },
        { awemeId, needleText: needle, mineText: mine },
      )
      .catch(() => null);
  };

  let typed = '';
  let sent = false;
  let cid = '';
  let attempts = 0;
  let lastNote = '';

  if (dry) {
    await openReplyBox();
    await page.keyboard.type(text, { delay: 20 });
    await pause(700);
    typed = await readEditors();
  } else {
    for (let attempt = 1; attempt <= 2 && !sent; attempt += 1) {
      attempts = attempt;
      await openReplyBox();
      if (attempt > 1) await clearEditor();
      await page.keyboard.type(text, { delay: 20 });
      await pause(700);
      typed = await readEditors();

      await page.keyboard.press('Enter'); // 这个输入框回车就是发送（点发送按钮也行，但按钮位置会飘）
      // 发完别只看页面文字（列表不一定刷新），问服务器最多 8 秒
      for (let i = 0; i < 4 && !sent; i += 1) {
        await pause(2_000);
        const check = await findOnServer();
        if (check?.cid) {
          sent = true;
          cid = check.cid;
        } else if (check) {
          lastNote = check.error ? `查证失败：${check.error}` : `服务器上没有（replyTotal=${check.replyTotal ?? 0}）`;
        }
      }
      if (!sent) await pause(1_000);
    }
  }

  const result = { ok: dry ? true : sent, dry, url, match, text, typed, sent, cid, attempts, note: lastNote, ms: Date.now() - started };
  console.log(JSON.stringify(result));

  if (!dry) {
    await mkdir(dirname(recordFile), { recursive: true }).catch(() => {});
    await appendFile(
      recordFile,
      `${JSON.stringify({
        at: started,
        url,
        text,
        why: why || null,
        nid: nid || null,
        mode: 'ui-reply',
        ok: sent,
        cid: cid || undefined,
        attempts,
        reason: sent ? undefined : lastNote || '没落地',
        match,
        ms: result.ms,
      })}\n`,
      'utf8',
    ).catch(() => {});
    // 真落地了才记「回过了」，否则她下一轮还会被领回同一条评论重说一遍
    if (sent && nid && nid !== 'undefined' && nid !== 'null') {
      await appendFile(
        resolve(root, 'data/douyin/replied.jsonl'),
        `${JSON.stringify({ nid: String(nid), at: Date.now(), text })}\n`,
        'utf8',
      ).catch(() => {});
    }
  }

  process.exitCode = dry || sent ? 0 : 2;
  await page.close().catch(() => {});
} catch (error) {
  console.log(JSON.stringify({ ok: false, url, match, text, reason: String(error?.message ?? error), ms: Date.now() - started }));
  process.exitCode = 2;
} finally {
  if (browser) await closeBrowser(browser.context, browser.remote, browser.preexisting).catch(() => {});
}