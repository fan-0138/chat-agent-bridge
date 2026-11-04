/**
 * 「她今天干了什么」——把散在 data/ 各处的记录拼成一条时间线。
 *
 *   import { collectTrail } from './trail.js';
 *   const items = await collectTrail({ root: process.cwd(), limit: 60 });
 *   // [{ at, kind, title, detail?, source }, ...] 按时间倒序
 *
 * 只读、不抛错：缺文件、坏 JSON、坏行、字段缺失都当没看见。
 */

import { open, readFile } from 'node:fs/promises';
import { join } from 'node:path';

const HOUR = 3_600_000;
const WINDOW_MS = 48 * HOUR; // 默认只看最近 48 小时
const DEDUP_MS = 15 * 60_000; // 同 kind + 同标题前 20 字，15 分钟内只留一条
const TITLE_KEY_CHARS = 20;
const TAIL_BYTES = 512 * 1024; // seen.jsonl 很大，只读尾巴

/**
 * @typedef {{ at: number, kind: string, title: string, detail?: string, source: string, ok?: boolean }} TrailItem
 */

/** 一行一个 JSON：只读文件尾部 limit 行，坏行静默跳过。 */
async function readJsonlTail(file, limit = 200) {
  let handle = null;
  try {
    handle = await open(file, 'r');
    const { size } = await handle.stat();
    if (!size) return [];
    const start = Math.max(0, size - TAIL_BYTES);
    const length = size - start;
    const buffer = Buffer.allocUnsafe(length);
    await handle.read(buffer, 0, length, start);
    let text = buffer.toString('utf8');
    if (start > 0) {
      // 第一行可能是半截，丢掉
      const cut = text.indexOf('\n');
      text = cut >= 0 ? text.slice(cut + 1) : '';
    }
    const rows = [];
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        rows.push(JSON.parse(trimmed));
      } catch {
        /* 坏行跳过 */
      }
    }
    return rows.slice(-limit);
  } catch {
    return [];
  } finally {
    if (handle) await handle.close().catch(() => {});
  }
}

async function readJson(file) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return null;
  }
}

