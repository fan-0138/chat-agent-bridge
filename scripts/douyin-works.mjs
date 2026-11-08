import { existsSync } from 'node:fs';
import { openBrowser, closeBrowser } from './lib/douyin-browser.mjs';
if (existsSync('.env.qq') && typeof process.loadEnvFile === 'function') process.loadEnvFile('.env.qq');
const { context, remote, preexisting } = await openBrowser({ offscreen: true });
let page = null;
try {
  page = await context.newPage();
  await page.goto('https://www.douyin.com/', { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
  const data = await page.evaluate(async () => {
    const base = 'device_platform=webapp&aid=6383&channel=channel_pc_web';
    const call = async (url) => {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), 15000);
      try { const r = await fetch(url, { credentials: 'include', signal: ctl.signal }); return await r.json(); }
      catch (e) { return { error: String(e?.name ?? e) }; } finally { clearTimeout(t); }
    };
    const self = await call(`https://www.douyin.com/aweme/v1/web/user/profile/self/?${base}`);
    const user = self?.user;
    if (!user?.sec_uid) return { error: 'no-self' };
    const qs = new URLSearchParams({ sec_user_id: user.sec_uid, count: '6', max_cursor: '0' });
    const posts = await call(`https://www.douyin.com/aweme/v1/web/aweme/post/?${qs}&${base}`);
    return {
      name: user.nickname, uid: String(user.uid),
      works: (posts?.aweme_list ?? []).map((a) => ({
        id: String(a.aweme_id),
        desc: String(a.desc ?? ''),
        at: new Date(a.create_time * 1000).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }),
        play: a.statistics?.play_count ?? 0,
        like: a.statistics?.digg_count ?? 0,
        comment: a.statistics?.comment_count ?? 0,
        status: a.status?.is_delete ? 'deleted' : (a.is_top ? 'top' : 'ok'),
        reviewing: a.status?.in_reviewing ?? null,
      })),
    };
  });
  console.log(JSON.stringify(data, null, 1));
} finally {
  await closeBrowser(context, remote, preexisting).catch(() => {});
  process.exit(0);
}
