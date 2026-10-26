import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  energyAt,
  moodAt,
  defaultActivity,
  currentActivity,
  describeLife,
  decideBrowse,
  unseenItems,
  scoreItem,
  pickCandidate,
  formatShare,
  freshShare,
  localDay,
  SHARE_TTL_MIN,
} from '../src/life.js';

const config = {
  lifeEnabled: true,
  lifeBrowseMaxPerDay: 3,
  lifeBrowseMinGapMin: 120,
  lifeBrowseChance: 1,
  proactiveQuietStart: 1,
  proactiveQuietEnd: 9,
};

const atHour = (hour, day = 24) => new Date(2026, 9, day, hour, 0, 0).getTime();
const freshState = () => ({ browseDay: '', browseCount: 0, browseAt: 0, seenIds: [] });

const video = (overrides = {}) => ({
  id: '7000000000000000001',
  desc: '刚刷到的一个猫猫视频，笑死',
  author: '某只猫',
  likes: 12_000,
  comments: 300,
  tags: ['猫'],
  url: 'https://www.douyin.com/video/7000000000000000001',
  isAd: false,
  isLive: false,
  ...overrides,
});

/* ───────────── 状态描述 ───────────── */

test('能量曲线：全天都在 0-100 之间', () => {
  for (let hour = 0; hour < 24; hour += 1) {
    const value = energyAt(hour);
    assert.ok(value >= 0 && value <= 100, `hour=${hour} 得到 ${value}`);
  }
});

test('能量曲线：凌晨最低，上午最高，午后有下坡', () => {
  assert.ok(energyAt(3) < energyAt(10));
  assert.ok(energyAt(13) < energyAt(12), '午饭后应该比午饭前困');
  assert.ok(energyAt(13) < energyAt(15), '下午三点应该回血');
  assert.ok(energyAt(23) < energyAt(20));
});

test('能量曲线：跨天取模不越界', () => {
  assert.equal(energyAt(24), energyAt(0));
  assert.equal(energyAt(-1), energyAt(23));
});

test('心情随能量变化', () => {
  assert.match(moodAt(90), /精神/);
  assert.match(moodAt(45), /困/);
  assert.match(moodAt(10), /睡/);
});

test('默认活动按时段走', () => {
  assert.match(defaultActivity(3).label, /睡/);
  assert.match(defaultActivity(8).label, /醒|赖/);
  assert.match(defaultActivity(13).label, /吃|午休/);
  assert.match(defaultActivity(19).label, /空间|发呆/);
  assert.ok(defaultActivity(13).ttlMin > 0);
});

test('当前活动：没有记录时退回时段默认值', () => {
  const now = atHour(15);
  const activity = currentActivity({}, now);
  assert.equal(activity.fromRecord, false);
  assert.ok(activity.label.length > 0);
});

test('当前活动：记录没过期就用记录，过期就回落', () => {
  const now = atHour(15);
  const base = now - 10 * 60_000;
  const state = { activity: '在刷抖音', activitySince: base, activityTtlMin: 60 };
  const live = currentActivity(state, now);
  assert.equal(live.fromRecord, true);
  assert.equal(live.label, '在刷抖音');
  assert.equal(live.ageMin, 10);

  const expired = currentActivity({ ...state, activitySince: now - 90 * 60_000 }, now);
  assert.equal(expired.fromRecord, false);
  assert.notEqual(expired.label, '在刷抖音');
});

test('生活状态段落包含时间、活动、心情', () => {
  const now = atHour(15);
  const text = describeLife({ activity: '在刷抖音', activitySince: now - 20 * 60_000, activityTtlMin: 60 }, now);
  assert.match(text, /15:00/);
  assert.match(text, /在刷抖音/);
  assert.match(text, /心情/);
});

/* ───────────── 刷不刷 ───────────── */

test('刷抖音：未启用时不动', () => {
  const verdict = decideBrowse({ state: freshState(), now: atHour(15), config: { ...config, lifeEnabled: false } });
  assert.equal(verdict.act, false);
  assert.equal(verdict.reason, 'disabled');
});

test('刷抖音：静默时段不动', () => {
  const verdict = decideBrowse({ state: freshState(), now: atHour(3), config });
  assert.equal(verdict.act, false);
  assert.equal(verdict.reason, 'quiet-hours');
});

