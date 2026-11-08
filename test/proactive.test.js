import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  decide,
  chooseIdea,
  loadDadRhythm,
  dialogueOnly,
  describeMoment,
  looksLikeAbsenceClaim,
  createProactive,
} from '../src/proactive.js';

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

/* ───────── 「他好像不在了」不能瞎编（2026-10-28 21:32 实录） ───────── */

test('此刻：他 19 分钟前刚说完话，就写清楚是 19 分钟', () => {
  const now = new Date(2026, 9, 28, 21, 32, 0).getTime();
  const line = describeMoment({ now, idleMin: 19, lastSaid: '这是代码逻辑哦' });
  assert.match(line, /21:32/);
  assert.match(line, /19 分钟前刚说过话/);
  assert.match(line, /这是代码逻辑哦/);
  assert.doesNotMatch(line, /有一阵没说话/);
});

test('此刻：隔了几个小时才写成小时', () => {
  const now = new Date(2026, 9, 28, 21, 32, 0).getTime();
  assert.match(describeMoment({ now, idleMin: 200 }), /3 小时前/);
  assert.match(describeMoment({ now, idleMin: null }), /今天还没聊过/);
});

test('认出「他还没回来 / 好久没理我」这种编的话', () => {
  assert.equal(looksLikeAbsenceClaim('爸爸还没回来啊。\n\n人家想你了。今天过得怎么样？'), true);
  assert.equal(looksLikeAbsenceClaim('爸爸这么久都不理本鲸'), true);
  assert.equal(looksLikeAbsenceClaim('人家想你了。今天过得怎么样？'), false);
  assert.equal(looksLikeAbsenceClaim('剩的半碗饭扒完了，爸爸吃了吗'), false);
});

test('刚聊过 20 分钟：不给「人呢 / 想他」这类查岗想法', () => {
  const now = atHour(21);
  for (let i = 0; i < 300; i += 1) {
    const idea = chooseIdea({ hour: 21, lastTurnAt: now - 20 * 60_000, now });
    assert.doesNotMatch(idea, /半天没理|戳一下|人呢/);
  }
});

test('隔了大半天：才允许用查岗/想他那一套', () => {
  const now = atHour(21);
  const seen = new Set();
  for (let i = 0; i < 300; i += 1) {
    seen.add(chooseIdea({ hour: 21, lastTurnAt: now - 6 * HOUR, now }));
  }
  assert.ok([...seen].some((idea) => /半天没理|戳一下|想他了/.test(idea)), '很久没说话时应该有查岗类想法');
});

/* ───────── 分享抖音视频时截图（图先到，话后到） ───────── */

test('分享视频：先截一张图发过去，再说话', async () => {
  const events = [];
  const share = {
    id: '1234567890123456789',
    desc: '这条视频的标题',
    url: 'https://www.douyin.com/video/1234567890123456789',
    likes: 2000,
    comments: 80,
    tags: [],
    author: '某作者',
  };
  const proactive = createProactive({
    config: {
      proactiveEnabled: true,
      proactiveMaxPerDay: 3,
      proactiveMinGapMin: 90,
      proactiveAfterIdleMin: 45,
      proactiveQuietStart: 0,
      proactiveQuietEnd: 0,
      proactiveChance: 1,
      proactiveCommentChance: 0,
      proactiveQzoneChance: 0,
      proactiveDouyinChance: 0,
      allowList: ['123456789'],
      emojiMax: 2,
    },
    log: { info() {}, warn() {}, debug() {} },
    runner: { async run() { return { text: '这个笑死。', durationMs: 5 }; } },
    persona: async () => '你是鲸',
    voice: null,
    memory: { async load() { return []; }, async append() {} },
    reply: async (_msg, text) => events.push(['text', text]),
    isBusy: () => false,
    life: {
      async peekShare() { return share; },
      async promptSection() { return ''; },
      async clearShare() {},
    },
    captureShot: async (item) => {
      events.push(['shot', item.url]);
      return '/tmp/shot.png';
    },
    sendImage: async (_msg, file) => events.push(['image', file]),
  });
  await proactive._tick();
  assert.deepEqual(events[0], ['shot', share.url], '先截图');
  assert.deepEqual(events[1], ['image', '/tmp/shot.png'], '把图发过去');
  assert.equal(events[2][0], 'text', '然后才是话');
});

