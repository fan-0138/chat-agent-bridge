/**
 * 抖音候选打分：从 dsh-douyin-scroll（MIT）的 `tools/forward-pick.py` 移植。
 *
 * 原版的判断逻辑比我们之前那套「点赞 1w–50w 加分」细得多，核心三个想法：
 *  1. 硬筛（纯代码、0 token）：没文案 / 时长 <12 秒 / 文案太短且评论太少 → 直接丢
 *  2. 互动结构：inter = 赞 + 评×2 + 藏×3 + 转×2 —— 收藏和转发的权重高于点赞
 *  3. 结构修正：评论/点赞比落在 2%–25% 之间（"有话说但不吵架"）×1.25；
 *     72 小时内发的 ×1.15（新鲜）
 *
 * 注意：这套判据**不看画面**，只用 JSON 字段（文案/作者/时长/互动数）。
 * 抖音没有字幕轨，所以"内容好不好"只能靠观众反应推断 —— 会误判，别当真理。
 */

/** 硬筛阈值：跟原版一致 */
export const DEFAULTS = Object.freeze({
  minDurationMs: 12_000, // 短于 12 秒多是模板/广告
  minDescLen: 12, // 文案短于这个……
  minComments: 3, // ……且评论少于这个，才丢（两个同时成立）
  freshHours: 72,
  goodRatioMin: 0.02,
  goodRatioMax: 0.25,
  ratioBoost: 1.25,
  freshBoost: 1.15,
});

const num = (value) => {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
};

/** 递归找所有「长得像 aweme」的对象（各接口层级不一样，别写死路径）。 */
export function walkAwemes(node, bag = new Map()) {
  if (Array.isArray(node)) {
    for (const item of node) walkAwemes(item, bag);
    return bag;
  }
  if (node && typeof node === 'object') {
    if (node.aweme_id && ('desc' in node || 'statistics' in node)) {
      bag.set(String(node.aweme_id), node);
      return bag;
    }
    for (const value of Object.values(node)) walkAwemes(value, bag);
  }
  return bag;
}

/** 硬筛：返回 null 表示保留，否则返回丢弃原因。 */
export function dropReason(aweme, config = DEFAULTS) {
  const desc = String(aweme?.desc ?? '').trim();
  if (!desc) return 'no_desc';

  const duration = num(aweme?.duration || aweme?.video?.duration);
  if (duration && duration < config.minDurationMs) return 'too_short_video';

  const comments = num(aweme?.statistics?.comment_count);
  if (config.minDescLen && desc.length < config.minDescLen && comments < config.minComments) {
    return 'short_and_quiet';
  }
  return null;
}

/** 归一化成一个干净的候选对象。 */
export function normalize(aweme, now = Date.now(), config = DEFAULTS) {
  const stats = aweme?.statistics ?? {};
  const digg = num(stats.digg_count);
  const comment = num(stats.comment_count);
  const collect = num(stats.collect_count);
  const share = num(stats.share_count);
  const durationMs = num(aweme?.duration || aweme?.video?.duration);
  const createdMs = num(aweme?.create_time) * 1000;
  const ageHours = createdMs ? Math.round(((now - createdMs) / 3_600_000) * 10) / 10 : null;

  const shareInfo = aweme?.share_info ?? {};
  const officialShare = shareInfo.share_url || aweme?.share_url || '';

  return {
    id: String(aweme.aweme_id),
    desc: String(aweme.desc ?? '').trim(),
    author: aweme?.author?.nickname ?? '',
    secUid: aweme?.author?.sec_uid ?? '',
    durationSec: durationMs ? Math.round(durationMs / 100) / 10 : null,
    likes: digg,
    comments: comment,
    collects: collect,
    shares: share,
    commentRatio: digg ? Math.round((comment / digg) * 10_000) / 10_000 : 0,
    ageHours,
    tags: (aweme.text_extra ?? []).map((item) => item?.hashtag_name).filter(Boolean).slice(0, 5),
    // 官方分享链接（带 share_sign，能在抖音里点开），别自己拼 aweme_id
    shareUrl: officialShare || `https://www.iesdouyin.com/share/video/${aweme.aweme_id}/`,
    webUrl: `https://www.douyin.com/video/${aweme.aweme_id}`,
    shareText: String(shareInfo.share_link_desc ?? '').replace('%s', officialShare).trim(),
    isAd: Boolean(aweme.ad_brand_info),
    isLive: Boolean(aweme.live_info),
  };
}

/** 打分：互动量为主，评论结构和新鲜度做修正。 */
export function score(item, now = Date.now(), config = DEFAULTS) {
  const inter = item.likes + item.comments * 2 + item.collects * 3 + item.shares * 2;
  let value = inter;

  const ratio = item.likes ? item.comments / item.likes : 0;
  if (ratio >= config.goodRatioMin && ratio <= config.goodRatioMax) value *= config.ratioBoost;

  if (item.ageHours !== null && item.ageHours !== undefined && item.ageHours <= config.freshHours) {
    value *= config.freshBoost;
  }
  if (item.isAd || item.isLive) value = 0;

  return Math.round(value);
}

/**
 * 一轮筛选：aweme 列表 → 排序后的候选。
 * @returns {{ items: Array, dropped: Record<string, number>, total: number }}
 */
export function rank(awemes, { now = Date.now(), limit = 20, config = DEFAULTS, seenIds = [], maxLikes = 0, maxAgeHours = 0 } = {}) {
  const seen = new Set(seenIds.map(String));
  const dropped = { no_desc: 0, too_short_video: 0, short_and_quiet: 0, seen: 0, too_viral: 0, too_old: 0 };
  const items = [];

  for (const aweme of awemes) {
    const id = String(aweme?.aweme_id ?? '');
    if (!id || seen.has(id)) {
      dropped.seen += 1;
      continue;
    }
    const reason = dropReason(aweme, config);
    if (reason) {
      dropped[reason] += 1;
      continue;
    }
    const item = normalize(aweme, now, config);

    // 纯互动量排序会让「半年前千万赞的爆款」永远排第一 —— 那不是「她刚刷到的」。
    // 所以再卡一道「人味过滤」：太老的、太爆的不要。
    if (maxLikes && item.likes > maxLikes) {
      dropped.too_viral += 1;
      continue;
    }
    if (maxAgeHours && item.ageHours !== null && item.ageHours > maxAgeHours) {
      dropped.too_old += 1;
      continue;
    }

    item.score = score(item, now, config);
    items.push(item);
  }

  items.sort((a, b) => b.score - a.score);
  return { items: items.slice(0, limit), dropped, total: items.length };
}