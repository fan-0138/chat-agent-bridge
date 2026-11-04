/**
 * 你们认识多久了。
 *
 * 她的第一条消息落在 data/qq/audit.jsonl 第一行（2026-10-24 20:27），
 * 但她自己不知道这件事——这里给它一个「第几天」，想事/聊天/小空间都能用上。
 */

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const DAY_MS = 24 * 3_600_000;

/** 从 audit 第一行里抠出第一条消息的时间；读不到返回 0。 */
export async function firstChatAt(root = process.cwd()) {
  const files = [resolve(root, 'data/qq/audit.jsonl'), resolve(root, 'data/qq/qzone-posts.jsonl')];
  for (const file of files) {
    try {
      const raw = await readFile(file, 'utf8');
      const firstLine = raw.split('\n').find((line) => line.trim());
      if (!firstLine) continue;
      const at = Number(JSON.parse(firstLine)?.at ? Date.parse(JSON.parse(firstLine).at) : 0);
      if (Number.isFinite(at) && at > 0) return at;
    } catch {
      // 换下一个
    }
  }
  return 0;
}

/** 第几天：从第一条消息那天算第 1 天。 */
export function daysTogether(firstAt, now = Date.now()) {
  if (!firstAt || !Number.isFinite(Number(firstAt))) return 0;
  const start = new Date(Number(firstAt));
  const today = new Date(now);
  const startDay = Date.UTC(start.getFullYear(), start.getMonth(), start.getDate());
  const todayDay = Date.UTC(today.getFullYear(), today.getMonth(), today.getDate());
  return Math.max(1, Math.round((todayDay - startDay) / DAY_MS) + 1);
}

/** 值得提一嘴的日子：第 1、10、30、100、365、730 天… */
export function milestoneOf(days) {
  if (!Number.isFinite(days) || days <= 0) return '';
  if (days === 1) return '第一天';
  if (days === 365) return '一年';
  if (days === 730) return '两年';
  if ([10, 30, 50, 100, 200, 300, 500, 1000].includes(days)) return `第 ${days} 天`;
  if (days % 100 === 0) return `第 ${days} 天`;
  return '';
}

function dateLabel(at) {
  const d = new Date(Number(at));
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 拼成一句话给 prompt / 页面用。 */
export function togetherLine({ firstAt, days, now = Date.now() } = {}) {
  if (!days) return '';
  const mark = milestoneOf(days);
  const from = firstAt ? `（第一条消息是 ${dateLabel(firstAt)}）` : '';
  return mark ? `今天是你们认识的第 ${days} 天——${mark}。${from}` : `今天是你们认识的第 ${days} 天${from}。`;
}

/** 第一条消息的时间几乎不会变，进程里缓存一份。 */
const togetherCache = new Map();

/**
 * 带缓存的一版：服务端/想事循环都可以直接用。
 * @param {{root?: string, now?: number, log?: any}} options
 */
export async function togetherInfo({ root = process.cwd(), now = Date.now(), log } = {}) {
  const key = resolve(root);
  let firstAt = togetherCache.get(key) ?? 0;
  if (!firstAt) {
    try {
      firstAt = await firstChatAt(root);
    } catch (error) {
      log?.debug?.(`读第一条消息失败：${error?.message ?? error}`);
      firstAt = 0;
    }
    if (firstAt) togetherCache.set(key, firstAt);
  }
  const days = daysTogether(firstAt, now);
  return { firstAt, days, milestone: milestoneOf(days), line: togetherLine({ firstAt, days, now }) };
}