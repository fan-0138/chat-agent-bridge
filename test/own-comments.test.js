import { test } from 'node:test';
import assert from 'node:assert/strict';
import { commentToRow, mergeSeen, pickNewComments } from '../src/own-comments.js';

const NOW = 1_793_900_000_000; // 固定时间，别用真实时钟
const SELF = '1000000000000000';

const comment = (over = {}) => ({
  cid: '7704686406501303075',
  text: '豆包ai生成嘛？有点意思',
  create_time: Math.floor(NOW / 1000) - 600,
  user: { uid: '2162074014987612', nickname: '常青清' },
  ...over,
});

const work = (over = {}) => ({
  awemeId: '7704630643740724499',
  desc: '豆包姐姐捏的，哭完了还得蹭一下手才算完事',
  comments: [comment()],
  ...over,
});

test('commentToRow：一条评论变成收件箱一行', () => {
  const row = commentToRow({ comment: comment(), awemeId: '7704630643740724499', nowMs: NOW });
  assert.equal(row.nid, 'own-7704630643740724499-7704686406501303075');
  assert.equal(row.content, '豆包ai生成嘛？有点意思');
  assert.equal(row.nickname, '常青清');
  assert.equal(row.commentId, '7704686406501303075');
  assert.equal(row.videoUrl, 'https://www.douyin.com/video/7704630643740724499');
  assert.equal(row.typeName, '评论了你的作品');
  assert.equal(row.type, 35);
});

test('commentToRow：自己的评论、空评论、老评论都丢掉', () => {
  const base = { awemeId: '7704630643740724499', nowMs: NOW };
  assert.equal(commentToRow({ ...base, comment: comment({ user: { uid: SELF, nickname: '自己' } }), selfUid: SELF }), null);
  assert.equal(commentToRow({ ...base, comment: comment({ text: '   ' }) }), null);
  const old = Math.floor(NOW / 1000) - 5 * 86_400;
  assert.equal(commentToRow({ ...base, comment: comment({ create_time: old }) }), null);
});

test('pickNewComments：只挑没见过的，同一条不重复', () => {
  const seen = ['own-7704630643740724499-7704686406501303075'];
  const works = [work()];
  const { rows } = pickNewComments({ works, seen, nowMs: NOW });
  assert.equal(rows.length, 0);

  const second = comment({ cid: '7704660976910041865', text: '好可爱', user: { uid: '334701064628749', nickname: '池鱼不吃鱼' } });
  const { rows: rows2 } = pickNewComments({ works: [work({ comments: [comment(), second] })], seen, nowMs: NOW });
  assert.equal(rows2.length, 1);
  assert.equal(rows2[0].nickname, '池鱼不吃鱼');
});

test('pickNewComments：limit 生效，最多给几条', () => {
  const comments = [1, 2, 3, 4].map((i) => comment({ cid: `c${i}`, text: `第${i}条`, user: { uid: `u${i}`, nickname: `路人${i}` } }));
  const { rows } = pickNewComments({ works: [work({ comments })], nowMs: NOW, limit: 2 });
  assert.equal(rows.length, 2);
  assert.equal(mergeSeen([], rows).length, 2);
});

test('pickNewComments：多个作品一起扫，跨作品去重', () => {
  const w1 = work({ awemeId: '111', comments: [comment({ cid: 'a1', text: '一' })] });
  const w2 = work({ awemeId: '222', comments: [comment({ cid: 'a1', text: '一' })] });
  const { rows } = pickNewComments({ works: [w1, w2], seen: [], nowMs: NOW });
  assert.equal(rows.length, 2);
  assert.notEqual(rows[0].nid, rows[1].nid);
});

test('mergeSeen：去重并保留最近的一批', () => {
  const merged = mergeSeen(['a', 'b'], [{ nid: 'b' }, { nid: 'c' }]);
  assert.deepEqual(merged, ['a', 'b', 'c']);
});