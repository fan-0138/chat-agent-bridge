import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { formatPeopleSection, loadPeopleBook, visitCandidates } from '../src/people.js';

const DAY = 24 * 3_600_000;
const at = (iso) => Date.parse(iso);

async function makeRoot({ inbox = [], replied = [] } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'people-'));
  await mkdir(join(dir, 'data/douyin'), { recursive: true });
  await writeFile(
    join(dir, 'data/douyin/at-inbox.jsonl'),
    inbox.map((row) => JSON.stringify(row)).join('\n') + (inbox.length ? '\n' : ''),
    'utf8',
  );
  await writeFile(
    join(dir, 'data/douyin/replied.jsonl'),
    replied.map((row) => JSON.stringify(row)).join('\n') + (replied.length ? '\n' : ''),
    'utf8',
  );
  return dir;
}

/** 一条通知。createTime 是秒。daysAgo 按「几天前」算。 */
function notice({ nickname, uid = '', text = '', daysAgo = 0, nid = '', videoUrl = 'https://www.douyin.com/video/1', commentId = 'c1' }) {
  const nowSec = Math.floor(Date.now() / 1000);
  return {
    nickname,
    uid,
    content: text,
    nid,
    createTime: String(nowSec - Math.round(daysAgo * 86400)),
    videoUrl,
    commentId,
    rootCommentId: commentId,
    replyable: 'True',
  };
}

test('网友簿：同一个人多次说话会合并，取最后一次的内容', async () => {
  const now = at('2026-11-03T12:00:00Z');
  const dir = await makeRoot({
    inbox: [
      notice({ nickname: '大笨钟.', uid: 'u1', text: '第一次', daysAgo: 6, nid: 'n1' }),
      notice({ nickname: '大笨钟.', uid: 'u1', text: '都辉腾了 还不舍得用', daysAgo: 4, nid: 'n2' }),
      notice({ nickname: '汤元', uid: 'u2', text: '～', daysAgo: 5, nid: 'n3' }),
    ],
  });
  try {
    const book = await loadPeopleBook({ root: dir, now });
    assert.equal(book.length, 2);
    assert.equal(book[0].name, '大笨钟.');
    assert.equal(book[0].count, 2);
    assert.equal(book[0].lastText, '都辉腾了 还不舍得用');
    assert.equal(book[1].name, '汤元');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('网友簿：回过的那条会标 replied，三天内的标 fresh', async () => {
  const now = at('2026-11-03T12:00:00Z');
  const dir = await makeRoot({
    inbox: [
      notice({ nickname: '甲', uid: 'a', text: '说过', daysAgo: 1, nid: 'n10' }),
      notice({ nickname: '乙', uid: 'b', text: '没回', daysAgo: 10, nid: 'n11' }),
    ],
    replied: [{ nid: 'n10', at: now - 3_600_000 }],
  });
  try {
    const book = await loadPeopleBook({ root: dir, now });
    const byName = Object.fromEntries(book.map((row) => [row.name, row]));
    assert.equal(byName['甲'].replied, true);
    assert.equal(byName['甲'].fresh, true);
    assert.equal(byName['乙'].replied, false);
    assert.equal(byName['乙'].fresh, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('网友簿：没 uid 的名字相同也算一个人', async () => {
  const now = at('2026-11-03T12:00:00Z');
  const dir = await makeRoot({
    inbox: [
      notice({ nickname: '路人', uid: '', text: '一', daysAgo: 2, nid: 'x1' }),
      notice({ nickname: '路人', uid: '', text: '二', daysAgo: 1, nid: 'x2' }),
    ],
  });
  try {
    const book = await loadPeopleBook({ root: dir, now });
    assert.equal(book.length, 1);
    assert.equal(book[0].count, 2);
    assert.equal(book[0].lastText, '二');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('回访候选：只挑没回过、有视频和评论 id、14 天内的', async () => {
  const now = at('2026-11-03T12:00:00Z');
  const dir = await makeRoot({
    inbox: [
      notice({ nickname: '该回', uid: 'a', text: '四天前的', daysAgo: 4, nid: 'v1', commentId: 'c9' }),
      notice({ nickname: '回过了', uid: 'b', text: '两天的', daysAgo: 2, nid: 'v2' }),
      notice({ nickname: '太旧了', uid: 'c', text: '二十天前', daysAgo: 20, nid: 'v3' }),
    ],
    replied: [{ nid: 'v2' }],
  });
  try {
    const rows = await visitCandidates({ root: dir, now });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].name, '该回');
    assert.equal(rows[0].index, 1);
    assert.equal(rows[0].lastCommentId, 'c9');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('空文件/缺文件：返回空数组不抛错', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'people-empty-'));
  try {
    assert.deepEqual(await loadPeopleBook({ root: dir }), []);
    assert.deepEqual(await visitCandidates({ root: dir }), []);
    assert.equal(await formatPeopleSection([], Date.now()), '');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('prompt 里那一小段：带上谁、多久前、说没说过', async () => {
  const now = at('2026-11-03T12:00:00Z');
  const text = await formatPeopleSection(
    [
      { name: '大笨钟.', lastAt: now - 4 * DAY, lastText: '都辉腾了 还不舍得用', replied: false, count: 1 },
      { name: '汤元', lastAt: now - 1 * DAY, lastText: '～', replied: true, count: 2 },
    ],
    now,
  );
  assert.match(text, /大笨钟\./);
  assert.match(text, /4 天前/);
  assert.match(text, /你还没接/);
  assert.match(text, /汤元/);
  assert.match(text, /你已经接过话/);
});