/**
 * 抖音浏览器底座：用本机 Edge（Chromium 内核）开一个「有头、几乎无自动化痕迹」的持久化 profile。
 *
 * 为什么不用无头：
 *  - 抖音有 CDP 探测、navigator.webdriver、headless UA、字体/WebGL 特征；
 *    无头在本机跑得通，但被判定为自动化的概率明显更高。
 *  - 有头窗口用一个离屏坐标（--window-position=-2400）藏在屏幕外，
 *    人看不见、但渲染链路是真的，风险最低。
 *
 * 为什么不用纯 HTTP：
 *  - www.douyin.com 有 __ac_nonce 反爬墙（直接 fetch 只会拿到 72KB 挑战页）；
 *    真实接口还要求 a_bogus / msToken 签名，逆向前端签名等于天天跟着抖音更新。
 *  - 让真浏览器自己发请求、我们只读响应（见 douyin-feed.mjs 的 response 拦截），
 *    签名问题就不存在了。
 *
 * 登录态存在 data/douyin-profile/（整个 profile 目录，不是单个 cookie 文件），
 * 所以设备指纹、localStorage、IndexedDB 都是连续的 —— 换了 cookie 文件却不换设备指纹，
 * 反而更容易被判定异常。
 */

import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

/** 桥接项目根目录（scripts/lib/ 往上两级），不依赖 cwd。 */
export const ROOT = resolve(import.meta.dirname, '..', '..');

export const PROFILE_DIR = resolve(ROOT, 'data/douyin-profile');

/**
 * 如果设了 QQ_DOUYIN_CDP_URL（比如 http://127.0.0.1:9222），就连虚拟机里的 chromium，
 * 而不是在本机开 Edge。本机桌面因此完全不会出现窗口。
 */
export const CDP_URL = process.env.QQ_DOUYIN_CDP_URL?.trim() || '';
/**
 * 本机模式（不连虚拟机）时我们也开一个调试端口：
 * 桥接常驻着浏览器的时候，别的脚本（读通知、点赞、看视频…）直接连上来就行，
 * 不用再启动第二个实例 —— 同一个 user-data-dir 是开不了两个进程的。
 */
export const HOST_CDP_URL = process.env.QQ_DOUYIN_HOST_CDP?.trim() || 'http://127.0.0.1:9223';
/**
 * 无头模式的 UA：Chromium 无头默认会带 "HeadlessChrome"，抖音一眼看穿。
 * 用真实 Edge 的 UA 盖掉，再把 webdriver/plugins 之类补上，实测能正常登录、能开私信面板。
 */
export const STEALTH_UA =
  process.env.QQ_DOUYIN_UA?.trim() ||
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36 Edg/156.0.4314.42';
export const STATE_DIR = resolve(ROOT, 'data/douyin');

const BASE_ARGS = [
  '--disable-blink-features=AutomationControlled',
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-infobars',
  '--disable-features=Translate,MediaRouter,OptimizationHints',
  '--disable-sync',
  '--disable-background-networking',
  '--no-service-autorun',
  '--password-store=basic',
];

/** 抖音判定「已登录」的 cookie 名（有任意一个且非空即算）。 */
const LOGIN_COOKIES = ['sessionid', 'sessionid_ss', 'sid_tt', 'sid_guard'];

export function ensureDirs() {
  mkdirSync(PROFILE_DIR, { recursive: true });
  mkdirSync(STATE_DIR, { recursive: true });
}

/**
 * @param {{ offscreen?: boolean, headless?: boolean, viewport?: {width:number,height:number}|null }} [options]
 */
