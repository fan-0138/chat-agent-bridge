/**
 * 抖音候选采集（纯 HTTP，不开浏览器）—— 从 dsh-douyin-scroll（MIT）的
 * `tools/forward-pick.py` 迁移过来的思路。
 *
 * 关键认识：**取候选不需要签名**。`/aweme/v1/web/tab/feed/` 和
 * `/aweme/v1/web/hot/search/list/` 是「不签名的只读接口」，只要有登录 cookie 就能拿。
 *
 * 但有一个坑：抖音会看 TLS 指纹。Python 那边用 `curl_cffi` 伪装 Chrome，
 * 我们在 Node 里没有等价物 —— 所以改用**在页面上下文里 fetch**：
 * 浏览器自己发的请求，指纹/同源/cookie 全都是真的，也不需要 a_bogus。
 *
 * 效果：一轮采集从「开浏览器 + 滚 6 屏，20~43 秒」变成「一次 fetch，1~2 秒」。
 */

const BASE = 'https://www.douyin.com';

/** 公共参数：照抄抖音 Web 端 PC 首页的请求。 */
export const COMMON_QUERY = [
  'device_platform=webapp',
  'aid=6383',
  'channel=channel_pc_web',
  'pc_client_type=1',
  'version_code=190500',
  'version_name=19.5.0',
  'cookie_enabled=true',
  'screen_width=1920',
  'screen_height=1080',
  'browser_language=zh-CN',
  'browser_platform=Win32',
  'browser_name=Chrome',
  'browser_version=141.0.0.0',
  'engine_name=Blink',
  'engine_version=141.0.0.0',
  'os_name=Windows',
  'os_version=10',
  'platform=PC',
  'downlink=10',
  'effective_type=4g',
  'round_trip_time=50',
].join('&');

/**
 * 在页面里 fetch 一个同源接口，返回 JSON。
 * 失败返回 { __error }，不抛 —— 采集是尽力而为。
 */
export async function fetchInPage(page, path) {
  return page
    .evaluate(async (url) => {
      try {
        const response = await fetch(url, {
          credentials: 'include',
          headers: { accept: 'application/json, text/plain, */*' },
        });
        if (!response.ok) return { __error: `HTTP ${response.status}` };
        return await response.json();
      } catch (error) {
        return { __error: String(error?.message ?? error) };
      }
    }, path.startsWith('http') ? path : BASE + path)
    .catch((error) => ({ __error: String(error?.message ?? error) }));
}

/** 递归收集所有 aweme 对象（各接口层级不一样）。 */
export function collectAwemes(node, bag = new Map()) {
  if (Array.isArray(node)) {
    for (const item of node) collectAwemes(item, bag);
    return bag;
  }
  if (node && typeof node === 'object') {
    if (node.aweme_id && ('desc' in node || 'statistics' in node)) {
      bag.set(String(node.aweme_id), node);
      return bag;
    }
    for (const value of Object.values(node)) collectAwemes(value, bag);
  }
  return bag;
}

/**
 * 拉一轮候选：推荐流 N 页 + 热榜。
 * @param {import('playwright').Page} page 已经在 douyin.com 同源页面上的 page
 */
export async function collectCandidates(page, { pages = 3, pause = () => new Promise((r) => setTimeout(r, 800)) } = {}) {
  const meta = [];
  const bag = new Map();

  for (let index = 1; index <= pages; index += 1) {
    const path = `/aweme/v1/web/tab/feed/?${COMMON_QUERY}&count=20&refresh_index=${index}`;
    const json = await fetchInPage(page, path);
    if (json?.__error) {
      meta.push({ src: `feed#${index}`, status: json.__error, added: 0 });
      continue;
    }
    const before = bag.size;
    collectAwemes(json, bag);
    meta.push({ src: `feed#${index}`, status: json.status_code ?? 0, added: bag.size - before });
    await pause();
  }

  const hotPath = `/aweme/v1/web/hot/search/list/?${COMMON_QUERY}&detail_list=1`;
  const hot = await fetchInPage(page, hotPath);
  if (hot?.__error) {
    meta.push({ src: 'hot-search', status: hot.__error, added: 0 });
  } else {
    const before = bag.size;
    collectAwemes(hot, bag);
    meta.push({ src: 'hot-search', status: hot.status_code ?? 0, added: bag.size - before });
  }

  return { awemes: [...bag.values()], meta };
}