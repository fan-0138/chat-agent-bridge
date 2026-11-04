/**
 * 抖音收件箱：别人 @ 她、或者在她评论区回复她的通知。
 *
 * 链路（只做读 / 判 / 挑 / 记账，不发评论）：
 *   data/douyin/at-inbox.jsonl  桥接把通知一行一条写进来（字段经常缺、类型不统一）
 *     → loadInbox      解析成统一结构（坏行跳过、缺字段兜底）
 *     → isSafeToReply  这条值不值得回（适当回复、不吵架；宁可漏掉）
 *     → pickCandidates 去掉已回 / 不安全 / 过期的，按时间倒序给最多 3 条，带 index
 *     → markReplied    回完记一笔 data/douyin/replied.jsonl，下轮不再选它
 *
 * 纯逻辑为主（只有读写两个 jsonl），方便单测；浏览器和发评论在 scripts/ 里。
 */
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

/** 超过这么多天的 @ 不再回（隔好几天才回很怪） */
export const REPLY_MAX_AGE_DAYS = 3;

const DAY_MS = 86_400_000;
const INBOX_FILE = 'data/douyin/at-inbox.jsonl';
const REPLIED_FILE = 'data/douyin/replied.jsonl';

// 骂人 / 引战：碰到就跳过，别在评论区吵起来
const HOSTILE = [
  '傻', '蠢', '滚', '闭嘴', '骂', '喷', '吵架', '杠', '垃圾', '恶心',
  '举报', '假', '骗子', '脑残', '有病', '废物', '去死', '弱智', '智障',
  '神经病', '沙雕', '引战', '网暴', '挂人', '开团', '丢人', '小丑',
];

// 政治敏感：只挡最明显的词，别误伤正常聊天
const SENSITIVE = ['台独', '港独', '藏独', '疆独', '反华', '辱华', '六四', '法轮', '习近平', '维尼'];

// 广告 / 引流（英文按小写比）
const SPAM = [
  '加微信', '微信', '私信', '私我', '加v', 'vx', 'wx', 'qq', '扣扣',
  '二维码', '扫码', '链接', 'http', 'www.', '主页', '橱窗', '下单',
  '优惠券', '返现', '求关注', '关注我', '滴滴我', 'dd我', '薇信',
];

// 营销号昵称：只认几个特别明显的词。保守点，宁可漏掉一个营销号，也别把普通网友误杀
const MARKETING_NAME = ['音乐', '带货', '直播', '好物', '优选', '种草', '代购', '小店', '招商', '客服', '旗舰', '涨粉', '互关'];

const str = (value) => String(value ?? '').trim();

function baseDir(root) {
  return root ? resolve(root) : process.cwd();
}

/** 通知里的布尔经常是字符串 "True"/"False"，也可能真是布尔；缺省按 fallback。 */
function parseFlag(value, fallback = true) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  const text = str(value).toLowerCase();
  return !['false', '0', 'no', 'n'].includes(text);
}

/** createTime 是秒；万一是毫秒也认（>= 1e12 就不乘 1000）。解析不出来返回 null。 */
function secondsToMs(value) {
  const n = Number(str(value));
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round(n >= 1e12 ? n : n * 1000);
}

/** seenAt 已经是毫秒了。解析不出来返回 null。 */
function msOf(value) {
  const n = Number(str(value));
  return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
}

/** 一行 JSON → 统一结构；坏行 / 没 nid 的返回 null。 */
function parseInboxLine(line) {
  const text = str(line);
  if (!text || !text.startsWith('{')) return null;
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;

  const nid = str(raw.nid);
  if (!nid) return null; // 没 nid 就没法去重 / 标记已回
  const awemeId = str(raw.awemeId);
  const at = secondsToMs(raw.createTime) ?? msOf(raw.seenAt) ?? 0;
  return {
    nid,
    nickname: str(raw.nickname),
    content: str(raw.content),
    videoUrl: str(raw.videoUrl) || (awemeId ? `https://www.douyin.com/video/${awemeId}` : ''),
    awemeId,
    commentId: str(raw.commentId),
    rootCommentId: str(raw.rootCommentId),
    desc: str(raw.awemeDesc),
    typeName: str(raw.typeName),
    at,
    replyable: parseFlag(raw.replyable, true),
  };
}

async function readJsonl(file) {
  try {
    return await readFile(file, 'utf8');
  } catch {
    return '';
  }
}