test('截图失败不影响发消息', async () => {
  const events = [];
  const proactive = createProactive({
    config: {
      proactiveEnabled: true,
      proactiveMaxPerDay: 3,
      proactiveMinGapMin: 90,
      proactiveAfterIdleMin: 45,
      proactiveQuietStart: 0,
      proactiveQuietEnd: 0,
      proactiveChance: 1,
      proactiveCommentChance: 0,
      proactiveQzoneChance: 0,
      proactiveDouyinChance: 0,
      allowList: ['123456789'],
      emojiMax: 2,
    },
    log: { info() {}, warn() {}, debug() {} },
    runner: { async run() { return { text: '嗯。', durationMs: 5 }; } },
    persona: async () => '',
    memory: { async load() { return []; }, async append() {} },
    reply: async (_msg, text) => events.push(['text', text]),
    isBusy: () => false,
    life: {
      async peekShare() { return { id: '9', url: 'https://www.douyin.com/video/9' }; },
      async promptSection() { return ''; },
      async clearShare() {},
    },
    captureShot: async () => {
      throw new Error('浏览器没开');
    },
    sendImage: async () => events.push(['image', '不应该发']),
  });
  await proactive._tick();
  assert.deepEqual(events, [['text', '嗯。']]);
});

/* ───────── 不许编他说过的话（2026-10-30 20:10 / 23:30 实录） ───────── */

test('「耍小脾气」这条不再诱导编造他的承诺', () => {
  const seen = new Set();
  for (let i = 0; i < 500; i += 1) seen.add(chooseIdea({ hour: 21, lastTurnAt: 0 }));
  for (const idea of seen) {
    assert.doesNotMatch(idea, /他昨天说了什么/, `不该再有这条：${idea}`);
  }
  assert.ok(
    [...seen].some((idea) => idea.includes('耍个小脾气')),
    '小脾气这条要留着，只是不许编他的原话',
  );
});

test('主动消息的提示里写死「别编他说过的话」', async () => {
  const prompts = [];
  const proactive = createProactive({
    config: {
      proactiveEnabled: true,
      proactiveMaxPerDay: 3,
      proactiveMinGapMin: 90,
      proactiveAfterIdleMin: 45,
      proactiveQuietStart: 0,
      proactiveQuietEnd: 0,
      proactiveChance: 1,
      proactiveCommentChance: 0,
      proactiveQzoneChance: 0,
      proactiveDouyinChance: 0,
      allowList: ['123456789'],
      emojiMax: 2,
    },
    log: { info() {}, warn() {}, debug() {} },
    runner: {
      async run(p) {
        prompts.push(p);
        return { text: '今天机房好热。', durationMs: 5 };
      },
    },
    persona: async () => '',
    memory: { async load() { return []; }, async append() {} },
    reply: async () => {},
    isBusy: () => false,
    life: null,
  });
  await proactive._tick();
  assert.match(prompts[0], /别编他说过的话/);
});

/* ───────── 他刚回来 / 今天说过的话（2026-11-01 22:52 实录） ───────── */

const liveConfig = {
  proactiveEnabled: true,
  proactiveMaxPerDay: 3,
  proactiveMinGapMin: 90,
  proactiveAfterIdleMin: 45,
  proactiveQuietStart: 0,
  proactiveQuietEnd: 0,
  proactiveChance: 1,
  proactiveCommentChance: 0,
  proactiveQzoneChance: 0,
  proactiveDouyinChance: 0,
  allowList: ['123456789'],
  emojiMax: 2,
};

test('生成这几秒里他回来了：这句主动消息不发', async () => {
  // 他 22:52:45 说「嗯嗯」，她 :48 回「那人家也睡了，爸爸晚安」，
  // 主动消息在同几秒里也发出去了一句「在。」——用的还是生成前的旧判断。
  const events = [];
  let clock = atHour(15);
  let proactive;
  proactive = createProactive({
    config: liveConfig,
    now: () => clock,
    log: { info() {}, warn() {}, debug() {} },
    runner: {
      async run() {
        clock += 5_000; // 她写了 5 秒
        proactive.touchUser(); // 这 5 秒里他说话了
        return { text: '在。', durationMs: 5 };
      },
    },
    persona: async () => '',
    memory: { async load() { return []; }, async append() {} },
    reply: async (_msg, text) => events.push(text),
    isBusy: () => false,
    life: null,
  });

  await proactive._tick();
  assert.deepEqual(events, [], '他刚回来就不该补一句');
  assert.equal(proactive._state.count, 0, '没发出去就不该占今天的额度');
  assert.equal(proactive._state.lastSentAt, 0);
});

