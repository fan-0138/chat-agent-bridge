import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeNotice, pickReplyable, TYPE_NAME } from '../scripts/lib/douyin-notice.js';

test('通知：@我 的通知能读出谁、在哪条视频、说了什么', () => {
  const item = normalizeNotice({
    type: 45,
    nid: '7700274174472439000',
    create_time: 1792859794,
    at: {
      user_info: { nickname: 'restart', uid: '987654321098765' },
      content: '好听的歌与你分享',
      schema_url: 'aweme://aweme/detail/7698772290419371441?cid=7700274126799766299',
      aweme: { aweme_id: '7698772290419371441', desc: '#去年夏天' },
    },
  });
  assert.equal(item.typeName, TYPE_NAME[45]);
  assert.equal(item.nickname, 'restart');
  assert.equal(item.uid, '987654321098765');
  assert.equal(item.awemeId, '7698772290419371441');
  assert.equal(item.commentId, '7700274126799766299');
  assert.equal(item.videoUrl, 'https://www.douyin.com/video/7698772290419371441');
  assert.match(item.commentUrl, /comment_id=7700274126799766299/);
  assert.equal(item.atMe, true);
  assert.equal(item.replyable, true);
});

test('通知：评论类通知的说话人在 block.comment.user 里', () => {
  const item = normalizeNotice({
    type: 35,
    nid: '1',
    create_time: 100,
    comment: {
      user_info: { nickname: '外层名字' },
      comment: { cid: '555', text: '这条视频不错', user: { nickname: '真正说话的人', uid: '42' } },
      aweme_id: '7666',
    },
  });
  assert.equal(item.nickname, '真正说话的人');
  assert.equal(item.uid, '42');
  assert.equal(item.content, '这条视频不错');
  assert.equal(item.commentId, '555');
  assert.equal(item.awemeId, '7666');
});

test('通知：回复楼中楼时能拿到楼根（reply_id 必须填它）', () => {
  const item = normalizeNotice({
    type: 31,
    nid: '2',
    create_time: 200,
    comment: {
      from_user: { nickname: '小明', uid: '7' },
      parent_id: '900',
      level1_comment: { cid: '900', text: '楼根那条', user: { nickname: '楼主' } },
      reply_comment: { cid: '901', text: '我回的那条', user: { nickname: '主人' } },
      aweme_id: '7777',
    },
  });
  assert.equal(item.rootCommentId, '900');
  assert.equal(item.rootAuthor, '楼主');
  assert.equal(item.rootText, '楼根那条');
  assert.equal(item.replyToNickname, '主人');
  assert.equal(item.replyToText, '我回的那条');
  assert.equal(item.replyToCommentId, '901');
  assert.equal(item.replyable, true);
});

test('通知：关注/点赞这类不该拿去回', () => {
  const follow = normalizeNotice({ type: 33, nid: '3', create_time: 1, follow: { user_info: { nickname: 'a' }, content: '关注了你' } });
  const digg = normalizeNotice({ type: 34, nid: '4', create_time: 1, digg: { user_info: { nickname: 'b' } } });
  assert.equal(follow.replyable, false);
  assert.equal(digg.replyable, false);
  assert.deepEqual(pickReplyable([follow, digg]), []);
});

test('通知：空条目不会炸', () => {
  assert.equal(normalizeNotice(null), null);
  const blank = normalizeNotice({});
  assert.equal(blank.nickname, '');
  assert.equal(blank.replyable, false);
  assert.equal(blank.type, 0);
  const empty = normalizeNotice({ type: 99, nid: '5' });
  assert.equal(empty.typeName, 'type_99');
  assert.equal(empty.replyable, false);
  assert.equal(empty.atMe, false);
});

test('通知：挑出「该回一句」的，按内容过滤', () => {
  const items = [
    normalizeNotice({ type: 45, nid: 'a', at: { user_info: { nickname: 'x' }, content: '@她 在吗', aweme_id: '1' } }),
    normalizeNotice({ type: 33, nid: 'b', follow: { user_info: { nickname: 'y' }, content: '关注了你' } }),
    normalizeNotice({ type: 35, nid: 'c', comment: { from_user: { nickname: 'z' }, content: '', aweme_id: '2' } }),
  ];
  const picked = pickReplyable(items);
  assert.equal(picked.length, 1);
  assert.equal(picked[0].nid, 'a');
});
