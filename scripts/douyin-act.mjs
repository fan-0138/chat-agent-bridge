#!/usr/bin/env node
/**
 * 抖音「动手」脚本：关注 / 回关 / 点赞 / 签名，全部在一次浏览器会话里做完。
 *
 *   node scripts/douyin-act.mjs whoami                       # 这个号是谁 + 粉丝数
 *   node scripts/douyin-act.mjs fans --limit 10              # 看粉丝列表（谁关注了她）
 *   node scripts/douyin-act.mjs follow-back --limit 1        # 回关最近关注她的人
 *   node scripts/douyin-act.mjs follow --query 1234567   # 关注指定账号（抖音号/主页链接）
 *   node scripts/douyin-act.mjs like --url https://www.douyin.com/video/xxx
 *   node scripts/douyin-act.mjs signature                    # 读当前签名
 *   node scripts/douyin-act.mjs signature --text "第七机房摸鱼专员"
 *   node scripts/douyin-act.mjs --all --follow-back --like <url> --signature "..." --text "..."
 *
 * 设计约束（别改）：
 *  - 不评论、不私信、不搜索陌生人；
 *  - 关注只允许「回关」或「显式 --query 指定」；
 *  - 点赞只针对明确给出的视频地址；
 *  - 所有动作都在同一次浏览器里，开一次窗口做完，减少被风控看到的次数。
 */

import { resolve } from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { launch, openBrowser, closeBrowser, stealth, isLoggedIn, fetchSelf, likeVideo, pause, humanScroll, STATE_DIR, stamp } from './lib/douyin-browser.mjs';
import { postComment, readComments } from './lib/douyin-comments.js';

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const option = (name, fallback) => {
  const index = argv.indexOf(name);
  return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback;
};

const SHOT_DIR = resolve(STATE_DIR, `act-${stamp()}`);
const report = { startedAt: new Date().toISOString(), steps: [] };

async function note(step, data) {
  report.steps.push({ step, at: new Date().toISOString(), ...data });
  console.error(`[${step}] ${JSON.stringify(data)}`);
}

async function shot(page, name) {
  await mkdir(SHOT_DIR, { recursive: true }).catch(() => {});
  const path = resolve(SHOT_DIR, `${name}.png`);
  await page.screenshot({ path }).catch(() => {});
  return path;
}

/* ───────────── 身份 ───────────── */

async function readSelf(page) {
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
            uniqueId: user.unique_id,
            uid: user.uid,
            secUid: user.sec_uid,
            followers: user.follower_count,
            following: user.following_count,
            signature: user.signature,
          };
        }
      })
      .catch(() => {});
  };
  page.on('response', handler);
  try {
    await page.goto('https://www.douyin.com/user/self', { waitUntil: 'domcontentloaded' });
    await pause(3_500, 5_000);
    if (!self) {
      const dom = await page.evaluate(() => {
        const match = document.documentElement.innerHTML.match(/"sec_uid":"([^"]+)"/);
        const name = document.querySelector('h1')?.innerText?.trim() ?? '';
        return { secUid: match?.[1], nickname: name };
      });
      if (dom.nickname) self = { nickname: dom.nickname, secUid: dom.secUid };
    }
  } finally {
    page.off('response', handler);
  }
  return self;
}

/* ───────────── 粉丝列表 ───────────── */

async function readFans(page, self) {
  /** @type {Array<{nickname:string, uniqueId?:string, secUid?:string, followed?:boolean}>} */
  const fans = [];
  const handler = (response) => {
    if (!response.url().includes('/follower/list')) return;
    response
      .json()
      .then((json) => {
        for (const raw of json?.followers ?? json?.user_list ?? []) {
          const user = raw?.user ?? raw;
          if (!user?.nickname) continue;
          if (fans.some((item) => item.secUid && item.secUid === user.sec_uid)) continue;
          fans.push({
            nickname: user.nickname,
            uniqueId: user.unique_id,
            secUid: user.sec_uid,
            followed: Boolean(raw?.follow_status || raw?.is_follow),
          });
        }
      })
      .catch(() => {});
  };
  page.on('response', handler);
  try {
    const target = self?.secUid ? `https://www.douyin.com/user/${self.secUid}` : 'https://www.douyin.com/user/self';
    await page.goto(target, { waitUntil: 'domcontentloaded' });
    await pause(3_000, 4_000);
    // 点「粉丝」那一栏
    const fansTab = page.locator('text=/^粉丝(\\s|\\n|$)/').first();
    if (await fansTab.count()) {
      await fansTab.click({ timeout: 6_000 }).catch(() => {});
      await pause(3_000, 4_500);
    }
    await humanScroll(page, { steps: 2, minPx: 200, maxPx: 500 });
    await pause(1_200, 2_000);
  } finally {
    page.off('response', handler);
  }
  return fans;
}

