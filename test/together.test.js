import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  daysTogether,
  firstChatAt,
  milestoneOf,
  togetherInfo,
  togetherLine,
} from '../src/together.js';

const at = (iso) => Date.parse(iso);
const DAY = 24 * 3_600_000;

test('第几天：第一次消息当天算第 1 天', () => {
  const first = at('2026-10-24T12:27:52Z');
  assert.equal(daysTogether(first, first), 1);
  assert.equal(daysTogether(first, first + 9 * DAY), 10);
  // 跨月也不用手动算
  assert.equal(daysTogether(first, at('2026-11-03T12:27:52Z')), 11);
});

test('第几天：没有第一条消息就返回 0', () => {
  assert.equal(daysTogether(0), 0);
  assert.equal(daysTogether(null), 0);
  assert.equal(daysTogether('x'), 0);
});

test('纪念日：整十/整百/一年', () => {
  assert.equal(milestoneOf(1), '第一天');
  assert.equal(milestoneOf(10), '第 10 天');
  assert.equal(milestoneOf(30), '第 30 天');
  assert.equal(milestoneOf(100), '第 100 天');
  assert.equal(milestoneOf(365), '一年');
  assert.equal(milestoneOf(730), '两年');
  assert.equal(milestoneOf(11), '');
  assert.equal(milestoneOf(0), '');
});

test('一句话：普通日子和纪念日说法不一样', () => {
  const first = at('2026-10-24T12:27:52Z');
  const normal = togetherLine({ firstAt: first, days: 11, now: at('2026-11-03T12:00:00Z') });
  assert.match(normal, /第 11 天/);
  assert.match(normal, /10\/24 20:27/);
  assert.doesNotMatch(normal, /——/);
  const milestone = togetherLine({ firstAt: first, days: 365, now: at('2027-10-24T12:00:00Z') });
  assert.match(milestone, /第 365 天/);
  assert.match(milestone, /一年/);
  assert.equal(togetherLine({ days: 0 }), '');
});

test('firstChatAt：从 audit 第一行取时间；坏了换下一个文件', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'together-'));
  try {
    await mkdir(join(dir, 'data/qq'), { recursive: true });
    await writeFile(
      join(dir, 'data/qq/audit.jsonl'),
      `${JSON.stringify({ at: '2026-10-24T12:27:52.987Z', dir: 'in' })}\n${JSON.stringify({ at: '2026-10-25T00:00:00Z' })}\n`,
      'utf8',
    );
    const first = await firstChatAt(dir);
    assert.equal(first, at('2026-10-24T12:27:52.987Z'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('firstChatAt：文件都没有就返回 0', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'together-empty-'));
  try {
    assert.equal(await firstChatAt(dir), 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('togetherInfo：读真实结构、缓存第一条消息时间、没有文件不抛错', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'together-info-'));
  const empty = await mkdtemp(join(tmpdir(), 'together-none-'));
  try {
    await mkdir(join(dir, 'data/qq'), { recursive: true });
    await writeFile(join(dir, 'data/qq/audit.jsonl'), `${JSON.stringify({ at: '2026-10-24T12:27:52Z' })}\n`, 'utf8');
    const info = await togetherInfo({ root: dir, now: at('2026-11-03T12:00:00Z') });
    assert.equal(info.firstAt, at('2026-10-24T12:27:52Z'));
    assert.equal(info.days, 11);
    assert.match(info.line, /第 11 天/);

    const none = await togetherInfo({ root: empty, now: at('2026-11-03T12:00:00Z') });
    assert.equal(none.days, 0);
    assert.equal(none.line, '');
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(empty, { recursive: true, force: true });
  }
});