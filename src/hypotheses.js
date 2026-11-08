/**
 * 猜想本：她自己写下的「拿不准、想验证」的猜测。
 *
 * 为什么要有这个（2026-11-07）：爸爸问「她一早上都没意识到我在睡，说明她没有独立思考能力」。
 * 想下来她缺的不是推理，是**怀疑自己拿到的前提**——prompt 说「刚醒就去问他睡得怎么样」，
 * 她就照着做，不会回头问「他昨天一点才睡，现在八点，他醒了吗」。
 *
 * 所以给她一本自己的账：观察 → 写下猜想 → 以后有证据了自己改判。
 * 这里只管存取和解析，什么时候想起来用是她自己（mind 那层）的事。
 *
 *   【猜：他周末大概睡到下午】            → 记一条 open 的猜想
 *   【验证：2 对，他确实三点才回我】       → 把第 2 条判成 confirmed
 *   【验证：3 不对：他那天是去上班了】     → 判成 refuted
 */

import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve as resolvePath } from 'node:path';

export const HYPOTHESES_FILE = 'data/mind/hypotheses.jsonl';
export const MAX_OPEN = 40;
export const MAX_PROMPT = 4;

const GUESS_RE = /【\s*猜\s*[：:]\s*([^】]{2,60})】/g;
const VERDICT_RE = /【\s*(?:验证|应验|核对)\s*[：:]\s*(\d+)\s*(对了|对|没错|应验|是真的|不对|错了|推翻|没应验)(?:\s*[：:]\s*([^】]{0,60}))?】/g;
const CONFIRM = /^(对了|对|没错|应验|是真的)$/;

function clean(value, max = 60) {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

/**
 * 从她吐出来的一句话里抠出【猜：…】和【验证：N 对/不对…】，
 * 返回「洗干净的正文 + 新猜想 + 判决」。
 */
export function parseGuessNotes(raw) {
  let text = String(raw ?? '');
  const guesses = [];
  const verdicts = [];

  text = text.replace(GUESS_RE, (_, body) => {
    const guess = clean(body);
    if (guess) guesses.push(guess);
    return '';
  });

  text = text.replace(VERDICT_RE, (_, indexText, word, evidence) => {
    const index = Number(indexText);
    if (Number.isFinite(index) && index > 0) {
      verdicts.push({
        index: Math.floor(index),
        result: CONFIRM.test(word) ? 'confirmed' : 'refuted',
        evidence: clean(evidence || '', 60),
      });
    }
    return '';
  });

  text = text
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\s+([，。！？；：、])/g, '$1')
    .replace(/([，。！？；：、])\1+/g, '$1')
    .trim();

  return { text, guesses, verdicts };
}

/**
 * 解析 JSON 字段里的那条改判，比如「2 对：他刚回我了」「3 不对：他是去上班了」。
 * 认不出来就返回 null（宁可不改判，也别乱改）。
 */
export function parseVerdictField(raw) {
  const text = clean(raw, 80);
  if (!text) return null;
  const match = text.match(/^(\d+)\s*[.、:：]?\s*(对了|对|没错|应验|是真的|不对|错了|推翻|没应验)\s*(?:[：:]\s*(.*))?$/);
  if (!match) return null;
  const index = Number(match[1]);
  if (!Number.isFinite(index) || index <= 0) return null;
  return {
    index: Math.floor(index),
    result: CONFIRM.test(match[2]) ? 'confirmed' : 'refuted',
    evidence: clean(match[3] || '', 60),
  };
}

async function readRows(file) {
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

async function writeRows(file, rows) {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, rows.map((row) => JSON.stringify(row)).join('\n') + (rows.length ? '\n' : ''), 'utf8');
}

