/**
 * 约爸爸一起做件事：她开口约，他应或不应，之后两个人都记得。
 *
 * 为什么单独一层，不塞进聊天：
 *  - 消息发出去就过去了；「约定」要等人回、有时限、做完了还得变成共同回忆。
 *  - 她得知道「他还没回」「他答应了还没做」「做完了」——这些决定了她在聊天里提不提。
 *
 * 状态在 data/mind/invite.json（只有最近一条，新的覆盖旧的）；
 * 每次变化追加 data/mind/invite.jsonl（痕迹读它）。做完会写一条 memory，进她的记忆。
 */

import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { localDay } from './life.js';

/** 两次开口约之间至少隔 20 小时：约人是件偶尔才做的事，不是日程提醒。 */
export const INVITE_MIN_GAP_MIN = 20 * 60;
export const INVITE_MAX_PER_DAY = 1;
/** 他没应：一天后就算了，不追着问。 */
export const INVITE_PENDING_TTL_MS = 24 * 3_600_000;
/** 答应了但一直没一起做：三天后当作没约成，别让一件旧事一直卡着她。 */
export const INVITE_OPEN_TTL_MS = 72 * 3_600_000;

/** 一句话能说清的约定，不该写成小作文。 */
export const INVITE_MAX_CHARS = 40;

const STATUSES = new Set(['pending', 'accepted', 'later', 'done', 'expired']);

function clean(text, max = INVITE_MAX_CHARS) {
  return String(text ?? '')
    .replace(/\s+/g, ' ')
    .replace(/^["'「『]|["'」』]$/g, '')
    .trim()
    .slice(0, max);
}

function agoText(ms) {
  const min = Math.max(0, Math.round(Number(ms) / 60_000));
  if (min < 1) return '刚刚';
  if (min < 60) return `${min} 分钟前`;
  if (min < 1_440) return `${Math.round(min / 60)} 小时前`;
  return `${Math.round(min / 1_440)} 天前`;
}

async function readJson(file, fallback) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return fallback;
  }
}

/**
 * 读磁盘上的那条约定，顺手把过期折算掉（只在内存里，不写盘）。
 * 坏文件/没有 → null。
 */
export function normalizeInvite(row, now = Date.now()) {
  if (!row || typeof row !== 'object') return null;
  const text = clean(row.text);
  const at = Number(row.at ?? 0) || 0;
  if (!text || !at) return null;
  let status = STATUSES.has(row.status) ? row.status : 'pending';
  if (status === 'pending' && now - at > INVITE_PENDING_TTL_MS) status = 'expired';
  if (status === 'accepted' && now - Number(row.answeredAt ?? at) > INVITE_OPEN_TTL_MS) status = 'expired';
  return {
    id: String(row.id ?? at),
    text,
    at,
    status,
    answeredAt: Number(row.answeredAt ?? 0) || 0,
    doneAt: Number(row.doneAt ?? 0) || 0,
  };
}

export async function readInvite({ root = process.cwd(), now = Date.now() } = {}) {
  const row = await readJson(resolve(root, 'data/mind/invite.json'), null);
  return normalizeInvite(row, now);
}

/**
 * 这会儿能不能开口约。纯函数。
 * reason: asleep / daily / gap / pending / planned / ok
 */
export function decideInvite({ state = {}, invite = null, now = Date.now() } = {}) {
  const hour = new Date(now).getHours();
  if (hour < 7) return { go: false, reason: 'asleep' };

  const day = localDay(now);
  const count = String(state.inviteDay ?? '') === day ? Number(state.inviteCount ?? 0) || 0 : 0;
  if (count >= INVITE_MAX_PER_DAY) return { go: false, reason: 'daily', count };

  const last = Number(state.lastInviteAt ?? 0) || 0;
  if (last > 0 && now - last < INVITE_MIN_GAP_MIN * 60_000) {
    return { go: false, reason: 'gap', waitMin: Math.ceil(INVITE_MIN_GAP_MIN - (now - last) / 60_000) };
  }

  const status = String(invite?.status ?? '');
  if (status === 'pending') return { go: false, reason: 'pending' };
  if (status === 'accepted') return { go: false, reason: 'planned' };
  return { go: true, reason: 'ok' };
}

