/**
 * 用量统计：一次模型调用记一行，只关心「几次、多少字、多久、成没成」。
 *
 * 为什么不算钱：模型单价随时会变，算出来的费用也是假的；
 * 先有「今天调了几次、大概多少 token」，够在额度烧穿之前发现异常。
 *
 * 数据：data/usage/usage.jsonl，一行一次调用。
 * 统计是旁路：文件缺失、坏行、写不进去一律按空处理，绝不拖累聊天。
 */

import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { localDay } from './life.js';

export const USAGE_FILE = 'data/usage/usage.jsonl';

/** 中文里 1 个字大约 1.6 个 token，估个量级就够。 */
const CHARS_PER_TOKEN = 1.6;
const DAY_MS = 24 * 3_600_000;

function numberOr(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/** now 按约定是函数（Date.now），也兼容直接给毫秒数；取不到就用当下。 */
function stampOf(now) {
  const value = typeof now === 'function' ? now() : now;
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : Date.now();
}

function rootOf(root) {
  return resolve(String(root || process.cwd()));
}

function fileOf(root) {
  return join(rootOf(root), USAGE_FILE);
}

/** 日期只认 YYYY-MM-DD；认不出就从 at 现算，别让坏字段打乱统计。 */
function dayOf(value, at) {
  const text = String(value ?? '').trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : localDay(at);
}

/** 读回来的一行 → 干净记录；缺关键字段（at / kind）就当坏行。 */
function storedRow(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const at = numberOr(raw.at, 0);
  if (!(at > 0)) return null;
  const kind = String(raw.kind ?? '').trim();
  if (!kind) return null;
  return {
    at,
    day: dayOf(raw.day, at),
    kind,
    ms: Math.max(0, numberOr(raw.ms, 0)),
    inChars: Math.max(0, numberOr(raw.inChars, 0)),
    outChars: Math.max(0, numberOr(raw.outChars, 0)),
    ok: raw.ok !== false,
  };
}

/**
 * 绑一个用途（chat / mind / pat…）：每轮调用结束调一次 record。
 * @param {{ root?: string, kind?: string, now?: (() => number) | number }} [options]
 * @returns {{ record: (input?: { ms?: number, inChars?: number, outChars?: number, ok?: boolean }) => Promise<any> }}
 */
export function createUsage({ root = process.cwd(), kind = 'unknown', now = Date.now } = {}) {
  const file = fileOf(root);
  const label = String(kind ?? '').trim() || 'unknown';
  let tail = Promise.resolve();

  async function append(row) {
    try {
      await mkdir(dirname(file), { recursive: true });
      await appendFile(file, `${JSON.stringify(row)}\n`, 'utf8');
      return row;
    } catch {
      return null; // 统计写失败不值得报错
    }
  }

  function record({ ms = 0, inChars = 0, outChars = 0, ok = true } = {}) {
    const at = stampOf(now);
    const row = {
      at,
      day: localDay(at),
      kind: label,
      ms: Math.max(0, Math.round(numberOr(ms, 0))),
      inChars: Math.max(0, Math.round(numberOr(inChars, 0))),
      outChars: Math.max(0, Math.round(numberOr(outChars, 0))),
      ok: ok !== false,
    };
    // 串行追加：同一进程里并发 record 时不会写出交叉的半行
    tail = tail.then(() => append(row));
    return tail;
  }

  return { record };
}

/**
 * 汇总最近 days 天（含今天）的用量。
 * @param {{ root?: string, now?: (() => number) | number, days?: number }} [options]
 */
export async function summarizeUsage({ root = process.cwd(), now = Date.now, days = 1 } = {}) {
  const at = stampOf(now);
  const today = localDay(at);
  const span = Math.max(1, Math.floor(numberOr(days, 1)));
  // 用 UTC 零点解析本地日期字符串，跨天差值不会被夏令时影响
  const todayStart = Date.parse(`${today}T00:00:00Z`);
  const buckets = new Map();
  const total = { calls: 0, ms: 0, chars: 0, failed: 0 };

  let lines = [];
  try {
    lines = (await readFile(fileOf(root), 'utf8')).split('\n');
  } catch {
    lines = []; // 还没记过任何一次
  }

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let raw = null;
    try {
      raw = JSON.parse(trimmed);
    } catch {
      continue; // 坏行跳过
    }
    const row = storedRow(raw);
    if (!row) continue;
    const rowStart = Date.parse(`${row.day}T00:00:00Z`);
    if (!Number.isFinite(rowStart)) continue;
    const diff = Math.round((todayStart - rowStart) / DAY_MS);
    if (diff < 0 || diff >= span) continue; // 太老或时间写歪了的不算

    let bucket = buckets.get(row.kind);
    if (!bucket) {
      bucket = { calls: 0, ms: 0, chars: 0, failed: 0 };
      buckets.set(row.kind, bucket);
    }
    const chars = row.inChars + row.outChars;
    bucket.calls += 1;
    bucket.ms += row.ms;
    bucket.chars += chars;
    if (!row.ok) bucket.failed += 1;
    total.calls += 1;
    total.ms += row.ms;
    total.chars += chars;
    if (!row.ok) total.failed += 1;
  }

  // Map → 普通对象。用 fromEntries 而不是逐键赋值，__proto__ 之类的 kind 污染不到原型。
  const entries = [...buckets.entries()].sort(([a], [b]) => a.localeCompare(b));
  return {
    day: today,
    byKind: Object.fromEntries(entries),
    total,
    estTokens: Math.round(total.chars / CHARS_PER_TOKEN),
  };
}