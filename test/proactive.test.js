import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decide, chooseIdea, dialogueOnly } from '../src/proactive.js';

const config = {
  proactiveEnabled: true,
  proactiveMaxPerDay: 3,
  proactiveMinGapMin: 90,
  proactiveAfterIdleMin: 45,
  proactiveQuietStart: 1,
  proactiveQuietEnd: 9,
  proactiveChance: 1,
};
const atHour = (hour) => new Date(2026, 9, 24, hour, 0, 0).getTime();
const fresh = () => ({ count: 0, lastSentAt: 0, lastUserAt: 0 });

test('主动消息：关闭时不发', () => {
  const r = decide({ state: fresh(), now: atHour(15), config: { ...config, proactiveEnabled: false } });
  assert.equal(r.act, false);
  assert.equal(r.reason, 'disabled');
});

test('主动消息：凌晨静默', () => {
  assert.equal(decide({ state: fresh(), now: atHour(3), config }).reason, 'quiet-hours');
  assert.equal(decide({ state: fresh(), now: atHour(8), config }).reason, 'quiet-hours');
});

test('主动消息：白天且概率命中就发', () => {
  const r = decide({ state: fresh(), now: atHour(15), config });
  assert.equal(r.act, true);
});

test('主动消息：冷却期内不发', () => {
  const now = atHour(15);
  const r = decide({ state: { ...fresh(), lastSentAt: now - 30 * 60_000 }, now, config });
  assert.equal(r.reason, 'cooldown');
});

test('主动消息：用户刚说过话不打扰', () => {
  const now = atHour(15);
  const r = decide({ state: { ...fresh(), lastUserAt: now - 10 * 60_000 }, now, config });
  assert.equal(r.reason, 'user-just-talked');
});

test('主动消息：每天有预算上限', () => {
  const now = atHour(15);
  const day = new Date(now).toISOString().slice(0, 10);
  const r = decide({ state: { day, count: 3, lastSentAt: 0, lastUserAt: 0 }, now, config });
  assert.equal(r.reason, 'daily-budget');
});

test('主动消息：概率不中就不发，忙的时候也不发', () => {
  assert.equal(decide({ state: fresh(), now: atHour(15), config: { ...config, proactiveChance: 0.5 }, random: () => 0.9 }).reason, 'chance');
  assert.equal(decide({ state: fresh(), now: atHour(15), config, quiet: true }).reason, 'busy');
});

/* ───────── 主动消息说什么：别再对着刚聊过的人「刚睁眼」 ───────── */

const HOUR = 3_600_000;

test('主动消息：她自己的旁白不进「最近对话」', () => {
  const history = [
    { role: 'user', text: '要上课哎', at: 1 },
    { role: 'assistant', text: '那人家先不吵你。好好上课。', at: 2 },
    { role: 'assistant', text: '（顺手丢了一张表情包）', at: 3 },
  ];
  const kept = dialogueOnly(history);
  assert.equal(kept.length, 2);
  assert.ok(kept.every((entry) => !entry.text.startsWith('（')));
});

test('早上确实一晚上没说话：用「刚醒」剧本', () => {
  const now = atHour(9);
  const idea = chooseIdea({ hour: 9, lastTurnAt: now - 8 * HOUR, now, random: () => 0 });
  assert.match(idea, /刚醒/);
});

test('早上刚聊过：不许再说「刚睁眼 / 睡得怎么样」', () => {
  const now = atHour(9);
  // 10-28 09:04 那次：07:45 刚聊完，09:04 又说「刚睁眼」
  const idea = chooseIdea({ hour: 9, lastTurnAt: now - 79 * 60_000, now, random: () => 0 });
  assert.doesNotMatch(idea, /刚醒|睁眼|上线|睡得怎么样/);
});

test('深夜刚聊过：不许再说「要去睡了」', () => {
  const now = atHour(23);
  const idea = chooseIdea({ hour: 23, lastTurnAt: now - 20 * 60_000, now, random: () => 0 });
  assert.doesNotMatch(idea, /快睡了|去睡了/);
});

test('深夜很久没说话：才可以说「要睡了」', () => {
  const now = atHour(23);
  const idea = chooseIdea({ hour: 23, lastTurnAt: now - 6 * HOUR, now, random: () => 0 });
  assert.match(idea, /快睡了/);
});

test('有刚刷到的视频时，分享优先于作息剧本', () => {
  const now = atHour(9);
  const idea = chooseIdea({ hour: 9, share: true, lastTurnAt: 0, now, random: () => 0 });
  assert.match(idea, /视频/);
});
