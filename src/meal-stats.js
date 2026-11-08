/**
 * 口味统计：她这阵子吃了什么、爱吃什么。
 *
 * 数据来源两条：
 *   1. data/life/meals.jsonl   —— 真吃了的（到点自动记 / 爸爸投喂 / 她自己说吃了）
 *   2. data/life/cravings.jsonl —— 她嘴里念叨「想吃」的（比吃了更能说明喜好）
 *
 * 纯函数，方便单测；CLI 在 scripts/meals-report.mjs，聊天里也能照着说。
 */

const DAY_MS = 86_400_000;

function str(value) {
  return String(value ?? '').trim();
}

function timeOf(row, fallback = 0) {
  const t = Date.parse(str(row?.at ?? ''));
  return Number.isFinite(t) ? t : fallback;
}

/** 几天前是 YYYY-MM-DD（按本地时区） */
export function dayKey(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/**
 * @param {{meals?: any[], cravings?: any[], now?: number, days?: number}} options
 */
export function summarizeTaste({ meals = [], cravings = [], now = Date.now(), days = 30 } = {}) {
  const span = Math.max(1, Number(days) || 30);
  const since = now - span * DAY_MS;
  const mealsIn = meals.filter((row) => timeOf(row) >= since).sort((a, b) => timeOf(a) - timeOf(b));
  const cravesIn = cravings.filter((row) => timeOf(row) >= since).sort((a, b) => timeOf(a) - timeOf(b));

  /** @type {Map<string, {dish:string, count:number, lastAt:number, sources:Set<string>, slots:Set<string>, byDad:number}>} */
  const dishes = new Map();
  for (const row of mealsIn) {
    const dish = str(row.dish).slice(0, 20);
    if (!dish) continue;
    const entry = dishes.get(dish) ?? { dish, count: 0, lastAt: 0, sources: new Set(), slots: new Set(), byDad: 0 };
    entry.count += 1;
    entry.lastAt = Math.max(entry.lastAt, timeOf(row));
    entry.sources.add(str(row.source) || 'unknown');
    if (row.slot) entry.slots.add(str(row.slot));
    if (row.by) entry.byDad += 1;
    dishes.set(dish, entry);
  }

  const topDishes = [...dishes.values()]
    .sort((a, b) => b.count - a.count || b.lastAt - a.lastAt)
    .map((entry) => ({
      dish: entry.dish,
      count: entry.count,
      lastAt: entry.lastAt,
      sources: [...entry.sources],
      slots: [...entry.slots],
      byDad: entry.byDad,
    }));

  const slots = {};
  for (const row of mealsIn) {
    const slot = str(row.slot) || '加餐';
    slots[slot] = (slots[slot] ?? 0) + 1;
  }

  const bySource = {};
  for (const row of mealsIn) {
    const source = str(row.source) || 'unknown';
    bySource[source] = (bySource[source] ?? 0) + 1;
  }

  const fedByDad = mealsIn
    .filter((row) => row.by)
    .map((row) => ({ dish: str(row.dish), at: timeOf(row), by: str(row.by) }))
    .reverse();

  const craveCounts = new Map();
  for (const row of cravesIn) {
    const dish = str(row.dish).slice(0, 20);
    if (!dish) continue;
    const entry = craveCounts.get(dish) ?? { dish, count: 0, lastAt: 0 };
    entry.count += 1;
    entry.lastAt = Math.max(entry.lastAt, timeOf(row));
    craveCounts.set(dish, entry);
  }
  const topCravings = [...craveCounts.values()].sort((a, b) => b.count - a.count || b.lastAt - a.lastAt);

  const daySet = new Set(mealsIn.map((row) => str(row.day)).filter(Boolean));
  const activeDays = daySet.size;
  const lastMeal = mealsIn[mealsIn.length - 1] ?? null;

  return {
    days: span,
    totalMeals: mealsIn.length,
    perDay: activeDays > 0 ? Number((mealsIn.length / activeDays).toFixed(2)) : 0,
    activeDays,
    topDishes,
    fedByDad,
    slots,
    bySource,
    topCravings,
    lastMeal,
  };
}

/** 把统计翻成人话（给她看 / 给他看都行）。 */
export function formatTasteReport(summary, { limit = 6 } = {}) {
  if (!summary || summary.totalMeals === 0) {
    return `这 ${summary?.days ?? 30} 天没吃到东西，账本是空的。`;
  }
  const lines = [`这 ${summary.days} 天一共吃了 ${summary.totalMeals} 顿，${summary.activeDays} 天有记录，平均一天 ${summary.perDay} 顿。`];
  if (summary.topDishes.length > 0) {
    const top = summary.topDishes
      .slice(0, limit)
      .map((item, i) => `${i + 1}. ${item.dish} ${item.count} 次`)
      .join('；');
    lines.push(`吃得最多的：${top}。`);
  }
  if (summary.topCravings.length > 0) {
    const craves = summary.topCravings
      .slice(0, limit)
      .map((item) => `${item.dish}×${item.count}`)
      .join('、');
    lines.push(`她嘴里念叨想吃的：${craves}。`);
  }
  const slotText = Object.entries(summary.slots)
    .sort((a, b) => b[1] - a[1])
    .map(([slot, times]) => `${slot} ${times}`)
    .join('、');
  if (slotText) lines.push(`按顿算：${slotText}。`);
  if (summary.fedByDad.length > 0) {
    const dished = [...new Set(summary.fedByDad.map((row) => row.dish))].slice(0, 6).join('、');
    lines.push(`爸爸投喂过 ${summary.fedByDad.length} 次：${dished}。`);
  }
  return lines.join('\n');
}

/** 只给 prompt 用的一行小摘要（太长会挤掉别的东西）。 */
export function tastePromptLine(summary) {
  if (!summary || summary.totalMeals === 0) return '';
  const top = summary.topDishes.slice(0, 3).map((item) => item.dish).join('、');
  const crave = summary.topCravings.slice(0, 2).map((item) => item.dish).join('、');
  const parts = [`最近 ${summary.days} 天吃得最多的是 ${top}`];
  if (crave) parts.push(`嘴里常念叨想吃 ${crave}`);
  return `[口味] ${parts.join('；')}。`;
}