export async function launch(options = {}) {
  ensureDirs();
  const { offscreen = false, headless = false, viewport = null } = options;

  const args = [...BASE_ARGS, '--remote-debugging-port=9223'];
  if (offscreen) {
    // 屏幕外渲染：不打扰用户，但仍是完整的有头浏览器
    args.push('--window-position=-2400,-2400', '--window-size=1600,1000');
  } else {
    args.push('--window-position=80,80', '--window-size=1280,900');
  }

  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    channel: 'msedge',
    headless,
    // 无头时必须把 UA 换成真的（默认会带 HeadlessChrome）
    ...(headless ? { userAgent: options.userAgent ?? STEALTH_UA } : {}),
    viewport,
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
    colorScheme: 'light',
    args,
    // 去掉 --enable-automation：它会给页面留 navigator.webdriver=true 和顶部提示条
    ignoreDefaultArgs: ['--enable-automation'],
    timeout: 60_000,
  });

  context.setDefaultTimeout(30_000);
  context.setDefaultNavigationTimeout(45_000);
  return context;
}

/**
 * 把「这一次启动的」Edge 进程隐藏起来（不进屏幕、不抢焦点）。
 *
 * 为什么需要这一步：macOS 会把完全离屏的窗口强行拉回可见区域，
 * --window-position=-3000 实测会被改写成 (0,25)。用 System Events 按 **PID**
 * 把那个进程设成 invisible 才真的看不见，且实测隐藏后页面 visibilityState
 * 仍是 visible，DOM 读写和点击都不受影响。
 *
 * 注意：只隐藏我们自己的进程，不会动用户自己开的 Edge。
 */
export function hideBrowserWindow(profileDir) {
  try {
    const out = execFileSync(
      'bash',
      ['-lc', `ps -axo pid,command | grep 'MacOS/Microsoft Edge' | grep -F -- '--user-data-dir=${profileDir}' | grep -v grep | head -1 | awk '{print $1}'`],
      { encoding: 'utf8', timeout: 5_000 },
    ).trim();
    if (!out) return false;
    execFileSync(
      'osascript',
      ['-e', `tell application "System Events" to set visible of (first process whose unix id is ${out}) to false`],
      { timeout: 8_000 },
    );
    return true;
  } catch {
    return false;
  }
}

/** 只关「自己开的」页面：连上来时已经存在的页面是别人的（桥接的私信页就在里面） */
export function pagesToClose(preexisting, current) {
  const keep = preexisting ?? new Set();
  return (current ?? []).filter((page) => !keep.has(page));
}

/**
 * 打开一个可用浏览器，返回 { context, remote }。
 *  - remote=false：本机新开一个 Edge（用完要 context.close()）
 *  - remote=true ：连虚拟机里常驻的 chromium（不能 close，只关自己开的 page）
 *
 * @param {{ offscreen?: boolean, headless?: boolean, viewport?: any, cdpUrl?: string }} [options]
 */
export async function openBrowser(options = {}) {
  const url = options.cdpUrl ?? CDP_URL;
  if (url) {
    const browser = await chromium.connectOverCDP(url, { timeout: 60_000 });
    const context = browser.contexts()[0] ?? (await browser.newContext());
    context.setDefaultTimeout(30_000);
    context.setDefaultNavigationTimeout(45_000);
    return { context, remote: true, browser, preexisting: new Set(context.pages()) };
  }
  // 本机模式：如果桥接已经开着浏览器（9223 在听），直接连上去，别再起第二个实例
  if (!options.forceLaunch) {
    try {
      const browser = await chromium.connectOverCDP(HOST_CDP_URL, { timeout: 3_000 });
      const context = browser.contexts()[0] ?? (await browser.newContext());
      context.setDefaultTimeout(30_000);
      context.setDefaultNavigationTimeout(45_000);
      return { context, remote: true, browser, preexisting: new Set(context.pages()) };
    } catch {
      // 没人在听 → 自己起
    }
  }
  const context = await launch(options);
  return { context, remote: false, browser: null, preexisting: new Set() };
}

