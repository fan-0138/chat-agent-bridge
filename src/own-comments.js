/**
 * 她自己作品下面的新评论 → 收件箱（data/douyin/at-inbox.jsonl）。
 *
 * 为什么不靠抖音的通知接口：实测「评论了你的作品」通知会晚两小时以上，
 * 有时候还只给一句「回复了评论」不带正文。直接拉自己作品的评论列表，准、快、带原文。
 *
 * 收件箱是现成的：桥接的 mind 循环读它，挑一条自己决定回不回（做=回）。
 */

const DAY_MS = 86_400_000;

export const OWN_SEEN_FILE = 'data/douyin/own-comments-seen.json';

function str(value) {
  return String(value ?? '').trim();
}

function secondsToMs(value) {
  const n = Number(str(value));
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round(n >= 1e12 ? n : n * 1000);
}

/** 评论 → 收件箱一行；自己的评论、空评论、太老的返回 null。 */
export function commentToRow({ comment, awemeId, awemeDesc = '', selfUid = '', nowMs = Date.now(), maxAgeDays = 3 }) {
  const cid = str(comment?.cid);
  if (!cid || !str(awemeId)) return null;
  const uid = str(comment?.user?.uid ?? comment?.user?.uid_str ?? '');
  if (selfUid && uid === selfUid) return null;
  const content = str(comment?.text);
  if (!content) return null;
  const at = secondsToMs(comment?.create_time) ?? nowMs;
  if (nowMs - at > maxAgeDays * DAY_MS) return null;
  return {
    type: 35,
    typeName: '评论了你的作品',
    nid: `own-${awemeId}-${cid}`,
    createTime: Math.round(at / 1000),
    nickname: str(comment?.user?.nickname),
    uid,
    content,
    awemeId: str(awemeId),
    commentId: cid,
    awemeDesc: str(awemeDesc),
    videoUrl: `https://www.douyin.com/video/${awemeId}`,
    source: 'own-work',
    seenAt: nowMs,
  };
}

/**
 * 从「作品 + 评论」里挑出没见过的新评论。
 * @param {{works: Array<{awemeId:string, desc?:string, comments?:any[]}>, seen?: string[], selfUid?: string, nowMs?: number, maxAgeDays?: number, limit?: number}} options
 */
export function pickNewComments({
  works = [],
  seen = [],
  selfUid = '',
  nowMs = Date.now(),
  maxAgeDays = 3,
  limit = 6,
} = {}) {
  const seenSet = new Set((seen ?? []).map(str));
  const rows = [];
  for (const work of works) {
    for (const comment of work?.comments ?? []) {
      const row = commentToRow({
        comment,
        awemeId: work?.awemeId,
        awemeDesc: work?.desc,
        selfUid,
        nowMs,
        maxAgeDays,
      });
      if (!row) continue;
      if (seenSet.has(row.nid)) continue;
      const dup = rows.some((existing) => existing.nid === row.nid);
      if (dup) continue;
      rows.push(row);
      if (rows.length >= Math.max(1, Number(limit) || 6)) return { rows, seenNext: mergeSeen(seen, rows) };
    }
  }
  return { rows, seenNext: mergeSeen(seen, rows) };
}

export function mergeSeen(seen = [], rows = [], cap = 800) {
  const out = [...(seen ?? []).map(str), ...rows.map((row) => str(row.nid))].filter(Boolean);
  return [...new Set(out)].slice(-cap);
}