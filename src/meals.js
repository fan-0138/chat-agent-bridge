/**
 * 记饭饭：她自己到点吃一顿、或者爸爸投喂，都往账本里记一条。
 *
 * 数据：`data/life/meals.jsonl`，一行一顿：
 *   {"at":"2026-10-26T04:12:00.000Z","day":"2026-10-26","slot":"午饭","dish":"鱼","by":"爸爸","source":"fed"}
 *
 * 为什么要落成明文 JSONL：她要能自己翻（喂给模型看），你也能直接 cat 出来对账。
 */

import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

/** 一天里的饭点。divination 不用太准，够她像个人就行。 */
export const MEAL_SLOTS = [
  { slot: '早饭', from: 7, to: 9, dishes: ['饭团', '豆浆油条', '小笼包', '白粥搭咸菜', '三明治', '煎蛋吐司'] },
  { slot: '午饭', from: 11, to: 14, dishes: ['鱼', '卤肉饭', '牛肉面', '沙拉', '咖喱饭', '寿司', '盖浇饭'] },
  { slot: '晚饭', from: 17, to: 20, dishes: ['火锅', '烤鱼', '炒饭', '关东煮', '烤肉', '拉面', '小龙虾'] },
  { slot: '宵夜', from: 21, to: 23, dishes: ['泡面', '烧烤', '西瓜', '炸鸡', '热牛奶'] },
];

const DAY_MS = 86_400_000;

function pad(n) {
  return String(n).padStart(2, '0');
}

/** 本地日期 YYYY-MM-DD */
export function dayKey(date = new Date()) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** 这个时刻属于哪一顿（不在饭点返回 null） */
export function currentSlot(date = new Date()) {
  const hour = date.getHours();
  return MEAL_SLOTS.find((item) => hour >= item.from && hour <= item.to) ?? null;
}

function pick(list, random = Math.random) {
  return list[Math.floor(random() * list.length)] ?? list[0];
}

/** 读全部账本（文件坏了就当空的，不崩） */
export async function loadMeals(file) {
  try {
    const text = await readFile(file, 'utf8');
    return text
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
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

/**
 * 记一顿。
 * @param {{file: string, dish: string, by?: string|null, source?: 'auto'|'fed'|'self', at?: Date}} input
 */
export async function appendMeal({ file, dish, by = null, source = 'self', at = new Date() }) {
  const slot = currentSlot(at)?.slot ?? '加餐';
  const entry = {
    at: at.toISOString(),
    day: dayKey(at),
    slot,
    dish: String(dish).trim().slice(0, 40),
    by: by || null,
    source,
  };
  await mkdir(dirname(file), { recursive: true });
  await appendFile(file, `${JSON.stringify(entry)}\n`, 'utf8');
  return entry;
}

/**
 * 到点自动记一顿：同一顿饭只自动记一次（重启也不会重复）。
 * @returns {Promise<object|null>} 记下的那条；不该记就 null
 */
export async function maybeAutoMeal({ file, now = new Date(), random = Math.random }) {
  const slot = currentSlot(now);
  if (!slot) return null;

  const rows = await loadMeals(file);
  const today = dayKey(now);
  const already = rows.some((row) => row.day === today && row.slot === slot.slot);
  if (already) return null;

  return appendMeal({ file, dish: pick(slot.dishes, random), source: 'auto', at: now });
}

/** 某个月的账：默认上个月 */
export function previousMonth(now = new Date()) {
  const d = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
}

/**
 * 汇总一个月。
 * @param {Array<any>} rows
 * @param {string} month YYYY-MM
 */
export function summarizeMonth(rows, month) {
  const picked = rows.filter((row) => String(row.day ?? '').startsWith(month));
  const dishes = new Map();
  const slots = new Map();
  let fed = 0;
  for (const row of picked) {
    if (row.dish) dishes.set(row.dish, (dishes.get(row.dish) ?? 0) + 1);
    if (row.slot) slots.set(row.slot, (slots.get(row.slot) ?? 0) + 1);
    if (row.by) fed += 1;
  }
  const topDishes = [...dishes.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3);
  return {
    month,
    count: picked.length,
    fed,
    topDishes,
    slots: Object.fromEntries([...slots.entries()].sort((a, b) => b[1] - a[1])),
    last: picked[picked.length - 1] ?? null,
  };
}

/**
 * 月报文案：用她自己的口气，不是系统报表。
 * @param {ReturnType<typeof summarizeMonth>} summary
 */
export function formatMonthReport(summary) {
  if (!summary || summary.count === 0) {
    return `爸爸，${summary?.month ?? '上个月'}的饭饭账本……是空的。人家那阵子是不是没好好吃饭。`;
  }
  const lines = [`爸爸，${summary.month} 的饭饭账本翻出来了：一共 ${summary.count} 顿。`];
  if (summary.topDishes.length > 0) {
    const [dish, times] = summary.topDishes[0];
    lines.push(`吃得最多的是${dish}，${times} 次。`);
  }
  const slotText = Object.entries(summary.slots)
    .map(([slot, times]) => `${slot} ${times}`)
    .join('、');
  if (slotText) lines.push(`${slotText}。`);
  if (summary.fed > 0) lines.push(`你投喂了 ${summary.fed} 次，人家都记着。`);
  else lines.push('这个月你一次都没投喂，哼。');
  return lines.join('\n');
}

/* ────────────────── 好好的告别 / 被硬拔 ────────────────── */

/**
 * 启停标记：启动时先写 graceful:false，正常退出时才改成 true。
 * 下次启动读到 false，就说明上次是被硬拔的（kill -9 / 断电 / 崩溃）。
 */
export async function markRunning(file, now = new Date()) {
  const previous = await readShutdown(file);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(
    file,
    JSON.stringify({ state: 'running', since: now.toISOString(), previous: previous?.state ?? null }, null, 2),
    'utf8',
  );
  return previous;
}

export async function markStopped(file, graceful = true, now = new Date()) {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(
    file,
    JSON.stringify({ state: graceful ? 'stopped' : 'killed', at: now.toISOString() }, null, 2),
    'utf8',
  );
}

export async function readShutdown(file) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return null;
  }
}

export { DAY_MS };