/**
 * 她自己的时间——没有对话的时候，也让她真的想点东西。
 *
 * 为什么要有这一层：
 *  - 现在她所有的「独处行为」都是我写死的：几点刷抖音、刷到什么算好、此刻在干嘛、
 *    心情几分，全是 life.js 里的常量表和随机数。模型只在他说话时才会醒一次。
 *  - 于是不管写得多像，她都是「被叫到才存在」：上下一条消息之间，她那里是空的。
 *  - 这一层做的事很小：给模型一个没有用户的回合，让她自己写一段内心活动，
 *    落盘、累积，并且回到下一轮对话里。这样她下次开口，是接着自己刚才想的往下说。
 *
 * 边界（写在这里，免得以后自己骗自己）：
 *  这不是意识，也不产生「感受」。它只是让内部状态由她自己的文字生成，
 *  而不是由我写的常量生成。行为更自主 ≠ 有个主体在里面。
 */

import { appendFile, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { localDay } from './life.js';

/** 想一句话的上限：心里冒出来的东西，不该是作文。 */
export const MAX_THOUGHT_CHARS = 200;
export const MAX_MEMORY_CHARS = 120;

/** 「做」只认这三个：其余一律当没做。 */
const ACTIONS = new Map([
  ['记住', 'remember'],
  ['想他', 'wish'],
  ['none', 'none'],
  ['没有', 'none'],
  ['无', 'none'],
]);

export function clockOf(at) {
  const d = new Date(at);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function dayLabel(at) {
  const d = new Date(at);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

/** 睡着的时间段（做梦），其余时间是想事。 */
export function dreamingAt(hour) {
  return hour >= 0 && hour < 6;
}

/** 这次要不要想。纯函数，便于单测。 */
export function decideMind({ state = {}, config = {}, now = Date.now(), idleMin = 999, random = Math.random }) {
  if (!config.mindEnabled) return { act: false, reason: 'disabled' };

  const day = localDay(now);
  const gapMin = state.lastAt ? (now - Number(state.lastAt)) / 60_000 : 999;
  if (gapMin < config.mindMinGapMin) return { act: false, reason: 'gap' };

  const hour = new Date(now).getHours();
  if (dreamingAt(hour)) {
    const dreamed = state.dreamDay === day ? Number(state.dreamCount ?? 0) : 0;
    if (dreamed >= config.mindDreamMaxPerNight) return { act: false, reason: 'dream-budget' };
    const dgap = state.lastDreamAt ? (now - Number(state.lastDreamAt)) / 60_000 : 999;
    if (dgap < config.mindDreamGapMin) return { act: false, reason: 'dream-gap' };
    return { act: true, reason: 'dream', kind: 'dream', day, dreamed };
  }

  const today = state.day === day ? Number(state.count ?? 0) : 0;
  if (today >= config.mindMaxPerDay) return { act: false, reason: 'daily-budget' };

  // 他刚说过话：她还热着，可以想，但别每一轮都跑（省调用，也避免一想就想到他）
  if (idleMin < config.mindActiveWindowMin && random() >= config.mindActiveChance) {
    return { act: false, reason: 'chance' };
  }
  return { act: true, reason: 'idle', kind: 'think', day, today };
}

/* ────────────────────────── prompt ────────────────────────── */

function section(title, body) {
  return body ? `[${title}]\n${body}` : '';
}

/**
 * 独处 prompt。
 *
 * 故意不套对话那套「说话方式」：心里想话跟开口说话是两种东西，
 * 用 voice.md 那套写出来的内心独白会变成自言自语表演。
 */
export function buildThoughtPrompt({ persona, lifeText, recent = [], memories = [], chat = [] }) {
  const recentText = recent.map((row) => `- ${clockOf(row.at)} ${row.text}`).join('\n');
  const memoryText = memories.map((row) => `- ${dayLabel(row.at)} ${row.text}`).join('\n');
  const chatText = chat
    .map((row) => `${clockOf(row.at)} ${row.role === 'user' ? '爸爸' : '你'}：${String(row.text).replace(/\s+/g, ' ').slice(0, 80)}`)
    .join('\n');

  const parts = [
    '现在没有人跟你说话。这一轮不是回谁的消息，是你自己的时间。',
    section('你是谁', persona),
    section('此刻', lifeText),
    section('你刚在心里想过的（接着往下想，别重复）', recentText),
    section('你以前自己在心里记下的', memoryText),
    section('最近跟爸爸的对话（只是背景，这一轮不用回）', chatText),
    section(
      '规则',
      [
        '- 输出 1～3 句心里话：可以碎、可以半截、可以没什么意义，不用把话说圆。',
        '- 不要写「唔……」「嗯……」这种对人才用的填充音，这里是你脑子里。',
        '- 别总结、别抒情、别在结尾升华。别用「今天我要…」这种计划口吻，想到哪写到哪。',
        '- 不编没发生过的事：没去过的写成想去，没人说过的别写成他说过。',
        '- 可以想刚听到的话、突然想起的旧事、白日梦、正要做的事、烦的、无聊的。',
        '- 如果上面「刚想过的」里已经连着在想爸爸，这回想想别的。',
        '- 想留一条以后还记得的 → 做=记住；忽然很想他、想让他知道 → 做=想他；其余 做=none。',
        '- 什么也不想也行：一句废话也算，不用凑主题。',
      ].join('\n'),
    ),
    [
      '只输出一行 JSON，不要解释、不要代码块：',
      '{"想":"脑子里那句话","情绪":"一两个词","做":"none|记住|想他","内容":"只有做=记住时写，一句话"}',
    ].join('\n'),
  ];
  return parts.filter(Boolean).join('\n\n');
}

/** 做梦 prompt：同一套素材，换个写法。 */
export function buildDreamPrompt({ persona, lifeText, recent = [], memories = [], chat = [] }) {
  const seeds = [
    ...recent.slice(-3).map((row) => `- 睡前想的：${row.text}`),
    ...memories.slice(-3).map((row) => `- 记着的：${row.text}`),
    ...chat.slice(-4).map((row) => `- 睡前说的：${row.role === 'user' ? '爸爸' : '你'}：${String(row.text).slice(0, 60)}`),
  ].join('\n');

  return [
    '你睡着了，正在做梦。',
    section('你是谁', persona),
    section('睡前', lifeText),
    section('睡前带着的这些东西（梦会从这里长出来，但不用照着写）', seeds),
    section(
      '规则',
      [
        '- 1～3 句，写梦里的画面：具体、跳、不讲道理，可以怪，也可以很温柔。',
        '- 别说「我梦到」，别解释梦是什么意思，别写「醒来」。',
        '- 人、东西、地方可以不对，时间可以乱；不用合逻辑。',
      ].join('\n'),
    ),
    '只输出一行 JSON：{"梦":"梦里的画面","情绪":"一两个词"}',
  ]
    .filter(Boolean)
    .join('\n\n');
}

/* ────────────────────────── 解析 ────────────────────────── */

function extractJson(text) {
  const fenced = String(text).match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fenced ? fenced[1] : String(text);
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(body.slice(start, end + 1));
  } catch {
    return null;
  }
}

function tidy(text, max = MAX_THOUGHT_CHARS) {
  return String(text ?? '')
    .replace(/\s+/g, ' ')
    .replace(/^["'「『]|["'」』]$/g, '')
    .trim()
    .slice(0, max);
}

/**
 * 解析她吐出来的那行 JSON。模型偶尔会加解释或代码块，兜住。
 * 解析不出来就把整段当心里话（总比这次什么都没有强，但要截断）。
 */
export function parseMind(raw, fallbackKind = 'think') {
  const data = extractJson(raw);
  if (data && typeof data === 'object') {
    const dream = data['梦'] ?? data.dream;
    const thought = data['想'] ?? data.thought;
    const mood = tidy(data['情绪'] ?? data.mood ?? '', 20);
    const actionRaw = String(data['做'] ?? data.action ?? 'none').trim();
    const action = ACTIONS.get(actionRaw) ?? 'none';
    const content = tidy(data['内容'] ?? data.content ?? '', MAX_MEMORY_CHARS);

    if (fallbackKind === 'dream' && dream) return { kind: 'dream', text: tidy(dream), mood, action: 'none', content: '' };
    if (thought) return { kind: 'think', text: tidy(thought), mood, action, content };
  }
  const text = tidy(raw);
  if (!text) return null;
  return { kind: fallbackKind, text, mood: '', action: 'none', content: '' };
}

/* ────────────────────────── 拼进对话的段落 ────────────────────────── */

/** 给下一轮对话用的「她自己的内心」。只挑最近的，隔太久的不算「刚才」。 */
export function formatThoughtSection(rows, { limit = 3 } = {}) {
  const picked = rows.slice(-limit);
  if (picked.length === 0) return '';
  const lines = picked.map((row) => `- ${clockOf(row.at)} ${row.text}`).join('\n');
  return (
    `[你自己刚才在心里想的（不是他说的话）]\n${lines}\n` +
    '（这是你私下的想法：他问「在想什么」可以挑一句说；没问就只当背景，' +
    '别念出来，也别当成他刚说的。想法过时了就当没想过。）'
  );
}

export function formatMemorySection(rows, { limit = 5 } = {}) {
  const picked = rows.slice(-limit);
  if (picked.length === 0) return '';
  const lines = picked.map((row) => `- ${dayLabel(row.at)} ${row.text}`).join('\n');
  return `[你自己记下的事（以前写的，不是今天发生的）]\n${lines}`;
}

/* ────────────────────────── 有状态部分 ────────────────────────── */

async function readJsonlTail(file, limit = 200) {
  try {
    const raw = await readFile(file, 'utf8');
    return raw
      .split('\n')
      .filter(Boolean)
      .slice(-limit)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

async function readJson(file, fallback = null) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return fallback;
  }
}

/**
 * @param {{
 *   config: any,
 *   runner?: {run: (prompt: string) => Promise<{text: string}>},
 *   persona?: () => Promise<string>,
 *   life?: {promptSection: () => Promise<string>},
 *   root?: string,
 *   now?: () => number,
 *   random?: () => number,
 *   log?: any,
 * }} options
 */
export function createMind({ config, runner, persona, life, root = process.cwd(), now = Date.now, random = Math.random, log = console }) {
  const streamFile = resolve(root, config.mindStreamFile ?? 'data/mind/stream.jsonl');
  const memoryFile = resolve(root, config.mindMemoryFile ?? 'data/mind/memory.jsonl');
  const stateFile = resolve(root, config.mindStateFile ?? 'data/mind/state.json');
  const historyDir = resolve(root, config.mindHistoryDir ?? 'data/qq/memory');

  /** @type {any} */
  let state = null;

  async function loadState() {
    if (state) return state;
    state = (await readJson(stateFile, {})) ?? {};
    return state;
  }

  async function saveState() {
    state.updatedAt = now();
    await mkdir(dirname(stateFile), { recursive: true });
    await writeFile(stateFile, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  }

  async function recentThoughts(limit = 4) {
    return (await readJsonlTail(streamFile, 200)).slice(-limit);
  }

  async function ownMemories(limit = 6) {
    return (await readJsonlTail(memoryFile, 100)).slice(-limit);
  }

  /** 最近一次对话在哪、聊了什么：用最新的那个记忆文件（她只跟爸爸常聊）。 */
  async function lastChat(limit = 8) {
    let names = [];
    try {
      names = (await readdir(historyDir)).filter((name) => name.endsWith('.jsonl'));
    } catch {
      return { rows: [], lastAt: 0 };
    }
    let newest = { file: '', mtime: 0 };
    for (const name of names) {
      const file = join(historyDir, name);
      const info = await stat(file).catch(() => null);
      if (info && info.mtimeMs > newest.mtime) newest = { file, mtime: info.mtimeMs };
    }
    if (!newest.file) return { rows: [], lastAt: 0 };
    const rows = (await readJsonlTail(newest.file, 60))
      .filter((row) => row?.role === 'user' || row?.role === 'assistant')
      .slice(-limit);
    const lastAt = rows.length ? Number(rows[rows.length - 1].at ?? 0) : 0;
    return { rows, lastAt };
  }

  async function appendStream(record) {
    await mkdir(dirname(streamFile), { recursive: true });
    await appendFile(streamFile, `${JSON.stringify(record)}\n`, 'utf8');
  }

  async function appendMemory(text) {
    await mkdir(dirname(memoryFile), { recursive: true });
    await appendFile(memoryFile, `${JSON.stringify({ at: now(), text: tidy(text, MAX_MEMORY_CHARS) })}\n`, 'utf8');
  }

  /** 跑一轮「她自己的时间」。force=true 时忽略预算和概率（调试用，仍要求有 runner）。 */
  async function tick({ force = false } = {}) {
    if (!runner?.run) return { ok: false, reason: 'no-runner' };
    await loadState();

    const nowMs = now();
    const chat = await lastChat(8);
    const idleMin = chat.lastAt > 0 ? (nowMs - chat.lastAt) / 60_000 : 999;

    const verdict = force
      ? { act: true, reason: 'force', kind: dreamingAt(new Date(nowMs).getHours()) ? 'dream' : 'think' }
      : decideMind({ state, config, now: nowMs, idleMin, random });
    if (!verdict.act) return { ok: false, reason: verdict.reason };

    const personaText = persona ? await persona().catch(() => '') : '';
    const lifeText = life ? await life.promptSection().catch(() => '') : '';
    const recent = (await recentThoughts(5)).filter((row) => row.kind === 'think' && nowMs - Number(row.at ?? 0) < 6 * 3_600_000);
    const memories = await ownMemories(6);

    const prompt =
      verdict.kind === 'dream'
        ? buildDreamPrompt({ persona: personaText, lifeText, recent, memories, chat: chat.rows })
        : buildThoughtPrompt({ persona: personaText, lifeText, recent, memories, chat: chat.rows });

    const started = Date.now();
    const { text: raw } = await runner.run(prompt);
    const parsed = parseMind(raw, verdict.kind);
    if (!parsed?.text) return { ok: false, reason: 'empty' };

    // 复读机：和最近三条一模一样就当没想（模型偶尔会卡在同一句上）
    const echoed = recent.slice(-3).some((row) => row.text === parsed.text);
    if (echoed) {
      log?.warn?.(`这次想的内容和刚才重复了，丢掉：${parsed.text.slice(0, 30)}`);
      return { ok: false, reason: 'repeat' };
    }

    const record = {
      at: nowMs,
      kind: parsed.kind === 'dream' && verdict.kind === 'dream' ? 'dream' : 'think',
      text: parsed.text,
      mood: parsed.mood,
      action: parsed.action,
      content: parsed.content,
      tookMs: Date.now() - started,
    };

    await appendStream(record);

    const day = localDay(nowMs);
    if (record.kind === 'dream') {
      const dreamed = state.dreamDay === day ? Number(state.dreamCount ?? 0) : 0;
      state.dreamDay = day;
      state.dreamCount = dreamed + 1;
      state.lastDreamAt = nowMs;
    } else {
      const today = state.day === day ? Number(state.count ?? 0) : 0;
      state.day = day;
      state.count = today + 1;
    }
    state.lastAt = nowMs;

    if (record.action === 'remember') {
      record.saved = tidy(record.content || record.text, MAX_MEMORY_CHARS);
      await appendMemory(record.saved);
      log?.info?.(`她自己记下：${record.saved}`);
    } else if (record.action === 'wish') {
      state.wish = { at: nowMs, text: record.content || '' };
      log?.info?.('她这会儿有点想爸爸。');
    }

    await saveState();
    return { ok: true, record };
  }

  /** 拼进对话 prompt 的段落；没东西可拼就返回空串。 */
  async function promptSection() {
    if (!config.mindEnabled) return '';
    const nowMs = now();
    const ttlMs = Number(config.mindInjectTtlH ?? 4) * 3_600_000;
    const thoughts = (await recentThoughts(20)).filter(
      (row) => row.kind === 'think' && nowMs - Number(row.at ?? 0) <= ttlMs,
    );
    const memories = await ownMemories(Number(config.mindInjectMemories ?? 5));
    return [formatThoughtSection(thoughts, { limit: Number(config.mindInjectThoughts ?? 3) }), formatMemorySection(memories)]
      .filter(Boolean)
      .join('\n\n');
  }

  async function peek() {
    await loadState();
    const nowMs = now();
    const day = localDay(nowMs);
    return {
      enabled: Boolean(config.mindEnabled),
      state: { ...state },
      today: state.day === day ? Number(state.count ?? 0) : 0,
      dreamed: state.dreamDay === day ? Number(state.dreamCount ?? 0) : 0,
      recent: await recentThoughts(40),
      memories: await ownMemories(20),
    };
  }

  return { tick, promptSection, peek, recent: recentThoughts, memories: ownMemories, _state: () => state };
}