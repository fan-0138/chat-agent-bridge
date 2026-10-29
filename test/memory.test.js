import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMemory } from '../src/memory.js';

const log = { warn() {}, info() {}, debug() {} };
const make = (dir) => createMemory({ dir, maxTurns: 8, maxChars: 6000, log });

test('记忆：append 之后能拿到时间戳（主动消息靠它判断刚聊过没）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-mem-'));
  try {
    const memory = make(dir);
    await memory.append('user_a', 'user', '在吗');
    const entries = await memory.load('user_a');
    assert.equal(entries.length, 1);
    assert.ok(entries[0].at > 1_600_000_000_000, 'at 应该是毫秒时间戳');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('记忆：重启后从文件读回，时间戳还在', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-mem-'));
  try {
    const before = Date.now();
    await make(dir).append('user_a', 'user', '在吗');
    const entries = await make(dir).load('user_a'); // 新实例 = 重启
    assert.equal(entries.length, 1);
    assert.ok(entries[0].at >= before - 1000);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('记忆：主动消息的 kind 标记能存下来读回来', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-mem-'));
  try {
    const memory = make(dir);
    await memory.append('user_a', 'assistant', '刚刷到个视频', { kind: 'proactive' });
    await memory.append('user_a', 'user', '这个是旧的');
    const entries = await memory.load('user_a');
    assert.equal(entries[0].kind, 'proactive');
    assert.equal(entries[1].kind, undefined);
    // 重启后还在
    const again = await make(dir).load('user_a');
    assert.equal(again[0].kind, 'proactive');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
