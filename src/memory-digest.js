/**
 * 睡前整理：把今天压成一两条能留得住的东西。
 *
 * 为什么不是「实时记住」：聊天里逐句提炼既费钱又会把记忆写成流水账。
 * 一天一次，用当天剩下的素材（聊了什么、想了什么、吃了什么、做了什么）让她自己写
 * 1～4 件「以后还想得起的事」和 0～3 条「稳定的、以后还用得上的事实」。
 *
 * 写进 memory-store 的两层：episodes（情景）、facts（事实）。
 * 白天每 4 小时可以整理一次，夜里 22 点后再整理一次；失败不写盘、不标记完成，下次还能补。
 */

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { localDay } from './life.js';
import { createMemoryStore } from './memory-store.js';

const DAY = 86_400_000;
const MAX_MATERIAL_TURNS = 40;

async function readJsonl(file, limit = 200) {
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

async function readJson(file, fallback) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function clean(text, max) {
  return String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

/**
 * 攒今天的素材。缺文件就当没有——一天全是空白也允许（只是不会调模型）。
 * @returns {Promise<{ turns: string[], thoughts: string[], meals: string[], acts: string[], notes: string[], hasSomething: boolean }>}
 */
export async function collectMaterial({ root = process.cwd(), now = Date.now(), since: sinceArg = 0 } = {}) {
  const since = Number(sinceArg) > 0 ? Number(sinceArg) : now - DAY;
  const today = localDay(now);

  // 聊天：只取最新的记忆文件
  let turns = [];
  try {
    const { readdir, stat } = await import('node:fs/promises');
    const dir = resolve(root, 'data/qq/memory');
    const names = (await readdir(dir)).filter((name) => name.endsWith('.jsonl') && !name.includes('.bak'));
    let newest = { file: '', mtime: 0 };
    for (const name of names) {
      const file = resolve(dir, name);
      const info = await stat(file).catch(() => null);
      if (info && info.mtimeMs > newest.mtime) newest = { file, mtime: info.mtimeMs };
    }
    if (newest.file) {
      turns = (await readJsonl(newest.file, 600))
        .filter((row) => row && Number(row.at ?? 0) >= since && (row.role === 'user' || row.role === 'assistant'))
        .map((row) => `${row.role === 'user' ? '他说' : '你说'}：${clean(row.text, 60)}`)
        .filter(Boolean)
        .slice(-MAX_MATERIAL_TURNS);
    }
  } catch {
    /* 没有聊天记忆 */
  }

  const thoughts = (await readJsonl(resolve(root, 'data/mind/stream.jsonl'), 200))
    .filter((row) => row && Number(row.at ?? 0) >= since && row.kind === 'think')
    .map((row) => clean(row.text, 50))
    .filter(Boolean)
    .slice(-20);

  const meals = (await readJsonl(resolve(root, 'data/life/meals.jsonl'), 100))
    .filter((row) => row && String(row.day ?? '') === today)
    .map((row) => `${clean(row.slot, 4)}：${clean(row.dish, 30)}`);

  const acts = [];
  const comments = (await readJsonl(resolve(root, 'data/mind/comments.jsonl'), 60)).filter(
    (row) => row && Number(row.at ?? 0) >= since && row.text,
  );
  for (const row of comments.slice(-6)) acts.push(`在评论区说了：${clean(row.text, 50)}`);
  const invites = (await readJsonl(resolve(root, 'data/mind/invite.jsonl'), 30)).filter(
    (row) => row && Number(row.at ?? 0) >= since && row.text,
  );
  for (const row of invites.slice(-4)) {
    if (row.status === 'done') acts.push(`和爸爸一起做过：${clean(row.text, 40)}`);
    else if (row.status === 'accepted') acts.push(`约好了要一起：${clean(row.text, 40)}`);
    else if (row.status === 'pending') acts.push(`约了他：${clean(row.text, 40)}`);
  }
  const state = await readJson(resolve(root, 'data/mind/state.json'), {});
  if (state?.plan?.text) acts.push(`给自己定的事：${clean(state.plan.text, 40)}`);

  const notes = [];
  const pats = (await readJsonl(resolve(root, 'data/mind/touch.jsonl'), 80)).filter(
    (row) => row && Number(row.at ?? 0) >= since && row.kind === 'pat',
  );
  if (pats.length > 0) notes.push(`被他摸了 ${pats.length} 次头，当时说「${clean(pats.at(-1).line, 20)}」`);
  const selfNotes = (await readJsonl(resolve(root, 'data/mind/memory.jsonl'), 40)).filter(
    (row) => row && Number(row.at ?? 0) >= since && row.text,
  );
  for (const row of selfNotes) notes.push(`记下了：${clean(row.text, 50)}`);

  return {
    turns,
    thoughts,
    meals,
    acts,
    notes,
    hasSomething: turns.length + thoughts.length + meals.length + acts.length + notes.length > 0,
  };
}

/** 整理用的 prompt。抽出来是为了单测能看它到底给了什么。 */
export function buildDigestPrompt({ persona = '', material, now = Date.now() } = {}) {
  const block = (title, lines) => (lines.length > 0 ? `[${title}]\n${lines.map((line) => `- ${line}`).join('\n')}` : '');
  return [
    persona ? `[你是谁]\n${persona}` : '',
    `[今天留下的东西]（现在是 ${new Date(now).toLocaleString('zh-CN', { hour12: false })}）`,
    block('聊到的', material.turns),
    block('你心里想的', material.thoughts),
    block('吃的', material.meals),
    block('你做过的事', material.acts),
    block('被摸头/自己记的', material.notes),
    [
      '[任务]',
      '把今天整理成「以后的自己」还能想起来的记忆，只输出一个 JSON 对象：',
      '{"事件":[{"标题":"不超过 20 字","细节":"不超过 40 字","人":["爸爸"],"重要":1-5}],' +
        '"事实":[{"关于":"爸爸","什么":"爱吃的","内容":"西瓜"}]}',
      '规则：',
      '- 事件 1～4 条：今天真的发生的事，用你自己的口吻写，不要编、不要抒情。',
      '- 事实 0～3 条：稳定、以后还用得上的（喜好、习惯、怕的东西、约定）。「关于」只能是「爸爸」或「小鲸」。',
      '- 计划、打算、明天要做什么不算事实，那种写进事件或干脆不写。',
      '- 跟 Minecraft 有关的写清楚是在游戏里；游戏里的伤、死不算现实里的事，不要写成身体受伤，也别编「点鼠标」这种现实动作。',
      '- 今天没什么就两个空数组。不要输出 JSON 以外的任何字。',
    ].join('\n'),
  ]
    .filter(Boolean)
    .join('\n\n');
}

/** 模型回的那段里抠出 JSON；坏了解析成 null，不猜。 */
export function parseDigest(raw) {
  const text = String(raw ?? '');
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  let data;
  try {
    data = JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
  if (!data || typeof data !== 'object') return null;
  const rawEvents = Array.isArray(data['事件'] ?? data.events) ? data['事件'] ?? data.events : [];
  const rawFacts = Array.isArray(data['事实'] ?? data.facts) ? data['事实'] ?? data.facts : [];

  const episodes = rawEvents
    .map((row) => {
      if (!row || typeof row !== 'object') return null;
      const title = clean(row['标题'] ?? row.title, 40);
      if (!title) return null;
      const people = Array.isArray(row['人'] ?? row.people) ? (row['人'] ?? row.people) : [];
      return {
        title,
        detail: clean(row['细节'] ?? row.detail, 80),
        people: people.map((p) => clean(p, 12)).filter(Boolean).slice(0, 5),
        salience: Math.max(1, Math.min(5, Number(row['重要'] ?? row.salience ?? 2) || 2)),
      };
    })
    .filter(Boolean)
    .slice(0, 4);

  const facts = rawFacts
    .map((row) => {
      if (!row || typeof row !== 'object') return null;
      const who = clean(row['关于'] ?? row.subject, 8);
      const key = clean(row['什么'] ?? row.key, 12);
      const value = clean(row['内容'] ?? row.value, 40);
      if (!who || !key || !value) return null;
      const subject = who === '他' ? '爸爸' : who === '她' ? '小鲸' : who;
      if (subject !== '爸爸' && subject !== '小鲸') return null;
      return { subject, key, value };
    })
    .filter(Boolean)
    .slice(0, 3);

  return { episodes, facts };
}

/**
 * 跑一次整理。force=true 时忽略「今天已经整理过」。
 * @returns {Promise<{ok: true, episodes: object[], facts: object[]} | {ok: false, reason: string}>}
 */
export async function digest({ root = process.cwd(), now = Date.now(), runner, persona = '', log = console, force = false, store } = {}) {
  const memory = store ?? createMemoryStore({ root, now: () => now, log });
  const day = localDay(now);
  if (!force) {
    const meta = await memory.readMeta();
    const lastAt = Number(meta.lastDigestAt ?? 0) || 0;
    // 同一天里，至少隔 4 小时才再整理一次（白天也留，不用等到晚上）；
    // 1 小时内连跑两次没意义，直接说不用。
    if (String(meta.lastDigestDay ?? '') === day && lastAt > 0 && now - lastAt < 4 * 3_600_000) {
      return { ok: false, reason: 'done' };
    }
    if (lastAt > 0 && now - lastAt < 3_600_000) return { ok: false, reason: 'gap' };
  }
  if (!runner?.run) return { ok: false, reason: 'no-runner' };

  // 增量：只整理上次整理之后的新素材（第一次跑 / force 就按最近一天）
  const metaForSince = await memory.readMeta().catch(() => ({}));
  const lastDigestAt = Number(metaForSince?.lastDigestAt ?? 0) || 0;
  const since = force || !lastDigestAt ? now - DAY : Math.max(now - DAY, lastDigestAt);
  const material = await collectMaterial({ root, now, since });
  if (!material.hasSomething) return { ok: false, reason: 'empty' };

  let raw;
  try {
    const result = await runner.run(buildDigestPrompt({ persona, material, now }));
    raw = result?.text;
  } catch (error) {
    log?.warn?.(`睡前整理失败：${error?.message ?? error}`);
    return { ok: false, reason: 'model' };
  }
  const parsed = parseDigest(raw);
  if (!parsed) {
    log?.warn?.(`睡前整理没解析出来：${String(raw ?? '').slice(0, 80)}`);
    return { ok: false, reason: 'model' };
  }

  const episodes = [];
  for (const row of parsed.episodes) {
    const added = await memory.addEpisode({
      at: now,
      kind: 'day',
      title: row.title,
      detail: row.detail,
      people: row.people,
      salience: row.salience,
      source: 'digest',
    });
    if (added && !added.duplicate) episodes.push(added);
  }
  const facts = [];
  for (const row of parsed.facts) {
    const saved = await memory.upsertFact({ at: now, ...row, source: 'digest' });
    if (saved) facts.push(saved);
  }
  if (episodes.length === 0 && facts.length === 0) return { ok: false, reason: 'empty' };

  await memory.saveMeta({ lastDigestDay: day, lastDigestAt: now });
  return { ok: true, episodes, facts };
}