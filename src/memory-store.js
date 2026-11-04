/**
 * 她的记忆结构。
 *
 * 为什么要有这一层：之前的「记忆」是两样东西——聊天上下文（滚动窗口，几十轮）和
 * data/mind/memory.jsonl（她说「记住」才写一条）。前者一滚就没，后者 64 轮独处里
 * 一次都没触发过。结果是她只有最近几小时，几小时之外的事等于没发生过。
 *
 * 这里补两层，加一个检索：
 *  - 情景记忆 episodes：有日期的事（一起看了月亮、被摸头、吃了火锅、谁说了句什么）
 *  - 语义记忆 facts：稳定的事（爸爸爱吃什么、她怕什么），按 关于+什么 去重，新的盖旧的
 *  - recall：聊天时按他这句话，把相关的旧事捞回来，拼成 prompt 里的一小段
 *
 * 写这两层的是 memory-digest.js（每天睡前把当天压成几条），代价一天一次模型调用。
 * 边界：它只解决「记得住、捞得回来」，不假装有回溯体验——记忆是记录，不是回忆。
 */

import { appendFile, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { localDay } from './life.js';

const DAY = 86_400_000;
const MAX_EPISODES = 600;

export const MEMORY_DIR = 'data/memory';
export const EPISODES_FILE = 'data/memory/episodes.jsonl';
export const FACTS_FILE = 'data/memory/facts.jsonl';
export const META_FILE = 'data/memory/state.json';
export const CHANGES_FILE = 'data/memory/changes.jsonl';

/** 检索时当噪声的中文二字词：命中它们不算「想起」。 */
const STOP_GRAMS = new Set([
  '就是', '这个', '那个', '什么', '怎么', '没有', '不是', '还是', '可以', '然后', '因为',
  '所以', '现在', '时候', '一下', '有点', '觉得', '知道', '看看', '我们', '你们', '他们',
  '今天', '明天', '昨天', '刚才', '已经', '真的', '其实', '不过', '但是', '如果', '这样',
  '那样', '一样', '东西', '事情', '起来', '出来', '进去', '回去', '一个', '两个', '自己',
  '还是', '还要', '一直', '可能', '应该', '整个', '反正', '算了', '干脆', '好像', '有点',
  '在吗', '不在', '干嘛', '了吗', '你好', '您好', '哈哈', '嗯嗯', '晚安', '早安',
]);

/** 中文 bigram + 英文/数字词。检索只做粗匹配，不追求语义。 */
export function gramsOf(text) {
  const clean = String(text ?? '').toLowerCase();
  const grams = new Set();
  for (const run of clean.match(/[\u4e00-\u9fff]+/g) ?? []) {
    if (run.length === 1) {
      if (!STOP_GRAMS.has(run)) grams.add(run);
      continue;
    }
    for (let i = 0; i + 1 < run.length; i += 1) {
      const gram = run.slice(i, i + 2);
      if (!STOP_GRAMS.has(gram)) grams.add(gram);
    }
  }
  for (const word of clean.match(/[a-z0-9]{2,}/g) ?? []) grams.add(word);
  return grams;
}

/**
 * 给他的这句话找相关的旧事。纯函数，便于单测。
 * 打分：命中 bigram 数 + 覆盖率，再乘「越近越算」和「越重要越算」。
 */
export function rankCandidates({ query, candidates = [], now = Date.now(), limit = 4, minHits } = {}) {
  const wanted = gramsOf(query);
  if (wanted.size === 0) return [];
  const need = Number.isFinite(minHits) ? minHits : wanted.size >= 8 ? 2 : 1;

  const scored = [];
  for (const row of candidates) {
    const text = String(row?.text ?? '').replace(/\s+/g, ' ').trim();
    if (!text) continue;
    const grams = gramsOf(text);
    let hits = 0;
    for (const gram of wanted) if (grams.has(gram)) hits += 1;
    if (hits < need) continue;

    const at = Number(row?.at ?? 0) || 0;
    const age = at > 0 ? Math.max(0, now - at) : Infinity;
    const recency = age < DAY ? 1.4 : age < 7 * DAY ? 1.2 : age < 30 * DAY ? 1.0 : 0.8;
    const salience = 1 + Math.max(0, Math.min(5, Number(row?.salience ?? 2)) - 2) * 0.08;
    scored.push({ ...row, text, at, score: (hits + hits / wanted.size) * recency * salience });
  }

  scored.sort((a, b) => b.score - a.score || b.at - a.at);
  // 同一件事只留一条：标题前 16 个字一样就算重
  const seen = new Set();
  const out = [];
  for (const row of scored) {
    const key = row.text.replace(/\s+/g, '').slice(0, 16);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(row);
    if (out.length >= limit) break;
  }
  return out;
}

function dayLabel(at) {
  const d = new Date(Number(at));
  return Number.isFinite(d.getTime()) ? `${d.getMonth() + 1}/${d.getDate()}` : '';
}

function agoLabel(at, now) {
  const diff = Math.max(0, now - Number(at));
  if (diff < 60_000) return '刚刚';
  if (diff < DAY) return `${Math.round(diff / 3_600_000)} 小时前`;
  return `${Math.round(diff / DAY)} 天前`;
}

/** prompt 里「你记得的事」那一段；没东西就返回空串。 */
export function formatRecallSection(items, { now = Date.now() } = {}) {
  if (!Array.isArray(items) || items.length === 0) return '';
  const lines = items.map((item) => {
    const when = Number(item.at) > 0 ? `${dayLabel(item.at)} ` : '';
    return `- ${when}${String(item.text ?? '').replace(/\s+/g, ' ').trim()}`;
  });
  return [
    '[你记得的事（以前留下的，不是他刚说的）]',
    ...lines,
    '（这些是你自己的记忆。搭得上就自然接一句，别逐条复述，也别显得在背资料。）',
  ].join('\n');
}

/** 她自己一个人待着时看的「最近几天」：只当背景，不用逐条回应。 */
export function formatRecentSection(rows, { now = Date.now(), limit = 6 } = {}) {
  const picked = (Array.isArray(rows) ? rows : []).filter((row) => row && row.text).slice(0, limit);
  if (picked.length === 0) return '';
  const lines = picked.map((row) => {
    const when = Number(row.at) > 0 ? `${dayLabel(row.at)} ` : '';
    return `- ${when}${String(row.text).replace(/\s+/g, ' ').trim()}`;
  });
  return [
    '[最近几天发生过的事（你记得的，不是今天刚聊的）]',
    ...lines,
    '（这是背景，不是任务；想起来就提一句，别硬往对话里塞。）',
  ].join('\n');
}

/* ────────────────────────── 落盘 ────────────────────────── */

async function readJson(file, fallback) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return fallback;
  }
}