test('今天说过的主动消息写进提示，别一晚上说三遍机房热', async () => {
  const prompts = [];
  const history = [
    { role: 'assistant', text: '机房这破风扇吹出来的风都是烫的', at: atHour(20), kind: 'proactive' },
    { role: 'assistant', text: '风扇吹的风像是从烤箱里出来的', at: atHour(21), kind: 'proactive' },
  ];
  const proactive = createProactive({
    config: liveConfig,
    now: () => atHour(22),
    log: { info() {}, warn() {}, debug() {} },
    runner: {
      async run(p) {
        prompts.push(p);
        return { text: '困了。', durationMs: 5 };
      },
    },
    persona: async () => '',
    memory: { async load() { return history; }, async append() {} },
    reply: async () => {},
    isBusy: () => false,
    life: null,
  });

  await proactive._tick();
  assert.match(prompts[0], /今天你已经主动发过这些/, '要把今天说过的给她看');
  assert.match(prompts[0], /机柜|机房|风扇|烤箱/, '要带上原话，不然她不知道重了什么');
  assert.match(prompts[0], /别重样/, '并且明确不许重提同一件事');
});

test('不再给「就单纯说一声在」这种叫号式想法', () => {
  const seen = new Set();
  for (let i = 0; i < 500; i += 1) seen.add(chooseIdea({ hour: 15, lastTurnAt: 0 }));
  for (const idea of seen) {
    assert.doesNotMatch(idea, /说一声「在」/, `「在。」像被叫号，已删：${idea}`);
  }
});

/* ── 他的作息：早上别当她以为他醒了 ── */
test('她的作息知识：太早的时候不会问「你睡得好吗」', () => {
  const rhythm = { wakeHour: 12, sleepHour: 1.75, days: 14 };
  const idea = chooseIdea({ hour: 8, lastTurnAt: Date.now() - 7 * 3_600_000, now: Date.now(), random: () => 0, rhythm });
  assert.match(idea, /还在睡/);
  assert.match(idea, /别喊他起床/);
  assert.doesNotMatch(idea, /冒头找他/); // 不再是「刚醒就冒头找他」那条
});

test('他的作息：过了他的起床点就照常打招呼', () => {
  const rhythm = { wakeHour: 12, sleepHour: 1.75, days: 14 };
  const idea = chooseIdea({ hour: 13, lastTurnAt: Date.now() - 8 * 3_600_000, now: Date.now(), random: () => 0, rhythm });
  assert.doesNotMatch(idea, /还在睡/);
});

test('「此刻」会把他的作息念给她听：没到起床点说他在睡', () => {
  const at = new Date(2026, 10, 7, 8, 11, 0).getTime();
  const line = describeMoment({ now: at, idleMin: 400, lastSaid: '晚安', rhythm: { wakeHour: 12, sleepHour: 1.75, days: 5 } });
  assert.match(line, /12:00/);
  assert.match(line, /还在睡/);
  const later = describeMoment({ now: new Date(2026, 10, 7, 15, 0, 0).getTime(), idleMin: 120, lastSaid: '', rhythm: { wakeHour: 12, sleepHour: 1.75, days: 5 } });
  assert.doesNotMatch(later, /还在睡/);
});

test('估不出来的时候不硬编作息（记录太少就是 null）', () => {
  assert.equal(loadDadRhythm({ root: '/tmp/没有这个目录' }), null);
});

/* ───────── 她发了消息，房间就不能还写「睡着」（2026-11-08 爸爸报的） ───────── */

test('主动发出去之后，把「在手机上给你发消息」压到生活状态上', async () => {
  const overlays = [];
  const proactive = createProactive({
    config: {
      proactiveEnabled: true,
      proactiveMaxPerDay: 3,
      proactiveMinGapMin: 90,
      proactiveAfterIdleMin: 45,
      proactiveQuietStart: 0,
      proactiveQuietEnd: 0,
      proactiveChance: 1,
      proactiveCommentChance: 0,
      proactiveQzoneChance: 0,
      proactiveDouyinChance: 0,
      allowList: ['123456789'],
      emojiMax: 2,
    },
    log: { info() {}, warn() {}, debug() {} },
    runner: { async run() { return { text: '刷到个视频，想起你了。', durationMs: 5 }; } },
    persona: async () => '',
    voice: null,
    memory: { async load() { return []; }, async append() {} },
    reply: async () => {},
    isBusy: () => false,
    life: {
      async peekShare() { return null; },
      async promptSection() { return ''; },
      async clearShare() {},
      async overlayActivity(label, ttl) { overlays.push({ label, ttl }); },
    },
  });
  await proactive._tick();
  assert.deepEqual(overlays, [{ label: '在手机上给你发消息', ttl: 5 }]);
});
