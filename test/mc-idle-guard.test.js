import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { maybeSleepMc, readActivity, shouldSleep, touchActivity, wakeMc } from '../tools/mc/idle-guard.mjs';

const quiet = { debug() {}, info() {}, warn() {}, error() {} };
const now = new Date(2026, 10, 4, 12, 0).getTime();

test('该不该睡：离线/在玩/刚用过都不睡，久没人用才睡', () => {
  assert.equal(shouldSleep({ online: false, now }).reason, 'offline');
  assert.equal(shouldSleep({ online: true, playing: true, lastTouchAt: now - 3_600_000, now }).reason, 'playing');
  assert.equal(shouldSleep({ online: true, lastTouchAt: now - 5 * 60_000, now }).reason, 'recent');
  assert.equal(shouldSleep({ online: true, lastTouchAt: 0, now }).reason, 'never-touched');
  const verdict = shouldSleep({ online: true, lastTouchAt: now - 25 * 60_000, now, idleMin: 20 });
  assert.equal(verdict.sleep, true);
  assert.equal(verdict.idleMin, 25);
});

test('活动记录：写一次读回来，坏文件当没有', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mc-idle-'));
  try {
    assert.equal((await readActivity(root)).lastAt, 0);
    await touchActivity(root, 'view', now);
    const row = await readActivity(root);
    assert.equal(row.lastAt, now);
    assert.equal(row.lastKind, 'view');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('停服：没人用就调 stop，在玩/刚用过不碰', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mc-idle-'));
  try {
    let stops = 0;
    const stop = async () => { stops += 1; return { ok: true }; };

    const playing = await maybeSleepMc({ root, now, online: true, playing: true, stop, log: quiet });
    assert.equal(playing.slept, false);
    assert.equal(stops, 0);

    await touchActivity(root, 'view', now - 60_000);
    const recent = await maybeSleepMc({ root, now, online: true, playing: false, stop, log: quiet });
    assert.equal(recent.slept, false);
    assert.equal(stops, 0);

    await touchActivity(root, 'view', now - 25 * 60_000);
    const slept = await maybeSleepMc({ root, now, online: true, playing: false, stop, log: quiet });
    assert.equal(slept.slept, true);
    assert.equal(stops, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('停服失败不记成睡了', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mc-idle-'));
  try {
    await touchActivity(root, 'view', now - 30 * 60_000);
    const result = await maybeSleepMc({ root, now, online: true, playing: false, stop: async () => ({ ok: false, error: 'x' }), log: quiet });
    assert.equal(result.slept, false);
    assert.equal(result.reason, 'stop-failed');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('叫醒：已经在线直接成功；不在线就 start 再等 online', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mc-idle-'));
  try {
    let checks = 0;
    let started = 0;
    const online = await wakeMc({
      root,
      log: quiet,
      check: async () => { checks += 1; return true; },
      start: async () => { started += 1; return { ok: true }; },
    });
    assert.equal(online, true);
    assert.equal(started, 0);

    checks = 0;
    const woken = await wakeMc({
      root,
      log: quiet,
      timeoutMs: 5_000,
      start: async () => { started += 1; return { ok: true }; },
      check: async () => {
        checks += 1;
        return checks >= 2; // 第一次不在线，等一轮后才上线
      },
    });
    assert.equal(woken, true);
    assert.equal(started, 1);
    assert.equal((await readActivity(root)).lastKind, 'wake');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
