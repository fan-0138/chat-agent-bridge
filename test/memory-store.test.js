import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createMemoryStore,
  formatRecallSection,
  formatRecentSection,
  gramsOf,
  rankCandidates,
} from '../src/memory-store.js';

const quiet = { debug() {}, info() {}, warn() {}, error() {} };
const DAY = 86_400_000;
const at = (iso) => Date.parse(iso);

async function makeRoot() {
  const root = await mkdtemp(join(tmpdir(), 'memory-'));
  await mkdir(join(root, 'data/memory'), { recursive: true });
  return root;
}

test('检索词：中文按二字切，虚词不算，英文数字保留', () => {
  const grams = gramsOf('爸爸，你还记得西瓜吗？');
  assert.ok(grams.has('西瓜'));
  assert.ok(grams.has('爸爸') || grams.has('爸你') || grams.has('还记'));
  assert.ok(!grams.has('吗？'));
  const mixed = gramsOf('MC 里那个 871');
  assert.ok(mixed.has('mc'));
  assert.ok(mixed.has('871'));
  assert.equal(gramsOf('').size, 0);
});

test('排序：命中越多越靠前，近的更重要，没命中的不要', () => {
  const now = at('2026-11-04T12:00:00Z');
  const candidates = [
    { at: now - 60 * DAY, text: '他说过：西瓜别放冰箱太久', salience: 2 },
    { at: now - 2 * DAY, text: '西瓜买回来放桌上就行', salience: 2 },
    { at: now - 1 * DAY, text: '今天下雨了', salience: 2 },
  ];
  const rows = rankCandidates({ query: '西瓜 买回来', candidates, now, limit: 4 });
  assert.equal(rows.length, 2);
  assert.match(rows[0].text, /西瓜买回来/);
  // 没命中「下雨」那句不该出现
  assert.ok(!rows.some((row) => row.text.includes('下雨')));
  assert.ok(rows[0].score > rows[1].score);
});

test('排序：一句话里没有有效词就什么都不捞', () => {
  const now = Date.now();
  assert.deepEqual(rankCandidates({ query: '在吗', candidates: [{ at: now, text: '在吗' }], now }), []);
  assert.deepEqual(rankCandidates({ query: '', candidates: [{ at: now, text: 'x' }], now }), []);
});

