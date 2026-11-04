import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  INVITE_MAX_PER_DAY,
  INVITE_MIN_GAP_MIN,
  INVITE_OPEN_TTL_MS,
  INVITE_PENDING_TTL_MS,
  answerInvite,
  createInvite,
  decideInvite,
  formatInviteSection,
  normalizeInvite,
  readInvite,
} from '../src/invite.js';

const at = (iso) => Date.parse(iso);
const HOUR = 3_600_000;
const quiet = { warn() {}, info() {}, debug() {}, error() {} };

test('约：凌晨不约，白天才约', () => {
  assert.equal(decideInvite({ now: new Date(2026, 10, 3, 3, 0).getTime() }).reason, 'asleep');
  assert.equal(decideInvite({ now: new Date(2026, 10, 3, 10, 0).getTime() }).go, true);
});

test('约：一天最多一次，两次至少隔 20 小时', () => {
  const now = at('2026-11-03T12:00:00Z');
  const day = '2026-11-03';
  assert.equal(INVITE_MAX_PER_DAY, 1);
  assert.equal(decideInvite({ state: { inviteDay: day, inviteCount: 1 }, now }).reason, 'daily');
  assert.equal(decideInvite({ state: { lastInviteAt: now - 19 * HOUR }, now }).reason, 'gap');
  assert.equal(decideInvite({ state: { lastInviteAt: now - 21 * HOUR }, now }).go, true);
  assert.equal(decideInvite({ state: { lastInviteAt: now - INVITE_MIN_GAP_MIN * 60_000 }, now }).go, true);
  // 跨天但间隔够久也能约
  assert.equal(decideInvite({ state: { inviteDay: '2026-11-02', inviteCount: 1, lastInviteAt: now - 21 * HOUR }, now }).go, true);
});

test('约：他没回 / 答应了没做，都先别约新的', () => {
  const now = at('2026-11-03T12:00:00Z');
  assert.equal(decideInvite({ now, invite: { status: 'pending' } }).reason, 'pending');
  assert.equal(decideInvite({ now, invite: { status: 'accepted' } }).reason, 'planned');
  assert.equal(decideInvite({ now, invite: { status: 'later' } }).go, true);
  assert.equal(decideInvite({ now, invite: { status: 'done' } }).go, true);
  assert.equal(decideInvite({ now, invite: { status: 'expired' } }).go, true);
});

test('约：过期折算——一天没应、三天没做', () => {
  const now = at('2026-11-03T12:00:00Z');
  const pending = normalizeInvite({ text: '一起看月亮', at: now - INVITE_PENDING_TTL_MS - 1 }, now);
  assert.equal(pending.status, 'expired');
  const fresh = normalizeInvite({ text: '一起看月亮', at: now - HOUR }, now);
  assert.equal(fresh.status, 'pending');
  const accepted = normalizeInvite({ text: '一起看月亮', at: now - 4 * 24 * HOUR, status: 'accepted', answeredAt: now - INVITE_OPEN_TTL_MS - 1 }, now);
  assert.equal(accepted.status, 'expired');
  const done = normalizeInvite({ text: '一起看月亮', at: now - 4 * 24 * HOUR, status: 'done', doneAt: now - 3 * 24 * HOUR }, now);
  assert.equal(done.status, 'done'); // 做过的约定不会过期
  assert.equal(normalizeInvite(null, now), null);
  assert.equal(normalizeInvite({ text: '' }, now), null);
  assert.equal(normalizeInvite({ text: 'x' }, now), null); // 没时间
});

test('约：写出去、读回来、清洗', async () => {
  const root = await mkdtemp(join(tmpdir(), 'invite-'));
  try {
    const now = at('2026-11-03T12:00:00Z');
    assert.equal(await createInvite({ root, text: '   ', now, log: quiet }), null);

    const created = await createInvite({ root, text: '  今晚 一起  看月亮  ', now, log: quiet });
    assert.equal(created.text, '今晚 一起 看月亮');
    assert.equal(created.status, 'pending');

    const read = await readInvite({ root, now });
    assert.equal(read.text, '今晚 一起 看月亮');
    assert.equal(read.status, 'pending');

    const lines = (await readFile(join(root, 'data/mind/invite.jsonl'), 'utf8')).trim().split('\n');
    assert.equal(lines.length, 1);
    assert.equal(JSON.parse(lines[0]).text, created.text);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('约：应下 → 做完（写成记忆）', async () => {
  const root = await mkdtemp(join(tmpdir(), 'invite-'));
  try {
    const now = at('2026-11-03T12:00:00Z');
    await createInvite({ root, text: '一起看月亮', now, log: quiet });

    const accepted = await answerInvite({ root, action: 'accept', now: now + 60_000, log: quiet });
    assert.equal(accepted.status, 'accepted');
    assert.equal(accepted.answeredAt, now + 60_000);

    const done = await answerInvite({ root, action: 'done', now: now + 2 * HOUR, log: quiet });
    assert.equal(done.status, 'done');
    assert.equal(done.doneAt, now + 2 * HOUR);

    const memory = JSON.parse((await readFile(join(root, 'data/mind/memory.jsonl'), 'utf8')).trim());
    assert.equal(memory.text, '跟爸爸一起做了件事：一起看月亮');
    assert.equal(memory.at, now + 2 * HOUR);

    // 已经做完，再点一次不重复写
    assert.equal(await answerInvite({ root, action: 'done', now: now + 3 * HOUR, log: quiet }), null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('约：改天；过期的约定不能再应', async () => {
  const root = await mkdtemp(join(tmpdir(), 'invite-'));
  try {
    const now = at('2026-11-03T12:00:00Z');
    await createInvite({ root, text: '一起打一局', now, log: quiet });
    const later = await answerInvite({ root, action: 'later', now: now + 60_000, log: quiet });
    assert.equal(later.status, 'later');

    // 再放一天多：pending 才会过期；later 不算 pending，这里手动换成一条两天前的 pending
    await writeFile(
      join(root, 'data/mind/invite.json'),
      `${JSON.stringify({ id: '1', text: '一起打一局', at: now - 2 * 24 * HOUR, status: 'pending', answeredAt: 0, doneAt: 0 })}\n`,
      'utf8',
    );
    const stale = await readInvite({ root });
    assert.equal(stale.status, 'expired');
    assert.equal(await answerInvite({ root, action: 'accept', now, log: quiet }), null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('约：坏文件不抛', async () => {
  const root = await mkdtemp(join(tmpdir(), 'invite-'));
  try {
    await mkdir(join(root, 'data/mind'), { recursive: true });
    await writeFile(join(root, 'data/mind/invite.json'), '{坏', 'utf8');
    assert.equal(await readInvite({ root }), null);
    assert.equal(await answerInvite({ root, action: 'accept', log: quiet }), null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('约：进 prompt 的每种状态', () => {
  const now = at('2026-11-03T12:00:00Z');
  const base = { at: now - 2 * HOUR, text: '一起看月亮' };

  assert.match(formatInviteSection({ ...base, status: 'pending' }, { now }), /他还没回/);
  assert.match(formatInviteSection({ ...base, status: 'accepted' }, { now }), /他答应了/);
  assert.match(formatInviteSection({ ...base, status: 'later' }, { now }), /改天/);
  assert.match(formatInviteSection({ ...base, status: 'done' }, { now }), /共同回忆/);
  assert.match(formatInviteSection({ ...base, status: 'expired' }, { now }), /没约成/);
  assert.equal(formatInviteSection(null, { now }), '');
  assert.equal(formatInviteSection({ ...base, status: 'whatever' }, { now }), '');
});