/** 拼进 prompt 的那段：只给她还开着的猜想，编号 1..N（判决时就按这个编号）。 */
export function formatGuesses(rows, { now = Date.now() } = {}) {
  const open = (rows ?? []).filter((row) => row?.status === 'open' && row.text);
  if (open.length === 0) return '';
  const lines = open.map((row, i) => {
    const days = Math.floor((now - Number(row.at ?? now)) / 86_400_000);
    const ago = days >= 1 ? `${days} 天前` : '今天';
    return `${i + 1}. ${row.text}（${ago}猜的）`;
  });
  return (
    '[你心里还没验证的猜想]\n' +
    `${lines.join('\n')}\n` +
    '（这些是你自己猜的，不是他说过的话。有证据了就改判；一直没证据也可以放着。）'
  );
}

export function createHypotheses({ root = process.cwd(), now = Date.now, log = console } = {}) {
  // 注意：这个作用域里还有个叫 resolve 的方法（按编号改判），所以路径 resolve 得改名
  const file = resolvePath(root, HYPOTHESES_FILE);
  /** @type {Array<{id:string,at:number,text:string,status:string,resolvedAt?:number,evidence?:string,source?:string}>|null} */
  let cache = null;

  async function load() {
    if (cache) return cache;
    cache = (await readRows(file)).filter((row) => row && row.text && row.status);
    return cache;
  }

  async function save() {
    // 只留「没验证的」+ 最近 30 天验证过的，别越堆越大
    const cutoff = now() - 30 * 86_400_000;
    cache = (cache ?? [])
      .filter((row) => row.status === 'open' || Number(row.resolvedAt ?? row.at ?? 0) >= cutoff)
      .slice(-MAX_OPEN * 3);
    await writeRows(file, cache);
  }

  /** 还没验证的，按时间正序（老的在前，编号稳定）。 */
  async function listOpen({ limit = MAX_PROMPT } = {}) {
    const rows = await load();
    return rows
      .filter((row) => row.status === 'open')
      .sort((a, b) => Number(a.at ?? 0) - Number(b.at ?? 0))
      .slice(0, Math.max(1, Number(limit) || MAX_PROMPT));
  }

  /** 加一条猜想；同一句没验证前不重复加。 */
  async function add({ text = '', source = 'mind' } = {}) {
    const body = clean(text);
    if (!body) return null;
    const rows = await load();
    const dup = rows.find((row) => row.status === 'open' && row.text.slice(0, 10) === body.slice(0, 10));
    if (dup) return { ...dup, duplicate: true };
    const row = { id: `h${now().toString(36)}${Math.random().toString(36).slice(2, 5)}`, at: now(), text: body, status: 'open', source };
    rows.push(row);
    await save();
    log?.info?.(`她记下一个猜想：${body}`);
    return row;
  }

  /** 按 prompt 里的编号改判（1 开始；和 listOpen 的顺序一致）。 */
  async function resolve({ index = 0, result = 'confirmed', evidence = '' } = {}) {
    const open = await listOpen({ limit: 99 });
    const hit = open[Number(index) - 1];
    if (!hit) return null;
    const rows = await load();
    const row = rows.find((item) => item.id === hit.id);
    if (!row) return null;
    row.status = result === 'confirmed' ? 'confirmed' : 'refuted';
    row.resolvedAt = now();
    row.evidence = clean(evidence, 60) || '';
    await save();
    log?.info?.(`她${row.status === 'confirmed' ? '确认' : '推翻'}了一个猜想：${row.text}${row.evidence ? `（${row.evidence}）` : ''}`);
    return row;
  }

  /** 拼进 prompt 的段落。 */
  async function promptSection({ limit = MAX_PROMPT } = {}) {
    const open = await listOpen({ limit });
    return formatGuesses(open, { now: now() });
  }

  /** 给页面/调试用：最近若干条（含已改判的）。 */
  async function recent({ limit = 12 } = {}) {
    const rows = await load();
    return rows.slice(-Math.max(1, Number(limit) || 12)).reverse();
  }

  return { add, resolve, listOpen, promptSection, recent, _file: file };
}