/* ───────────── 回关 ───────────── */

async function followBack(page, limit) {
  const done = [];
  const apiHits = [];
  const handler = (response) => {
    if (response.url().includes('/commit/follow/user/')) apiHits.push(response.status());
  };
  page.on('response', handler);
  try {
    for (let i = 0; i < limit; i += 1) {
      // 粉丝卡片上没回关的按钮叫「回关」，已回关的会变成「互相关注」
      const button = page
        .locator('button:has-text("回关"), button:has-text("关注")')
        .filter({ hasNotText: /已关注|互相关注/ })
        .first();
      if (!(await button.count().catch(() => 0))) break;
      const label = (await button.innerText().catch(() => '')).trim();
      const before = apiHits.length;
      await button.click({ timeout: 8_000 }).catch(() => {});
      await pause(1_800, 3_000);
      const after = (await button.innerText().catch(() => '')).trim();
      done.push({ clicked: label, after, apiCalled: apiHits.length > before });
      if (/已关注|互相关注/.test(after)) break;
    }
  } finally {
    page.off('response', handler);
  }
  return { done, apiHits };
}

/* ───────────── 关注指定账号 ───────────── */

async function followQuery(page, query) {
  const target = /^https?:\/\//.test(query)
    ? query
    : `https://www.douyin.com/search/${encodeURIComponent(query)}?type=user`;
  await page.goto(target, { waitUntil: 'domcontentloaded' });
  await pause(3_500, 5_000);
  const candidates = page.locator('button:has-text("关注")').filter({ hasNotText: '已关注' });
  const count = await candidates.count();
  if (!count) {
    await page.goto(`https://www.douyin.com/user/${query}`, { waitUntil: 'domcontentloaded' }).catch(() => {});
    await pause(3_000, 4_000);
  }
  const button = page.locator('button:has-text("关注"), div[role="button"]:has-text("关注")').filter({ hasNotText: '已关注' }).first();
  if (!(await button.count())) return { ok: false, reason: '没找到关注按钮' };
  await button.click({ timeout: 6_000 }).catch(() => {});
  await pause(1_500, 2_500);
  const after = await button.innerText().catch(() => '');
  return { ok: /已关注|互相关注/.test(after), after: after.trim() };
}

/* ───────────── 签名 ───────────── */

async function readSignature(page, self) {
  const target = self?.secUid ? `https://www.douyin.com/user/${self.secUid}` : 'https://www.douyin.com/user/self';
  await page.goto(target, { waitUntil: 'domcontentloaded' });
  await pause(2_500, 3_500);
  const text = await page
    .evaluate(() => {
      const el = [...document.querySelectorAll('div,span,p')].find((node) => {
        const cls = String(node.className || '');
        return /signature/i.test(cls) && node.innerText.trim();
      });
      return el?.innerText?.trim() ?? '';
    })
    .catch(() => '');
  return text;
}

/** 网页版找不到编辑入口时，去头像菜单的「去设置」里再试一次。 */
async function probeSettings(page) {
  await page.goto('https://www.douyin.com/user/self', { waitUntil: 'domcontentloaded' });
  await pause(3_000, 4_000);
  const avatar = page.locator('img[src*="aweme-avatar"]').first();
  await avatar.hover().catch(() => {});
  await pause(1_200, 2_000);
  const clicked = await page
    .evaluate(() => {
      const node = [...document.querySelectorAll('*')].find(
        (el) => el.children.length === 0 && (el.innerText || '').trim() === '去设置',
      );
      if (!node) return false;
      node.click();
      return true;
    })
    .catch(() => false);
  await pause(2_500, 3_500);
  const haystack = await page.evaluate(() => document.body.innerText).catch(() => '');
  return {
    clicked,
    url: page.url(),
    hasEditEntry: /编辑资料|修改资料|个人资料/.test(haystack),
    snippet: haystack.slice(0, 300),
  };
}

