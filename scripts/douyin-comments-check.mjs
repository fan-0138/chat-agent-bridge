#!/usr/bin/env node
/**
 * 只读探针：把她自己作品评论区的原始 JSON（含 comment/list 自带的 reply_comment 首条楼中楼）打出来。
 * 不用 comment/list/reply（那个接口会挂十几秒到几十秒，把整轮拖死）。
 *
 *   node scripts/douyin-comments-check.mjs [--works 3] [--comments 25]
 */
import { existsSync } from 'node:fs';
import { openBrowser, closeBrowser } from './lib/douyin-browser.mjs';

if (existsSync('.env.qq') && typeof process.loadEnvFile === 'function') {
  try {
    process.loadEnvFile('.env.qq');
  } catch {
    /* ignore */
  }
}

const argv = process.argv.slice(2);
const num = (name, fallback) => {
  const i = argv.indexOf(name);
  const v = i >= 0 ? Number(argv[i + 1]) : NaN;
  return Number.isFinite(v) ? v : fallback;
};
const maxWorks = num('--works', 3);
const perWork = num('--comments', 25);

const { context, remote, preexisting } = await openBrowser({ offscreen: true });
let page = null;
try {
  // ⚠️ 别复用已有页面：上一次跑完留下的页面可能停在播放器/回复框上，
  //    直接在上面 evaluate 会挂住（2026-11-06 实测卡了 4 分钟）。一律新开、用完关。
  page = await context.newPage();
  await page.goto('https://www.douyin.com/', { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
  console.error(`# page: ${page.url()}`);

  const data = await page.evaluate(
    async ({ maxWorks, perWork }) => {
      const call = async (url) => {
        const ctl = new AbortController();
        const timer = setTimeout(() => ctl.abort(), 12000);
        try {
          const res = await fetch(url, { credentials: 'include', signal: ctl.signal });
          if (!res.ok) return { __err: `http ${res.status}` };
          return await res.json().catch(() => ({ __err: 'json' }));
        } catch (e) {
          return { __err: String(e?.name ?? e) };
        } finally {
          clearTimeout(timer);
        }
      };
      const base = 'device_platform=webapp&aid=6383&channel=channel_pc_web';
      const self = await call(`https://www.douyin.com/aweme/v1/web/user/profile/self/?${base}`);
      const user = self?.user ?? null;
      if (!user?.sec_uid) return { error: 'no-self', raw: self };
      const qs = new URLSearchParams({ sec_user_id: user.sec_uid, count: String(maxWorks), max_cursor: '0' });
      const posts = await call(`https://www.douyin.com/aweme/v1/web/aweme/post/?${qs}&${base}`);
      const works = (posts?.aweme_list ?? []).slice(0, maxWorks);
      const out = [];
      for (const work of works) {
        const cqs = new URLSearchParams({ aweme_id: String(work.aweme_id), count: String(perWork), cursor: '0' });
        const res = await call(`https://www.douyin.com/aweme/v1/web/comment/list/?${cqs}&${base}`);
        out.push({
          awemeId: String(work.aweme_id),
          desc: String(work.desc ?? '').slice(0, 60),
          stats: {
            play: Number(work.statistics?.play_count ?? 0),
            like: Number(work.statistics?.digg_count ?? 0),
            comment: Number(work.statistics?.comment_count ?? 0),
          },
          err: res?.__err ?? '',
          comments: (res?.comments ?? []).map((c) => ({
            cid: String(c.cid ?? ''),
            user: String(c.user?.nickname ?? ''),
            uid: String(c.user?.uid ?? ''),
            text: String(c.text ?? ''),
            time: Number(c.create_time ?? 0),
            replyTotal: Number(c.reply_comment_total ?? 0),
            // ⚠️ reply_comment 有时是**数组**、有时是对象，两种都处理，否则字段全空
            replies: (Array.isArray(c.reply_comment) ? c.reply_comment : c.reply_comment ? [c.reply_comment] : []).map((n) => ({
              cid: String(n.cid ?? ''),
              user: String(n.user?.nickname ?? ''),
              uid: String(n.user?.uid ?? ''),
              text: String(n.text ?? ''),
              time: Number(n.create_time ?? 0),
              replyId: String(n.reply_id ?? ''),
            })),
          })),
        });
      }
      return { selfUid: String(user.uid ?? ''), selfName: String(user.nickname ?? ''), works: out };
    },
    { maxWorks, perWork },
  );
  // 先写完 stdout 再退：process.exit 立刻退会把没刷出去的小输出截断（踩过）
  await new Promise((done) => process.stdout.write(`${JSON.stringify(data, null, 2)}\n`, done));
} finally {
  await page?.close().catch(() => {});
  await closeBrowser(context, remote, preexisting).catch(() => {});
  process.exit(0);
}