/** 读整个收件箱（文件顺序，坏行跳过）。 */
async function readInbox(root) {
  const text = await readJsonl(resolve(baseDir(root), INBOX_FILE));
  if (!text) return [];
  const items = [];
  for (const line of text.split('\n')) {
    const item = parseInboxLine(line);
    if (item) items.push(item);
  }
  return items;
}

/**
 * 读收件箱尾部 `limit` 条（坏行不算数，缺文件返回 []）。
 * @param {{root?: string, limit?: number}} [options]
 */
export async function loadInbox({ root, limit = 30 } = {}) {
  const items = await readInbox(root);
  const max = Math.floor(Number(limit));
  if (!Number.isFinite(max) || max <= 0) return [];
  return items.slice(-max);
}

/**
 * 判断一条值不值得回；值得返回 null，不值得返回原因（方便日志和排查）。
 * @param {object} item loadInbox 出来的结构
 * @param {{now?: number, maxAgeDays?: number}} [options]
 */
export function unsafeReason(item, { now = Date.now(), maxAgeDays = REPLY_MAX_AGE_DAYS } = {}) {
  if (!item || typeof item !== 'object') return 'no_item';
  if (!parseFlag(item.replyable, true)) return 'replyable_false';

  const content = str(item.content);
  if (!content) return 'empty';

  const at = Number(item.at);
  if (!Number.isFinite(at) || at <= 0) return 'no_time'; // 不知道多旧 ⇒ 不敢回
  if (now - at > maxAgeDays * DAY_MS) return 'too_old';

  const nickname = str(item.nickname);
  const text = `${nickname}\n${content}`;
  const lower = text.toLowerCase();
  if (HOSTILE.some((word) => text.includes(word))) return 'hostile';
  if (SENSITIVE.some((word) => text.includes(word))) return 'sensitive';
  if (SPAM.some((word) => lower.includes(word.toLowerCase()))) return 'spam';
  if (MARKETING_NAME.some((word) => nickname.includes(word))) return 'marketing_name';
  return null;
}

/** 值不值得回。适当回复、不吵架 —— 宁可漏掉，也别吵起来。 */
export function isSafeToReply(item, options) {
  return unsafeReason(item, options) === null;
}

/** 读 replied.jsonl 里已经回过的 nid 集合（坏行跳过，缺文件算出空集）。 */
async function loadRepliedNids(root) {
  const text = await readJsonl(resolve(baseDir(root), REPLIED_FILE));
  const nids = new Set();
  if (!text) return nids;
  for (const line of text.split('\n')) {
    const item = str(line);
    if (!item) continue;
    try {
      const row = JSON.parse(item);
      const nid = str(row?.nid);
      if (nid) nids.add(nid);
    } catch {
      // 坏行跳过
    }
  }
  return nids;
}

/**
 * 挑这轮可以回的候选：没回过、安全、没过期，按时间倒序，最多 limit 条。
 * 每条多带一个 index（从 1 开始），给 prompt 里「第 1 条」这样指代用。
 * @param {{root?: string, limit?: number, now?: number, maxAgeDays?: number}} [options]
 */
export async function pickCandidates({ root, limit = 3, now = Date.now(), maxAgeDays = REPLY_MAX_AGE_DAYS } = {}) {
  const inbox = await readInbox(root);
  const replied = await loadRepliedNids(root);
  const ranked = inbox
    .filter((item) => !replied.has(item.nid))
    .filter((item) => isSafeToReply(item, { now, maxAgeDays }))
    .sort((a, b) => b.at - a.at);
  const max = Math.floor(Number(limit));
  const count = Number.isFinite(max) && max > 0 ? max : 0;
  return ranked.slice(0, count).map((item, index) => ({ ...item, index: index + 1 }));
}

/**
 * 记一笔「这条回过了」，追加到 data/douyin/replied.jsonl（一行 {nid, at, text}）。
 * 目录不存在会自动建。
 */
export async function markReplied({ root, nid, at = Date.now(), text = '' } = {}) {
  const id = str(nid);
  if (!id) throw new Error('markReplied 需要 nid');
  const file = resolve(baseDir(root), REPLIED_FILE);
  await mkdir(dirname(file), { recursive: true });
  const row = { nid: id, at: Number(at) || Date.now(), text: str(text) };
  await appendFile(file, `${JSON.stringify(row)}\n`, 'utf8');
  return row;
}