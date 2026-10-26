#!/usr/bin/env node
/**
 * 她的饭饭账本。
 *
 *   node scripts/meal.mjs --add "烤鱼"                记一顿（自己吃的）
 *   node scripts/meal.mjs --add "西瓜" --by 爸爸       记一顿（爸爸投喂）
 *   node scripts/meal.mjs --list --limit 10           最近的几顿
 *   node scripts/meal.mjs --month                     上个月的月报（她自己念给你听）
 *   node scripts/meal.mjs --month 2026-10             指定月份
 *
 * 账本在 data/life/meals.jsonl（明文，一行一顿）。
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  appendMeal,
  dayKey,
  formatMonthReport,
  loadMeals,
  previousMonth,
  summarizeMonth,
} from '../src/meals.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const file = join(root, 'data', 'life', 'meals.jsonl');

const args = process.argv.slice(2);
const arg = (name, fallback = '') => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? (args[i + 1] ?? fallback) : fallback;
};
const has = (name) => args.includes(`--${name}`);

function fmtAt(iso) {
  const d = new Date(iso);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getMonth() + 1}/${d.getDate()} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

if (has('add')) {
  const dish = arg('add').trim();
  if (!dish) {
    console.error('用法：--add "吃的啥" [--by 爸爸]');
    process.exit(2);
  }
  const by = arg('by').trim() || null;
  const entry = await appendMeal({ file, dish, by, source: by ? 'fed' : 'self' });
  console.log(`记下了：${entry.day} ${entry.slot} ${entry.dish}${entry.by ? `（${entry.by}投喂）` : ''}`);
} else if (has('month')) {
  const wanted = arg('month').trim();
  // 「这个月」就看当月，「上个月」或留空看上月
  const month = ['current', '这个月', '本月'].includes(wanted)
    ? dayKey(new Date()).slice(0, 7)
    : wanted || previousMonth();
  const rows = await loadMeals(file);
  console.log(formatMonthReport(summarizeMonth(rows, month)));
} else if (has('list') || args.length === 0) {
  const limit = Number(arg('limit', '10')) || 10;
  const rows = await loadMeals(file);
  const tail = rows.slice(-limit);
  if (tail.length === 0) {
    console.log('账本还是空的。');
  } else {
    for (const row of tail) {
      console.log(`${fmtAt(row.at)}  ${row.slot}  ${row.dish}${row.by ? `（${row.by}投喂）` : ''}`);
    }
    console.log(`共 ${rows.length} 顿。`);
  }
} else {
  console.error('用法：--add "吃的" [--by 爸爸] | --list [--limit N] | --month [YYYY-MM]');
  process.exit(2);
}