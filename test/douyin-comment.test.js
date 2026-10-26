import { test } from 'node:test';
import assert from 'node:assert/strict';
import { awemeIdFromUrl, buildMentionPayload, judgePlacement } from '../scripts/lib/douyin-comment-api.js';
import { stripLeadingMention } from '../scripts/lib/douyin-mention-ui.js';

test('评论：从各种链接里取 19 位视频 id', () => {
  assert.equal(awemeIdFromUrl('https://www.douyin.com/video/7412345678901234567'), '7412345678901234567');
  assert.equal(awemeIdFromUrl('https://www.douyin.com/note/7412345678901234567?x=1'), '7412345678901234567');
  assert.equal(awemeIdFromUrl('https://v.douyin.com/abc/'), null);
  assert.equal(awemeIdFromUrl(''), null);
});

test('评论：落位判定 —— 没楼根就是顶层评论', () => {
  const placement = judgePlacement({ plan: { root: '' }, res: { http: 200, cid: '1' } });
  assert.equal(placement.state, 'top-level');
  assert.equal(placement.ok, true);
});

test('评论：落位判定 —— 重读楼里读到 level=2 才算进楼', () => {
  const ok = judgePlacement({ plan: { root: '100' }, res: { http: 200, cid: '200', verified: true, verified_level: 2 } });
  assert.equal(ok.state, 'in-thread');
  assert.equal(ok.ok, true);
});

test('评论：落位判定 —— 变成 level=1 的独立评论要报错', () => {
  const bad = judgePlacement({ plan: { root: '100' }, res: { http: 200, cid: '200', verified: true, verified_level: 1 } });
  assert.equal(bad.state, 'misplaced');
  assert.equal(bad.ok, false);
  assert.match(bad.note, /楼根填错/);

  const top = judgePlacement({ plan: { root: '100' }, res: { http: 200, cid: '200', found_at_top: true } });
  assert.equal(top.ok, false);
  assert.equal(top.state, 'misplaced');
});

test('评论：落位判定 —— 读不到不算失败（评论按热度排）', () => {
  const unknown = judgePlacement({ plan: { root: '100' }, res: { http: 200, cid: '200' } });
  assert.equal(unknown.state, 'unverified');
  assert.equal(unknown.ok, null);
});

test('评论：没拿到 cid 就是失败', () => {
  const fail = judgePlacement({ plan: { root: '100' }, res: { http: 403, cid: '' } });
  assert.equal(fail.ok, null);
  assert.equal(fail.state, 'unknown');
});

test('评论：点选 @ 之后别再把 @昵称 打一遍', () => {
  assert.equal(stripLeadingMention('@主人 这句我喜欢', '主人'), '这句我喜欢');
  assert.equal(stripLeadingMention('@主人', '主人'), '');
  // 正文中间的 @ 不动
  assert.equal(stripLeadingMention('这句 @主人 说得对', '主人'), '这句 @主人 说得对');
  assert.equal(stripLeadingMention('没有 at', '主人'), '没有 at');
  assert.equal(stripLeadingMention('@别人 你好', '主人'), '@别人 你好');
});
const TAG = { nickname: 'restart', remark: '主人', user_id: '987654321098765', sec_uid: 'MS4wLjABAAAA_PLACEHOLDER' };

test('评论 @：正文前缀 + text_extra 区间要和正文对得上', () => {
  const payload = buildMentionPayload('听见了', TAG);
  assert.equal(payload.text, '@restart 听见了');
  assert.equal(payload.textExtra.length, 1);
  assert.deepEqual(payload.textExtra[0], {
    user_id: '987654321098765',
    sec_uid: 'MS4wLjABAAAA_PLACEHOLDER',
    type: 0,
    start: 0,
    end: '@restart'.length,
  });
  // end 必须正好切在「@昵称」后面，正文里的 @ 区间就靠它
  assert.equal(payload.text.slice(0, payload.textExtra[0].end), '@restart');
});

test('评论 @：正文里自己写的 @xxx 会被剥掉，不重复', () => {
  assert.equal(buildMentionPayload('@主人 听见了', TAG).text, '@restart 听见了');
  assert.equal(buildMentionPayload('@主人', TAG).text, '@restart');
  assert.equal(buildMentionPayload('  听见了  ', TAG).text, '@restart 听见了');
  // 中间/结尾的 @ 不动
  assert.equal(buildMentionPayload('听见了 @主人', TAG).text, '@restart 听见了 @主人');
});

test('评论 @：候选人信息不全时不生成（宁可不发）', () => {
  assert.equal(buildMentionPayload('听见了', null), null);
  assert.equal(buildMentionPayload('听见了', { nickname: 'restart' }), null);
  assert.equal(buildMentionPayload('听见了', { nickname: 'restart', user_id: '1' }), null);
});
