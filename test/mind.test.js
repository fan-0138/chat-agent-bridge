import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  dreamingAt,
  decideMind,
  buildThoughtPrompt,
  buildDreamPrompt,
  parseMind,
  agoLabel,
  recentThemes,
  repeatsThemes,
  formatThoughtSection,
  formatMemorySection,
  createMind,
} from '../src/mind.js';

const atHour = (hour, day = 24) => new Date(2026, 9, day, hour, 0, 0).getTime();

const baseConfig = {
  mindEnabled: true,
  mindMaxPerDay: 48,
  mindMinGapMin: 6,
  mindActiveWindowMin: 12,
  mindActiveChance: 0.35,
  mindDreamMaxPerNight: 5,
  mindDreamGapMin: 50,
  mindInjectThoughts: 3,
  mindInjectMemories: 5,
  mindInjectTtlH: 4,
  mindStreamFile: 'data/mind/stream.jsonl',
  mindMemoryFile: 'data/mind/memory.jsonl',
  mindStateFile: 'data/mind/state.json',
  mindHistoryDir: 'data/qq/memory',
};

test('凌晨做梦、白天想事', () => {
  assert.equal(dreamingAt(0), true);
  assert.equal(dreamingAt(5), true);
  assert.equal(dreamingAt(6), false);
  assert.equal(dreamingAt(15), false);
  assert.equal(dreamingAt(23), false);
});

test('关掉时不想；刚想过不连着再想', () => {
  assert.equal(decideMind({ state: {}, config: { ...baseConfig, mindEnabled: false }, now: atHour(15) }).reason, 'disabled');

  const now = atHour(15);
  const verdict = decideMind({ state: { lastAt: now - 60_000, day: '2026-10-24', count: 1 }, config: baseConfig, now });
  assert.equal(verdict.act, false);
  assert.equal(verdict.reason, 'gap');
});

test('每天有额度，跨天归零；睡着时走做梦的额度', () => {
  const now = atHour(15);
  const spent = decideMind({ state: { day: '2026-10-24', count: 48, lastAt: now - 3_600_000 }, config: baseConfig, now });
  assert.equal(spent.reason, 'daily-budget');

  const nextDay = decideMind({ state: { day: '2026-10-23', count: 48, lastAt: now - 3_600_000 }, config: baseConfig, now });
  assert.equal(nextDay.act, true);

  const night = decideMind({
    state: { dreamDay: '2026-10-24', dreamCount: 5, lastDreamAt: now - 3_600_000 },
    config: baseConfig,
    now: atHour(2),
  });
  assert.equal(night.reason, 'dream-budget');

  const dreamGap = decideMind({ state: { lastDreamAt: atHour(2) - 10 * 60_000 }, config: baseConfig, now: atHour(2) });
  assert.equal(dreamGap.reason, 'dream-gap');

  const dream = decideMind({ state: { lastDreamAt: atHour(2) - 90 * 60_000 }, config: baseConfig, now: atHour(2) });
  assert.equal(dream.act, true);
  assert.equal(dream.kind, 'dream');
});

test('他刚说完话时降低频率，隔久了才稳定会想', () => {
  const now = atHour(15);
  const active = decideMind({ state: {}, config: baseConfig, now, idleMin: 2, random: () => 0.9 });
  assert.equal(active.reason, 'chance');
  const lucky = decideMind({ state: {}, config: baseConfig, now, idleMin: 2, random: () => 0.1 });
  assert.equal(lucky.act, true);
  assert.equal(lucky.kind, 'think');

  const idle = decideMind({ state: {}, config: baseConfig, now, idleMin: 40, random: () => 0.99 });
  assert.equal(idle.act, true);
});

