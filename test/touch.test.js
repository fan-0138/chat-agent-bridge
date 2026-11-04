import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  PAT_COOLDOWN_MS,
  PAT_PROMPT_TTL_MS,
  PAT_STREAK_WINDOW_MS,
  buildPatReplyPrompt,
  createTouch,
  formatTouchSection,
  patReaction,
  pickPatLine,
} from '../src/touch.js';

const at = (iso) => Date.parse(iso);
const zero = () => 0; // 固定取台词池第一句，方便断言
const DAY = 24 * 3_600_000;

test('摸头：第一次是第 1 档，2.5 秒内连点算冷却', () => {
  const now = at('2026-11-03T12:00:00Z');
  const first = patReaction({ now, random: zero });
  assert.equal(first.ok, true);
  assert.equal(first.level, 1);
  assert.equal(first.streak, 1);
  assert.equal(first.count, 1);
  assert.ok(first.line.length > 0);

  const again = patReaction({ state: { day: '2026-11-03', count: 1, streak: 1, lastAt: now - PAT_COOLDOWN_MS + 100 }, now, random: zero });
  assert.equal(again.ok, false);
  assert.equal(again.reason, 'cooldown');
  assert.equal(again.count, 1); // 不落盘、不计数
});

test('摸头：连击分档 1 / 2-3 / 4-5 / 6+', () => {
  const now = at('2026-11-03T12:00:00Z');
  const step = 5_000;
  let streak = 0;
  const levels = [];
  for (let i = 0; i < 6; i += 1) {
    const result = patReaction({
      state: { day: '2026-11-03', count: i, streak, streakAt: now - step, lastAt: now - step },
      now,
      random: zero,
    });
    streak = result.streak;
    levels.push(result.level);
  }
  assert.deepEqual(levels, [1, 2, 2, 3, 3, 4]);
});

test('摸头：超过 90 秒重新从一开始', () => {
  const now = at('2026-11-03T12:00:00Z');
  const result = patReaction({
    state: { day: '2026-11-03', count: 3, streak: 3, lastAt: now - PAT_STREAK_WINDOW_MS - 1_000 },
    now,
    random: zero,
  });
  assert.equal(result.streak, 1);
  assert.equal(result.level, 1);
  assert.equal(PAT_STREAK_WINDOW_MS, 90_000);
});

test('摸头：睡着时叫不醒，也不涨连击', () => {
  const now = at('2026-11-03T02:00:00Z');
  const result = patReaction({ now, scene: 'sleep', random: zero });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'asleep');
  assert.equal(result.streak, 0);
  assert.ok(result.line);
});

test('摸头：跨天计数从 1 重新算', () => {
  const now = at('2026-11-03T12:00:00Z');
  const result = patReaction({ state: { day: '2026-11-02', count: 9, streak: 0 }, now, random: zero });
  assert.equal(result.count, 1);
});

test('摸头：台词按时间/情绪挑，random 固定可复现', () => {
  const night = pickPatLine({ level: 1, hour: 23, random: zero });
  assert.equal(night, '困……别闹');
  const quiet = pickPatLine({ level: 2, hour: 12, mood: '烦，累', random: zero });
  assert.equal(quiet, '嗯。');
  const normal = pickPatLine({ level: 1, hour: 12, random: zero });
  assert.equal(normal, '嗯…');
  const last = pickPatLine({ level: 4, hour: 12, random: () => 0.999 });
  assert.equal(last, '再摸我咬你');
});

test('摸头：进 prompt 的时间窗', () => {
  const now = at('2026-11-03T12:00:00Z');
  const state = { lastAt: now - 3 * 60_000, lastLine: '嗯…', streak: 3 };
  const text = formatTouchSection(state, { now });
  assert.match(text, /他刚才摸了摸你的头/);
  assert.match(text, /3 分钟前/);
  assert.match(text, /嗯…/);
  assert.match(text, /摸了好几下/);

  assert.equal(formatTouchSection({ lastAt: now - PAT_PROMPT_TTL_MS - 1_000, lastLine: '嗯…' }, { now }), '');
  assert.equal(formatTouchSection({}, { now }), '');
  assert.equal(formatTouchSection(null, { now }), '');
});

