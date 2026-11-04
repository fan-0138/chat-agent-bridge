import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  PLAY_MIN_GAP_MIN,
  buildThoughtPrompt,
  createMind,
  decidePlay,
  formatPlaySection,
  parseMind,
  summarizeSession,
} from '../src/mind.js';
import { maybePlay, playArgs } from '../scripts/mind-run.mjs';

const atHour = (hour, day = 24) => new Date(2026, 9, day, hour, 0, 0).getTime();
const quiet = { debug() {}, info() {}, warn() {}, error() {} };

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

/** 往临时根目录塞一条 sessions.jsonl 记录。 */
async function writeSession(dir, row) {
  await mkdir(join(dir, 'data/mc'), { recursive: true });
  await writeFile(join(dir, 'data/mc/sessions.jsonl'), `${JSON.stringify(row)}\n`, 'utf8');
}

test('限流：90 分钟内不玩，满了才玩；离线/占用都不玩', () => {
  const now = atHour(18);
  assert.equal(decidePlay({ now, state: {} }).go, true);
  assert.equal(PLAY_MIN_GAP_MIN, 90);

  const fresh = decidePlay({ now, state: { lastPlayAt: now - 89 * 60_000 } });
  assert.equal(fresh.go, false);
  assert.equal(fresh.reason, 'gap');
  assert.equal(fresh.waitMin, 1);

  assert.equal(decidePlay({ now, state: { lastPlayAt: now - 90 * 60_000 } }).go, true);
  assert.equal(decidePlay({ now, state: {}, online: false }).reason, 'offline');
  assert.equal(decidePlay({ now, state: {}, busy: true }).reason, 'busy');
});

test('解析「玩」：第四个动作，没写做时行为不变', () => {
  const play = parseMind('{"想":"手痒","情绪":"想动","做":"玩","内容":"去砍点木头搭个棚子"}');
  assert.equal(play.action, 'play');
  assert.equal(play.content, '去砍点木头搭个棚子');
  assert.equal(parseMind('{"想":"发呆","情绪":"懒"}').action, 'none');
  assert.equal(parseMind('就是想吃西瓜', 'think').action, 'none');
});

test('独处 prompt：告诉它 做=玩，带上一行最近在 Minecraft 里', () => {
  const prompt = buildThoughtPrompt({
    persona: '',
    lifeText: '',
    playText: '今天在游戏里砍了 7 块橡木、3 块桦木',
  });
  assert.match(prompt, /最近在 Minecraft 里/);
  assert.match(prompt, /砍了 7 块橡木/);
  assert.match(prompt, /做=玩/);
  assert.match(prompt, /"做":"none\|记住\|想他\|想看\|玩\|评论\|刷\|说\|回\|收\|计划\|访\|约"/);

  // 没玩过就没有这一段，原有内容不变
  const plain = buildThoughtPrompt({ persona: '我是小鲸。' });
  assert.doesNotMatch(plain, /最近在 Minecraft 里/);
  assert.match(plain, /"想":/);
});

test('把最后一场游戏压成一句话；超过 24 小时不算', () => {
  const startedAt = new Date(2026, 9, 24, 16, 37).toISOString();
  const row = {
    startedAt,
    minutes: 2,
    turns: 6,
    goal: '砍点木头，攒材料，晚上好搭个棚子',
    inventory: [
      { name: 'oak_log', count: 7 },
      { name: 'wooden_sword', count: 1 },
      { name: 'birch_log', count: 3 },
    ],
  };
  const line = summarizeSession(row, atHour(18, 24));
  assert.match(line, /今天在游戏里砍了 7 块橡木、3 块桦木/);
  assert.match(line, /本来想：砍点木头/);
  assert.doesNotMatch(line, /木剑/); // 工具不算玩出来的
  assert.equal(summarizeSession(row, atHour(18, 25)), '');
  assert.equal(summarizeSession({}, atHour(18, 24)), '');
});

test('sessions.jsonl 会进 promptSection；文件不在就安静跳过', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mind-play-'));
  try {
    const now = atHour(18, 24);
    const mind = createMind({ config: baseConfig, root: dir, now: () => now, log: quiet });
    assert.equal(await mind.promptSection(), '');

    await writeSession(dir, {
      startedAt: new Date(2026, 9, 24, 17, 0).toISOString(),
      turns: 4,
      inventory: [{ name: 'oak_log', count: 7 }],
    });
    const text = await mind.promptSection();
    assert.match(text, /最近在 Minecraft 里/);
    assert.match(text, /砍了 7 块橡木/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('想事情时素材里带着最近玩过的；tick 不负责起进程', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mind-play-'));
  try {
    const now = atHour(18, 24);
    await writeSession(dir, {
      startedAt: new Date(2026, 9, 24, 17, 0).toISOString(),
      turns: 3,
      inventory: [{ name: 'birch_log', count: 3 }],
    });
    let prompt = '';
    const mind = createMind({
      config: baseConfig,
      runner: {
        run: async (text) => {
          prompt = text;
          return { text: '{"想":"想去搭个棚子","情绪":"手痒","做":"玩","内容":"搭个棚子"}' };
        },
      },
      root: dir,
      now: () => now,
      log: quiet,
    });
    const result = await mind.tick({ force: true });
    assert.equal(result.ok, true);
    assert.equal(result.record.action, 'play');
    assert.match(prompt, /最近在 Minecraft 里/);
    assert.match(prompt, /砍了 3 块桦木/);
    // 起进程/落 lastPlayAt 是 mind-run 的事，tick 不管
    assert.equal((await mind.peek()).state.lastPlayAt, undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('玩过之后记下 lastPlayAt，限流认它', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mind-play-'));
  try {
    const now = atHour(18, 24);
    const mind = createMind({ config: baseConfig, root: dir, now: () => now, log: quiet });
    await mind.markPlayed(now);
    const peek = await mind.peek();
    assert.equal(peek.state.lastPlayAt, now);
    assert.equal(decidePlay({ state: peek.state, now: now + 30 * 60_000 }).go, false);
    assert.equal(decidePlay({ state: peek.state, now: now + PLAY_MIN_GAP_MIN * 60_000 }).go, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('dry-run 只打印「本来要玩」，不起进程、不落 state', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mind-play-'));
  const lines = [];
  const original = console.log;
  console.log = (line) => lines.push(String(line));
  try {
    const mind = {
      _state: () => ({}),
      markPlayed: async () => {
        throw new Error('dry-run 不该落 state');
      },
    };
    const result = await maybePlay({ root: dir, mind, log: quiet, record: { content: '去砍点木头搭个棚子' }, dry: true });
    assert.equal(result.started, false);
    assert.equal(result.reason, 'dry-run');
    assert.deepEqual(lines, ['本来要玩：去砍点木头搭个棚子']);
    // 没起进程：pid / 日志文件都不该出现
    await assert.rejects(readFile(join(dir, 'data/mc/play-daemon.pid')), /ENOENT/);
    await assert.rejects(readFile(join(dir, 'data/mc/play-daemon.log')), /ENOENT/);
  } finally {
    console.log = original;
    await rm(dir, { recursive: true, force: true });
  }
});

test('拼给 play.mjs 的参数：4 分钟、带 goal', () => {
  assert.deepEqual(playArgs('去砍点木头搭个棚子'), [
    '--env-file-if-exists=.env.qq',
    'tools/mc/play.mjs',
    '--minutes',
    '4',
    '--goal',
    '去砍点木头搭个棚子',
  ]);
  assert.equal(formatPlaySection(''), '');
  assert.match(formatPlaySection('今天砍了木头'), /最近在 Minecraft 里/);
});