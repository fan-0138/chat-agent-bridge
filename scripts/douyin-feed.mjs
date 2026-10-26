#!/usr/bin/env node
/**
 * 抖音「刷一下」：用登录态的 Edge 真浏览器刷推荐流，把看到的视频抓成结构化数据。
 *
 *   node scripts/douyin-feed.mjs                      # 刷 8 屏，打印 20 条（人读格式）
 *   node scripts/douyin-feed.mjs --json               # 同上，输出 JSON（给程序用）
 *   node scripts/douyin-feed.mjs --cached --limit 5   # 不启动浏览器，读上次刷到的缓存（毫秒级）
 *   node scripts/douyin-feed.mjs --comments 3         # 额外打开 3 条视频，抓热门评论
 *   node scripts/douyin-feed.mjs --visible            # 窗口放在屏幕中间（调试用）
 *   node scripts/douyin-feed.mjs --scroll 15 --limit 30
 *
 * 原理：不逆向签名。让真浏览器自己发请求，我们只监听 /aweme/v1/web/... 的响应，
 * 把 JSON 直接读出来 —— a_bogus / msToken / __ac_nonce 全部由浏览器自己算。
 */

import { appendFile, readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { launch, openBrowser, closeBrowser, stealth, isLoggedIn, likeVideo, pause, humanScroll, ensureDirs, hideBrowserWindow, PROFILE_DIR, STATE_DIR } from './lib/douyin-browser.mjs';
import { scoreItem } from '../src/life.js';
import { collectCandidates } from './lib/douyin-collect.js';
import { rank as rankCandidates } from '../src/douyin-score.js';

const CACHE_FILE = resolve(STATE_DIR, 'seen.jsonl');
const LATEST_FILE = resolve(STATE_DIR, 'latest.json');
// 「已经给她看过的视频」：同一批内容别反复喂给她，否则她会把同一个视频反复讲给主人听
const TOLD_FILE = resolve(STATE_DIR, 'told.json');
const TOLD_HOURS = Number(process.env.DOUYIN_TOLD_HOURS || 24);

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const option = (name, fallback) => {
  const index = argv.indexOf(name);
  return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback;
};

const AS_JSON = flag('--json');
const CACHED = flag('--cached');
const VISIBLE = flag('--visible');
const SCROLLS = Number(option('--scroll', 8));
const LIMIT = Number(option('--limit', 20));
const COMMENTS = Number(option('--comments', 0));
// 点赞：在同一次会话里点掉，避免再开一次浏览器
const LIKE = Number(option('--like', 0));
const SKIP_IDS = new Set(String(option('--skip', '')).split(',').filter(Boolean));
const SHOW_ALL = flag('--all');

/* ────────────────────────── 缓存读写 ────────────────────────── */

async function readCache() {
  if (!existsSync(CACHE_FILE)) return [];
  const raw = await readFile(CACHE_FILE, 'utf8');
  const items = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      items.push(JSON.parse(trimmed));
    } catch {
      /* 坏行忽略：缓存是日志式的，不值得为一行崩掉 */
    }
  }
  return items;
}

async function appendCache(items) {
  ensureDirs();
  const lines = items.map((item) => JSON.stringify({ ...item, seenAt: new Date().toISOString() })).join('\n');
  await appendFile(CACHE_FILE, `${lines}\n`, 'utf8');
  await writeFile(LATEST_FILE, `${JSON.stringify(items, null, 2)}\n`, 'utf8');
  // 缓存只留最近 1500 行，防止无限增长
  const all = await readCache();
  if (all.length > 1_500) {
    const keep = all.slice(-1_500).map((item) => JSON.stringify(item)).join('\n');
    await writeFile(CACHE_FILE, `${keep}\n`, 'utf8');
  }
}

/** 已经给她看过的视频（id -> 时间戳），超过 TOLD_HOURS 自动过期。 */
async function loadTold() {
  try {
    const data = JSON.parse(await readFile(TOLD_FILE, 'utf8'));
    return data && typeof data.ids === 'object' ? data.ids : {};
  } catch {
    return {};
  }
}

async function saveTold(ids) {
  const cutoff = Date.now() - TOLD_HOURS * 3_600_000;
  const kept = Object.entries(ids)
    .filter(([, ts]) => Number(ts) > cutoff)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 300);
  ensureDirs();
  await writeFile(TOLD_FILE, `${JSON.stringify({ ids: Object.fromEntries(kept) }, null, 2)}\n`, 'utf8');
}

