/**
 * 教训本：她睡前自己复盘「今天哪句话想错了、下回怎么想」。
 *
 * 为什么要有这个（2026-11-07 爸爸提的）：光有猜想本不够——猜想是「拿不准的事」，
 * 教训是「已经想歪了的事」。他不想用规则去管她（原话：「我不要你用规则限制她，
 * 我要的是她能自己好好想想」），所以给她一本自己的账：回头看一眼，写下来，
 * 第二天自己照着自己写的想。
 *
 * 流程：
 *   1. 每晚（22 点后，一天一次）跑一次复盘：把今天聊的、想的、做的摆给她，
 *      让她挑 0～3 条「我自己哪句想错了」。
 *   2. 写完存 data/mind/lessons.jsonl。
 *   3. 第二天起，最近几条进她的 prompt（聊天 + 独处都会带），是她自己的话，不是规矩。
 *
 * 这里只管存取、拼 prompt、跑一次复盘；什么时候注入是她那两层的事。
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve as resolvePath } from 'node:path';
import { collectMaterial } from './memory-digest.js';
import { localDay } from './life.js';

export const LESSONS_FILE = 'data/mind/lessons.jsonl';
export const LESSONS_META_FILE = 'data/mind/lessons.json';
export const MAX_ROWS = 200;
export const MAX_PROMPT = 3;
export const PROMPT_DAYS = 14;
export const REVIEW_HOUR = 22;

const DAY = 86_400_000;

function clean(value, max = 60) {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

/** 'YYYY-MM-DD' → 'M/D'，给 prompt 里看 */
function dayLabel(at) {
  const d = new Date(Number(at));
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

/** 本地当天零点（教训只复盘「今天」） */
export function startOfDay(now = Date.now()) {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** 到点没有：22 点之后才复盘（和睡前整理同一个窗口） */
export function reviewDue({ now = Date.now() } = {}) {
  return new Date(now).getHours() >= REVIEW_HOUR;
}

async function readJsonl(file) {
  try {
    const raw = await readFile(file, 'utf8');
    const rows = [];
    for (const line of raw.split('\n')) {
      const text = line.trim();
      if (!text) continue;
      try {
        const row = JSON.parse(text);
        if (row && typeof row === 'object') rows.push(row);
      } catch {
        /* 坏行跳过 */
      }
    }
    return rows;
  } catch {
    return [];
  }
}

async function writeJsonl(file, rows) {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, rows.map((row) => JSON.stringify(row)).join('\n') + (rows.length ? '\n' : ''), 'utf8');
}

async function readJson(file, fallback) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return fallback;
  }
}