test('独处 prompt 带人设、状态、最近想法、对话，且要求 JSON', () => {
  const prompt = buildThoughtPrompt({
    persona: '我是小鲸。',
    lifeText: '现在 21:41。你正在：在机房写代码。',
    recent: [{ at: atHour(21), text: '风扇声像海。' }],
    memories: [{ at: atHour(10), text: '西瓜要挑纹路深的。' }],
    chat: [{ at: atHour(21), role: 'user', text: '嗯' }],
  });
  assert.match(prompt, /没有人跟你说话/);
  assert.match(prompt, /我是小鲸/);
  assert.match(prompt, /风扇声像海/);
  assert.match(prompt, /西瓜要挑纹路深的/);
  assert.match(prompt, /爸爸：嗯/);
  assert.match(prompt, /"想":/);
  // 这里不该出现「对人说话」的规则
  assert.doesNotMatch(prompt, /说话方式/);
});

test('做梦 prompt 是画面，不是聊天', () => {
  const prompt = buildDreamPrompt({ persona: '我是小鲸。', lifeText: '半夜。', recent: [], memories: [], chat: [] });
  assert.match(prompt, /睡着了，正在做梦/);
  assert.match(prompt, /"梦":/);
});

test('解析：正常 JSON、代码块、带解释、纯文本兜底', () => {
  const ok = parseMind('{"想":"他回得有点敷衍。","情绪":"闷","做":"记住","内容":"他累了话就短"}');
  assert.deepEqual(ok, { kind: 'think', text: '他回得有点敷衍。', mood: '闷', action: 'remember', content: '他累了话就短' });

  const fenced = parseMind('好的\n```json\n{"梦":"机柜变成一排鲸鱼肋骨","情绪":"安静"}\n```', 'dream');
  assert.equal(fenced.kind, 'dream');
  assert.equal(fenced.text, '机柜变成一排鲸鱼肋骨');

  const wish = parseMind('{"想":"有点想他","情绪":"软","做":"想他"}');
  assert.equal(wish.action, 'wish');

  const search = parseMind('{"想":"鲸鱼为什么会搁浅","情绪":"好奇","做":"想看","内容":"鲸鱼为什么会搁浅"}');
  assert.equal(search.action, 'search');
  assert.equal(search.content, '鲸鱼为什么会搁浅');

  const plain = parseMind('就是有点想吃西瓜', 'think');
  assert.equal(plain.text, '就是有点想吃西瓜');
  assert.equal(plain.action, 'none');

  assert.equal(parseMind('   ', 'think'), null);
});

test('注入段落带时间，并提醒别把想法当成他说的话', () => {
  const text = formatThoughtSection([{ at: atHour(21), text: '风扇声像海。' }]);
  assert.match(text, /21:00 风扇声像海/);
  assert.match(text, /不是他说的话/);

  const memory = formatMemorySection([{ at: atHour(10), text: '西瓜要挑纹路深的。' }]);
  assert.match(memory, /10\/24 西瓜要挑纹路深的/);
});

