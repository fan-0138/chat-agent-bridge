/**
 * 抖音私信通道：让她在抖音里也能聊天。
 *
 * 和她刷视频用的是同一个浏览器 profile（同一台「设备」），
 * 但是这个模块**常驻**：浏览器开着，每 20 秒看一眼未读私信，有新消息就用同一套人设回。
 *
 * 为什么常驻而不是每次开一个浏览器：
 *  - 私信是实时性需求，反复开浏览器又慢又容易触发风控；
 *  - 同一个会话里既读又写，消息顺序和已读状态都是浏览器自己维护的，最不容易出错。
 *
 * 风控边界：
 *  - 只回**关注了她**或她关注的人（默认），陌生人消息需要显式开启；
 *  - 每小时的回复条数有上限；
 *  - 不主动发起会话，只回。
 */

import { resolve, join } from 'node:path';
import { readFile, writeFile, mkdir, unlink, appendFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import { polish } from './decor.js';
import { UNSUPPORTED_PATTERN, assignSides, isUnsupportedMessage, pickInbound } from './douyin-side.js';
import { buildPrompt } from './prompt.js';
import { splitBubbles } from './split.js';
import { likeVideo } from '../scripts/lib/douyin-browser.mjs';
import { postComment } from '../scripts/lib/douyin-comments.js';
import { hideBrowserWindow, openBrowser, closeBrowser as closeRemoteBrowser, STEALTH_UA, HOST_CDP_URL } from '../scripts/lib/douyin-browser.mjs';
import { extractDouyinVideo, readVideoSummary, formatVideoSummary } from '../scripts/lib/douyin-video.js';
import { readNotices, pickReplyable } from '../scripts/lib/douyin-notice.js';

const INPUT_SELECTOR = '[data-placeholder="发送消息"]';
const MESSAGE_LIST = '.messageMessageListlist, [class*="messageMessageList"]';
const CONV_ITEM = '[class*="conversationConversationItemwrapper"]';

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

/** 稳定的去重键：会话 + 方向 + 文本 + 在列表里的序号。 */
function messageKey(conversation, index, side, text) {
  return `${conversation}|${index}|${side}|${text.slice(0, 60)}`;
}

/**
 * 抖音私信该用哪个记忆 key。
 *
 * 主人两边都用同一个 key（`user_private_<QQ号>`）—— 这是「同一条鱼」的关键：
 * 她在 QQ 里说的话，抖音这边也看得到，反之亦然。
 * 其他人在抖音只按名字单独存一份，别混进主人的时间线。
 */
export function conversationMemoryKey(name, config) {
  const owner = String(config?.allowList?.[0] ?? '').trim();
  const ownerName = String(config?.douyinChatSelfName ?? '主人').trim() || '主人';
  const label = String(name ?? '').trim();
  if (owner && label === ownerName) return `user_private_${owner}`;
  return `douyin_${label || 'someone'}`;
}

export function createDouyinChannel({ config, runner, persona, voice, slang, memory, log, onInbound }) {
  const profileDir = resolve(process.cwd(), 'data/douyin-profile');
  const seenFile = resolve(process.cwd(), 'data/douyin/dm-seen.json');
  const sentFile = resolve(process.cwd(), 'data/douyin/dm-sent.json');
  /** 我们自己发出去的消息文本（用来自我识别） */
  const recentSent = new Set();
  /** 视频摘要缓存：同一条链接不重复打开 */
  const videoCache = new Map();
  const historyDir = resolve(process.cwd(), 'data/douyin/dm-history');

  let context = null;
  let page = null;
  /** 浏览器是不是跑在虚拟机里（CDP 远程模式） */
  let remoteBrowser = false;
  let timer = null;
  let running = false;
  let stopped = false;
  let lastPanelWarnAt = 0;
  let lastNoticeAt = 0;
  let lastFullCheckAt = 0;
  let lastHeartbeatAt = 0;

  /** @type {Set<string>} */
  let seen = new Set();
  /** @type {{hour:number, hourCount:number, day:string, dayCount:number}} */
  const budget = { hour: -1, hourCount: 0, day: '', dayCount: 0 };
  /** 没有 memory 时的兜底：每个会话最近几轮（正常不会走到） */
  const threads = new Map();

  async function loadSeen() {
    try {
      const raw = JSON.parse(await readFile(seenFile, 'utf8'));
      seen = new Set(Array.isArray(raw) ? raw : []);
    } catch {
      seen = new Set();
    }
  }

  async function saveSeen() {
    try {
      await mkdir(join(seenFile, '..'), { recursive: true });
      await writeFile(seenFile, JSON.stringify([...seen].slice(-2_000)), 'utf8');
    } catch {
      /* 写不进去就算了，最多下次重复回一条 */
    }
  }

  function withinBudget() {
    const now = new Date();
    const hour = now.getHours();
    const day = now.toISOString().slice(0, 10);
    if (budget.day !== day) {
      budget.day = day;
      budget.dayCount = 0;
    }
    if (budget.hour !== hour) {
      budget.hour = hour;
      budget.hourCount = 0;
    }
    return budget.hourCount < config.douyinChatMaxPerHour && budget.dayCount < config.douyinChatMaxPerDay;
  }

  /* ───────────── 浏览器 ───────────── */

  async function ensureBrowser() {
    if (context && page && !page.isClosed()) return true;

    // 虚拟机模式：连过去，不在本机开任何窗口
    if (config.douyinCdpUrl) {
      try {
        const opened = await openBrowser({ cdpUrl: config.douyinCdpUrl });
        context = opened.context;
        remoteBrowser = opened.remote;
        page = context.pages()[0] ?? (await context.newPage());
        // 停在个人主页：首页会预加载大量视频，把私信面板挤得加载很慢
        await page.goto('https://www.douyin.com/user/self', { waitUntil: 'domcontentloaded' });
        await sleep(4_000);
        log.info(`抖音私信通道：已连上虚拟机浏览器（${config.douyinCdpUrl}）`);
        return true;
      } catch (error) {
        log.warn(`连虚拟机浏览器失败：${error?.message ?? error}`);
        context = null;
        page = null;
        return false;
      }
    }

    // 启动失败多半是上一个实例还没退干净、profile 被锁；退避重试，别干等 3 分钟
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const headless = config.douyinChatHeadless === true;
        context = await chromium.launchPersistentContext(profileDir, {
          channel: 'msedge',
          headless,
          // 无头：UA 换成真的 + 视口固定（没有窗口就没有视口）
          ...(headless ? { userAgent: STEALTH_UA, viewport: { width: 1600, height: 1000 } } : { viewport: null }),
          locale: 'zh-CN',
          timezoneId: 'Asia/Shanghai',
          args: [
            '--disable-blink-features=AutomationControlled',
            '--no-first-run',
            '--no-default-browser-check',
            '--disable-infobars',
            '--remote-debugging-port=9223',
            '--window-position=-3000,-3000',
            '--window-size=1600,1000',
          ],
          ignoreDefaultArgs: ['--enable-automation'],
          timeout: 60_000,
        });
        context.setDefaultTimeout(20_000);
        page = context.pages()[0] ?? (await context.newPage());
        await page.addInitScript(() => {
          Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
          // 无头浏览器默认没有插件、语言列表也可能是空的，补成正常桌面的样子
          Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
          Object.defineProperty(navigator, 'languages', { get: () => ['zh-CN', 'zh', 'en'] });
        });

        // macOS 会把离屏窗口拉回来，用 System Events 按 PID 隐藏才算真的看不见
        if (config.douyinChatHideWindow !== false) {
          const hidden = hideBrowserWindow(profileDir);
          if (config.douyinChatDebug) log.info(`隐藏浏览器窗口：${hidden ? '成功' : '失败'}`);
        }

        await page.goto('https://www.douyin.com/', { waitUntil: 'domcontentloaded' });
        await sleep(3_000);
        log.info('抖音私信通道：浏览器已就绪');
        return true;
      } catch (error) {
        log.warn(`抖音私信通道：启动浏览器失败（第 ${attempt + 1} 次）${error?.message ?? error}`);
        // profile 被锁多半是「浏览器还活着，只是我们这边连接断了」——连 9223 复用，别再起第二个
        if (await reuseExistingBrowser()) return true;
        context = null;
        page = null;
        await sleep(6_000 * (attempt + 1));
      }
    }
    return false;
  }

  /** 启动失败时的兜底：如果 9223 上已经有一个浏览器，直接连上去用 */
  async function reuseExistingBrowser() {
    try {
      const attached = await chromium.connectOverCDP(HOST_CDP_URL, { timeout: 3_000 });
      const existing = attached.contexts()[0];
      if (!existing) return false;
      existing.setDefaultTimeout(20_000);
      context = existing;
      page = existing.pages()[0] ?? (await existing.newPage());
      await page.goto('https://www.douyin.com/user/self', { waitUntil: 'domcontentloaded' });
      await sleep(4_000);
      log.info('抖音私信通道：直接复用了还开着的浏览器（9223）');
      return true;
    } catch (error) {
      log.warn(`抖音私信通道：复用现有浏览器也没成：${error?.message ?? error}`);
      return false;
    }
  }

  /** 用 CDP 把窗口挪到屏幕外，并把结果记下来。 */
  async function moveWindowOffscreen(targetPage) {
    const session = await targetPage.context().newCDPSession(targetPage);
    const { windowId } = await session.send('Browser.getWindowForTarget');
    await session.send('Browser.setWindowBounds', {
      windowId,
      bounds: { windowState: 'normal', left: -3000, top: -3000, width: 1600, height: 1000 },
    });
    const applied = await session.send('Browser.getWindowBounds', { windowId });
    if (config.douyinChatDebug) log.info(`窗口位置：${JSON.stringify(applied.bounds)}`);
    await session.detach().catch(() => {});
  }

  async function closeBrowser() {
    if (!context) return;
    if (remoteBrowser) {
      // 虚拟机里的浏览器是常驻服务，只丢掉引用，别把它关了
      context = null;
      page = null;
      return;
    }
    await context.close().catch(() => {});
    context = null;
    page = null;
  }

  /** 面板是否真的打开了：会话条目在 DOM 里不等于可见，隐藏时 innerText 是空的。 */
  async function panelReady() {
    return page
      .evaluate((selector) => {
        return [...document.querySelectorAll(selector)].some((n) => {
          const rect = n.getBoundingClientRect();
          if (rect.width < 40 || rect.height < 12) return false;
          const style = getComputedStyle(n);
          if (style.display === 'none' || style.visibility === 'hidden') return false;
          return (n.innerText ?? '').trim().length > 0;
        });
      }, CONV_ITEM)
      .catch(() => false);
  }

  async function openPanel() {
    if (await panelReady()) return true;

    // 顶栏「消息」图标：页面上可能有多处「消息」字样（正文里也有），
    // 按位置挑：右上角（x 偏右、y 很小）的那个才是入口。
    await page.waitForSelector('[data-e2e="searchbar-input"], input[placeholder*="搜索"]', { timeout: 20_000 }).catch(() => {});
    await sleep(1_500);

    const target = await page
      .evaluate(() => {
        const nodes = [...document.querySelectorAll('*')].filter((el) => {
          const t = (el.innerText || '').trim();
          if (!t.startsWith('消息') || t.length > 6) return false;
          const r = el.getBoundingClientRect();
          if (r.width < 10 || r.height < 8 || r.width > 200) return false;
          const style = getComputedStyle(el);
          return style.display !== 'none' && style.visibility !== 'hidden';
        });
        if (nodes.length === 0) return null;
        // 右上角优先：y 越小越靠上，x 越大越靠右
        nodes.sort((a, b) => {
          const ra = a.getBoundingClientRect();
          const rb = b.getBoundingClientRect();
          return ra.top - rb.top || rb.right - ra.right;
        });
        const best = nodes[0];
        const r = best.getBoundingClientRect();
        best.setAttribute('data-dsh-dm-entry', '1');
        return { count: nodes.length, x: Math.round(r.left), y: Math.round(r.top) };
      })
      .catch(() => null);

    if (!target) {
      if (config.douyinChatDebug) log.info('抖音私信：没找到顶栏「消息」入口');
      return false;
    }
    if (config.douyinChatDebug) log.info(`抖音私信：点入口 (${target.x},${target.y})，共 ${target.count} 个候选`);

    await page.locator('[data-dsh-dm-entry="1"]').first().click({ timeout: 8_000 }).catch(() => {});
    for (let wait = 0; wait < 35; wait += 1) {
      await sleep(1_000);
      if (await panelReady()) return true;
    }
    return false;
  }

  /** 「restart14分钟前」→「restart」 */
  function cleanName(raw) {
    // 标题区可能是「restart\n点亮中 1/3」这种多行，只取第一行
    const text = String(raw ?? '').split('\n')[0].trim();
    const cut = text.replace(/(刚刚|昨天|\d+分钟前|\d+小时前|\d{1,2}\/\d{1,2}).*$/, '').trim();
    return cut || text;
  }

  /** 会话列表：[{name, preview, unread}] */
  async function listConversations() {
    return page
      .evaluate((selector) => {
        // 先记下 DOM 下标再过滤：过滤后的下标和 querySelectorAll 的下标对不上，
        // 拿过滤后的下标去点，会点到隐藏节点上（点不开、也不报错）。
        const items = [];
        [...document.querySelectorAll(selector)].forEach((node, domIndex) => {
          const rect = node.getBoundingClientRect();
          if (rect.width < 40 || rect.height < 12) return;
          const style = getComputedStyle(node);
          if (style.display === 'none' || style.visibility === 'hidden') return;
          if ((node.innerText ?? '').trim().length === 0) return;
          items.push({ node, domIndex });
        });
        return items.map(({ node, domIndex }) => {
          const text = (node.innerText || '').trim();
          const lines = text.split('\n').map((line) => line.trim()).filter(Boolean);
          const titleNode = node.querySelector('[class*="conversationConversationItemtitle"]');
          const badge = node.querySelector('[class*="badge"], [class*="Badge"], [class*="count"], [class*="Count"]');
          return {
            // 注意：cleanName 是 Node 侧函数，不能在这里调用，只返回原始标题
            // domIndex 是它在 querySelectorAll 里的下标（过滤掉隐藏节点后下标会错位，点错人）
            domIndex,
            title: (titleNode?.innerText ?? lines[0] ?? '').trim(),
            avatar: (node.querySelector('img')?.src ?? '').slice(-40),
            preview: lines.slice(1).join(' ').slice(0, 60),
            unread: Number((badge?.innerText ?? '').replace(/\D/g, '')) || 0,
            text,
          };
        });
      }, CONV_ITEM)
      .then((items) =>
        items.map((item) => ({
          ...item,
          name: cleanName(item.title),
          // 用头像地址当会话身份：昵称/火花等级会变，头像不会
          key: item.avatar || cleanName(item.title),
        })),
      )
      .catch(() => []);
  }

  /**
   * 当前打开的会话里的消息，**最新的在前**（抖音私信列表是倒序）。
   *
   * 实测踩过的坑：
   *  - 消息框的选择器必须用 messageMessageBoxmessageBox，否则会把内层 row/contentBox 也算一条；
   *  - 系统提示（「你们已互相关注对方」）挂在子节点 SystemNormalSystem 上，不是外层 class；
   *  - 每条的 innerText 里混着时间标签（「18分钟前」），要取 MessageBoxContent 而不是整个框。
   */
  async function readMessages() {
    const raw = await page
      .evaluate(({ selector, unsupportedPattern }) => {
        const isUnsupported = (text) => new RegExp(unsupportedPattern).test(String(text ?? ''));
        const list = document.querySelector(selector);
        if (!list) return [];
        const bounds = list.getBoundingClientRect();
        const midX = bounds.left + bounds.width / 2;
        const boxes = [...list.querySelectorAll('[class*="messageMessageBoxmessageBox"]')];
        const out = [];
        // 一条消息在 DOM 里可能有几层都带 messageMessageBox：用 React 的 message 对象去重
        const seenObjects = new WeakSet();
        const seenFallback = new Set();

        for (const box of boxes) {
          if (box.querySelector('[class*="SystemNormalSystem"]')) continue;
          if (/isFullRowCenterMessage/.test(String(box.className))) continue;

          // ① 从 fiber 里拿到这条消息的数据对象（同一层会被多个节点共享，靠它去重）
          const fiberKey = Object.keys(box).find((key) => key.startsWith('__reactFiber$'));
          let message = null;
          if (fiberKey) {
            let fiber = box[fiberKey];
            for (let depth = 0; fiber && depth < 24; depth += 1) {
              const props = fiber.memoizedProps;
              if (props && props.message && typeof props.message === 'object' && props.message.parsedContent) {
                message = props.message;
                break;
              }
              fiber = fiber.return;
            }
          }
          if (message) {
            if (seenObjects.has(message)) continue;
            seenObjects.add(message);
          }

          // ② 正文：优先用解析后的字段，取不到再退回 innerText
          const parsed = message?.parsedContent ?? {};
          let text = String(parsed.text ?? parsed.content_title ?? '')
            .replace(/\s+/g, ' ')
            .trim();
          if (!text) {
            const content =
              box.querySelector('[class*="MessageBoxContentcolumnBox"]') ??
              box.querySelector('[class*="MessageBoxContent"]') ??
              box.querySelector('[class*="selectableRow"]');
            text = (content?.innerText ?? '')
              .replace(/\s+/g, ' ')
              .replace(/\s*(已读|未读|\d+人已读)\s*$/g, '')
              .trim();
          }
          if (!text) continue;
          if (/^(刚刚|\d+分钟前|\d+小时前|\d{1,2}\/\d{1,2}|昨天.*)$/.test(text)) continue;

          // 没有 fiber 的数据对象时（改版兜底），用文案+位置去重，别把同一条读两遍
          if (!message) {
            const top = Math.round(box.getBoundingClientRect().top);
            const fallbackKey = `${top}|${text}`;
            if (seenFallback.has(fallbackKey)) continue;
            seenFallback.add(fallbackKey);
          }

          // ③ 判方向：只认 28~48px 的正方形头像（分享卡片缩略图 108px、已读标记 20px 都排除），
          //    看它落在列表左半边还是右半边
          const rect = box.getBoundingClientRect();
          const avatar = [...box.querySelectorAll('img')].find((img) => {
            const b = img.getBoundingClientRect();
            if (b.width < 28 || b.width > 48) return false;
            if (Math.abs(b.width - b.height) > 6) return false;
            const centerY = b.top + b.height / 2;
            return centerY >= rect.top - 2 && centerY <= rect.bottom + 2;
          });
          let own = '';
          if (avatar) {
            const b = avatar.getBoundingClientRect();
            own = b.left + b.width / 2 < midX ? 'them' : 'me';
          }
          // 抖音网页版渲染不了的消息（图片/表情/语音/卡片）只显示一句占位文案，
          // 而且往往没有头像 —— 缺头像时会「继承上一条」，于是被当成自己发的，
          // 整轮就判成「对方还没回」。她只会发文字，所以这种占位一律算对方的。
          const unsupported = isUnsupported(text);
          if (unsupported && !avatar) own = 'them';

          out.push({ text, own, unsupported });
        }
        return out;
      }, { selector: MESSAGE_LIST, unsupportedPattern: UNSUPPORTED_PATTERN })
      .catch(() => []);

    // DOM 是「新的在上」，继承也从旧往新 —— 纯逻辑放在 douyin-side.js，单测盯着
    return assignSides(raw);
  }

  /**
   * 点开会话。
   *
   * 坑：Playwright 的 locator.click（连 force 也一样）**点不开**会话列表里的那一行 ——
   * 它点的是行里的子节点，React 那边的点击处理器收不到。只有**真实鼠标点到行的中心**才会打开。
   */
  async function clickConversationAt(index, name) {
    const point = await page
      .evaluate(
        ({ selector, position }) => {
          const item = document.querySelectorAll(selector)[position];
          if (!item) return null;
          const rect = item.getBoundingClientRect();
          if (rect.width < 40 || rect.height < 12) return null;
          return { x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) };
        },
        { selector: CONV_ITEM, position: index },
      )
      .catch(() => null);
    log.debug(`[dm] conv point ${JSON.stringify(point)} idx=${index}`);
    if (!point) return false;

    await sleep(800);
    await page.mouse.move(point.x, point.y).catch(() => {});
    await sleep(250);
    await page.mouse.click(point.x, point.y).catch(() => {});

    for (let wait = 0; wait < 14; wait += 1) {
      await sleep(600);
      const count = await page.locator('[class*="messageMessageBoxmessageBox"]').count().catch(() => 0);
      if (count > 0) {
        if (config.douyinChatDebug) log.info(`会话「${name}」打开成功，${count} 个消息节点`);
        return true;
      }
    }

    {
      const diag = await page
        .evaluate(({ x, y }) => {
          const at = document.elementFromPoint(x, y);
          const conv = document.querySelector('[class*="conversationConversationItemwrapper"]');
          const list = document.querySelector('[class*="messageMessageListlist"]');
          const rect = (n) => (n ? (() => { const r = n.getBoundingClientRect(); return [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)]; })() : null);
          return {
            at: at ? `${at.tagName}.${String(at.className || '').slice(0, 40)}` : null,
            convRect: rect(conv),
            listRect: rect(list),
            boxes: document.querySelectorAll('[class*="messageMessageBoxmessageBox"]').length,
            panelRect: rect(document.querySelector('[class*="conversationConversationList"]')),
          };
        }, point)
        .catch(() => ({}));
      log.debug(`[dm] after click ${JSON.stringify(diag)}`);
      void page.screenshot({ path: resolve(process.cwd(), `data/douyin/dm-open-fail-${Date.now()}.png`) }).catch(() => {});
    }
    if (config.douyinChatDebug) {
      const diag = await page
        .evaluate(() => ({
          msgBox: document.querySelectorAll('[class*="messageMessageBox"]').length,
          input: document.querySelectorAll('[data-placeholder="发送消息"]').length,
          tail: document.body.innerText.slice(-200).replace(/\n/g, '|'),
        }))
        .catch(() => ({}));
      log.info(`会话「${name}」打不开：${JSON.stringify(diag)}`);
    }
    return false;
  }

  async function openConversationByIndex(index, name) {
    return clickConversationAt(index, name);
  }

  /** 按名字打开会话（出站队列用，比如主动说一句话）。 */
  async function openConversation(name) {
    const index = await page
      .evaluate(({ selector, needle }) => {
        const items = [...document.querySelectorAll(selector)];
        return items.findIndex((item) => (item.innerText || '').includes(needle));
      }, { selector: CONV_ITEM, needle: name })
      .catch(() => -1);
    if (index < 0) return false;
    return clickConversationAt(index, name);
  }

  async function sendMessage(text) {
    const input = page.locator(INPUT_SELECTOR).first();
    if (!(await input.count().catch(() => 0))) return false;
    await input.click({ timeout: 8_000 }).catch(() => {});
    await sleep(400);

    // 分条发，像真人一次打不完
    for (const bubble of splitBubbles(text, { maxLen: config.bubbleMaxChars ?? 90, maxBubbles: config.bubbleMax ?? 3 })) {
      await page.keyboard.type(bubble, { delay: 18 + Math.random() * 40 }).catch(() => {});
      await sleep(400 + Math.random() * 900);
      await page.keyboard.press('Enter').catch(() => {});
      recentSent.add(bubble.trim());
      await sleep(1_200 + Math.random() * 1_800);
    }
    return true;
  }

  /* ───────────── 主循环 ───────────── */

  /** 读上下文：和 QQ 共用同一个 memory（同一份 JSONL），读不到才退回内存 */
  async function historyOf(name) {
    if (memory) return (await memory.load(conversationMemoryKey(name, config))).map((entry) => ({ ...entry }));
    if (!threads.has(name)) threads.set(name, []);
    return threads.get(name);
  }

  /** 写一行记录：主人的话进共享时间线，其他人的单独一份 */
  async function remember(name, role, text) {
    if (memory) {
      await memory.append(conversationMemoryKey(name, config), role, text).catch((error) => {
        log.warn(`抖音私信写记忆失败：${error?.message ?? error}`);
      });
      return;
    }
    const thread = await historyOf(name);
    thread.push({ role, text });
    if (thread.length > 12) thread.splice(0, thread.length - 12);
  }

  /** 最近发出去的内容，用来识别「最新那条其实是自己发的」。 */
  async function loadSent() {
    try {
      const raw = JSON.parse(await readFile(sentFile, 'utf8'));
      for (const text of Array.isArray(raw) ? raw : []) recentSent.add(text);
    } catch {
      /* 第一次运行没有文件 */
    }
  }

  async function saveSent() {
    try {
      await mkdir(join(sentFile, '..'), { recursive: true });
      await writeFile(sentFile, JSON.stringify([...recentSent].slice(-80)), 'utf8');
    } catch {
      /* 忽略 */
    }
  }

  /** 失败过的消息别每 90 秒重试一次：同一句话 10 分钟内只试一回 */
  const retryAfter = new Map();

  async function handleConversation(conversation) {
    const name = conversation?.name ?? '对方';
    const identity = conversation?.key ?? name;
    const list = await readMessages(); // 最新的在前
    log.debug(`[dm] msgs=${list.length} newest=${list[0]?.from}:${String(list[0]?.text ?? '').slice(0, 20)}`);
    if (list.length === 0) return;

    // 最新一条是不是对方说的：靠头像左右判方向，认不出来时才退回「这句话是不是我刚发的」
    const incoming = pickInbound(list, (text) => recentSent.has(text));
    if (!incoming) return; // 最新一条是自己发的 ⇒ 对方还没回，什么都不用做
    const newest = incoming;

    // 去重键必须带上「这条消息在第几位」——
    // 只按文本去重的话，你连发三遍「在干嘛」，第二遍就会被当成「已经回过了」直接吞掉。
    const key = `${identity}|${list.length}|${newest.text}`;
    if (seen.has(key)) {
      if (config.douyinChatDebug) log.info(`抖音私信：这句已经回过了（${list.length} 条处的「${newest.text.slice(0, 20)}」）`);
      return;
    }
    const lastFail = retryAfter.get(key) ?? 0;
    if (Date.now() - lastFail < 10 * 60_000) return;

    log.info(
      newest.unsupported
        ? `抖音私信收到（${name}）：[网页版打不开的消息类型，让他改打字]`
        : `抖音私信收到（${name}）：${newest.text.slice(0, 40)}`,
    );
    onInbound?.({ name, text: newest.text });

    if (!withinBudget()) {
      log.warn('抖音私信：已达回复上限，这次不回');
      return;
    }

    // 主人甩链接过来时，先真的点开看一眼再回
    let extra = newest.unsupported
      ? '[好友刚发来的那条消息]\n抖音网页版打不开这种消息（可能是图片、表情、语音或者分享卡片），你看不到内容。' +
        '用一句话告诉他这边没收到内容，让他用文字再说一遍；别装看过，也别问「你发的啥」重复三遍。'
      : '';
    const link = extractDouyinVideo(newest.text);
    if (link && !link.id) {
      // 分享卡片里的链接经常被截断，打不开就别硬开
      extra = '[主人发来的抖音视频]\n（链接看起来是不完整的，打不开。别装看过，问问他视频叫啥、或者让他发个能点开的链接）';
    } else if (link) {
      let summary = videoCache.get(link.id ?? link.url);
      if (!summary) {
        try {
          if (!context) await ensureBrowser();
          const videoPage = await newHiddenPage();
          try {
            summary = await readVideoSummary(videoPage, link.url);
          } finally {
            await videoPage.close().catch(() => {});
          }
          if (summary) videoCache.set(link.id ?? link.url, summary);
          log.info(`打开了主人发的视频：${summary?.desc?.slice(0, 40) ?? '(读不到)'}`);
        } catch (error) {
          log.warn(`打开主人发的视频失败：${error?.message ?? error}`);
        }
      }
      extra = summary
        ? `[主人发来的抖音视频，你已经点开看过了]\n${formatVideoSummary(summary)}\n（就这个视频跟他聊，别提「我打不开」）`
        : '[主人发来的抖音视频]\n（链接打得开但没读出内容，可以让他说说是啥）';
    }

    const history = await historyOf(name);

    const personaText = persona ? await persona().catch(() => '') : '';
    const voiceText = voice ? (await voice.load()).text : '';
    const slangText = slang ? (await slang.load()).text : '';
    const prompt = buildPrompt({
      persona: personaText,
      voice: voiceText,
      slang: slangText,
      history,
      // 占位文案别原样喂给模型，换成人话
      text: newest.unsupported ? '（发来一条网页版看不到内容的消息）' : newest.text,
      senderName: name,
      channel: 'qq',
      extra,
    });

    try {
      const { text: answer } = await runner.run(prompt);
      const recent = history
        .filter((entry) => entry.role === 'assistant')
        .map((entry) => entry.text)
        .slice(-2);
      const body = polish(String(answer).trim(), { recent, maxEmoji: config.emojiMax ?? 2 });
      if (!body) return;
      await sendMessage(body);
      // 只有真的发出去了才记 seen —— 之前是先记后发，发失败的那条就永远不再试了
      seen.add(key);
      await saveSeen();
      recentSent.add(body.trim());
      await saveSent();
      await remember(name, 'user', newest.text);
      await remember(name, 'assistant', body);
      budget.hourCount += 1;
      budget.dayCount += 1;
      log.info(`抖音私信已回复（${name}，今日第 ${budget.dayCount} 条）`);
    } catch (error) {
      retryAfter.set(key, Date.now());
      // 失败也记下对方说了什么，别让她的上下文缺一块（和 QQ 那边一致）
      await remember(name, 'user', newest.text).catch(() => {});
      log.warn(`抖音私信回复失败：${error?.message ?? error}`);
    }
  }

  /**
   * 刷一轮推荐流（在常驻浏览器里开个新标签页做，做完关掉）。
   * 常驻模式下 life.js 不能再自己开浏览器（同一个 profile 只能有一个进程），
   * 所以走请求/响应文件：data/douyin/browse-request.json → browse-result.json
   */
  async function runBrowse({ likeCount = 0 } = {}) {
    const items = new Map();
    const browsePage = await newHiddenPage();
    const handler = (response) => {
      const url = response.url();
      if (!/\/aweme\/v[12]\/web\/(module\/feed|multi\/aweme\/detail|tab\/feed)\//.test(url)) return;
      response
        .json()
        .then((json) => {
          const list = Array.isArray(json?.aweme_list) ? json.aweme_list : Array.isArray(json?.aweme_details) ? json.aweme_details : [];
          for (const raw of list) {
            const id = raw?.aweme_id;
            if (!id || items.has(id)) continue;
            if (raw.live_info || raw.ad_brand_info) continue;
            const desc = String(raw.desc ?? '').replace(/\s+/g, ' ').trim();
            if (desc.length < 4) continue;
            items.set(id, {
              id: String(id),
              desc,
              author: raw.author?.nickname ?? '',
              likes: Number(raw.statistics?.digg_count ?? 0),
              comments: Number(raw.statistics?.comment_count ?? 0),
              tags: (raw.text_extra ?? []).map((e) => e.hashtag_name).filter(Boolean).slice(0, 4),
              url: `https://www.douyin.com/video/${id}`,
              isAd: false,
              isLive: false,
            });
          }
        })
        .catch(() => {});
    };
    browsePage.on('response', handler);
    try {
      await browsePage.addInitScript(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
      });
      await browsePage.goto('https://www.douyin.com/', { waitUntil: 'domcontentloaded' });
      await sleep(3_000);
      for (let i = 0; i < 6; i += 1) {
        await browsePage.mouse.move(700, 500).catch(() => {});
        await browsePage.mouse.wheel(0, 500 + Math.random() * 600).catch(() => {});
        await sleep(900 + Math.random() * 1_200);
      }
      const list = [...items.values()];
      log.info(`抖音私信通道代刷：拿到 ${list.length} 条`);

      const liked = [];
      if (likeCount > 0 && list.length > 0) {
        const likePage = await context.newPage();
        try {
          for (const item of list.slice(0, likeCount)) {
            const result = await likeVideo(likePage, item.url);
            liked.push({ id: item.id, ok: result.ok, strategy: result.strategy ?? result.reason });
            await sleep(2_500 + Math.random() * 2_500);
          }
          log.info(`代刷顺带点赞：${liked.filter((l) => l.ok).length}/${liked.length}`);
        } finally {
          await likePage.close().catch(() => {});
        }
      }
      return { list, liked };
    } catch (error) {
      log.warn(`代刷失败：${error?.message ?? error}`);
      return { list: [], liked: [] };
    } finally {
      browsePage.off('response', handler);
      await browsePage.close().catch(() => {});
    }
  }

  /** 处理 life.js 塞进来的刷视频请求。 */
  async function handleBrowseRequest() {
    const requestFile = resolve(process.cwd(), 'data/douyin/browse-request.json');
    const resultFile = resolve(process.cwd(), 'data/douyin/browse-result.json');
    let request;
    try {
      request = JSON.parse(await readFile(requestFile, 'utf8'));
    } catch {
      return;
    }
    await writeFile(requestFile, '', 'utf8').catch(() => {});
    if (!request) return;
    const { list, liked } = await runBrowse({ likeCount: Number(request.like) || 0 });
    await writeFile(resultFile, JSON.stringify({ at: Date.now(), items: list, liked }), 'utf8').catch(() => {});
  }

  /** 处理「让她去发一条评论」的请求。 */
  async function handleCommentRequest() {
    const requestFile = resolve(process.cwd(), 'data/douyin/comment-request.json');
    const resultFile = resolve(process.cwd(), 'data/douyin/comment-result.json');
    let request;
    try {
      request = JSON.parse(await readFile(requestFile, 'utf8'));
    } catch {
      return;
    }
    await writeFile(requestFile, '', 'utf8').catch(() => {});
    if (!request?.url || !request?.text) return;

    const commentPage = await newHiddenPage();
    try {
      const result = await postComment(commentPage, request.url, request.text, {
        mention: request.mention ?? '',
        replyText: request.replyText ?? '',
      });
      log.info(`抖音评论：${result.ok ? '成功' : '失败'} ${result.reason ?? ''}`);
      await writeFile(resultFile, JSON.stringify({ at: Date.now(), ...result }), 'utf8').catch(() => {});
    } catch (error) {
      log.warn(`抖音评论失败：${error?.message ?? error}`);
      await writeFile(resultFile, JSON.stringify({ at: Date.now(), ok: false, reason: String(error?.message ?? error) }), 'utf8').catch(() => {});
    } finally {
      await commentPage.close().catch(() => {});
    }
  }

  /**
   * 互动通知：谁 @ 了她、谁评论了她。
   * 只读、便宜（页面里一次 fetch），所以每 10 分钟顺手看一眼。
   * 新的 @ 会写进 data/douyin/at-inbox.jsonl —— 主人问「有人@你吗」时她能直接查。
   */
  async function pollNotices() {
    if (!config.douyinNoticeEnabled) return;
    const interval = Math.max(1, config.douyinNoticeMin ?? 10) * 60_000;
    const now = Date.now();
    if (now - lastNoticeAt < interval) return;
    lastNoticeAt = now;

    const seenFile = resolve(process.cwd(), 'data/douyin/notices-seen.json');
    const inboxFile = resolve(process.cwd(), 'data/douyin/at-inbox.jsonl');
    /** @type {string[]} */
    let seen = [];
    try {
      const raw = JSON.parse(await readFile(seenFile, 'utf8'));
      if (Array.isArray(raw)) seen = raw.map(String);
    } catch {
      /* 第一次运行 */
    }
    const seenSet = new Set(seen);

    const report = await readNotices(page, { count: 20 }).catch(() => null);
    if (!report || report.items.length === 0) {
      if (report?.warnings?.length && config.douyinChatDebug) log.debug(`抖音通知：${report.warnings.join('；')}`);
      return;
    }

    const fresh = report.items.filter((item) => item.nid && !seenSet.has(item.nid));
    if (fresh.length === 0) return;

    const atMe = fresh.filter((item) => item.atMe);
    const replyable = pickReplyable(fresh);
    for (const item of fresh) {
      if (!item.atMe && !item.replyable) continue;
      log.info(`抖音通知：${item.typeName}（${item.nickname || '某人'}）${item.content ? `「${item.content.slice(0, 30)}」` : ''}`);
    }
    if (atMe.length > 0) log.info(`抖音通知：有 ${atMe.length} 条 @ 提到她`);

    // @ 我 的通知单独存一份，方便她之后去回
    try {
      await mkdir(join(inboxFile, '..'), { recursive: true });
      const lines = replyable.map((item) => JSON.stringify({ ...item, seenAt: now })).join('\n');
      if (lines) await appendFile(inboxFile, `${lines}\n`, 'utf8');
    } catch (error) {
      log.warn(`抖音通知：写 inbox 失败（${error?.message ?? error}）`);
    }

    try {
      const next = [...seen, ...fresh.map((item) => item.nid)].slice(-500);
      await writeFile(seenFile, JSON.stringify(next), 'utf8');
    } catch {
      /* 忽略 */
    }
  }

  /** 出站队列：别的进程/脚本想让她在抖音里说一句话，就写进这个文件。 */
  async function flushOutbox() {
    const file = resolve(process.cwd(), 'data/douyin/outbox.jsonl');
    let raw = '';
    try {
      raw = await readFile(file, 'utf8');
    } catch {
      return;
    }
    const lines = raw.split('\n').map((line) => line.trim()).filter(Boolean);
    if (lines.length === 0) return;

    const remaining = [];
    for (const line of lines) {
      let job;
      try {
        job = JSON.parse(line);
      } catch {
        continue;
      }
      if (!job?.to || !job?.text) continue;
      const ok = await openConversation(job.to);
      if (!ok) {
        log.warn(`抖音私信出站：找不到会话「${job.to}」`);
        continue;
      }
      await sendMessage(String(job.text));
      log.info(`抖音私信已发送（${job.to}）：${String(job.text).slice(0, 40)}`);
      await sleep(1_000);
    }
    await writeFile(file, remaining.map((line) => `${line}\n`).join(''), 'utf8').catch(() => {});
  }

  /**
   * 便宜的先看一眼：顶栏「消息」图标上的未读红点。
   * 这个只要读 DOM，不用开面板、不用重建页面 —— 没有红点就什么都不做。
   * 返回 -1 表示「读不到」（页面还没加载好），这时候别省，老老实实走完整流程。
   */
  async function readUnreadBadge() {
    if (!page || page.isClosed?.()) return -1;
    const value = await page
      .evaluate(() => {
        const entry = [...document.querySelectorAll('li, div')].find((element) => {
          if ((element.innerText || '').trim() !== '消息') return false;
          const rect = element.getBoundingClientRect();
          return rect.top < 90 && rect.width > 6 && rect.height > 6;
        });
        if (!entry) return -1;
        let scope = entry;
        for (let up = 0; up < 3 && scope.parentElement; up += 1) scope = scope.parentElement;
        let total = 0;
        let seenAny = false;
        for (const node of scope.querySelectorAll('[class*="badge"], [class*="Badge"], [class*="count"], [class*="Count"]')) {
          const text = (node.innerText || '').trim();
          if (!/^\d+$/.test(text)) continue;
          seenAny = true;
          total += Number(text);
        }
        if (seenAny) return total;
        // 兜底：找「消息图标附近」的角标。
        // 2026-10-26 修：角标位置会飘（实测 top≈118、left≈1553），而且右上角有个常驻的
        // 「保存登录信息」红色开关，不能当成未读。所以按「离消息图标多近」来判，
        // 数字角标和纯红点都算。
        const iconRect = entry.getBoundingClientRect();
        let loose = 0;
        let dots = 0;
        for (const node of document.querySelectorAll('span,div,i,em,sup,button')) {
          const rect = node.getBoundingClientRect();
          if (rect.width === 0 || rect.height === 0) continue;
          const cls = String(node.className || '');
          if (/trust-login|switch-button/i.test(cls)) continue;
          // 离「消息」图标不超过 160px 才算它的角标
          const dx = Math.max(0, Math.abs(rect.x + rect.width / 2 - (iconRect.x + iconRect.width / 2)) - 80);
          const dy = Math.max(0, Math.abs(rect.y + rect.height / 2 - (iconRect.y + iconRect.height / 2)) - 50);
          if (dx > 120 || dy > 140) continue;
          const text = (node.innerText || '').trim();
          let bg = '';
          try {
            bg = getComputedStyle(node).backgroundColor || '';
          } catch {
            bg = '';
          }
          const looksLikeBadge = /badge|count|dot|unread|red/i.test(cls) || /rgba?\(\s*(?:2[0-9]{2}|1[5-9][0-9])\s*,\s*(?:[0-9]{1,2})\s*,\s*(?:[0-9]{1,2})/.test(bg);
          if (!looksLikeBadge) continue;
          if (/^\d+$/.test(text)) loose += Number(text);
          else if (text === '' && rect.width <= 22 && rect.height <= 22) dots += 1;
        }
        if (loose > 0) return loose;
        return dots > 0 ? 1 : 0;      })
      .catch(() => -1);
    return typeof value === 'number' ? value : -1;
  }

  /** 出站队列里有没有等着发的话（有就必须走完整流程，因为要打开会话） */
  async function hasOutboxPending() {
    try {
      const raw = await readFile(resolve(process.cwd(), 'data/douyin/outbox.jsonl'), 'utf8');
      return raw.split('\n').some((line) => line.trim().length > 0);
    } catch {
      return false;
    }
  }

  /**
   * 开一个**全新页面**给这一轮用。
   * 实测：同一个页面用过一阵后点顶栏「消息」就不弹面板了，reload 也救不回来，
   * 只有新页面正常 —— 所以有活干的时候才开一个新的，干完就关。
   */
  /** 新开一个页面，并且**立刻把它藏起来**（否则窗口会弹到主人面前） */
  async function newHiddenPage() {
    const fresh = await context.newPage();
    if (config.douyinChatHideWindow !== false) hideBrowserWindow(profileDir);
    return fresh;
  }

  async function openPanelPage() {
    try {
      const fresh = await newHiddenPage();
      await fresh.goto('https://www.douyin.com/jingxuan', { waitUntil: 'domcontentloaded', timeout: 45_000 }).catch(() => {});
      // 等顶栏「消息」入口渲染出来（3 秒不够，实测偶尔还没有）
      for (let wait = 0; wait < 12; wait += 1) {
        const ready = await fresh
          .evaluate(() => [...document.querySelectorAll('li, div')].some((e) => (e.innerText || '').trim() === '消息' && e.getBoundingClientRect().top < 90))
          .catch(() => false);
        if (ready) break;
        await sleep(800);
      }
      await sleep(1_200);
      return fresh;
    } catch (error) {
      log.warn(`抖音私信：开新页面失败（${error?.message ?? error}）`);
      return null;
    }
  }

  /** 完整流程：开面板 → 回私信 → 处理刷视频/评论请求。调用前 page 已经指向本轮的新页面。 */
  async function runInboxRound() {
    let panelOk = await openPanel();
    if (!panelOk) {
      log.info('抖音私信：面板没打开，这个新页面再试一次');
      await sleep(1_500);
      panelOk = await openPanel();
    }
    if (!panelOk) {
      if (config.douyinChatDebug) {
        const why = await page
          .evaluate(() => ({
            url: location.href,
            needLogin: /扫码登录|手机号登录|验证码|安全验证|登录后|重新登录/.test(document.body.innerText),
            tail: document.body.innerText.slice(-120).replace(/\n/g, '|'),
          }))
          .catch(() => ({}));
        if (why?.needLogin) {
          log.error('抖音私信：登录态失效或触发安全验证 —— 跑 `npm run douyin:login` 扫码，窗口会显示在屏幕上');
        } else {
          log.info(`抖音私信：消息面板没打开 ${JSON.stringify(why)}`);
        }
      } else {
        log.debug('抖音私信：消息面板没打开，跳过这轮');
      }
      const now = Date.now();
      if (now - lastPanelWarnAt > 10 * 60_000) {
        lastPanelWarnAt = now;
        log.warn('抖音私信：消息面板连续打不开（已换过新页面重试），这轮跳过。若持续出现，看 data/douyin/dm-fail-*.png');
      }
      return false;
    }

    // 面板是滑入动画，动画没停就量坐标会算到底下的元素上（点空）
    await sleep(1_800);
    await flushOutbox();

    const conversations = await listConversations();
    log.debug(`[dm] convs=${conversations.length} ${JSON.stringify(conversations.map((c) => c.name))}`);
    if (config.douyinChatDebug) {
      log.info(`私信会话 ${conversations.length} 个：${JSON.stringify(conversations.map((c) => ({ n: c.name, u: c.unread })))}`);
    }
    if (conversations.length === 0) {
      if (config.douyinChatDebug) {
        void page.screenshot({ path: resolve(process.cwd(), `data/douyin/dm-fail-${Date.now()}.png`) }).catch(() => {});
        const diag = await page
          .evaluate(() => ({
            url: location.href,
            title: document.title,
            convNodes: document.querySelectorAll('[class*="conversationConversationItemwrapper"]').length,
            hasMsgText: [...document.querySelectorAll('*')].some((n) => (n.innerText || '').trim() === '消息'),
            body: document.body.innerText.slice(0, 160).replace(/\n/g, '|'),
          }))
          .catch(() => ({ url: 'evaluate-failed' }));
        log.info(`私信面板诊断：${JSON.stringify(diag)}`);
      }
      return true;
    }

    const allow = config.douyinChatAllowList;
    // 不依赖未读角标：角标标记不可靠，直接看最近几个会话谁最后说话
    const targets = conversations
      .map((item) => ({ ...item, index: item.domIndex ?? 0 }))
      .filter((item) => item.name && (allow.length === 0 || allow.includes(item.name)))
      .slice(0, 4);

    for (const conversation of targets) {
      const opened = await openConversationByIndex(conversation.index, conversation.name);
      log.debug(`[dm] open ${conversation.name} -> ${opened}`);
      if (!opened) continue;
      if (config.douyinChatDebug) {
        const messages = await readMessages();
        log.info(`会话「${conversation.name}」消息 ${messages.length} 条：${JSON.stringify(messages.slice(-4))}`);
      }
      await handleConversation(conversation);
    }

    await handleBrowseRequest();
    await handleCommentRequest();

    // 回到列表，别停在某个会话里
    const back = page.locator('[class*="conversationConversationList"]').first();
    if (await back.count().catch(() => 0)) await back.click({ timeout: 3_000 }).catch(() => {});
    return true;
  }

  async function tick() {
    if (running || stopped) return;
    running = true;
    try {
      if (!(await ensureBrowser())) return;
      log.debug('[dm] tick start');

      // 便宜的活先干：通知是页面里一次 fetch，10 分钟一次
      await pollNotices();

      // 心跳：10 分钟一条，顺便再确认一次窗口是藏着的（新窗口偶尔会把进程顶出来）
      if (Date.now() - lastHeartbeatAt > 10 * 60_000) {
        lastHeartbeatAt = Date.now();
        const unread = await readUnreadBadge();
        if (config.douyinChatHideWindow !== false) hideBrowserWindow(profileDir);
        log.info(`抖音私信：心跳（未读 ${unread < 0 ? '未知' : unread}）`);
      }
      log.debug('[dm] notices done');

      // 便宜路径：顶上没有未读红点、出站队列也空 → 不用开面板
      // 以前是 5 分钟强制一次：角标读不到就等于「5 分钟内不看你有没有发私信」。
      // 现在默认 25 秒一轮（tick 30 秒），角标只当加速用的旁路。
      const recheckSec = config.douyinRecheckSec ?? 25;
      const force = Date.now() - lastFullCheckAt > recheckSec * 1_000;
      if (!force) {
        const unread = await readUnreadBadge();
        if (unread === 0) {
          const pending = await hasOutboxPending();
          if (!pending) return;
        }
      }
      log.debug(`[dm] force=${force} unread=${await readUnreadBadge()}`);
      lastFullCheckAt = Date.now();

      // 先试着在当前页面干活（不新开窗口）；面板真打不开了才换新页面
      let ok = false;
      if (page && !page.isClosed()) {
        ok = await runInboxRound();
      }
      if (!ok) {
        const fresh = await openPanelPage();
        if (!fresh) return;
        const previousPage = page;
        page = fresh;
        try {
          ok = await runInboxRound();
          if (!ok) {
            await fresh.close().catch(() => {});
            page = previousPage;
          } else {
            // 新页面能用就把它留下来当常驻页，旧的关掉
            await previousPage?.close().catch(() => {});
          }
        } catch (error) {
          await fresh.close().catch(() => {});
          page = previousPage;
          throw error;
        }
      }
      log.debug(`[dm] round done ok=${ok}`);
    } catch (error) {
      log.warn(`抖音私信轮询出错：${error?.message ?? error}`);
      // 页面可能崩了，下一轮重建
      if (page?.isClosed?.()) {
        context = null;
        page = null;
      }
    } finally {
      running = false;
      // 非常驻模式：查完就关，别一直占着内存和 Dock 图标
      if (!config.douyinChatResident) await closeBrowser();
    }
  }

  return {
    start() {
      if (!config.douyinChatEnabled) {
        log.info('抖音私信：未启用');
        return;
      }
      void loadSeen();
      void loadSent();
      timer = setInterval(() => void tick(), config.douyinChatTickMs);
      timer.unref?.();
      if (config.douyinChatResident && !config.douyinCdpUrl) {
        void writeFile(resolve(process.cwd(), 'data/douyin/browser.lock'), String(process.pid), 'utf8').catch(() => {});
      }
      log.info(
        `抖音私信：开启（每 ${Math.round(config.douyinChatTickMs / 1000)} 秒查一次，每小时最多 ${config.douyinChatMaxPerHour} 条，每天 ${config.douyinChatMaxPerDay} 条）`,
      );
      void tick();
    },
    async stop() {
      stopped = true;
      if (timer) clearInterval(timer);
      await context?.close().catch(() => {});
      context = null;
      page = null;
      await unlink(resolve(process.cwd(), 'data/douyin/browser.lock')).catch(() => {});
    },
    _tick: tick,
    historyDir,
  };
}