test('摸头：落盘后能读回，坏状态文件不抛', async () => {
  const root = await mkdtemp(join(tmpdir(), 'touch-'));
  try {
    let clock = at('2026-11-03T12:00:00Z');
    const touch = createTouch({ root, now: () => clock, log: { warn() {} } });

    const first = await touch.pat({ hour: 12 });
    assert.equal(first.ok, true);
    assert.equal(first.streak, 1);

    clock += 1_000;
    assert.equal((await touch.pat({ hour: 12 })).reason, 'cooldown');

    clock += 5_000;
    const second = await touch.pat({ hour: 12 });
    assert.equal(second.ok, true);
    assert.equal(second.streak, 2);

    const state = JSON.parse(await readFile(join(root, 'data/mind/touch-state.json'), 'utf8'));
    assert.equal(state.count, 2);
    assert.equal(state.streak, 2);
    assert.equal(state.day, '2026-11-03');

    const last = await touch.last();
    assert.equal(last.streak, 2);
    assert.ok(last.line);

    await writeFile(join(root, 'data/mind/touch-state.json'), '{坏', 'utf8');
    const broken = createTouch({ root, now: () => clock, log: { warn() {} } });
    assert.deepEqual(await broken.state(), {});
    assert.equal((await broken.last()).streak, 2); // jsonl 还是好的
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('摸头：隔天后输入旧状态不会崩', () => {
  const now = at('2026-11-04T12:00:00Z');
  const result = patReaction({ state: { day: '2026-11-03', count: 2, lastAt: now - DAY * 2 }, now, random: zero });
  assert.equal(result.ok, true);
  assert.equal(result.count, 1);
});


test('她自己的反应：prompt 里有视频、有那半句、有字数要求', () => {
  const prompt = buildPatReplyPrompt({ persona: '我是小鲸。', line: '嗯…', streak: 1, hour: 12 });
  assert.match(prompt, /我是小鲸/);
  assert.match(prompt, /摸了摸你的头/);
  assert.match(prompt, /嗯…/);
  assert.match(prompt, /8～20 个字/);
  assert.doesNotMatch(prompt, /想躲/);

  const many = buildPatReplyPrompt({ line: '别摸了', streak: 5, hour: 12 });
  assert.match(many, /想躲/);
  const asleep = buildPatReplyPrompt({ line: '唔', streak: 0, scene: 'sleep', hour: 2 });
  assert.match(asleep, /半梦半醒/);
});

test('进 prompt：摸完紧接着开口才提醒她提一句', () => {
  const now = at('2026-11-03T12:00:00Z');
  const fresh = { lastAt: now - 2 * 60_000, lastLine: '嗯…' };
  assert.match(formatTouchSection(fresh, { now, nudge: true }), /顺口提一句/);
  assert.doesNotMatch(formatTouchSection(fresh, { now }), /顺口提一句/);
  // 20 分钟前摸的：还算「刚才」，但不推她去翻旧账
  const old = { lastAt: now - 20 * 60_000, lastLine: '嗯…' };
  assert.match(formatTouchSection(old, { now, nudge: true }), /摸了摸你的头/);
  assert.doesNotMatch(formatTouchSection(old, { now, nudge: true }), /顺口提一句/);
});

test('进 prompt：她已经自己补了一句，就带上那句', () => {
  const now = at('2026-11-03T12:00:00Z');
  const state = {
    lastAt: now - 60_000,
    lastLine: '嗯…',
    said: { at: now - 30_000, forAt: now - 60_000, text: '你手凉不凉' },
  };
  const text = formatTouchSection(state, { now });
  assert.match(text, /你后来自己补了一句「你手凉不凉」/);
  // 对不上就不算（比如后来又摸了一下）
  const stale = { ...state, lastAt: now - 10_000 };
  assert.doesNotMatch(formatTouchSection(stale, { now }), /你手凉不凉/);
});

test('落盘：说出去的那句能读回来，下次被摸就不算数了', async () => {
  const root = await mkdtemp(join(tmpdir(), 'touch-say-'));
  try {
    let clock = at('2026-11-03T12:00:00Z');
    const touch = createTouch({ root, now: () => clock, log: { warn() {} } });
    const first = await touch.pat({ hour: 12 });
    const said = await touch.say({ forAt: first.at, text: '「你手好凉」' });
    assert.equal(said.text, '你手好凉');

    const state = await touch.state();
    assert.equal(state.said.forAt, first.at);
    assert.match(formatTouchSection(state, { now: clock }), /你手好凉/);

    const rows = (await readFile(join(root, 'data/mind/touch.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    assert.equal(rows.at(-1).kind, 'pat-said');
    assert.equal(rows.at(-1).text, '你手好凉');

    // 再摸一下：上一次那句就不显示了
    clock += 5_000;
    await touch.pat({ hour: 12 });
    assert.doesNotMatch(formatTouchSection(await touch.state(), { now: clock }), /你手好凉/);

    assert.equal(await touch.say({ forAt: 0, text: 'x' }), null);
    assert.equal(await touch.say({ forAt: first.at, text: '   ' }), null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
