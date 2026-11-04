import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { digestBacklogDue } from '../scripts/mind-run.mjs';

const quiet = { debug() {}, info() {}, warn() {}, error() {} };

async function makeRoot(meta) {
  const root = await mkdtemp(join(tmpdir(), 'digest-backlog-'));
  await mkdir(join(root, 'data/memory'), { recursive: true });
  await writeFile(join(root, 'data/memory/state.json'), JSON.stringify(meta), 'utf8');
  return root;
}

test('白天积压：超过 4 小时才补，夜里交给睡前整理', async () => {
  const now = new Date(2026, 10, 4, 14, 0).getTime();
  const root = await makeRoot({ lastDigestDay: '2026-11-04', lastDigestAt: now - 5 * 3_600_000 });
  try {
    assert.equal(await digestBacklogDue({ root, now }), true);
    await writeFile(join(root, 'data/memory/state.json'), JSON.stringify({ lastDigestDay: '2026-11-04', lastDigestAt: now - 2 * 3_600_000 }), 'utf8');
    assert.equal(await digestBacklogDue({ root, now }), false);
    // 22 点之后不抢睡前那次
    assert.equal(await digestBacklogDue({ root, now: new Date(2026, 10, 4, 22, 30).getTime() }), false);
    // 早上 8 点前也不跑
    assert.equal(await digestBacklogDue({ root, now: new Date(2026, 10, 4, 7, 30).getTime() }), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('从没整理过：白天第一次就该跑', async () => {
  const root = await makeRoot({});
  try {
    assert.equal(await digestBacklogDue({ root, now: new Date(2026, 10, 4, 10, 0).getTime() }), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
