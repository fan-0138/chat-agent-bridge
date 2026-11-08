/**
 * 读她自己抖音号的作品列表（网页内接口，只读）。
 *
 * 为什么走 www.douyin.com 的接口而不是创作者中心：
 *  - 创作者中心是「页面」，要等渲染、还会分页；这个接口一次给 20 条，够数今天发了几条；
 *  - 新作品刚发出来就会出现在列表里（`in_reviewing` 标着审核中），可以拿来做「真发出去了没有」的核对。
 */

const BASE = 'device_platform=webapp&aid=6383&channel=channel_pc_web';

/**
 * @param {import('playwright').Page} page  已经打开 www.douyin.com 的页面
 * @param {{count?: number}} [options]
 * @returns {Promise<{ok: boolean, error?: string, name?: string, uid?: string, works: Array<{id: string, desc: string, at: number, durationMs: number, reviewing: boolean|null}>}>}
 */
export async function readOwnWorks(page, { count = 20 } = {}) {
  if (!page) return { ok: false, error: 'no-page', works: [] };
  const data = await page.evaluate(async (limit) => {
    const base = 'device_platform=webapp&aid=6383&channel=channel_pc_web';
    const call = async (url) => {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 15_000);
      try {
        const response = await fetch(url, { credentials: 'include', signal: ctl.signal });
        return await response.json();
      } catch (error) {
        return { error: String(error?.name ?? error) };
      } finally {
        clearTimeout(timer);
      }
    };
    const self = await call(`https://www.douyin.com/aweme/v1/web/user/profile/self/?${base}`);
    const user = self?.user;
    if (!user?.sec_uid) return { error: 'no-self' };
    const qs = new URLSearchParams({ sec_user_id: user.sec_uid, count: String(limit), max_cursor: '0' });
    const posts = await call(`https://www.douyin.com/aweme/v1/web/aweme/post/?${qs}&${base}`);
    return {
      name: user.nickname,
      uid: String(user.uid),
      works: (posts?.aweme_list ?? []).map((row) => ({
        id: String(row.aweme_id),
        desc: String(row.desc ?? ''),
        at: Number(row.create_time ?? 0) * 1000,
        durationMs: Number(row.video?.duration ?? 0),
        reviewing: row.status?.in_reviewing ?? null,
      })),
    };
  }, Math.max(1, Math.min(50, Number(count) || 20)));

  if (data?.error) return { ok: false, error: String(data.error), works: [] };
  return {
    ok: true,
    name: data?.name ?? '',
    uid: data?.uid ?? '',
    works: Array.isArray(data?.works) ? data.works : [],
  };
}

/** 打开她自己的主页（接口要在同一个源下调用）。 */
export async function openOwnPage(context) {
  const page = await context.newPage();
  await page.goto('https://www.douyin.com/', { waitUntil: 'domcontentloaded', timeout: 45_000 }).catch(() => {});
  return page;
}