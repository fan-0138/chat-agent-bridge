import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { USAGE_FILE, createUsage, summarizeUsage } from '../src/usage.js';
import { localDay } from '../src/life.js';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOW = new Date(2026, 10, 4, 9, 0, 0).getTime(); // 固定时间，跑多久都稳

async function tempRoot(t) {
  const root = await mkdtemp(join(tmpdir(), 'usage-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function put(root, rel, content) {
  const file = join(root, rel);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, content);
  return file;
}

/** 直接造一份 jsonl：字符串原样写入，对象转 JSON。 */
async function putRows(root, rows) {
  const text = `${rows.map((row) => (typeof row === 'string' ? row : JSON.stringify(row))).join('\n')}\n`;
  await put(root, USAGE_FILE, text);
}

const readRows = async (root) => {
  const raw = (await readFile(join(root, USAGE_FILE), 'utf8')).trim();
  return raw ? raw.split('\n').map((line) => JSON.parse(line)) : [];
};

/* ── 记录 ── */

test('createUsage：record 落盘到 data/usage/usage.jsonl，字段齐全', async (t) => {
  const root = await tempRoot(t);
  assert.equal(USAGE_FILE, 'data/usage/usage.jsonl');

  const usage = createUsage({ root, kind: 'chat', now: () => NOW });
  const first = await usage.record({ ms: 1234, inChars: 300, outChars: 50, ok: true });
  const expected = {
    at: NOW,
    day: localDay(NOW),
    kind: 'chat',
    ms: 1234,
    inChars: 300,
    outChars: 50,
    ok: true,
  };
  assert.deepEqual(first, expected);

  // 目录本来不存在，record 里 mkdir -p 建出来
  const rows = await readRows(root);
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0], expected);

  await usage.record({ ms: 10, inChars: 1, outChars: 2, ok: false });
  const rows2 = await readRows(root);
  assert.equal(rows2.length, 2, '一次调用追加一行');
  assert.equal(rows2[1].ok, false);
});

test('createUsage：默认值与脏输入兜底，kind 去空格、空 kind 记 unknown', async (t) => {
  const root = await tempRoot(t);
  const usage = createUsage({ root, kind: '  ', now: () => NOW });
  const row = await usage.record({ ms: -100, inChars: 'x', outChars: null, ok: undefined });

  assert.equal(row.kind, 'unknown');
  assert.equal(row.ms, 0, '负数归零');
  assert.equal(row.inChars, 0, '非数字归零');
  assert.equal(row.outChars, 0);
  assert.equal(row.ok, true, '没写 ok 就当成功');

  const trimmed = createUsage({ root, kind: ' mind ', now: () => NOW });
  assert.equal((await trimmed.record()).kind, 'mind');
  assert.equal((await trimmed.record()).ms, 0);
});

test('createUsage：now 每次现取，跨天 day 跟着变', async (t) => {
  const root = await tempRoot(t);
  let clock = new Date(2026, 10, 4, 23, 50, 0).getTime();
  const usage = createUsage({ root, kind: 'mind', now: () => clock });

  const late = await usage.record({ ms: 5 });
  clock = new Date(2026, 10, 5, 0, 10, 0).getTime();
  const early = await usage.record({ ms: 6 });

  assert.equal(late.day, '2026-11-04');
  assert.equal(early.day, '2026-11-05');
  assert.equal(late.at, new Date(2026, 10, 4, 23, 50, 0).getTime());
  assert.equal(early.at, clock);
});

test('createUsage：写失败不抛（路径被占成文件）', async (t) => {
  const root = await tempRoot(t);
  await writeFile(join(root, 'data'), '不是目录', 'utf8');

  const usage = createUsage({ root, kind: 'chat', now: () => NOW });
  const row = await usage.record({ ms: 1 });
  assert.equal(row, null, '写不进去就当没记，不抛错');
});

/* ── 汇总 ── */

test('summarizeUsage：按 kind 汇总今天，坏行和坏记录跳过', async (t) => {
  const root = await tempRoot(t);
  await putRows(root, [
    { at: NOW, day: localDay(NOW), kind: 'chat', ms: 1000, inChars: 100, outChars: 20, ok: true },
    { at: NOW - 1 * HOUR, day: localDay(NOW), kind: 'chat', ms: 2000, inChars: 200, outChars: 30, ok: false },
    { at: NOW - 2 * HOUR, kind: 'mind', ms: 500, inChars: 50, outChars: 10, ok: true }, // day 缺省由 at 推
    { at: NOW - 26 * HOUR, kind: 'chat', ms: 9999, inChars: 999, outChars: 999, ok: true }, // 昨天，不算
    { at: NOW + 1 * DAY, kind: 'chat', ms: 9999, inChars: 999, outChars: 999, ok: true }, // 未来时间，不算
    '这不是 JSON',
    '{"at":',
    { at: '坏时间', kind: 'chat', ms: 1 },
    { at: NOW, ms: 1 }, // 缺 kind
    'null',
  ]);

  const summary = await summarizeUsage({ root, now: () => NOW });
  assert.deepEqual(summary, {
    day: localDay(NOW),
    byKind: {
      chat: { calls: 2, ms: 3000, chars: 350, failed: 1 },
      mind: { calls: 1, ms: 500, chars: 60, failed: 0 },
    },
    total: { calls: 3, ms: 3500, chars: 410, failed: 1 },
    estTokens: 256, // round(410 / 1.6)
  });
});

test('summarizeUsage：days 窗口（今天 / 最近 7 天 / 非法值按 1 天）', async (t) => {
  const root = await tempRoot(t);
  await putRows(root, [
    { at: NOW, kind: 'chat', ms: 100, inChars: 10, outChars: 5, ok: true },
    { at: NOW - 3 * DAY, kind: 'chat', ms: 100, inChars: 10, outChars: 5, ok: true },
    { at: NOW - 10 * DAY, kind: 'chat', ms: 100, inChars: 10, outChars: 5, ok: true },
  ]);

  assert.equal((await summarizeUsage({ root, now: () => NOW })).total.calls, 1, '默认只看今天');
  assert.equal((await summarizeUsage({ root, now: () => NOW, days: 7 })).total.calls, 2, '7 天含 3 天前，不含 10 天前');
  assert.equal((await summarizeUsage({ root, now: () => NOW, days: 0 })).total.calls, 1, '非法天数回落到 1 天');
  assert.equal((await summarizeUsage({ root, now: () => NOW, days: '坏' })).total.calls, 1);
});

test('summarizeUsage：文件不存在 / 全是坏行 → 空统计，不抛', async (t) => {
  const root = await tempRoot(t);
  const empty = {
    day: localDay(NOW),
    byKind: {},
    total: { calls: 0, ms: 0, chars: 0, failed: 0 },
    estTokens: 0,
  };
  assert.deepEqual(await summarizeUsage({ root, now: () => NOW }), empty);

  await put(root, USAGE_FILE, '全是坏行\n{"at":');
  assert.deepEqual(await summarizeUsage({ root, now: () => NOW }), empty);
});

test('summarizeUsage：estTokens = round(chars / 1.6)', async (t) => {
  const root = await tempRoot(t);
  await putRows(root, [
    { at: NOW, kind: 'chat', ms: 1, inChars: 100, outChars: 60, ok: true }, // 160 字
  ]);
  const summary = await summarizeUsage({ root, now: () => NOW });
  assert.equal(summary.total.chars, 160);
  assert.equal(summary.estTokens, 100);
});