async function readJsonl(file, limit = 500) {
  try {
    const raw = await readFile(file, 'utf8');
    const rows = [];
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const row = JSON.parse(trimmed);
        if (row && typeof row === 'object') rows.push(row);
      } catch {
        /* 坏行跳过 */
      }
    }
    return rows.slice(-limit);
  } catch {
    return [];
  }
}

async function appendJsonl(file, row) {
  await mkdir(dirname(file), { recursive: true });
  await appendFile(file, `${JSON.stringify(row)}\n`, 'utf8');
}

/** 单行 → 对象；空白、坏 JSON、非对象一律 null（写回时按原始文本保留）。 */
function parseLine(raw) {
  const trimmed = String(raw ?? '').trim();
  if (!trimmed) return null;
  try {
    const row = JSON.parse(trimmed);
    return row && typeof row === 'object' && !Array.isArray(row) ? row : null;
  } catch {
    return null;
  }
}

function clean(text, max) {
  return String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

/** 把各种来源的行统一成「有 at、有 text、有 label」的形状。 */
function normalizeEpisode(row) {
  const at = Number(row?.at ?? 0) || 0;
  const text = clean(row?.text ?? row?.title ?? '', 160);
  if (!at || !text) return null;
  return {
    at,
    text,
    title: clean(row?.title ?? text, 40),
    kind: String(row?.kind ?? 'event'),
    people: Array.isArray(row?.people) ? row.people.map((p) => clean(p, 12)).filter(Boolean).slice(0, 5) : [],
    salience: Math.max(1, Math.min(5, Number(row?.salience ?? 2) || 2)),
  };
}

export function createMemoryStore({ root = process.cwd(), log = console, now = Date.now } = {}) {
  const dir = resolve(root, MEMORY_DIR);
  const episodesFile = resolve(root, EPISODES_FILE);
  const factsFile = resolve(root, FACTS_FILE);
  const metaFile = resolve(root, META_FILE);
  const changesFile = resolve(root, CHANGES_FILE);
  const selfNotesFile = resolve(root, 'data/mind/memory.jsonl');
  const chatDir = resolve(root, 'data/qq/memory');

  async function readEpisodes({ limit = 300, since = 0, days = 0 } = {}) {
    const rows = (await readJsonl(episodesFile, Math.max(limit, MAX_EPISODES))).map(normalizeEpisode).filter(Boolean);
    const floor = days > 0 ? now() - days * DAY : since;
    return rows.filter((row) => row.at >= floor).sort((a, b) => b.at - a.at).slice(0, limit);
  }

  async function readFacts({ subject = '' } = {}) {
    const rows = await readJsonl(factsFile, 400);
    return rows
      .filter((row) => row && typeof row === 'object' && row.text && row.subject)
      .filter((row) => !subject || row.subject === subject)
      .map((row) => ({
        subject: String(row.subject),
        key: String(row.key ?? ''),
        value: String(row.value ?? ''),
        text: String(row.text ?? `${row.subject}${row.key ?? ''}是${row.value ?? ''}`),
        at: Number(row.at ?? 0) || 0,
      }))
      .sort((a, b) => b.at - a.at);
  }

  async function readSelfNotes(limit = 200) {
    return (await readJsonl(selfNotesFile, limit))
      .map((row) => normalizeEpisode({ at: row?.at, text: row?.text, kind: 'note', salience: 2 }))
      .filter(Boolean);
  }

  /** 最近一段聊天：只取最新的那个记忆文件，尾巴 1200 行。 */
  async function readChatTail(limit = 1200) {
    let names = [];
    try {
      names = (await readdir(chatDir)).filter((name) => name.endsWith('.jsonl') && !name.includes('.bak'));
    } catch {
      return [];
    }
    let newest = { file: '', mtime: 0 };
    for (const name of names) {
      const file = join(chatDir, name);
      const info = await stat(file).catch(() => null);
      if (info && info.mtimeMs > newest.mtime) newest = { file, mtime: info.mtimeMs };
    }
    if (!newest.file) return [];
    return (await readJsonl(newest.file, limit))
      .filter((row) => row && (row.role === 'user' || row.role === 'assistant') && row.text)
      .map((row) => ({
        at: Number(row.at ?? 0) || 0,
        role: String(row.role),
        text: clean(row.text, 100),
      }))
      .filter((row) => row.at && row.text);
  }

  /**
   * 他这句话里提到的东西，她在以前哪条记录里见过。
   * 返回的 text 已经写成 prompt 里能直接读的一句。
   */
  async function recall(text, { limit = 4, at = now() } = {}) {
    const query = String(text ?? '').trim();
    if (!query) return [];
    const [episodes, facts, notes, chat] = await Promise.all([
      readEpisodes({ limit: 400 }),
      readFacts(),
      readSelfNotes(200),
      readChatTail(1200),
    ]);
    const candidates = [
      ...episodes.map((row) => ({ at: row.at, text: row.text, kind: 'episode', salience: row.salience, source: 'episodes' })),
      ...facts.map((row) => ({ at: row.at, text: `你知道：${row.text}`, kind: 'fact', salience: 3, source: 'facts' })),
      ...notes.map((row) => ({ at: row.at, text: `你自己记下：${row.text}`, kind: 'note', salience: 2, source: 'memory' })),
      ...chat.map((row) => ({
        at: row.at,
        text: `${row.role === 'user' ? '他说过' : '你说过'}：${row.text}`,
        kind: 'chat',
        salience: row.role === 'user' ? 2 : 1,
        source: 'chat',
      })),
    ];
    return rankCandidates({ query, candidates, now: at, limit });
  }

  /** 拼进对话 prompt 的那一段。 */
  async function promptSection(text, { limit = 4 } = {}) {
    const at = now();
    // 除了按他这句话去捞，固定带上最近两天的事：不然隔了一天就像失忆
    const [items, recent, notes] = await Promise.all([
      recall(text, { limit, at }).catch((error) => {
        log?.debug?.(`回忆失败：${error?.message ?? error}`);
        return [];
      }),
      readEpisodes({ limit: 3, days: 2 }).catch(() => []),
      readSelfNotes(5).catch(() => []),
    ]);
    const recentNotes = notes.slice(-3).map((row) => ({ at: row.at, text: `你自己记下：${row.text}` }));
    const merged = [];
    const seen = new Set();
    for (const row of [...items, ...recentNotes, ...recent]) {
      const text = String(row?.text ?? '').replace(/\s+/g, ' ').trim();
      if (!text) continue;
      const key = text.slice(0, 16);
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push({ ...row, text });
    }
    merged.sort((a, b) => Number(b.at ?? 0) - Number(a.at ?? 0));
    return formatRecallSection(merged.slice(0, limit + 2), { now: at });
  }

  /** 她自己在聊天里记下一句（【记住：…】），和「她自己的时间」写的是同一个文件。 */
  async function addNote({ text = '', at = now(), source = 'chat' } = {}) {
    const cleanText = clean(text, 120);
    if (!cleanText) return null;
    await mkdir(dirname(selfNotesFile), { recursive: true });
    const row = { at: Number(at) || now(), text: cleanText, kind: 'note', source: clean(source, 16) || 'chat' };
    await appendFile(selfNotesFile, `${JSON.stringify(row)}\n`, 'utf8');
    return row;
  }

  /** 她自己待着时看的：最近几天的事。 */
  async function recentEpisodes({ days = 3, limit = 6 } = {}) {
    const rows = await readEpisodes({ limit: 50, days });
    return rows.slice(0, limit);
  }

  /** 睡前整理用：追加一条情景。同一天同一件事（标题前 12 字一样）不重复写。 */
  async function addEpisode({ at = now(), kind = 'event', title = '', detail = '', people = [], salience = 2, source = 'digest' } = {}) {
    const cleanTitle = clean(title, 40);
    const when = Number(at) || now();
    if (!cleanTitle) return null;
    const day = localDay(when);
    const recent = (await readJsonl(episodesFile, 80)).slice(-40).map((row) => ({
      at: Number(row?.at ?? 0) || 0,
      title: clean(row?.title, 40),
      day: String(row?.day ?? ''),
    }));
    const duplicate = recent.find(
      (row) => row.day === day && row.title.slice(0, 12) === cleanTitle.slice(0, 12),
    );
    if (duplicate) return { at: duplicate.at, text: duplicate.title, duplicate: true };

    const record = {
      at: when,
      day,
      kind: clean(kind, 12) || 'event',
      title: cleanTitle,
      text: [cleanTitle, clean(detail, 120)].filter(Boolean).join('：'),
      detail: clean(detail, 120),
      people: Array.isArray(people) ? people.map((p) => clean(p, 12)).filter(Boolean).slice(0, 5) : [],
      salience: Math.max(1, Math.min(5, Number(salience) || 2)),
      source: clean(source, 16) || 'digest',
    };
    await appendJsonl(episodesFile, record);
    await pruneEpisodes();
    return record;
  }

  /** 事实按「关于 + 什么」去重：新说的盖掉旧的。 */
  async function upsertFact({ at = now(), subject = '爸爸', key = '', value = '', source = 'digest' } = {}) {
    const who = clean(subject, 8);
    const what = clean(key, 12);
    const body = clean(value, 40);
    if (!who || !what || !body) return null;
    const text = `${who}${what}是${body}`;
    const rows = await readJsonl(factsFile, 400);
    const index = rows.findIndex((row) => row && row.subject === who && clean(row.key, 12) === what);
    const when = Number(at) || now();
    if (index >= 0) {
      rows[index] = { ...rows[index], value: body, text, at: when, updatedAt: when, source };
    } else {
      rows.push({ subject: who, key: what, value: body, text, at: when, updatedAt: when, source });
    }
    await mkdir(dirname(factsFile), { recursive: true });
    await writeFile(factsFile, rows.map((row) => JSON.stringify(row)).join('\n') + '\n', 'utf8');
    return { subject: who, key: what, value: body, text, at: when };
  }

  /** 原始行：删除要整文件重写，坏行也得原样带回去。 */
  async function readRawLines(file) {
    try {
      const lines = (await readFile(file, 'utf8')).split('\n');
      // 正常文件以换行结尾，split 会多一个空串；去掉它，写回时才不会多出空行
      if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
      return lines;
    } catch {
      return []; // 文件不存在就当没有
    }
  }

  /** 行数组写回；全删光了就留个空文件。 */
  async function writeRawLines(file, lines) {
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, lines.length > 0 ? `${lines.join('\n')}\n` : '', 'utf8');
  }

  /** 审计：记下被划掉的是哪一条；审计写失败不能挡住删除本身。 */
  async function auditForget(action, row) {
    try {
      await appendJsonl(changesFile, { at: now(), action, row });
    } catch (error) {
      log?.debug?.(`记忆审计没写上：${error?.message ?? error}`);
    }
  }

  /**
   * 划掉一条事实：按 subject + 归一化 key 定位（和 upsertFact 的写法一致），命中删一行。
   * 命中返回 true；文件不存在、坏行、删不掉都返回 false，不抛。
   */
  async function removeFact({ subject = '', key = '' } = {}) {
    try {
      const who = clean(subject, 8);
      const what = clean(key, 12);
      if (!who || !what) return false; // 定位不了就别乱删
      const lines = await readRawLines(factsFile);
      let hit = -1;
      let hitRow = null;
      for (let i = 0; i < lines.length; i += 1) {
        const row = parseLine(lines[i]);
        if (!row) continue; // 坏行留着
        if (clean(row.subject, 8) !== who || clean(row.key, 12) !== what) continue;
        hit = i;
        hitRow = row;
        break;
      }
      if (hit < 0) return false;
      await auditForget('forget-fact', hitRow);
      lines.splice(hit, 1);
      await writeRawLines(factsFile, lines);
      return true;
    } catch (error) {
      log?.debug?.(`删事实失败：${error?.message ?? error}`);
      return false;
    }
  }

  /**
   * 划掉一条情景：按 at 精确匹配；传了 title 再校验标题前 12 字（防止删错同毫秒的）。
   * 命中返回 true；不命中、坏文件都返回 false，不抛。
   */
  async function removeEpisode({ at = 0, title = '' } = {}) {
    try {
      const when = Number(at) || 0;
      if (!when) return false; // 没有时间就没法精确认领
      const wantTitle = clean(title, 40).slice(0, 12);
      const lines = await readRawLines(episodesFile);
      let hit = -1;
      let hitRow = null;
      for (let i = 0; i < lines.length; i += 1) {
        const row = parseLine(lines[i]);
        if (!row) continue;
        if ((Number(row.at) || 0) !== when) continue;
        if (wantTitle && clean(row.title ?? row.text, 40).slice(0, 12) !== wantTitle) continue;
        hit = i;
        hitRow = row;
        break;
      }
      if (hit < 0) return false;
      await auditForget('forget-episode', hitRow);
      lines.splice(hit, 1);
      await writeRawLines(episodesFile, lines);
      return true;
    } catch (error) {
      log?.debug?.(`删情景失败：${error?.message ?? error}`);
      return false;
    }
  }

  /** 老了、又不重要的事就少留几条，别让文件无限长。 */
  async function pruneEpisodes() {
    const rows = await readJsonl(episodesFile, MAX_EPISODES + 200);
    if (rows.length <= MAX_EPISODES) return 0;
    const keep = rows.slice(-MAX_EPISODES);
    await mkdir(dirname(episodesFile), { recursive: true });
    await writeFile(episodesFile, keep.map((row) => JSON.stringify(row)).join('\n') + '\n', 'utf8');
    return rows.length - keep.length;
  }

  async function readMeta() {
    return (await readJson(metaFile, {})) ?? {};
  }

  async function saveMeta(patch = {}) {
    const meta = { ...(await readMeta()), ...patch };
    await mkdir(dirname(metaFile), { recursive: true });
    await writeFile(metaFile, `${JSON.stringify(meta, null, 2)}\n`, 'utf8');
    return meta;
  }

  async function stats() {
    const [episodes, facts, meta] = await Promise.all([readEpisodes({ limit: MAX_EPISODES }), readFacts(), readMeta()]);
    return {
      episodes: episodes.length,
      facts: facts.length,
      latestEpisodeAt: episodes[0]?.at ?? 0,
      lastDigestDay: String(meta.lastDigestDay ?? ''),
      lastDigestAt: Number(meta.lastDigestAt ?? 0) || 0,
      dir,
    };
  }

  return {
    recall,
    promptSection,
    addNote,
    recentEpisodes,
    addEpisode,
    upsertFact,
    removeFact,
    removeEpisode,
    readEpisodes,
    readFacts,
    readMeta,
    saveMeta,
    stats,
    _files: { episodesFile, factsFile, metaFile, changesFile },
  };
}