/** 过滤掉最近给她看过的；剩下的标记为看过，避免下一轮又端上来。 */
async function filterAndMark(items) {
  if (SHOW_ALL) return { items, hidden: 0 };
  const ids = await loadTold();
  const now = Date.now();
  const kept = items.filter((item) => !(item.id && ids[item.id]));
  for (const item of kept) if (item.id) ids[item.id] = now;
  await saveTold(ids).catch(() => {});
  return { items: kept, hidden: items.length - kept.length };
}

/** 最近 N 条不重复的视频（新的在前）。 */
function latestUnique(entries, limit) {
  const seen = new Set();
  const out = [];
  for (let i = entries.length - 1; i >= 0 && out.length < limit; i -= 1) {
    const item = entries[i];
    if (!item?.id || seen.has(item.id)) continue;
    seen.add(item.id);
    out.push(item);
  }
  return out;
}

/* ────────────────────────── 数据规整 ────────────────────────── */

const AD_HINTS = ['广告', '商品', '直播间', '下单', '小黄车'];

function normalize(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = raw.aweme_id || raw.awemeId;
  if (!id) return null;

  const stats = raw.statistics ?? {};
  const desc = String(raw.desc ?? '').replace(/\s+/g, ' ').trim();
  const duration = Math.round((raw.video?.duration ?? raw.duration ?? 0) / 1000) || 0;
  const isLive = Boolean(raw.live_info) || raw.aweme_type === 101 || raw.aweme_type === 1001;
  const isAd = Boolean(raw.ad_brand_info) || AD_HINTS.some((hint) => desc.includes(hint));

  const tags = (raw.text_extra ?? [])
    .map((extra) => extra?.hashtag_name)
    .filter(Boolean)
    .slice(0, 4);

  return {
    id: String(id),
    desc,
    author: raw.author?.nickname ?? '',
    authorId: raw.author?.unique_id || raw.author?.short_id || '',
    likes: Number(stats.digg_count ?? 0),
    comments: Number(stats.comment_count ?? 0),
    shares: Number(stats.share_count ?? 0),
    collects: Number(stats.collect_count ?? 0),
    duration,
    tags,
    music: raw.music?.title ?? '',
    cover: raw.video?.cover?.url_list?.[0] ?? raw.video?.origin_cover?.url_list?.[0] ?? '',
    url: `https://www.douyin.com/video/${id}`,
    isLive,
    isAd,
    // 刷到的时候可能已经是「看过的」状态，但不影响
    createdAt: raw.create_time ? new Date(raw.create_time * 1000).toISOString() : '',
  };
}

function isWorthKeeping(item) {
  if (!item) return false;
  if (item.isLive || item.isAd) return false;
  if (!item.desc || item.desc.length < 4) return false;
  if (item.duration > 0 && item.duration < 5) return false;
  return true;
}

/* ────────────────────────── 浏览器抓取 ────────────────────────── */

const FEED_PATTERNS = [
  '/aweme/v1/web/tab/feed/',
  '/aweme/v1/web/module/feed/',
  '/aweme/v2/web/module/feed/', // 2026 年线上实际用的是 v2
  '/aweme/v1/web/multi/aweme/detail/',
  '/aweme/v1/web/aweme/post/',
  '/aweme/v1/web/channel/feed/',
  '/aweme/v2/web/channel/feed/',
  '/aweme/v1/web/general/search/single/',
  '/aweme/v2/web/general/search/single/',
];

/** 不同接口把视频列表放在不同字段里。 */
const LIST_KEYS = ['aweme_list', 'aweme_details', 'data', 'aweme_detail_list'];

function pickList(json) {
  for (const key of LIST_KEYS) {
    const value = json?.[key];
    if (Array.isArray(value) && value.length > 0) return value;
  }
  // 部分接口是 { data: { aweme_list: [...] } }
  if (json?.data && typeof json.data === 'object' && !Array.isArray(json.data)) {
    for (const key of LIST_KEYS) {
      const value = json.data[key];
      if (Array.isArray(value) && value.length > 0) return value;
    }
  }
  return [];
}

/**
 * 快路采集：页面内 fetch → 归一化 → 打分。
 * 失败返回空，交给滚屏兜底。
 */
async function collectFast(page) {
  const startedAt = Date.now();
  try {
    const { awemes, meta } = await collectCandidates(page, { pages: 3, pause: () => new Promise((r) => setTimeout(r, 350)) });
    const { items, dropped } = rankCandidates(awemes, {
      limit: LIMIT,
      seenIds: [...SKIP_IDS],
      maxLikes: 2_000_000, // 太爆的不是「刚刷到的」
      maxAgeHours: 24 * 7, // 一周前的不是「新鲜事」
    });
    if (items.length > 0) {
      console.error(`  采集源：${JSON.stringify(meta)}`);
      console.error(`  硬筛跳过：${JSON.stringify(dropped)}`);
    }
    return {
      items: items.map((item) => ({ ...item, url: item.webUrl, tags: item.tags })),
      rawCount: awemes.length,
      startedAt,
    };
  } catch (error) {
    console.error(`  快路异常：${error?.message ?? error}`);
    return { items: [], rawCount: 0, startedAt };
  }
}

