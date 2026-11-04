import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatPlanLine } from '../src/mind.js';
import { buildPrompt } from '../src/prompt.js';

const now = new Date(2026, 10, 4, 7, 30).getTime(); // 11-04 早上
const day = (offset) => {
  const d = new Date(now + offset * 86_400_000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

test('打算：昨天写给今天的「明天」要读成「今天」', () => {
  const line = formatPlanLine({ day: day(0), text: '明天把屋顶搭完，再把墙里的土块换掉' }, now);
  assert.equal(line, '今天打算：今天把屋顶搭完，再把墙里的土块换掉');
});

test('打算：明天的、过期的都要说清楚，别混成今天', () => {
  assert.equal(formatPlanLine({ day: day(1), text: '去把地板接完' }, now), '明天打算：去把地板接完');
  assert.match(formatPlanLine({ day: day(-2), text: '去把地板接完' }, now), /已经过期/);
  assert.equal(formatPlanLine({}, now), '');
});

test('prompt：告诉他别一条里又睡又干活', () => {
  const prompt = buildPrompt({
    persona: '',
    history: [],
    text: '那你睡到自然醒吧',
    senderName: '爸爸',
    life: '现在 07:30。你正在：赖在床上。',
  });
  assert.match(prompt, /别自相矛盾/);
  assert.match(prompt, /继续睡，就别马上说要去干活/);
});
