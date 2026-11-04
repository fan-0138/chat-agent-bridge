/**
 * 摸头：在小空间里点她一下。
 *
 * 为什么反应台词写死在本地：
 *  - 点一下要立刻有反应。模型一轮要十几秒，那不叫摸头，叫提交表单。
 *  - 身体反应本来就是反射，不经过「想」。
 * 但她怎么想这件事不归这里管：touch.jsonl 会进她独处的 prompt，让她自己决定
 * 要不要提起、怎么提。这里只负责「她身体上被碰了一下」和一句下意识的话。
 */

import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { localDay } from './life.js';

/** 连点太快：上一次不到 2.5 秒，就当没摸到（页面抖一下就发出好几个请求）。 */
export const PAT_COOLDOWN_MS = 2_500;
/** 90 秒内连着摸，算同一次「被顺毛」；隔久了重新从一开始。 */
export const PAT_STREAK_WINDOW_MS = 90_000;
/** 摸完 90 分钟内进 prompt；再久就不算「刚才」了。 */
export const PAT_PROMPT_TTL_MS = 90 * 60_000;

/** 反应台词：按被摸的次数分档。短、口语，像人下意识会说的。 */
const LINES = {
  1: ['嗯…', '干嘛呀', '你手好凉', '摸头长不高的', '别弄乱头发', '……头发本来就这样'],
  2: ['说了别弄乱啦', '再摸就乱了', '行吧，就一下', '轻点，疼'],
  3: ['别摸……', '脸有点烫', '再摸真当我是猫啊', '你手停停'],
  4: ['躲开了', '不给摸了', '摸够了没有', '再摸我咬你'],
};
const NIGHT_LINES = ['困……别闹', '几点了还摸', '嗯…要睡了'];
const QUIET_LINES = ['嗯。', '……先别碰我', '让我缓一下'];
const SLEEP_LINES = ['唔……别吵', '嗯…再睡会儿', '（翻了个身）'];
const COOLDOWN_LINES = ['别戳啦', '刚摸过了', '缓一下'];

const pick = (pool, random = Math.random) => pool[Math.min(pool.length - 1, Math.floor(random() * pool.length))];

function levelOf(streak) {
  const n = Math.max(1, Number(streak) || 1);
  if (n === 1) return 1;
  if (n <= 3) return 2;
  if (n <= 5) return 3;
  return 4;
}

/** 台词挑一句。hour / mood 只影响「淡」和「困」，不改变结构。 */
export function pickPatLine({ level = 1, hour = 12, mood = '', random = Math.random } = {}) {
  const lv = Math.min(4, Math.max(1, Number(level) || 1));
  const text = String(mood ?? '');
  const sleepy = hour >= 22 || hour < 6;
  if (lv <= 2 && sleepy) return pick(NIGHT_LINES, random);
  if (lv <= 2 && /烦|累|倦|困|难受/.test(text)) return pick(QUIET_LINES, random);
  return pick(LINES[lv], random);
}

/**
 * 这次摸头的反应。纯函数。
 * reason: 'cooldown'（还没缓过来，不计数）| 'asleep'（睡着，不涨 streak）| 'ok'
 */
export function patReaction({ state = {}, now = Date.now(), scene = 'idle', hour = new Date(now).getHours(), mood = '', random = Math.random } = {}) {
  const day = localDay(now);
  const lastAt = Number(state.lastAt ?? 0) || 0;
  const count = String(state.day ?? '') === day ? Number(state.count ?? 0) || 0 : 0;
  // 90 秒内接着摸才算一次连击；隔久了从 1 重来
  const prevStreak = lastAt > 0 && now - lastAt <= PAT_STREAK_WINDOW_MS ? Number(state.streak ?? 0) || 0 : 0;

  if (lastAt > 0 && now - lastAt < PAT_COOLDOWN_MS) {
    return { ok: false, reason: 'cooldown', line: pick(COOLDOWN_LINES, random), level: levelOf(prevStreak), streak: prevStreak, count, at: now };
  }
  if (scene === 'sleep') {
    return { ok: false, reason: 'asleep', line: pick(SLEEP_LINES, random), level: 0, streak: 0, count: count + 1, at: now };
  }
  const streak = prevStreak + 1;
  const level = levelOf(streak);
  return { ok: true, reason: 'ok', line: pickPatLine({ level, hour, mood, random }), level, streak, count: count + 1, at: now };
}

function agoText(ms) {
  const min = Math.max(0, Math.round(Number(ms) / 60_000));
  if (min < 1) return '刚刚';
  if (min < 60) return `${min} 分钟前`;
  return `${Math.round(min / 60)} 小时前`;
}

/** 给 prompt 的段落：她刚才被摸过头。太久了就返回空串。 */
export function formatTouchSection(state, { now = Date.now(), ttlMs = PAT_PROMPT_TTL_MS, nudge = false } = {}) {
  const at = Number(state?.lastAt ?? 0) || 0;
  if (!at || now - at > ttlMs || now < at) return '';
  const line = String(state?.lastLine ?? '').trim();
  const streak = Number(state?.streak ?? 0) || 0;
  const extra = streak >= 3 ? '（他连着摸了好几下）' : '';
  const said = state?.said && Number(state.said.forAt) === at ? String(state.said.text ?? '').trim() : '';
  const lines = [
    '[他刚才摸了摸你的头]',
    `${agoText(now - at)}他伸手摸了摸你的头${extra}，你当时「${line || '嗯…'}」。`,
  ];
  if (said) lines.push(`你后来自己补了一句「${said}」。`);
  lines.push('（这是真的发生过，不是他想出来的。想提就提一句，不想提就让它过去；别复述那句台词，也别过度撒娇。）');
  // 只在他摸完紧接着开口的这段时间里推她一把：再晚就不算「刚才」了，翻旧账很怪
  if (nudge && now - at <= 8 * 60_000) {
    lines.push('（这是他摸完之后说的第一句：搭得上就顺口提一句，一句就够；搭不上别硬提，后面也别反复提。）');
  }
  return lines.join('\n');
}

