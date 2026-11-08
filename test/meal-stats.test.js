import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatTasteReport, summarizeTaste, tastePromptLine } from '../src/meal-stats.js';
import { parseCraveNote } from '../src/life.js';

const DAY = 86_400_000;
const NOW = new Date(2026, 10, 5, 20, 0, 0).getTime();

const meal = (dish, { daysAgo = 0, slot = '晚饭', source = 'auto', by = null, hour = 19 } = {}) => ({
  at: new Date(NOW - daysAgo * DAY - (19 - hour) * 3_600_000).toISOString(),
  day: new Date(NOW - daysAgo * DAY).toISOString().slice(0, 10),
  slot,
  dish,
  by,
  source,
});

test('summarizeTaste：按次数排菜品，只算窗口内的', () => {
  const meals = [
    meal('关东煮', { daysAgo: 1 }),
    meal('关东煮', { daysAgo: 2 }),
    meal('咖喱饭', { daysAgo: 1 }),
    meal('西瓜', { daysAgo: 40 }), // 窗口外，不算
  ];
  const s = summarizeTaste({ meals, now: NOW, days: 30 });
  assert.equal(s.totalMeals, 3);
  assert.equal(s.topDishes[0].dish, '关东煮');
  assert.equal(s.topDishes[0].count, 2);
  assert.equal(s.topDishes[1].dish, '咖喱饭');
  assert.ok(!s.topDishes.some((row) => row.dish === '西瓜'));
});

test('summarizeTaste：爸爸投喂单独统计，按顿统计对得上', () => {
  const meals = [
    meal('蛋炒饭', { source: 'fed', by: '爸爸', slot: '午饭' }),
    meal('白饭', { source: 'fed', by: '爸爸', slot: '晚饭' }),
    meal('咖喱饭', { source: 'auto', slot: '晚饭' }),
  ];
  const s = summarizeTaste({ meals, now: NOW, days: 30 });
  assert.equal(s.fedByDad.length, 2);
  assert.equal(s.fedByDad[0].by, '爸爸');
  assert.equal(s.slots['午饭'], 1);
  assert.equal(s.slots['晚饭'], 2);
  assert.equal(s.bySource.fed, 2);
  assert.equal(s.bySource.auto, 1);
});

test('summarizeTaste：念叨想吃的单独排，吃的和想吃的不会混', () => {
  const meals = [meal('关东煮')];
  const cravings = [
    { at: new Date(NOW - DAY).toISOString(), day: '2026-11-04', dish: '西瓜' },
    { at: new Date(NOW - 2 * DAY).toISOString(), day: '2026-11-03', dish: '西瓜' },
    { at: new Date(NOW - 2 * DAY).toISOString(), day: '2026-11-03', dish: '火锅' },
    { at: new Date(NOW - 60 * DAY).toISOString(), day: '2026-09-06', dish: '冰淇淋' }, // 窗口外
  ];
  const s = summarizeTaste({ meals, cravings, now: NOW, days: 30 });
  assert.equal(s.topCravings[0].dish, '西瓜');
  assert.equal(s.topCravings[0].count, 2);
  assert.equal(s.topCravings.length, 2);
  assert.equal(s.topDishes.length, 1);
});

test('summarizeTaste：空账本不炸', () => {
  const s = summarizeTaste({ meals: [], cravings: [], now: NOW });
  assert.equal(s.totalMeals, 0);
  assert.equal(s.perDay, 0);
  assert.deepEqual(s.topDishes, []);
});

test('formatTasteReport：人话版带次数和投喂', () => {
  const meals = [meal('关东煮'), meal('关东煮'), meal('蛋炒饭', { source: 'fed', by: '爸爸' })];
  const text = formatTasteReport(summarizeTaste({ meals, now: NOW, days: 30 }));
  assert.match(text, /一共吃了 3 顿/);
  assert.match(text, /关东煮 2 次/);
  assert.match(text, /爸爸投喂过 1 次/);
});

test('tastePromptLine：给 prompt 的一行，空账本返回空串', () => {
  const s = summarizeTaste({ meals: [meal('关东煮'), meal('关东煮'), meal('咖喱饭')], now: NOW });
  assert.match(tastePromptLine(s), /关东煮/);
  assert.equal(tastePromptLine(summarizeTaste({ meals: [], now: NOW })), '');
});

test('parseCraveNote：抽出【想吃：…】，剩下的正文照旧', () => {
  assert.deepEqual(parseCraveNote('等你买西瓜【想吃：西瓜】'), { text: '等你买西瓜', crave: '西瓜' });
  assert.deepEqual(parseCraveNote('没这标记'), { text: '没这标记', crave: '' });
  assert.deepEqual(parseCraveNote('[想吃: 火锅]好馋'), { text: '好馋', crave: '火锅' });
});