async function browse() {
  const { context, remote, preexisting } = await openBrowser({ offscreen: !VISIBLE });
  if (!VISIBLE && !remote) hideBrowserWindow(PROFILE_DIR);
  const collected = new Map();

  try {
    // 远程模式（连桥接的浏览器）必须自己开页：拿别人那页会互相踩
  const page = remote ? await context.newPage() : (context.pages()[0] ?? (await context.newPage()));
    await stealth(page);

    const login = await isLoggedIn(context);
    if (!login.loggedIn) {
      console.error('⚠️  没有登录态：刷出来的是游客推荐流，而且很快会弹登录框。');
      console.error('   先跑 node scripts/douyin-login.mjs 扫码登录。');
    }

    page.on('response', (response) => {
      const url = response.url();
      if (!FEED_PATTERNS.some((pattern) => url.includes(pattern))) return;
      if (response.status() !== 200) return;
      response
        .json()
        .then((json) => {
          for (const raw of pickList(json)) {
            const item = normalize(raw);
            if (isWorthKeeping(item) && !collected.has(item.id)) collected.set(item.id, item);
          }
        })
        .catch(() => {});
    });

    if (!(remote && page.url().includes('douyin.com'))) {
      await page.goto('https://www.douyin.com/', { waitUntil: 'domcontentloaded' });
      await pause(2_000, 3_000);
    }

    // ① 快路：在页面里直接调只读接口（同源 + 真 cookie + 真 TLS 指纹，不需要签名）
    const fast = await collectFast(page);
    if (fast.items.length > 0) {
      console.error(`快路采集：${fast.rawCount} 条原始 → ${fast.items.length} 条可用（${Date.now() - fast.startedAt}ms）`);
      return { items: fast.items, loggedIn: login.loggedIn, liked: [] };
    }
    console.error('快路没拿到候选，退回滚屏采集');

    // 关掉可能出现的「打开 App」引导条，它会挡住滚动
    await page
      .locator('text=以后再说, [class*="close"], [aria-label="关闭"]')
      .first()
      .click({ timeout: 1_500 })
      .catch(() => {});

    for (let i = 0; i < SCROLLS; i += 1) {
      // 鼠标挪到视频区域再滚，避免滚到侧栏
      await page.mouse.move(640, 480).catch(() => {});
      await humanScroll(page, { steps: 2, minPx: 400, maxPx: 1_100 });
      await pause(800, 1_800);
      if (collected.size >= LIMIT * 2) break;
    }

    // 兜底：如果接口没被拦截到（比如换了接口路径），退化成 DOM 解析
    if (collected.size === 0) {
      const domItems = await page
        .evaluate(() => {
          // 卡片不一定是 <a>，href 也可能是 //www.douyin.com/video/... 这种协议相对地址
          const nodes = [...document.querySelectorAll('[href*="/video/"]')];
          return nodes.slice(0, 60).map((node) => {
            const href = node.getAttribute('href') || '';
            const match = href.match(/\/video\/(\d+)/);
            return { id: match?.[1], desc: (node.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 120) };
          });
        })
        .catch(() => []);
      for (const raw of domItems) {
        if (!raw.id) continue;
        const item = normalize({
          aweme_id: raw.id,
          desc: raw.desc || '(无标题)',
          statistics: {},
          author: {},
          video: {},
        });
        if (isWorthKeeping(item) && !collected.has(item.id)) collected.set(item.id, item);
      }
      if (collected.size > 0) console.error('（接口拦截没命中，已退化为页面解析：信息会少一些）');
    }

    const items = [...collected.values()].slice(0, LIMIT);

    if (COMMENTS > 0 && items.length > 0) {
      const targets = items.slice(0, COMMENTS);
      for (const item of targets) {
        item.topComments = await grabComments(page, item.id);
        await pause(2_500, 5_000); // 看视频的节奏，别一条接一条
      }
    }

    // 点赞：只点这一轮刚刷到、评分靠前的那几条
    let liked = [];
    if (LIKE > 0 && items.length > 0) {
      const candidates = items
        .filter((item) => !SKIP_IDS.has(item.id))
        .map((item) => ({ item, score: scoreItem(item) }))
        .sort((a, b) => b.score - a.score)
        .slice(0, Math.max(1, LIKE));
      for (const { item } of candidates) {
        const result = await likeVideo(page, item.url);
        liked.push({ id: item.id, ok: result.ok, strategy: result.strategy ?? result.reason });
        await pause(2_500, 5_000); // 看一会儿再点下一条
      }
      if (liked.length > 0) console.error(`点赞：${liked.filter((l) => l.ok).length}/${liked.length} 成功`);
    }

    if (items.length > 0) await appendCache(items);
    return { items, loggedIn: login.loggedIn, liked };
  } finally {
    await closeBrowser(context, remote, preexisting);
  }
}