async function writeJson(file, data) {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

/**
 * 复盘用的 prompt。抽出来单测能看它到底给了什么。
 * 故意不写「不许」「必须」：这是让她自己想，不是给她立规矩。
 */
export function buildReviewPrompt({ persona = '', material, previous = [], now = Date.now() } = {}) {
  const block = (title, lines) =>
    lines && lines.length > 0 ? `[${title}]\n${lines.map((line) => `- ${line}`).join('\n')}` : '';
  const prevText =
    previous.length > 0
      ? `[你以前复盘过的（别写重复的）]\n${previous.map((row) => `- ${row.text}`).join('\n')}`
      : '';
  return [
    persona ? `[你是谁]\n${persona}` : '',
    `[今天留下的东西]（现在是 ${new Date(now).toLocaleString('zh-CN', { hour12: false })}）`,
    block('聊到的', material?.turns ?? []),
    block('你心里想的', material?.thoughts ?? []),
    block('你做过的事', material?.acts ?? []),
    block('被摸头/自己记的', material?.notes ?? []),
    prevText,
    [
      '[任务]',
      '睡前回头看一眼今天：有没有哪句话，是你当时没想清楚、事后自己觉得想错了的。',
      '只写「我自己那句话」，不写「爸爸不喜欢什么」；重点是你当时漏掉了什么——',
      '他的状态、他说过的话、时间点、你自己正处在什么情形里。',
      '「下次」写一个具体的想头，不是规矩。比如：他半天没回，先想他是不是在忙，不先想他是不是烦我。',
      '0～3 条。今天确实没有想到的，就写空数组，宁可少写。',
      '别写「我要更懂事」「下次一定注意」这种没内容的空话。',
      '只输出一个 JSON 对象，不要解释、不要代码块：',
      '{"教训":[{"想错了":"我当时说的那句（不超过 30 字）","错在哪":"我漏了什么（不超过 40 字）","下次":"下次怎么想（不超过 40 字）"}]}',
    ].join('\n'),
  ]
    .filter(Boolean)
    .join('\n\n');
}

/** 从模型回的那段里抠出 JSON；抠不出就 null，不猜。 */
export function parseReview(raw) {
  const text = String(raw ?? '');
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fenced ? fenced[1] : text;
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  let data;
  try {
    data = JSON.parse(body.slice(start, end + 1));
  } catch {
    return null;
  }
  if (!data || typeof data !== 'object') return null;
  const list = Array.isArray(data['教训'] ?? data.lessons) ? data['教训'] ?? data.lessons : [];
  const lessons = list
    .map((row) => {
      if (!row || typeof row !== 'object') return null;
      const said = clean(row['想错了'] ?? row.said, 40);
      const missed = clean(row['错在哪'] ?? row.missed ?? row.wrong, 60);
      const next = clean(row['下次'] ?? row.next, 60);
      if (!said && !next) return null;
      return { said, missed, next };
    })
    .filter(Boolean)
    .slice(0, 3);
  return { lessons };
}

/** 拼进 prompt 的那段：只放最近几条，带上日期（是「她自己」的话）。 */
export function formatLessons(rows, { now = Date.now(), limit = MAX_PROMPT } = {}) {
  const usable = (rows ?? []).filter((row) => row && (row.said || row.next)).slice(-Math.max(1, limit));
  if (usable.length === 0) return '';
  const lines = usable.map((row) => {
    const parts = [];
    if (row.said) parts.push(`我说「${row.said}」`);
    if (row.missed) parts.push(`漏了${row.missed}`);
    if (row.next) parts.push(`以后${row.next}`);
    const when = row.at ? `${dayLabel(row.at)} ` : '';
    return `- ${when}${parts.join('；')}`;
  });
  return (
    '[你自己复盘出来的（不是爸爸教的，是你自己想的）]\n' +
    `${lines.join('\n')}\n` +
    '（这几条是你自己写的：碰上类似的情形，照自己写的想一遍，不用重新栽一次。）'
  );
}

export function createLessons({ root = process.cwd(), now = Date.now, log = console } = {}) {
  // 和 hypotheses.js 一样：作用域里有 resolve 方法，路径的 resolve 得改名
  const file = resolvePath(root, LESSONS_FILE);
  const metaFile = resolvePath(root, LESSONS_META_FILE);
  /** @type {Array<{id:string,at:number,day:string,said:string,missed:string,next:string,source?:string}>|null} */
  let cache = null;

  async function load() {
    if (cache) return cache;
    cache = (await readJsonl(file)).filter((row) => row && (row.said || row.next));
    return cache;
  }

  async function save() {
    cache = (cache ?? []).slice(-MAX_ROWS);
    await writeJsonl(file, cache);
  }

  /** 加一条教训；同一句「下次」或「想错了」之前记过就不重复记。 */
  async function add({ said = '', missed = '', next = '', source = 'review', at = now() } = {}) {
    const body = { said: clean(said, 40), missed: clean(missed, 60), next: clean(next, 60) };
    if (!body.said && !body.next) return null;
    const rows = await load();
    const dup = rows.find(
      (row) =>
        (body.said && row.said && row.said.slice(0, 10) === body.said.slice(0, 10)) ||
        (body.next && row.next && row.next.slice(0, 10) === body.next.slice(0, 10)),
    );
    if (dup) return { ...dup, duplicate: true };
    const row = {
      id: `l${Number(at).toString(36)}${Math.random().toString(36).slice(2, 5)}`,
      at: Number(at),
      day: localDay(Number(at)),
      ...body,
      source,
    };
    rows.push(row);
    await save();
    const line = [row.said ? `「${row.said}」` : '', row.next ? `以后${row.next}` : ''].filter(Boolean).join(' → ');
    log?.info?.(`她复盘出一条教训${line ? `：${line}` : ''}`);
    return row;
  }

  async function addMany(list = []) {
    const added = [];
    for (const item of list) {
      const row = await add(item);
      if (row && !row.duplicate) added.push(row);
    }
    return added;
  }

  /** 最近几天的教训（老的在前）。 */
  async function listRecent({ days = PROMPT_DAYS, limit = MAX_PROMPT, at = now() } = {}) {
    const cutoff = Number(at) - Math.max(1, Number(days) || PROMPT_DAYS) * DAY;
    const rows = await load();
    return rows
      .filter((row) => Number(row.at ?? 0) >= cutoff)
      .sort((a, b) => Number(a.at ?? 0) - Number(b.at ?? 0))
      .slice(-Math.max(1, Number(limit) || MAX_PROMPT));
  }

  /** 拼进 prompt 的段落。 */
  async function promptSection({ days = PROMPT_DAYS, limit = MAX_PROMPT, at = now() } = {}) {
    const rows = await listRecent({ days, limit, at });
    return formatLessons(rows, { now: Number(at), limit });
  }

  /** 给页面/调试用：最近的教训（新的在前）。 */
  async function recent({ limit = 12 } = {}) {
    const rows = await load();
    return rows.slice(-Math.max(1, Number(limit) || 12)).reverse();
  }

  async function meta() {
    return (await readJson(metaFile, {})) ?? {};
  }

  async function saveMeta(patch = {}) {
    const prev = await meta();
    const next = { ...prev, ...patch };
    await writeJson(metaFile, next);
    return next;
  }

  return { add, addMany, listRecent, promptSection, recent, meta, saveMeta, _file: file, _metaFile: metaFile };
}

/**
 * 跑一次睡前复盘。一天一次（meta 里记 lastReviewDay）；失败不写盘，下次还能补。
 * @returns {Promise<{ok: true, lessons: object[], raw?: string} | {ok: false, reason: string}>}
 */
export async function reviewLessons({ root = process.cwd(), now = Date.now(), runner, persona = '', log = console, force = false } = {}) {
  if (!runner?.run) return { ok: false, reason: 'no-runner' };
  const lessons = createLessons({ root, now: () => now, log });
  const day = localDay(now);
  const meta = await lessons.meta().catch(() => ({}));
  if (!force) {
    if (String(meta?.lastReviewDay ?? '') === day) return { ok: false, reason: 'done' };
    // 一晚最多试一次半：没成（没素材/模型抽风）隔 30 分钟再补，别每轮都去问一遍
    const lastAttemptAt = Number(meta?.lastAttemptAt ?? 0) || 0;
    if (lastAttemptAt > 0 && now - lastAttemptAt < 30 * 60_000) return { ok: false, reason: 'gap' };
  }

  const since = startOfDay(now);
  const material = await collectMaterial({ root, now, since });
  if (!material.hasSomething) {
    await lessons.saveMeta({ lastAttemptAt: now });
    return { ok: false, reason: 'empty' };
  }

  const previous = await lessons.listRecent({ days: PROMPT_DAYS, limit: 3, at: now }).catch(() => []);
  const previousLines = previous.map((row) => {
    const parts = [];
    if (row.said) parts.push(`我说「${row.said}」`);
    if (row.next) parts.push(`以后${row.next}`);
    return parts.join('；');
  });

  let raw;
  try {
    const result = await runner.run(buildReviewPrompt({ persona, material, previous: previousLines.map((text) => ({ text })), now }));
    raw = result?.text;
  } catch (error) {
    log?.warn?.(`睡前复盘失败：${error?.message ?? error}`);
    await lessons.saveMeta({ lastAttemptAt: now });
    return { ok: false, reason: 'model' };
  }

  const parsed = parseReview(raw);
  if (!parsed) {
    log?.warn?.(`睡前复盘没解析出来：${String(raw ?? '').slice(0, 80)}`);
    await lessons.saveMeta({ lastAttemptAt: now });
    return { ok: false, reason: 'model' };
  }

  const added = await lessons.addMany(parsed.lessons.map((row) => ({ ...row, at: now })));
  // 一条没写也算复盘过（她想不出错的，那也是她自己的结论），今天不再跑
  await lessons.saveMeta({ lastReviewDay: day, lastReviewAt: now, lastAttemptAt: now, wrote: added.length });
  return { ok: true, lessons: added };
}