#!/usr/bin/env node
/**
 * 她的口味报表：这阵子吃了什么、爱吃什么、嘴上念叨想吃什么。
 *
 *   node scripts/meals-report.mjs              # 最近 30 天
 *   node scripts/meals-report.mjs --days 90
 *   node scripts/meals-report.mjs --json       # 给别的脚本用
 */
import { resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import { formatTasteReport, summarizeTaste } from '../src/meal-stats.js';
import { loadCravings, loadMeals } from '../src/meals.js';

const args = process.argv.slice(2);
const arg = (name, fallback = '') => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? (args[i + 1] ?? fallback) : fallback;
};
const days = Number(arg('days', '30')) || 30;
const asJson = args.includes('--json');

const root = resolve(import.meta.dirname, '..');
const mealsFile = resolve(root, 'data/life/meals.jsonl');
const cravingsFile = resolve(root, 'data/life/cravings.jsonl');

const [meals, cravings] = await Promise.all([loadMeals(mealsFile), loadCravings(cravingsFile)]);
const summary = summarizeTaste({ meals, cravings, now: Date.now(), days });

if (asJson) {
  console.log(JSON.stringify({ ...summary, mealsFile, cravingsFile }, null, 1));
} else {
  console.log(formatTasteReport(summary));
  const recent = meals.slice(-6).map((row) => `${String(row.day ?? '')} ${row.slot ?? ''} ${row.dish ?? ''}`.trim());
  if (recent.length > 0) console.log(`\n最近几顿：\n- ${recent.join('\n- ')}`);
  if (cravings.length > 0) {
    const shops = cravings.slice(-6).map((row) => `${String(row.day ?? '')} 想吃 ${row.dish ?? ''}`.trim());
    console.log(`\n最近念叨的：\n- ${shops.join('\n- ')}`);
  }
}