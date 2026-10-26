/**
 * 上网冲浪：几个不用登录、不需要 cookie 的热榜源。
 *
 * 为什么是这几个：
 *  - 微博热搜：要 Referer + 像样的 UA，但不用登录，JSON 直接给；
 *  - 头条热榜：JSON 最干净；
 *  - B 站热搜：JSON，年轻人用语多，学梗首选；
 *  - 百度热搜：HTML 里埋了 JSON，能解析但脆，放最后兜底。
 * 知乎/抖音网页版都要 cookie，交给已有的 douyin-hot 那套。
 */

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36';

export const SOURCES = {
  weibo: { label: '微博', url: 'https://weibo.com/ajax/side/hotSearch', headers: { Referer: 'https://weibo.com/', Accept: 'application/json' }, parse: parseWeibo },
  toutiao: { label: '头条', url: 'https://www.toutiao.com/hot-event/hot-board/?origin=toutiao_pc', headers: { Accept: 'application/json' }, parse: parseToutiao },
  bili: { label: 'B站', url: 'https://api.bilibili.com/x/web-interface/search/square?limit=30', headers: { Accept: 'application/json' }, parse: parseBili },
  baidu: { label: '百度', url: 'https://top.baidu.com/board?tab=realtime', headers: { Accept: 'text/html' }, parse: parseBaidu },
};

function str(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

/** 微博：data.realtime[].word_scheme / word / note */
export function parseWeibo(json, limit = 10) {
  const list = json?.data?.realtime ?? [];
  return list
    .map((item) => ({
      title: str(item.word_scheme || item.word || item.note),
      hot: Number(item.num ?? item.raw_hot ?? 0) || 0,
      tag: str(item.label_name || ''),
    }))
    .filter((item) => item.title)
    .slice(0, limit);
}

/** 头条：data[].Title */
export function parseToutiao(json, limit = 10) {
  const list = json?.data ?? [];
  return list
    .map((item) => ({
      title: str(item.Title),
      hot: Number(item.HotValue ?? 0) || 0,
      tag: str(item.Label || ''),
    }))
    .filter((item) => item.title)
    .slice(0, limit);
}

/** B 站：data.trending.list[].keyword / show_name */
export function parseBili(json, limit = 10) {
  const list = json?.data?.trending?.list ?? [];
  return list
    .map((item) => ({
      title: str(item.show_name || item.keyword),
      hot: Number(item.score ?? 0) || 0,
      tag: '',
    }))
    .filter((item) => item.title)
    .slice(0, limit);
}

/** 百度：页面里 __INITIAL_STATE__ 的 hotBoard 数据，取不到就返回空（脆，兜底用） */
export function parseBaidu(html, limit = 10) {
  const text = String(html ?? '');
  const match = text.match(/<!--s-data:([\s\S]*?)-->/);
  if (!match) return [];
  try {
    const data = JSON.parse(match[1]);
    const cards = data?.data?.cards ?? [];
    const out = [];
    for (const card of cards) {
      for (const item of card?.content ?? []) {
        const title = str(item.word || item.query || item.title);
        if (!title) continue;
        out.push({ title, hot: Number(item.hotScore ?? 0) || 0, tag: str(item.hotTag || '') });
        if (out.length >= limit) return out;
      }
    }
    return out;
  } catch {
    return [];
  }
}

/** 拉一个源。失败返回 {ok:false}，不抛 —— 冲浪不该因为一个站挂了就中断。 */
export async function fetchSource(name, { limit = 10, timeoutMs = 12_000 } = {}) {
  const source = SOURCES[name];
  if (!source) return { ok: false, source: name, error: '未知来源', items: [] };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(source.url, {
      headers: { 'User-Agent': UA, ...source.headers },
      signal: controller.signal,
    });
    const text = await response.text();
    if (!response.ok) return { ok: false, source: name, label: source.label, error: `HTTP ${response.status}`, items: [] };
    const parsed = text.trim().startsWith('<') ? source.parse(text, limit) : source.parse(JSON.parse(text), limit);
    return { ok: true, source: name, label: source.label, items: parsed };
  } catch (error) {
    return { ok: false, source: name, label: source.label, error: String(error?.message ?? error), items: [] };
  } finally {
    clearTimeout(timer);
  }
}