test('刷抖音：当天次数用完就不刷', () => {
  const state = { ...freshState(), browseDay: localDay(atHour(15)), browseCount: 3 };
  const verdict = decideBrowse({ state, now: atHour(15), config });
  assert.equal(verdict.act, false);
  assert.equal(verdict.reason, 'daily-budget');
});

test('刷抖音：两次之间要够久', () => {
  const now = atHour(15);
  const state = { ...freshState(), browseAt: now - 30 * 60_000 };
  const verdict = decideBrowse({ state, now, config });
  assert.equal(verdict.act, false);
  assert.equal(verdict.reason, 'cooldown');
});

test('刷抖音：概率没中就不刷', () => {
  const verdict = decideBrowse({
    state: freshState(),
    now: atHour(15),
    config: { ...config, lifeBrowseChance: 0.5 },
    random: () => 0.99,
  });
  assert.equal(verdict.act, false);
  assert.equal(verdict.reason, 'chance');
});

test('刷抖音：条件都满足时刷，并给出当天计数', () => {
  const now = atHour(15);
  const state = { ...freshState(), browseDay: localDay(now), browseCount: 1 };
  const verdict = decideBrowse({ state, now, config: { ...config, lifeBrowseChance: 1 }, random: () => 0 });
  assert.equal(verdict.act, true);
  assert.equal(verdict.reason, 'ok');
  assert.equal(verdict.today, 1);
});

test('刷抖音：跨天后预算重置', () => {
  const now = atHour(15, 25);
  const state = { ...freshState(), browseDay: localDay(atHour(15, 24)), browseCount: 3 };
  const verdict = decideBrowse({ state, now, config, random: () => 0 });
  assert.equal(verdict.act, true);
  assert.equal(verdict.today, 0);
});

/* ───────────── 挑哪条 ───────────── */

test('已看过的会被过滤掉', () => {
  const items = [video({ id: 'a' }), video({ id: 'b' })];
  assert.deepEqual(
    unseenItems(items, ['a']).map((item) => item.id),
    ['b'],
  );
  assert.equal(unseenItems(items, ['a', 'b']).length, 0);
});

test('评分：中位点赞优于百万赞，广告和直播直接负分', () => {
  const mid = scoreItem(video({ likes: 30_000 }));
  const mega = scoreItem(video({ likes: 3_000_000 }));
  const cold = scoreItem(video({ likes: 0, comments: 0, tags: [] }));
  assert.ok(mid > mega, '中位点赞更像「随手刷到的」');
  assert.ok(mid > cold);
  assert.ok(scoreItem(video({ isAd: true })) < 0);
  assert.ok(scoreItem(video({ isLive: true })) < 0);
});

test('挑一条：跳过看过的和广告，没得挑就返回 null', () => {
  const items = [video({ id: 'a' }), video({ id: 'b' }), video({ id: 'c', isAd: true })];
  const picked = pickCandidate(items, ['a'], { random: () => 0 });
  assert.equal(picked.id, 'b');
  assert.equal(pickCandidate([video({ id: 'a' })], ['a']), null);
  assert.equal(pickCandidate([], []), null);
});

test('挑一条：随机不会挑到广告位', () => {
  const items = [video({ id: 'ad', isAd: true }), video({ id: 'real' })];
  for (const r of [0, 0.3, 0.7, 0.99]) {
    assert.equal(pickCandidate(items, [], { random: () => r }).id, 'real');
  }
});

/* ───────────── 分享 ───────────── */

test('分享文本包含标题、作者、链接', () => {
  const text = formatShare(video());
  assert.match(text, /猫猫/);
  assert.match(text, /@某只猫/);
  assert.match(text, /https:\/\/www\.douyin\.com\/video\//);
  assert.match(text, /万赞/);
});

test('分享文本：没有视频时返回空串', () => {
  assert.equal(formatShare(null), '');
});

test('待分享有时效，过期就不提了', () => {
  const now = Date.now();
  assert.equal(freshShare({}), null);
  assert.equal(freshShare({ pendingShare: { item: video(), at: now } }, now).item.id, video().id);
  assert.equal(
    freshShare({ pendingShare: { item: video(), at: now - (SHARE_TTL_MIN + 1) * 60_000 } }, now),
    null,
  );
});

test('localDay 用本地时区且长度固定', () => {
  assert.equal(localDay(new Date(2026, 0, 5, 12, 0, 0).getTime()), '2026-01-05');
});