/** 她开口约：落盘 + 追加日志。text 空了就不写。 */
export async function createInvite({ root = process.cwd(), text, now = Date.now(), log = console } = {}) {
  const body = clean(text);
  if (!body) return null;
  const record = { id: String(now), text: body, at: now, status: 'pending', answeredAt: 0, doneAt: 0 };
  const dir = resolve(root, 'data/mind');
  await mkdir(dir, { recursive: true });
  await writeFile(resolve(dir, 'invite.json'), `${JSON.stringify(record, null, 2)}\n`, 'utf8');
  await appendFile(resolve(dir, 'invite.jsonl'), `${JSON.stringify(record)}\n`, 'utf8').catch((error) => {
    log?.warn?.(`记约定日志失败：${error?.message ?? error}`);
  });
  return record;
}

/**
 * 他的回应：accept / later / done。
 * 只对当前这条生效；没有、已经做完、已经过期都返回 null（不改盘）。
 */
export async function answerInvite({ root = process.cwd(), action, now = Date.now(), log = console } = {}) {
  if (!['accept', 'later', 'done'].includes(action)) return null;
  const current = await readInvite({ root, now });
  if (!current) return null;
  if (current.status === 'done' || current.status === 'expired') return null;

  const next = { ...current };
  if (action === 'accept') {
    next.status = 'accepted';
    next.answeredAt = now;
  } else if (action === 'later') {
    next.status = 'later';
    next.answeredAt = now;
  } else {
    next.status = 'done';
    next.answeredAt = next.answeredAt || now;
    next.doneAt = now;
  }

  const dir = resolve(root, 'data/mind');
  await mkdir(dir, { recursive: true });
  await writeFile(resolve(dir, 'invite.json'), `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  await appendFile(resolve(dir, 'invite.jsonl'), `${JSON.stringify(next)}\n`, 'utf8').catch((error) => {
    log?.warn?.(`记约定日志失败：${error?.message ?? error}`);
  });

  // 做完了才算数：变成她自己的一条记忆，以后可以当共同回忆提
  if (action === 'done') {
    const memory = { at: now, text: clean(`跟爸爸一起做了件事：${current.text}`, 120) };
    await appendFile(resolve(dir, 'memory.jsonl'), `${JSON.stringify(memory)}\n`, 'utf8').catch((error) => {
      log?.warn?.(`写她的记忆失败：${error?.message ?? error}`);
    });
  }
  return next;
}

/** 给 prompt 的段落。没有约定就空串。 */
export function formatInviteSection(invite, { now = Date.now() } = {}) {
  if (!invite || typeof invite !== 'object' || !invite.text) return '';
  const ago = agoText(now - Number(invite.at ?? now));
  switch (invite.status) {
    case 'pending':
      return [
        '[你约了他一起做件事]',
        `${ago}你说「${invite.text}」，他还没回。`,
        '（聊天里提一句可以，别催、别重复问；他不接就算了。）',
      ].join('\n');
    case 'accepted':
      return [
        '[你们约好了]',
        `他答应了：${invite.text}（${ago}应下的）。`,
        '（想什么时候做、怎么开始，你自己提；别拖太久。）',
      ].join('\n');
    case 'later':
      return ['[他说改天]', `你说「${invite.text}」，他说改天。`, '（别缠着，过几天再提。）'].join('\n');
    case 'done':
      return ['[你们一起做过]', `${ago}：${invite.text}。`, '（这是你们的共同回忆，可以当成真发生过的事提。）'].join('\n');
    case 'expired':
      return ['[没约成]', `${ago}你约他「${invite.text}」，没成。`, '（算了，别翻旧账。）'].join('\n');
    default:
      return '';
  }
}