/**
 * 让她自己写一句对摸头的反应（要调模型，慢一两秒）。
 * 本地那套台词只是她下意识冒出来的那半句，真正说什么由这里生成。
 */
export function buildPatReplyPrompt({ persona = '', line = '', streak = 1, scene = 'idle', hour = 12 } = {}) {
  const mood =
    scene === 'sleep'
      ? '你半梦半醒，刚被碰了一下，还没完全清醒'
      : hour >= 22 || hour < 6
        ? '很晚了，你有点困，但还醒着'
        : '你醒着，在自己屋里待着';
  const extra =
    Number(streak) >= 4
      ? '[补充] 他连着摸了好几下，你已经有点想躲了。'
      : Number(streak) >= 2
        ? '[补充] 他听你说了一句也没停，又摸了一下。'
        : '';
  return [
    persona ? `[你是谁]\n${persona}` : '',
    `[刚才]\n爸爸伸手摸了摸你的头。你下意识冒了一句：「${line || '嗯…'}」`,
    `[你现在]\n${mood}`,
    extra,
    '[任务] 写一句你此刻真正想说的反应：8～20 个字，口语，像随口说的；',
    '可以顺着刚才那半句往下，也可以嘴硬、别扭、小声嘟囔；不解释、不总结、不撒娇过头；',
    '不写动作，不加新剧情；只输出这一句，不要引号，不要解释。',
  ]
    .filter(Boolean)
    .join('\n\n');
}

async function readJson(file, fallback) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return fallback;
  }
}

/**
 * 落盘版：网页里点她 → pat()。
 * 状态在 data/mind/touch-state.json（今天摸了几下、连击几），
 * 每条反应追加到 data/mind/touch.jsonl（她的 prompt 和痕迹都读这个）。
 */
export function createTouch({ root = process.cwd(), log = console, now = Date.now } = {}) {
  const stateFile = resolve(root, 'data/mind/touch-state.json');
  const eventFile = resolve(root, 'data/mind/touch.jsonl');

  // 不缓存：桥接进程活很久，摸头是另一个进程写的，缓存了下一轮对话就看不见
  async function readState() {
    const raw = await readJson(stateFile, null);
    return raw && typeof raw === 'object' ? raw : {};
  }

  async function pat({ scene = 'idle', hour = new Date(now()).getHours(), mood = '' } = {}) {
    const at = now();
    const prev = await readState();
    const result = patReaction({ state: prev, now: at, scene, hour, mood });
    if (result.reason === 'cooldown') return result; // 连点不落盘，不然状态会越来越乱

    const next = {
      day: localDay(at),
      count: result.count,
      streak: result.reason === 'asleep' ? 0 : result.streak,
      streakAt: result.reason === 'asleep' ? Number(prev.streakAt ?? 0) : at,
      lastAt: at,
      lastLine: result.line,
      // 旧的那句留着，但 forAt 对不上就不算数（见 formatTouchSection）
      said: prev.said ?? null,
    };
    await mkdir(dirname(stateFile), { recursive: true });
    await writeFile(stateFile, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
    await appendFile(eventFile, `${JSON.stringify({ at, kind: 'pat', scene, line: result.line, level: result.level, streak: next.streak, count: next.count })}\n`, 'utf8').catch((error) => {
      log?.warn?.(`记摸头日志失败：${error?.message ?? error}`);
    });
    return result;
  }

  /** 她自己的那句反应回来了：写进状态，页面和 prompt 都用它。 */
  async function say({ forAt, text } = {}) {
    const at = now();
    const body = String(text ?? '')
      .replace(/\s+/g, ' ')
      .replace(/^[「『"'“]+|[」』"'”]+$/g, '')
      .trim()
      .slice(0, 60);
    if (!body || !forAt) return null;
    const prev = await readState();
    const next = { ...prev, said: { at, forAt: Number(forAt), text: body } };
    await mkdir(dirname(stateFile), { recursive: true });
    await writeFile(stateFile, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
    await appendFile(eventFile, `${JSON.stringify({ at, kind: 'pat-said', forAt: Number(forAt), text: body })}\n`, 'utf8').catch((error) => {
      log?.warn?.(`记摸头回应失败：${error?.message ?? error}`);
    });
    return next.said;
  }

  /** 最近一次被摸（痕迹/页面用）。 */
  async function last() {
    try {
      const raw = await readFile(eventFile, 'utf8');
      const lines = raw.split('\n').filter(Boolean);
      for (let i = lines.length - 1; i >= 0; i -= 1) {
        try {
          const row = JSON.parse(lines[i]);
          if (row && typeof row === 'object') return row;
        } catch {
          /* 坏行跳过 */
        }
      }
    } catch {
      /* 还没被摸过 */
    }
    return null;
  }

  return { pat, say, state: readState, last };
}
