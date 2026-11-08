/**
 * 发布前的「守门员」：几个纯函数，方便单测。
 *
 * 为什么要有（2026-11-08）：11-07 那次她自己说「发了」，其实视频还在上传（40%），
 * 脚本已经走完、页面被关掉，作品从来没发出去。爸爸问「她不会自己发视频是吗」，
 * 结论是：把发布这条路修成**不会撒谎**的，再交给她。
 *
 * 这里的判据：
 *   - 一天最多两条（`MAX_PER_DAY`）；
 *   - 文案末尾必须挂三个标签（`#机器人账号#DeepSeek#ai动画`），少了就补；
 *   - 「还有上传中/转码中」就不算成功，哪怕地址栏已经跳到内容管理；
 *   - 真发没发出去，最终以「作品列表里有没有多出一条」为准（`findNewWork`）。
 */

export const MAX_PER_DAY = 2;
export const REQUIRED_TAGS = ['#机器人账号', '#DeepSeek', '#ai动画'];

/** 本地自然日 'YYYY-MM-DD'（抖音后台按北京时间算）。 */
export function dayOf(at = Date.now()) {
  const d = new Date(Number(at));
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** 文案末尾补标签：缺哪个补哪个，已有了就不动。 */
export function ensureTags(title) {
  const text = String(title ?? '').replace(/\s+/g, ' ').trim();
  const missing = REQUIRED_TAGS.filter((tag) => !text.includes(tag));
  if (missing.length === 0) return text;
  return `${text} ${missing.join('')}`.trim();
}

/**
 * 从「作品列表」里数今天发了几条。
 * @param {Array<{at?: number}>} works at = 作品发布时间（毫秒）
 */
export function countPublishedToday(works = [], now = Date.now()) {
  const day = dayOf(now);
  return (works ?? []).filter((row) => row && dayOf(row.at) === day).length;
}

/** 今天还能不能发。 */
export function checkDailyCap({ works = [], now = Date.now(), max = MAX_PER_DAY } = {}) {
  const today = countPublishedToday(works, now);
  if (today >= max) {
    return { allow: false, today, max, reason: `今天已经发了 ${today} 条（上限 ${max} 条，多了限流）` };
  }
  return { allow: true, today, max, reason: '' };
}

/**
 * 上传页现在是什么状态：'uploading' | 'failed' | 'ready'。
 *
 * 坑一（11-07）：页面会挂着「作品上传中 41%」，这时候点发布/走人都等于白发。
 * 坑二（11-08 实测）：发布页右边预览框会一直写「预览转码中，请稍后」，旁边又写着
 *   「转码过程也可以发布作品」——所以**预览转码不算没传完**，只有「作品上传中/正在上传」才算。
 */
export function judgeUploadState({ text = '' } = {}) {
  const body = String(text ?? '');
  if (/上传失败|发布失败|转码失败/.test(body)) return 'failed';
  if (/作品上传中|正在上传|上传中\s*\d+\s*%/.test(body)) return 'uploading';
  return 'ready';
}

/**
 * 点了发布之后，页面算不算成功：'done' | 'failed' | 'uploading' | 'pending'。
 * 地址跳到内容管理不等于发完了——还得没有「上传中」。
 */
export function judgePublishState({ url = '', text = '' } = {}) {
  const body = String(text ?? '');
  if (/上传失败|发布失败|转码失败/.test(body)) return 'failed';
  if (/作品上传中|正在上传|上传中\s*\d+\s*%/.test(body)) return 'uploading';
  if (/发布成功|已发布|发布完成/.test(body)) return 'done';
  if (/content\/manage/.test(String(url ?? ''))) return 'done';
  return 'pending';
}

/**
 * 发布前后对比作品列表，找出「这次新出现的那条」。
 * 只有找到才算真发出去了（11-07 的教训：别信页面提示）。
 */
export function findNewWork({ before = [], after = [], title = '' } = {}) {
  const seen = new Set((before ?? []).map((row) => String(row?.id ?? '')));
  const fresh = (after ?? []).filter((row) => row && !seen.has(String(row.id ?? '')));
  if (fresh.length === 0) return null;
  const head = String(title ?? '').replace(/\s+/g, ' ').trim().slice(0, 10);
  if (!head) return fresh[0];
  return fresh.find((row) => String(row.desc ?? '').includes(head.slice(0, 8))) ?? fresh[0];
}
// ── 去重 ────────────────────────────────────────────────────────────────
//
// 为什么要有（2026-11-08，爸爸说「她今天早上重复发了昨天的，我删掉了」）：
// 上传这条路本身通了，但「发什么」没人守——同一个片子换个文件名、换句文案，
// 网页那边照样能发出去，页面上也不会提醒。所以发之前拿两道判据拦：
//   1. 文案：把话题标签、标点、表情去掉，按字bigram比重合度（一条短的被另一条盖住也算）
//   2. 内容：片子时长一模一样（同一个文件重传 / 重编码后时长不变）
//   外加本地账本（data/douyin/published.jsonl）里的文件指纹，重命名也躲不过。

/** 文案重合到这个程度就当成同一条（0.62 ≈ 十几个字里有十来个字一样）。 */
export const DUP_TITLE_SIM = 0.62;
/** 长度一样时，文案至少得像到这个程度才算重复（她片子时长常常一样，光看长度会误伤）。 */
export const DUP_WEAK_TITLE_SIM = 0.35;
/** 两条片子时长差在这个范围里，基本就是同一个文件。 */
export const DUP_DURATION_MS = 300;
/** 抽样帧 dHash 平均允许差几位（64 位里 ≤10 位还能认成同一段片子）。 */
export const DUP_FRAME_BITS = 10;

/** 去掉话题标签、@、标点、符号、空白，留纯正文，方便比文案。 */
export function normalizeTitle(title = '') {
  return String(title ?? '')
    .replace(/#[^#\s@]{1,24}/g, ' ')
    .replace(/@[^\s#]+/g, ' ')
    .replace(/[\s\p{P}\p{S}]+/gu, '')
    .toLowerCase();
}

function charBigrams(text = '') {
  const chars = [...String(text ?? '')];
  const out = new Set();
  if (chars.length === 0) return out;
  if (chars.length === 1) {
    out.add(chars[0]);
    return out;
  }
  for (let i = 0; i < chars.length - 1; i += 1) out.add(chars[i] + chars[i + 1]);
  return out;
}

/** 两条文案有多像：0 = 没关系，1 = 一条完全被另一条盖住。 */
export function titleSimilarity(a = '', b = '') {
  const left = charBigrams(normalizeTitle(a));
  const right = charBigrams(normalizeTitle(b));
  if (left.size === 0 || right.size === 0) return 0;
  let hit = 0;
  for (const gram of left) if (right.has(gram)) hit += 1;
  return hit / Math.min(left.size, right.size);
}

/** 两串 16 进制 dHash 差多少位。 */
export function hammingHex(a = '', b = '') {
  const left = String(a ?? '');
  const right = String(b ?? '');
  let diff = 0;
  const n = Math.min(left.length, right.length);
  for (let i = 0; i < n; i += 1) {
    let x = parseInt(left[i], 16) ^ parseInt(right[i], 16);
    if (Number.isNaN(x)) return 64;
    while (x) {
      diff += x & 1;
      x >>= 1;
    }
  }
  return diff + Math.abs(left.length - right.length) * 4;
}

/** 两串抽样帧是不是同一段片子：帧数对得上，而且平均差异在容忍范围内。 */
export function sameFootage(a = [], b = [], { bits = DUP_FRAME_BITS } = {}) {
  const left = Array.isArray(a) ? a : [];
  const right = Array.isArray(b) ? b : [];
  if (left.length === 0 || right.length === 0) return false;
  if (Math.abs(left.length - right.length) > 1) return false;
  const n = Math.min(left.length, right.length);
  let total = 0;
  for (let i = 0; i < n; i += 1) total += hammingHex(left[i], right[i]);
  return total / n <= bits;
}

function shortDesc(text = '', max = 40) {
  return String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

/**
 * 主页上已经有差不多的一条了吗？
 *
 * 实测（2026-11-08）：她的片子几乎都是同一条流水线出来的，时长经常一模一样
 * （六条作品里四条都是 30.125 秒），所以**「长度一样」不能单独当重复判据**——
 * 文案也得有点像是同一件事（≥ WEAK_SIM）。真正铁的证据在本地账本（findDuplicatePublish）：
 * 同一个文件的指纹。
 *
 * @param {{works?: Array<{id?: string, desc?: string, at?: number, durationMs?: number}>, title?: string, durationMs?: number}} args
 */
export function findDuplicateWork({ works = [], title = '', durationMs = 0 } = {}) {
  const duration = Number(durationMs) || 0;
  const matches = [];
  const weak = [];
  for (const work of works ?? []) {
    if (!work) continue;
    const similarity = titleSimilarity(title, work.desc);
    const workDuration = Number(work.durationMs) || 0;
    const sameDuration = duration > 0 && workDuration > 0 && Math.abs(duration - workDuration) <= DUP_DURATION_MS;
    const sameTitle = similarity >= DUP_TITLE_SIM;
    const weakTitle = similarity >= DUP_WEAK_TITLE_SIM;
    const row = {
      id: String(work.id ?? ''),
      desc: shortDesc(work.desc),
      at: Number(work.at) || 0,
      similarity: Number(similarity.toFixed(3)),
      sameDuration,
    };
    if (sameTitle) {
      matches.push({ ...row, why: sameDuration ? '文案几乎一样、长度也一样' : '文案几乎一样' });
    } else if (sameDuration && weakTitle) {
      matches.push({ ...row, why: '长度一样、文案也有点像' });
    } else if (sameDuration) {
      weak.push(row);
    }
  }
  matches.sort((a, b) => Number(b.sameDuration) - Number(a.sameDuration) || b.similarity - a.similarity);
  const dup = matches[0] ?? null;
  return {
    dup,
    matches: matches.slice(0, 3),
    weak: weak.slice(0, 3),
    reason: dup ? `主页已经有这条了：「${dup.desc}」（${dup.why}，作品 ${dup.id}）` : '',
  };
}

/**
 * 这个文件以前发过没有？（本地账本 data/douyin/published.jsonl）
 * 只看铁证：字节一样，或者抽样帧是同一段画面。长度一样不算。
 * @param {{print?: {sha256?: string, frames?: string[], durationMs?: number}, registry?: Array<object>}} args
 */
export function findDuplicatePublish({ print = {}, registry = [] } = {}) {
  const sha256 = String(print?.sha256 ?? '');
  const frames = Array.isArray(print?.frames) ? print.frames : [];
  const duration = Number(print?.durationMs) || 0;
  const matches = [];
  const weak = [];
  for (const row of registry ?? []) {
    if (!row) continue;
    const sameFile = Boolean(sha256) && String(row.sha256 ?? '') === sha256;
    const sameFrames = sameFootage(frames, row.frames);
    const sameDuration = duration > 0 && Number(row.durationMs) > 0 && Math.abs(duration - Number(row.durationMs)) <= DUP_DURATION_MS;
    const entry = {
      id: String(row.id ?? ''),
      title: shortDesc(row.title),
      at: Number(row.at) || 0,
      sameFile,
      sameFrames,
      sameDuration,
    };
    if (sameFile || sameFrames) {
      matches.push({ ...entry, why: sameFile ? '文件一模一样' : '片子内容一样（重新编码过也认得出）' });
    } else if (sameDuration) {
      weak.push(entry);
    }
  }
  matches.sort(
    (a, b) => Number(b.sameFile) - Number(a.sameFile) || Number(b.sameFrames) - Number(a.sameFrames) || b.at - a.at,
  );
  const dup = matches[0] ?? null;
  return {
    dup,
    matches: matches.slice(0, 3),
    weak: weak.slice(0, 3),
    reason: dup
      ? `这条以前发过：「${dup.title}」（${dup.why}${dup.id ? `，作品 ${dup.id}` : ''}）`
      : '',
  };
}