/**
 * 收尾：远程模式只关自己开的页面 + 断开 CDP 连接，本机模式直接关浏览器。
 *
 * 两个坑，都是真踩过的：
 *  1. 断开连接不能省：`connectOverCDP` 的 websocket 会一直挂着事件循环，脚本跑完
 *     不 process.exit 就永远退不出去（实测挂 4 分钟，被调用方按超时杀掉）。
 *     实测 `browser.close()` 对 CDP 连接只是断开，不会关掉桥接正在用的那个浏览器。
 *  2. 不能顺手关掉「所有」页面：连接时已经开着的页面属于桥接（私信页），
 *     全关掉会让桥接以为浏览器挂了、然后疯狂重连失败。只关自己新开的。
 */
export async function closeBrowser(context, remote, preexisting) {
  if (!context) return;
  if (remote) {
    for (const page of pagesToClose(preexisting, context.pages())) await page.close().catch(() => {});
    await context.browser()?.close().catch(() => {});
    return;
  }
  await context.close().catch(() => {});
}

/** 页面级补丁：抹掉剩下的自动化指纹。 */
export async function stealth(page) {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    Object.defineProperty(navigator, 'languages', { get: () => ['zh-CN', 'zh', 'en'] });
    Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
    // 无头窗口宽度为 0 时 window.outerWidth 会和 innerWidth 相等，是常见检测点
    if (window.outerWidth === 0) {
      Object.defineProperty(window, 'outerWidth', { get: () => window.innerWidth + 16 });
      Object.defineProperty(window, 'outerHeight', { get: () => window.innerHeight + 96 });
    }
    const originalQuery = window.navigator.permissions?.query?.bind(window.navigator.permissions);
    if (originalQuery) {
      window.navigator.permissions.query = (params) =>
        params?.name === 'notifications'
          ? Promise.resolve({ state: Notification.permission })
          : originalQuery(params);
    }
  });
}

/** @param {import('playwright').BrowserContext} context */
export async function isLoggedIn(context) {
  const cookies = await context.cookies('https://www.douyin.com');
  const found = cookies.filter((c) => LOGIN_COOKIES.includes(c.name) && c.value);
  return { loggedIn: found.length > 0, names: found.map((c) => c.name) };
}

/**
 * 读一下「这个号是谁」：昵称、抖音号、粉丝数。
 * 走 /user/self 页面 —— 登录态下浏览器自己带签名，不需要我们算 a_bogus。
 * @param {import('playwright').BrowserContext} context
 */
export async function fetchSelf(context) {
  const page = await context.newPage();
  /** @type {null | {nickname:string, uid?:string, uniqueId?:string, secUid?:string, followers?:number, signature?:string}} */
  let self = null;

  const handler = (response) => {
    if (!response.url().includes('/aweme/v1/web/query/user/')) return;
    response
      .json()
      .then((json) => {
        const user = json?.user ?? json?.user_info ?? json?.data?.user;
        if (user?.nickname) {
          self = {
            nickname: user.nickname,
            uid: user.uid,
            uniqueId: user.unique_id,
            secUid: user.sec_uid,
            followers: user.follower_count,
            signature: user.signature,
          };
        }
      })
      .catch(() => {});
  };

  page.on('response', handler);
  try {
    await page.goto('https://www.douyin.com/user/self', { waitUntil: 'domcontentloaded' });
    await pause(3_000, 4_500);
    if (!self) {
      // 接口没命中就退回标题：「XXX的抖音 - 抖音」
      const title = await page.title().catch(() => '');
      const match = title.match(/^(.+?)的抖音/);
      if (match) self = { nickname: match[1].trim() };
    }
  } catch {
    /* 读不到就算了，不影响登录 */
  } finally {
    page.off('response', handler);
    await page.close().catch(() => {});
  }
  return self;
}

/**
 * 给一条视频点赞。
 * 抖音网页版的点赞按钮没有稳定 data-e2e，所以按「多选择器 + 点完验证」来：
 * 点完看 aria-pressed / class 里有没有 active，或者点赞数有没有 +1。
 * @param {import('playwright').Page} page
 */