async function grabComments(page, awemeId) {
  const bucket = [];
  const handler = (response) => {
    if (!response.url().includes('/aweme/v1/web/comment/list/')) return;
    response
      .json()
      .then((json) => {
        for (const raw of json?.comments ?? []) {
          const text = String(raw?.text ?? '').replace(/\s+/g, ' ').trim();
          if (text) bucket.push({ text, likes: Number(raw?.digg_count ?? 0) });
        }
      })
      .catch(() => {});
  };
  page.on('response', handler);
  try {
    await page.goto(`https://www.douyin.com/video/${awemeId}`, { waitUntil: 'domcontentloaded' });
    await pause(3_000, 5_000);
    await humanScroll(page, { steps: 2, minPx: 300, maxPx: 700 });
    await pause(1_500, 3_000);
  } catch {
    /* 单条失败不影响整体 */
  } finally {
    page.off('response', handler);
  }
  return bucket.sort((a, b) => b.likes - a.likes).slice(0, 6);
}

/* ────────────────────────── 输出 ────────────────────────── */

function printHuman(items, { loggedIn, hidden = 0 } = {}) {
  if (items.length === 0) {
    console.log('什么也没刷到（可能是没登录、被风控、或者页面结构变了）。');
    return;
  }
  const when = new Date().toLocaleTimeString('zh-CN', { hour12: false });
  console.log(`刷到 ${items.length} 条（${when}）${loggedIn === false ? ' [游客模式]' : ''}${hidden > 0 ? `（另有 ${hidden} 条之前看过，已隐藏）` : ''}`);
  items.forEach((item, index) => {
    const meter = item.likes >= 10_000 ? `${(item.likes / 10_000).toFixed(1)}万赞` : `${item.likes}赞`;
    const flags = [item.isAd ? '广告' : '', item.isLive ? '直播' : ''].filter(Boolean).join('/');
    console.log('');
    console.log(`${String(index + 1).padStart(2)}. ${item.desc}`);
    console.log(`    @${item.author || '未知'}  ·  ${meter}  ·  评论 ${item.comments}  ${flags ? `· ${flags}` : ''}`);
    if (item.tags?.length) console.log(`    话题：${item.tags.map((tag) => `#${tag}`).join(' ')}`);
    console.log(`    ${item.url}`);
    if (item.topComments?.length) {
      console.log('    热评：');
      for (const comment of item.topComments.slice(0, 4)) {
        console.log(`      · ${comment.text.slice(0, 80)}${comment.likes ? `（${comment.likes}赞）` : ''}`);
      }
    }
  });
}

async function main() {
  await mkdir(STATE_DIR, { recursive: true }).catch(() => {});

  if (CACHED) {
    const entries = await readCache();
    const picked = latestUnique(entries, LIMIT);
    if (picked.length === 0) {
      console.log('缓存是空的。先跑一次 node scripts/douyin-feed.mjs 真刷一遍。');
      process.exit(2);
    }
    const { items, hidden } = await filterAndMark(picked);
    if (items.length === 0) {
      if (AS_JSON) console.log(JSON.stringify([]));
      else console.log(`最近 ${TOLD_HOURS} 小时刷到的这几条都已经看过/说过了，换个时间再刷。（要全都看加 --all）`);
      return;
    }
    if (AS_JSON) console.log(JSON.stringify(items, null, 2));
    else printHuman(items, { loggedIn: true, hidden });
    return;
  }

  const { items, loggedIn, liked } = await browse();
  const { items: fresh, hidden } = await filterAndMark(items);

  if (AS_JSON) {
    console.log(JSON.stringify({ loggedIn, count: fresh.length, hidden, items: fresh, liked }, null, 2));
  } else {
    printHuman(fresh, { loggedIn, hidden });
  }
  if (fresh.length === 0) process.exit(2);
}

main().catch((error) => {
  console.error(`刷抖音失败：${error?.message ?? error}`);
  process.exit(1);
});