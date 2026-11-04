import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAgenda } from '../src/agenda.js';

const quiet = { info() {}, warn() {}, debug() {}, error() {} };
const now = new Date(2026, 10, 4, 23, 0).getTime();

test('待办：记下来、列出来、同一句不重复加', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agenda-'));
  try {
    const agenda = createAgenda({ root, now: () => now, log: quiet });
    await agenda.add({ text: '把视频重剪一版' });
    await agenda.add({ text: '把视频重剪一版' }); // 重复
    await agenda.add({ text: '屋顶还差三块' });
    const open = await agenda.listOpen();
    assert.equal(open.length, 2);
    assert.equal(open.at(-1).text, '屋顶还差三块');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('待办：做完能划掉，模糊里也行', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agenda-'));
  try {
    const agenda = createAgenda({ root, now: () => now, log: quiet });
    await agenda.add({ text: '把视频重剪一版' });
    await agenda.add({ text: '屋顶还差三块' });
    const closed = await agenda.closeByText('视频重剪');
    assert.ok(closed);
    const open = await agenda.listOpen();
    assert.equal(open.length, 1);
    assert.equal(open[0].text, '屋顶还差三块');
    // 划不存在的返回 null
    assert.equal(await agenda.closeByText('不存在的事'), null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('待办进 prompt：只有没做完的、带时间，空的时候不出现', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agenda-'));
  try {
    const agenda = createAgenda({ root, now: () => now, log: quiet });
    assert.equal(await agenda.promptSection(), '');
    await agenda.add({ text: '把视频重剪一版' });
    const section = await agenda.promptSection();
    assert.match(section, /你手上还欠着的事/);
    assert.match(section, /把视频重剪一版/);
    await agenda.closeByText('把视频重剪一版');
    assert.equal(await agenda.promptSection(), '');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