export async function likeVideo(page, url) {
  if (!url) return { ok: false, reason: '没有给视频地址' };

  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await pause(3_000, 4_500);

  // 底部「因浏览器限制，当前为静音」会挡住点击
  await page.locator('text=打开声音').first().click({ timeout: 2_500 }).catch(() => {});
  await pause(500, 1_000);
  await page.keyboard.press('Escape').catch(() => {});
  await pause(500, 1_000);

  // 点赞成功时页面会发 /commit/item/digg/ —— 用这个响应作为唯一可信证据
  const diggHits = [];
  const handler = (response) => {
    if (response.url().includes('/commit/item/digg/')) diggHits.push(response.status());
  };
  page.on('response', handler);

  const attempts = [];
  const tried = async (label, fn) => {
    const base = diggHits.length;
    await fn().catch(() => {});
    await pause(1_400, 2_200);
    attempts.push({ label, api: diggHits.length > base, status: diggHits.at(-1) ?? null });
    return diggHits.length > base;
  };

  try {
    // ① 双击视频区域：抖音网页版沿用手机端习惯，双击＝点赞
    if (await tried('dblclick 视频', () => page.mouse.dblclick(640, 400))) {
      return { ok: true, strategy: 'dblclick', attempts };
    }

    // ② data-e2e 的点赞元素，点它自己 → 父节点 → 祖父节点（真实 handler 不一定在目标上）
    const digg = page.locator('[data-e2e="video-player-digg"], [data-e2e="feed-video-digg"]').first();
    if (await digg.count().catch(() => 0)) {
      const before = (await digg.innerText().catch(() => '')).trim();
      if (await tried('digg 元素', () => digg.click({ timeout: 5_000, force: true }))) {
        return { ok: true, strategy: 'digg', before, api: diggHits.at(-1) };
      }
      if (await tried('digg 父节点', () => digg.locator('xpath=..').click({ timeout: 5_000, force: true }))) {
        return { ok: true, strategy: 'digg-parent', before, api: diggHits.at(-1) };
      }
    }

    // ③ aria-label / 文案里带「点赞」「赞」的可点元素
    for (const selector of ['[aria-label*="点赞"]', '[aria-label*="赞"]', 'button:has-text("点赞")']) {
      const element = page.locator(selector).first();
      if (!(await element.count().catch(() => 0))) continue;
      if (await tried(`aria:${selector}`, () => element.click({ timeout: 5_000, force: true }))) {
        return { ok: true, strategy: selector, api: diggHits.at(-1) };
      }
    }

    // ④ 把页面所有带「万」的计数元素筛出来，逐个点（点赞数通常在标题附近）
    const countNodes = page.locator('[class*="digg"], [class*="Digg"], [class*="like"], [class*="Like"]');
    const total = Math.min(await countNodes.count().catch(() => 0), 6);
    for (let i = 0; i < total; i += 1) {
      const node = countNodes.nth(i);
      if (await tried(`like-node#${i}`, () => node.click({ timeout: 3_000, force: true }))) {
        return { ok: true, strategy: `like-node#${i}`, api: diggHits.at(-1) };
      }
    }
  } finally {
    page.off('response', handler);
  }

  return { ok: false, reason: '所有点法都没触发点赞', attempts };
}

/** 拟人停顿：操作之间不要固定间隔。 */
export function pause(minMs = 600, maxMs = 2_200) {
  const ms = minMs + Math.random() * Math.max(0, maxMs - minMs);
  return new Promise((done) => setTimeout(done, Math.round(ms)));
}

/** 拟人滚动：分几步、每步随机距离和停顿。 */
export async function humanScroll(page, { steps = 3, minPx = 300, maxPx = 900 } = {}) {
  for (let i = 0; i < steps; i += 1) {
    const delta = Math.round(minPx + Math.random() * (maxPx - minPx));
    await page.mouse.wheel(0, delta).catch(() => {});
    await pause(500, 1_600);
  }
}

export function stamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}