async function setSignature(page, text) {
  // 网页版目前没有「编辑资料」入口（2026-10 实测），这里把能试的路径都试一遍，
  // 失败就明确告诉调用方「需要手机 App 改」，不要假装成功。
  await page.goto('https://www.douyin.com/user/self', { waitUntil: 'domcontentloaded' });
  await pause(3_000, 4_000);

  const editEntry = page.locator('text=编辑资料, [data-e2e="edit-profile"], text=修改资料').first();
  if (!(await editEntry.count())) {
    const settings = await probeSettings(page);
    await note('signature:settings-probe', settings);
    return {
      ok: false,
      reason: settings.hasEditEntry
        ? '设置页里似乎有编辑入口，但没自动点开（结构变了）'
        : '网页版没有「编辑资料」入口，签名只能在手机抖音 App 改',
      text,
    };
  }

  await editEntry.click({ timeout: 8_000 }).catch(() => {});
  await pause(2_000, 3_000);
  const field = page.locator('textarea, input[placeholder*="签名"]').first();
  if (!(await field.count())) return { ok: false, reason: '打开编辑资料后没找到签名输入框', text };

  await field.fill(text).catch(() => {});
  await pause(800, 1_500);
  await page.locator('button:has-text("保存")').first().click({ timeout: 8_000 }).catch(() => {});
  await pause(2_500, 4_000);
  const current = await readSignature(page);
  return { ok: current.includes(text), applied: current, text };
}

/* ───────────── 主流程 ───────────── */

async function main() {
  // 先把「带值的开关」剔掉，剩下的裸词才是动作名
  const VALUE_FLAGS = new Set(['--url', '--text', '--query', '--limit']);
  const actions = [];
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i];
    if (item.startsWith('--')) {
      if (VALUE_FLAGS.has(item)) i += 1;
      continue;
    }
    actions.push(item);
  }
  const wanted = new Set(actions);
  const doAll = flag('--all');
  const doLike = wanted.has('like');
  const doComment = wanted.has('comment') && Boolean(option('--url', '') && option('--text', ''));
  const doReadComments = wanted.has('comments') && Boolean(option('--url', ''));
  const doFollow = wanted.has('follow') && Boolean(option('--query', ''));
  const doSignature = wanted.has('signature') || doAll;
  const doFollowBack = wanted.has('follow-back') || doAll;
  if (wanted.size === 0 && !doAll) {
    console.error('用法：whoami | fans | follow-back | follow --query X | like --url Y | signature [--text Z]');
    process.exit(1);
  }

  const { context, remote, preexisting } = await openBrowser({ offscreen: true });
  try {
    // 远程模式（连桥接的浏览器）必须自己开页：拿别人那页会互相踩
  const page = remote ? await context.newPage() : (context.pages()[0] ?? (await context.newPage()));
    await stealth(page);

    const login = await isLoggedIn(context);
    if (!login.loggedIn) {
      console.error('没有登录态，先跑 npm run douyin:login');
      process.exit(2);
    }

    let self = null;
    if (doAll || wanted.has('whoami') || wanted.has('fans') || doFollowBack || doSignature) {
      self = await readSelf(page);
      await note('whoami', self ?? { error: '读不到身份' });
      await shot(page, 'profile');
    }

    if (doAll || wanted.has('fans') || doFollowBack) {
      const fans = await readFans(page, self);
      await note('fans', { count: fans.length, fans: fans.slice(0, 10) });
      if (doFollowBack) {
        const result = await followBack(page, Number(option('--limit', 1)));
        await note('follow-back', result);
        await shot(page, 'follow-back');
      }
    }

    if (doFollow) {
      const result = await followQuery(page, option('--query', ''));
      await note('follow', result);
      await shot(page, 'follow');
    }

    if (doSignature) {
      const before = await readSignature(page, self);
      await note('signature:read', { current: before });
      const text = option('--text', '');
      if (text) {
        const result = await setSignature(page, text);
        await note('signature:write', result);
        await shot(page, 'signature');
      }
    }

    if (doLike) {
      const url = option('--url', '');
      const result = await likeVideo(page, url);
      await note('like', { url, ...result });
      await shot(page, 'like');
    }

    if (doReadComments) {
      const url = option('--url', '');
      const comments = await readComments(page, url, Number(option('--limit', 8)));
      await note('comments', { url, count: comments.length, comments: comments.slice(0, 5) });
    }

    if (doComment) {
      const url = option('--url', '');
      const result = await postComment(page, url, option('--text', ''), { mention: option('--mention', '') });
      await note('comment', { url, ...result });
      await shot(page, 'comment');
    }

    report.finishedAt = new Date().toISOString();
    report.shots = SHOT_DIR;
    console.log(JSON.stringify(report, null, 2));
  } finally {
    await writeFile(resolve(STATE_DIR, 'last-act.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8').catch(() => {});
    await closeBrowser(context, remote, preexisting);
  }
}

main().catch((error) => {
  console.error(`执行失败：${error?.message ?? error}`);
  process.exit(1);
});