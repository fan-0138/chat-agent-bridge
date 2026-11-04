import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { CHANGES_FILE, EPISODES_FILE, FACTS_FILE, createMemoryStore } from '../src/memory-store.js';

const quiet = { debug() {}, info() {}, warn() {}, error() {} };
const NOW = new Date(2026, 10, 4, 12, 0, 0).getTime();
const DAY = 86_400_000;

async function tempRoot(t) {
  const root = await mkdtemp(join(tmpdir(), 'memory-forget-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

const storeOf = (root) => createMemoryStore({ root, now: () => NOW, log: quiet });

async function put(root, rel, content) {
  const file = join(root, rel);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, content, 'utf8');
}

/** 读原始文本；文件不存在返回 null。 */
async function rawOf(root, rel) {
  try {
    return await readFile(join(root, rel), 'utf8');
  } catch {
    return null;
  }
}

/** 一行一个 JSON 的行文件读回来（跳过空行）。 */
async function jsonRows(root, rel) {
  const raw = await rawOf(root, rel);
  if (!raw) return [];
  return raw
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

const fact = (over = {}) => ({
  subject: '爸爸',
  key: '爱吃的',
  value: '西瓜',
  text: '爸爸爱吃的 是西瓜',
  at: NOW - DAY,
  updatedAt: NOW - DAY,
  source: 'digest',
  ...over,
});

const episode = (over = {}) => ({
  at: NOW - DAY,
  day: '2026-11-03',
  kind: 'event',
  title: '一起看了月亮',
  text: '一起看了月亮：窗外月亮很圆',
  detail: '窗外月亮很圆',
  people: ['爸爸'],
  salience: 3,
  source: 'digest',
  ...over,
});

/* ── 删事实 ── */

test('removeFact：按 subject + key 删中一行，其他事实不动', async (t) => {
  const root = await tempRoot(t);
  const store = storeOf(root);
  await store.upsertFact({ at: NOW - DAY, subject: '爸爸', key: '爱吃的', value: '西瓜' });
  await store.upsertFact({ at: NOW - DAY, subject: '爸爸', key: '怕的', value: '打雷' });
  await store.upsertFact({ at: NOW - DAY, subject: '小鲸', key: '爱吃的', value: '面条' });

  assert.equal(await store.removeFact({ subject: '爸爸', key: '爱吃的' }), true);

  const facts = await store.readFacts();
  assert.equal(facts.length, 2);
  assert.ok(!facts.some((row) => row.subject === '爸爸' && row.key === '爱吃的'), '删的那条没了');
  assert.ok(facts.some((row) => row.subject === '小鲸' && row.key === '爱吃的'), '同 key 的别人不动');
  assert.ok(facts.some((row) => row.subject === '爸爸' && row.key === '怕的'));

  // 再删一次已经没了 → false
  assert.equal(await store.removeFact({ subject: '爸爸', key: '爱吃的' }), false);
});

test('removeFact：subject/key 归一化后仍能命中（空格、超长 key）', async (t) => {
  const root = await tempRoot(t);
  const store = storeOf(root);
  await put(root, FACTS_FILE, `${JSON.stringify(fact({ key: ' 爱吃的 ' }))}\n`);

  assert.equal(await store.removeFact({ subject: ' 爸爸 ', key: '爱吃的' }), true);
  assert.equal(await rawOf(root, FACTS_FILE), '', '唯一的行删掉后文件留空');

  // 超长 key 和写入时一样截到 12 字，能对上
  await put(root, FACTS_FILE, `${JSON.stringify(fact({ key: '一二三四五六七八九十十一十二十三' }))}\n`);
  assert.equal(await store.removeFact({ subject: '爸爸', key: '一二三四五六七八九十十一十二十三' }), true);
});

test('removeFact：不命中 / 缺参数 → false，盘上文件不动', async (t) => {
  const root = await tempRoot(t);
  const store = storeOf(root);

  // 文件都没有
  assert.equal(await store.removeFact({ subject: '爸爸', key: '爱吃的' }), false);
  assert.equal(await rawOf(root, CHANGES_FILE), null, '没删中就不写审计');

  await store.upsertFact({ at: NOW - DAY, subject: '爸爸', key: '爱吃的', value: '西瓜' });
  const before = await rawOf(root, FACTS_FILE);
  assert.equal(await store.removeFact({ subject: '爸爸', key: '没有这个' }), false);
  assert.equal(await store.removeFact({ subject: '爸爸' }), false);
  assert.equal(await store.removeFact({}), false);
  assert.equal(await store.removeFact(), false);
  assert.equal(await rawOf(root, FACTS_FILE), before);
});

/* ── 删情景 ── */

test('removeEpisode：按 at 精确匹配删中一行，其他情景保留', async (t) => {
  const root = await tempRoot(t);
  const store = storeOf(root);
  await store.addEpisode({ at: NOW - DAY, title: '一起看了月亮', detail: '月亮很圆' });
  await store.addEpisode({ at: NOW - 3 * DAY, title: '一起背了蒹葭', detail: '卡在第三章' });

  assert.equal(await store.removeEpisode({ at: NOW - DAY }), true);
  const rows = await store.readEpisodes();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].title, '一起背了蒹葭');

  assert.equal(await store.removeEpisode({ at: NOW - DAY }), false, '删过就没了');
  assert.equal(await store.removeEpisode({ at: 0 }), false, '没时间不认领');
  assert.equal(await store.removeEpisode({}), false);
});

test('removeEpisode：传 title 时校验标题前 12 字，不匹配不删', async (t) => {
  const root = await tempRoot(t);
  const store = storeOf(root);
  const at = NOW - DAY;
  const title = '一起背了蒹葭第三章的故事';
  await store.addEpisode({ at, title, detail: '其实只背到第一章' });
  const before = await rawOf(root, EPISODES_FILE);

  assert.equal(await store.removeEpisode({ at, title: '完全不相干的标题' }), false);
  assert.equal(await rawOf(root, EPISODES_FILE), before, '没删中不改盘');

  // 前 12 字一样就算同一条（后面多几个字不影响）
  assert.equal(await store.removeEpisode({ at, title: `${title}第二段` }), true);
  assert.deepEqual(await store.readEpisodes(), []);
});

/* ── 审计 ── */

test('审计：删掉的行写进 changes.jsonl（at/action/row）', async (t) => {
  const root = await tempRoot(t);
  const store = storeOf(root);
  await store.upsertFact({ at: NOW - DAY, subject: '爸爸', key: '爱吃的', value: '西瓜' });
  await store.addEpisode({ at: NOW - DAY, title: '一起看了月亮', detail: '月亮很圆', people: ['爸爸'], salience: 3 });

  const factRow = (await jsonRows(root, FACTS_FILE))[0];
  const episodeRow = (await jsonRows(root, EPISODES_FILE))[0];
  assert.equal(await store.removeFact({ subject: '爸爸', key: '爱吃的' }), true);
  assert.equal(await store.removeEpisode({ at: NOW - DAY }), true);

  const changes = await jsonRows(root, CHANGES_FILE);
  assert.equal(changes.length, 2);
  const factChange = changes.find((row) => row.action === 'forget-fact');
  const episodeChange = changes.find((row) => row.action === 'forget-episode');
  assert.ok(factChange && episodeChange, '两种动作都记了');
  assert.equal(factChange.at, NOW);
  assert.equal(episodeChange.at, NOW);
  assert.deepEqual(factChange.row, factRow, '审计里留着被删的原样一行');
  assert.deepEqual(episodeChange.row, episodeRow);
});

/* ── 坏文件 ── */

test('坏文件：坏行原样保留，只删命中的那行，不抛', async (t) => {
  const root = await tempRoot(t);
  const store = storeOf(root);
  const goodFact = fact();
  await put(root, FACTS_FILE, `这不是 JSON\n[1,2]\n${JSON.stringify(goodFact)}\n{"at":\n`);
  assert.equal(await store.removeFact({ subject: '爸爸', key: '爱吃的' }), true);
  assert.equal(
    await rawOf(root, FACTS_FILE),
    '这不是 JSON\n[1,2]\n{"at":\n',
    '解析不了的行原样写回',
  );

  const goodEpisode = episode();
  await put(root, EPISODES_FILE, `{坏\n${JSON.stringify(goodEpisode)}\n`);
  assert.equal(await store.removeEpisode({ at: goodEpisode.at, title: goodEpisode.title }), true);
  assert.equal(await rawOf(root, EPISODES_FILE), '{坏\n');
});

test('坏文件：文件/目录不存在、整文件坏 JSON 都返回 false，不抛', async (t) => {
  const root = await tempRoot(t);
  const store = storeOf(root);

  assert.equal(await store.removeFact({ subject: '爸爸', key: '爱吃的' }), false);
  assert.equal(await store.removeEpisode({ at: NOW }), false);

  await put(root, FACTS_FILE, '{{{ 全是坏的\n');
  await put(root, EPISODES_FILE, '也不是 JSON\n');
  assert.equal(await store.removeFact({ subject: '爸爸', key: '爱吃的' }), false);
  assert.equal(await store.removeEpisode({ at: NOW }), false);
  assert.equal(await rawOf(root, FACTS_FILE), '{{{ 全是坏的\n');
  assert.equal(await rawOf(root, EPISODES_FILE), '也不是 JSON\n');
  assert.equal(await rawOf(root, CHANGES_FILE), null);
});

/* ── 删完真的想不起来 ── */

test('删完 recall 不再召回，promptSection 也空了', async (t) => {
  const root = await tempRoot(t);
  const store = storeOf(root);
  await store.addEpisode({ at: NOW - DAY, title: '一起看了月亮', detail: '窗外月亮很圆', people: ['爸爸'], salience: 3 });
  await store.upsertFact({ at: NOW - DAY, subject: '爸爸', key: '爱吃的', value: '西瓜' });

  const query = '一起看月亮，还有爸爸爱吃的西瓜';
  assert.ok((await store.recall(query)).length >= 1, '删之前捞得到');

  assert.equal(await store.removeEpisode({ at: NOW - DAY }), true);
  assert.equal(await store.removeFact({ subject: '爸爸', key: '爱吃的' }), true);

  assert.deepEqual(await store.recall(query), [], '删完就不再 recalled');
  assert.equal(await store.promptSection(query), '');
});