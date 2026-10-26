import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  appendMeal,
  currentSlot,
  dayKey,
  formatMonthReport,
  loadMeals,
  maybeAutoMeal,
  previousMonth,
  summarizeMonth,
} from '../src/meals.js';

const at = (h, m = 0, day = 26) => new Date(2026, 9, day, h, m, 0);

test('认得出饭点，其余时间不算饭', () => {
  assert.equal(currentSlot(at(8))?.slot, '早饭');
  assert.equal(currentSlot(at(12))?.slot, '午饭');
  assert.equal(currentSlot(at(18))?.slot, '晚饭');
  assert.equal(currentSlot(at(22))?.slot, '宵夜');
  assert.equal(currentSlot(at(15)), null);
  assert.equal(currentSlot(at(4)), null);
});

test('记一顿会落盘，投喂会记下是谁', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'meals-'));
  const file = join(dir, 'meals.jsonl');
  await appendMeal({ file, dish: '烤鱼', at: at(18) });
  await appendMeal({ file, dish: '西瓜', by: '爸爸', at: at(13) });
  const rows = await loadMeals(file);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].slot, '晚饭');
  assert.equal(rows[1].by, '爸爸');
  assert.equal(rows[1].day, '2026-10-26');
});

test('同一顿饭只自动记一次（重启也不会重复记）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'meals-'));
  const file = join(dir, 'meals.jsonl');
  const first = await maybeAutoMeal({ file, now: at(12), random: () => 0 });
  const second = await maybeAutoMeal({ file, now: at(12, 30), random: () => 0.5 });
  assert.ok(first);
  assert.equal(second, null);
  assert.equal((await loadMeals(file)).length, 1);
});

test('不在饭点不自动记', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'meals-'));
  const file = join(dir, 'meals.jsonl');
  assert.equal(await maybeAutoMeal({ file, now: at(15) }), null);
  assert.equal((await loadMeals(file)).length, 0);
});

test('月报算得对：顿数、最爱、投喂次数', () => {
  const rows = [
    { day: '2026-10-01', slot: '午饭', dish: '鱼', by: null },
    { day: '2026-10-02', slot: '午饭', dish: '鱼', by: null },
    { day: '2026-10-03', slot: '晚饭', dish: '火锅', by: '爸爸' },
    { day: '2026-09-30', slot: '晚饭', dish: '旧月份的', by: null },
  ];
  const summary = summarizeMonth(rows, '2026-10');
  assert.equal(summary.count, 3);
  assert.equal(summary.fed, 1);
  assert.deepEqual(summary.topDishes[0], ['鱼', 2]);
  assert.match(formatMonthReport(summary), /一共 3 顿/);
  assert.match(formatMonthReport(summary), /投喂了 1 次/);
});

test('空月份也会好好说话，不是报错', () => {
  const text = formatMonthReport(summarizeMonth([], '2026-09'));
  assert.match(text, /空的/);
});

test('上个月 / 今天的日期算得对', () => {
  assert.equal(previousMonth(new Date(2026, 9, 26)), '2026-09');
  assert.equal(previousMonth(new Date(2026, 0, 5)), '2025-12');
  assert.equal(dayKey(new Date(2026, 9, 5)), '2026-10-05');
});