test('落盘：写进情景、同日同题不重复、事实新的盖旧的', async () => {
  const root = await makeRoot();
  try {
    const now = at('2026-11-04T12:00:00Z');
    const store = createMemoryStore({ root, now: () => now, log: quiet });

    const first = await store.addEpisode({ at: now, title: '一起看了月亮', detail: '窗外月亮很圆', people: ['爸爸'], salience: 3 });
    assert.equal(first.title, '一起看了月亮');
    const dup = await store.addEpisode({ at: now + 60_000, title: '一起看了月亮', detail: '又说了一遍' });
    assert.equal(dup.duplicate, true);

    const rows = await store.readEpisodes();
    assert.equal(rows.length, 1);
    assert.match(rows[0].text, /窗外月亮很圆/);

    await store.upsertFact({ at: now, subject: '爸爸', key: '爱吃的', value: '西瓜' });
    await store.upsertFact({ at: now + 1000, subject: '爸爸', key: '爱吃的', value: '火锅' });
    const facts = await store.readFacts();
    assert.equal(facts.length, 1);
    assert.equal(facts[0].value, '火锅');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('回忆：情景、自记、聊天里的一句话都能被捞出来', async () => {
  const root = await makeRoot();
  try {
    const now = at('2026-11-04T12:00:00Z');
    const store = createMemoryStore({ root, now: () => now, log: quiet });
    await store.addEpisode({ at: now - DAY, title: '一起背了《蒹葭》', detail: '卡在第三章', people: ['爸爸'], salience: 4 });
    await mkdir(join(root, 'data/mind'), { recursive: true });
    await writeFile(join(root, 'data/mind/memory.jsonl'), `${JSON.stringify({ at: now - 3 * DAY, text: '他说蒹葭第三章最难背' })}\n`, 'utf8');
    await mkdir(join(root, 'data/qq/memory'), { recursive: true });
    await writeFile(
      join(root, 'data/qq/memory/user_private_1.jsonl'),
      [
        { at: now - 5 * DAY, role: 'user', text: '蒹葭第三章我小时候背过' },
        { at: now - 5 * DAY, role: 'assistant', text: '那你背给我听' },
        { at: now - 4 * DAY, role: 'user', text: '今天吃了火锅' },
      ]
        .map((row) => JSON.stringify(row))
        .join('\n') + '\n',
      'utf8',
    );

    const hits = await store.recall('蒹葭第三章怎么背来着');
    assert.ok(hits.length >= 2);
    assert.ok(hits.some((row) => row.kind === 'episode'));
    assert.ok(hits.some((row) => row.kind === 'chat'));

    const section = await store.promptSection('蒹葭');
    assert.match(section, /你记得的事/);
    assert.match(section, /蒹葭/);

    // 不相关的话不按关键词硬塞，但最近两天的事会固定当背景带上（2026-11-04 改：
    // 之前隔一天就像失忆，现在至少最近的事一直在）
    const unrelated = await store.promptSection('今天星期几');
    assert.match(unrelated, /你记得的事/);
    assert.match(unrelated, /最近两天|蒹葭/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('最近几天：只取窗口内的，按时间倒序', async () => {
  const root = await makeRoot();
  try {
    const now = at('2026-11-04T12:00:00Z');
    const store = createMemoryStore({ root, now: () => now, log: quiet });
    await store.addEpisode({ at: now - DAY, title: '昨天的事' });
    await store.addEpisode({ at: now - 10 * DAY, title: '很久以前的事' });
    const rows = await store.recentEpisodes({ days: 3, limit: 5 });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].title, '昨天的事');
    assert.match(formatRecentSection(rows, { now }), /昨天的事/);
    assert.equal(formatRecentSection([], { now }), '');
    assert.equal(formatRecallSection([], { now }), '');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('坏文件不抛：可以直接在空目录上回忆/统计', async () => {
  const root = await mkdtemp(join(tmpdir(), 'memory-bad-'));
  try {
    const store = createMemoryStore({ root, log: quiet });
    assert.deepEqual(await store.recall('西瓜'), []);
    assert.deepEqual(await store.readFacts(), []);
    const stats = await store.stats();
    assert.equal(stats.episodes, 0);
    assert.equal(stats.facts, 0);
    await mkdir(join(root, 'data/memory'), { recursive: true });
    await writeFile(join(root, 'data/memory/episodes.jsonl'), '{坏\n{"at":1,"title":"好的"}\n', 'utf8');
    assert.equal((await store.readEpisodes()).length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('整理进度：meta 能读能写', async () => {
  const root = await makeRoot();
  try {
    const store = createMemoryStore({ root, log: quiet });
    assert.equal((await store.readMeta()).lastDigestDay, undefined);
    await store.saveMeta({ lastDigestDay: '2026-11-04', lastDigestAt: 123 });
    const meta = await store.readMeta();
    assert.equal(meta.lastDigestDay, '2026-11-04');
    const stats = await store.stats();
    assert.equal(stats.lastDigestDay, '2026-11-04');
    const raw = await readFile(join(root, 'data/memory/state.json'), 'utf8');
    assert.match(raw, /lastDigestDay/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test('她自己写的笔记：写进去、捞得出来、最近的事也带得上', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mem-note-'));
  try {
    const store = createMemoryStore({ root, log: { debug() {}, warn() {}, info() {} } });
    await store.addNote({ text: '爸爸喜欢我说话短一点', at: Date.now() });
    const rows = await store.readFacts().catch(() => []);
    const notes = await store.promptSection('说话长度');
    assert.match(notes, /爸爸喜欢我说话短一点/);
    assert.ok(Array.isArray(rows));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