/** 压成一行、去多余空白。 */
function textOf(value) {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 截到 max 字（标题用）。 */
function cut(value, max) {
  return textOf(value).slice(0, max);
}

/** 毫秒时间戳；ISO 字符串 / 数字 / 数字字符串都认，认不出返回 0。 */
function timeOf(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  const text = String(value ?? '').trim();
  if (!text) return 0;
  if (/^\d+$/.test(text)) return Number(text);
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? parsed : 0;
}

function numberOr(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/** 统一形状；detail 没内容就不带这个字段。 */
function item(at, kind, title, source, detail) {
  const row = { at, kind, title, source };
  if (detail) row.detail = detail;
  return row;
}

/** 抖音链接里抠视频 id（评论记录里只有 url，靠它找作者）。 */
function videoIdOf(url) {
  const match = String(url ?? '').match(/\/(?:video|note|slides)\/(\d+)/) || String(url ?? '').match(/\d{6,}/);
  return match ? match[1] : '';
}

/** 游戏记录拼一句标题。 */
function gameTitle(row) {
  const minutes = numberOr(row.minutes);
  const turns = numberOr(row.turns);
  // goal 常常带一长串坐标（"地板已经铺在 x=871~873、z=-194~-192 这一层"），
  // 时间线上只留一句人话：括号里的坐标去掉，太长就截断
  const goalRaw = String(row.goal ?? '').replace(/（[^）]*）/g, '').replace(/[(][^)]*[)]/g, '').trim();
  const goal = cut(goalRaw, 24);
  const base = minutes > 0 ? `在游戏里玩了 ${minutes} 分钟` : '在游戏里转了一圈';
  if (goal) return `${base}：${goal}`;
  return turns > 0 ? `${base}，动了 ${turns} 下` : base;
}

/** 游戏记录的位置 + 背包前两样。 */
function gameDetail(row) {
  const parts = [];
  const position = row.position;
  if (position && typeof position === 'object') {
    const x = numberOr(position.x, NaN);
    const y = numberOr(position.y, NaN);
    const z = numberOr(position.z, NaN);
    if ([x, y, z].every(Number.isFinite)) {
      parts.push(`位置 (${Math.round(x)}, ${Math.round(y)}, ${Math.round(z)})`);
    }
  }
  const bag = (Array.isArray(row.inventory) ? row.inventory : [])
    .filter((entry) => entry && textOf(entry.name) && numberOr(entry.count) > 0)
    .slice(0, 2)
    .map((entry) => `${textOf(entry.name)}×${numberOr(entry.count)}`);
  if (bag.length > 0) parts.push(`背包 ${bag.join('、')}`);
  return parts.join(' · ');
}

/**
 * 收一条时间线。
 * @param {{ root?: string, now?: number, limit?: number }} [options]
 * @returns {Promise<TrailItem[]>}
 */
export async function collectTrail({ root = process.cwd(), now = Date.now(), limit = 80 } = {}) {
  try {
    const base = String(root || process.cwd());
    const clock = numberOr(now, Date.now());
    const max = Math.max(0, Math.floor(numberOr(limit, 80)));
    if (max === 0) return [];

    const [seen, thoughts, memories, comments, sessions, qzoneRows, state, commentResult, mindState, pats, invites] = await Promise.all([
      readJsonlTail(join(base, 'data/douyin/seen.jsonl'), 200),
      readJsonlTail(join(base, 'data/mind/stream.jsonl'), 300),
      readJsonlTail(join(base, 'data/mind/memory.jsonl'), 200),
      readJsonlTail(join(base, 'data/mind/comments.jsonl'), 200),
      readJsonlTail(join(base, 'data/mc/sessions.jsonl'), 200),
      readJsonlTail(join(base, 'data/qq/qzone-posts.jsonl'), 200),
      readJson(join(base, 'data/life/state.json')),
      readJson(join(base, 'data/douyin/comment-result.json')),
      readJson(join(base, 'data/mind/state.json')),
      readJsonlTail(join(base, 'data/mind/touch.jsonl'), 100),
      readJsonlTail(join(base, 'data/mind/invite.jsonl'), 60),
    ]);

    // 视频 id → 作者，给评论记录补 @作者 用（认不出就省略）
    const authors = new Map();
    for (const row of seen) {
      const id = textOf(row?.id);
      const author = textOf(row?.author);
      if (id && author) authors.set(id, author);
    }

    /** @type {TrailItem[]} */
    const rows = [];

    // 她想的事：think → thought，dream → dream
    for (const row of thoughts) {
      if (!row || typeof row !== 'object') continue;
      const kind = row.kind === 'think' ? 'thought' : row.kind === 'dream' ? 'dream' : '';
      if (!kind) continue;
      const at = timeOf(row.at);
      const title = cut(row.text, 80);
      if (!at || !title) continue;
      const detail = [textOf(row.mood), row.action && row.action !== 'none' ? `动作：${textOf(row.action)}` : '']
        .filter(Boolean)
        .join(' · ');
      rows.push(item(at, kind, title, 'stream.jsonl', detail));
    }

    // 她自己记下的事
    for (const row of memories) {
      if (!row || typeof row !== 'object') continue;
      const at = timeOf(row.at);
      const title = cut(row.text, 120);
      if (!at || !title) continue;
      rows.push(item(at, 'note', title, 'memory.jsonl'));
    }

    // 她去评论区说的话
    for (const row of comments) {
      if (!row || typeof row !== 'object') continue;
      const at = timeOf(row.at);
      const title = cut(row.text, 80);
      if (!at || !title) continue;
      const url = textOf(row.url);
      const author = textOf(row.author) || authors.get(videoIdOf(url)) || '';
      const detail = [url, author ? `@${author}` : '', row.ok === false ? '没发出去' : '']
        .filter(Boolean)
        .join(' · ');
      const entry = item(at, 'comment', title, 'comments.jsonl', detail);
      if (typeof row.ok === 'boolean') entry.ok = row.ok; // 页面按 ok=false 标红
      rows.push(entry);
    }

    // 她去玩游戏
    for (const row of sessions) {
      if (!row || typeof row !== 'object') continue;
      const at = timeOf(row.startedAt);
      if (!at) continue;
      rows.push(item(at, 'game', cut(gameTitle(row), 80), 'sessions.jsonl', gameDetail(row)));
    }

    // 她发的说说（字段可能是 content 或 text）
    for (const row of qzoneRows) {
      if (!row || typeof row !== 'object') continue;
      const at = timeOf(row.at);
      const body = textOf(row.content ?? row.text);
      if (!at || !body) continue;
      rows.push(item(at, 'qzone', cut(body, 80), 'qzone-posts.jsonl'));
    }

    // 你摸了她头：她的反应也算她的一部分，不是只记着玩
    for (const row of pats) {
      if (!row || typeof row !== 'object') continue;
      const at = timeOf(row.at);
      const title = textOf(row.line);
      if (!at || !title) continue;
      const detail = Number(row.streak) >= 3 ? '连着摸了好几下' : row.scene === 'sleep' ? '她在睡' : '';
      rows.push(item(at, 'pat', title, 'touch.jsonl', detail));
    }

    // 她约爸爸一起做件事，以及他的回应
    for (const row of invites) {
      if (!row || typeof row !== 'object') continue;
      const text = textOf(row.text);
      const status = textOf(row.status);
      if (!text) continue;
      const at = timeOf(row.at);
      const when = timeOf(row.doneAt) || timeOf(row.answeredAt) || at;
      if (!at || !when) continue;
      const label = { pending: '她开口约了', accepted: '他答应了', later: '他说改天', done: '一起做完了', expired: '没约成' }[status] ?? '';
      rows.push(item(when, 'invite', label ? `${label}：${cut(text, 60)}` : cut(text, 80), 'invite.jsonl'));
    }

    // 她刷到 / 搜到的视频
    for (const row of seen) {
      if (!row || typeof row !== 'object') continue;
      const at = timeOf(row.seenAt) || timeOf(row.at);
      const title = cut(row.desc, 60);
      if (!at || !title) continue;
      const author = textOf(row.author);
      rows.push(item(at, 'video', title, 'seen.jsonl', author ? `@${author}` : ''));
    }

    // 最近一次评论结果
    if (commentResult && typeof commentResult === 'object') {
      const at = timeOf(commentResult.at);
      const title = cut(commentResult.comment, 80);
      if (at && title) {
        const entry = item(at, 'comment', title, 'comment-result.json', commentResult.ok === false ? '失败' : '成功');
        if (typeof commentResult.ok === 'boolean') entry.ok = commentResult.ok;
        rows.push(entry);
      }
    }

    // 她此刻的活动：只有一条，没有 activitySince 就跳过
    if (state && typeof state === 'object') {
      const at = timeOf(state.activitySince);
      const title = cut(state.activity, 80);
      // 过了 TTL 的活动就别再当成「她此刻在做的事」了
      const ttlMin = numberOr(state.activityTtlMin);
      const fresh = !(ttlMin > 0) || (at > 0 && clock - at <= ttlMin * 60_000);
      if (at && title && fresh) rows.push(item(at, 'browse', title, 'state.json'));
    }

    // 她给自己定的打算
    const plan = mindState && typeof mindState === 'object' ? mindState.plan : null;
    if (plan && typeof plan === 'object' && plan.text) {
      const at = timeOf(plan.at);
      const day = textOf(plan.day);
      const title = `明天打算：${cut(String(plan.text), 60)}`;
      if (at) rows.push(item(at, 'plan', title, 'mind/state.json', day ? `给 ${day}` : ''));
    }

    // 时间窗口 → 时间倒序 → 15 分钟去重 → limit
    const recent = rows.filter((row) => row.at > 0 && clock - row.at <= WINDOW_MS).sort((a, b) => b.at - a.at);
    const lastAtByKey = new Map();
    const out = [];
    for (const row of recent) {
      const key = `${row.kind}|${row.title.slice(0, TITLE_KEY_CHARS)}`;
      const previousAt = lastAtByKey.get(key);
      lastAtByKey.set(key, row.at); // 记下最新一次（包括被丢的），整串刷屏一起塌掉
      if (previousAt !== undefined && previousAt - row.at <= DEDUP_MS) continue;
      out.push(row);
      if (out.length >= max) break;
    }
    return out;
  } catch {
    return [];
  }
}