test('真跑一轮：落盘、记下、计数、能重新读出来', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mind-'));
  try {
    const now = atHour(15);
    let reply = '{"想":"刚才那句话有点冷。","情绪":"闷","做":"记住","内容":"他忙的时候话很短"}';
    const runner = { run: async () => ({ text: reply }) };
    const mind = createMind({
      config: baseConfig,
      runner,
      persona: async () => '我是小鲸。',
      life: { promptSection: async () => '现在 15:00。你在机房发呆。' },
      root: dir,
      now: () => now,
      log: { debug() {}, info() {}, warn() {}, error() {} },
    });

    const first = await mind.tick();
    assert.equal(first.ok, true);
    assert.equal(first.record.kind, 'think');
    assert.equal(first.record.text, '刚才那句话有点冷。');

    const stream = await readFile(join(dir, baseConfig.mindStreamFile), 'utf8');
    assert.match(stream, /刚才那句话有点冷/);
    const memories = await readFile(join(dir, baseConfig.mindMemoryFile), 'utf8');
    assert.match(memories, /他忙的时候话很短/);

    const peek = await mind.peek();
    assert.equal(peek.today, 1);
    assert.equal(peek.state.wish, undefined);

    const injected = await mind.promptSection();
    assert.match(injected, /你自己刚才在心里想的/);
    assert.match(injected, /刚才那句话有点冷/);
    assert.match(injected, /你自己记下的事/);

    // 同一句话再说一遍会被丢掉
    const again = await mind.tick({ force: true });
    assert.equal(again.ok, false);
    assert.equal(again.reason, 'repeat');

    // 换了内容就正常记
    reply = '{"想":"想吃西瓜。","情绪":"馋","做":"none"}';
    const third = await mind.tick({ force: true });
    assert.equal(third.ok, true);
    assert.equal(third.record.text, '想吃西瓜。');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('没开时不注入任何东西', async () => {
  const mind = createMind({ config: { ...baseConfig, mindEnabled: false }, root: '/tmp', log: { warn() {} } });
  assert.equal(await mind.promptSection(), '');
});

test('做梦那轮落成 dream，不占「想」的额度', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mind-'));
  try {
    const night = atHour(2);
    const mind = createMind({
      config: baseConfig,
      runner: { run: async () => ({ text: '{"梦":"水一直往上，机柜变成了芦苇","情绪":"安静"}' }) },
      root: dir,
      now: () => night,
      log: { debug() {}, info() {}, warn() {}, error() {} },
    });
    const result = await mind.tick();
    assert.equal(result.ok, true);
    assert.equal(result.record.kind, 'dream');
    assert.match(result.record.text, /芦苇/);
    const peek = await mind.peek();
    assert.equal(peek.dreamed, 1);
    assert.equal(peek.today, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test('对话行带「多久以前」：不让模型自己算时间', () => {
  const now = atHour(21);
  const prompt = buildThoughtPrompt({
    persona: '',
    lifeText: '',
    chat: [{ at: now - 4 * 60_000, role: 'user', text: '等会宝贝就知道了' }],
    now,
  });
  assert.match(prompt, /20:56（4 分钟前）爸爸：等会宝贝就知道了/);
  assert.equal(agoLabel(now - 30_000, now), '刚刚');
  assert.equal(agoLabel(now - 2 * 3_600_000, now), '2 小时前');
  assert.equal(agoLabel(0, now), '');
});

test('连着几条都在说同一个东西，能认出来', () => {
  const rows = [
    { text: '眼镜又滑到鼻尖了，懒得往上推' },
    { text: '眼镜推上去两秒又滑回来' },
    { text: '眼镜怎么推都往下滑' },
  ];
  const themes = recentThemes(rows);
  assert.ok(themes.includes('眼镜'), themes.join(','));
  assert.equal(repeatsThemes('眼镜还是不听话', themes), true);
  assert.equal(repeatsThemes('想吃西瓜', themes), false);
});

test('prompt 里会列出「这次换个方向」', () => {
  const prompt = buildThoughtPrompt({ persona: '', lifeText: '', themes: ['眼镜', '滑落'] });
  assert.match(prompt, /该换个方向/);
  assert.match(prompt, /眼镜/);
});

test('她惦记着想搜的东西，取一次就清掉', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mind-'));
  try {
    const now = atHour(15);
    const mind = createMind({
      config: baseConfig,
      runner: { run: async () => ({ text: '{"想":"有点好奇","情绪":"好奇","做":"想看","内容":"鲸鱼为什么会搁浅"}' }) },
      root: dir,
      now: () => now,
      log: { debug() {}, info() {}, warn() {}, error() {} },
    });
    const result = await mind.tick({ force: true });
    assert.equal(result.ok, true);
    assert.equal(result.record.action, 'search');

    const first = await mind.takeSearch();
    assert.equal(first.text, '鲸鱼为什么会搁浅');
    assert.equal(await mind.takeSearch(), null, '取过一次就清掉');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
