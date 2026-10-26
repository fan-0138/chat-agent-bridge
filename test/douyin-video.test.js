import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractDouyinVideo, formatVideoSummary } from '../scripts/lib/douyin-video.js';

test('能从文本里认出完整的抖音视频链接', () => {
  const link = extractDouyinVideo('看这个 https://www.douyin.com/video/7679049119339482431 笑死');
  assert.equal(link.id, '7679049119339482431');
  assert.equal(link.url, 'https://www.douyin.com/video/7679049119339482431');
});

test('能认出带 modal_id 的分享链接', () => {
  const link = extractDouyinVideo('https://www.douyin.com/user/self?modal_id=7687453895372713216');
  assert.equal(link.id, '7687453895372713216');
});

test('只有裸视频 ID 也能认出来', () => {
  const link = extractDouyinVideo('视频号 7679049119339482431 那个');
  assert.equal(link.id, '7679049119339482431');
});

test('链接被截断时返回 id 为空，交给上层提示用户', () => {
  const link = extractDouyinVideo('https://www.douyin.com/video/76874538953…');
  assert.ok(link);
  assert.equal(link.id, null);
});

test('没有链接时返回 null', () => {
  assert.equal(extractDouyinVideo('在干嘛呢'), null);
  assert.equal(extractDouyinVideo(''), null);
  assert.equal(extractDouyinVideo(null), null);
});

test('视频摘要格式包含标题、作者、链接、热评', () => {
  const text = formatVideoSummary({
    url: 'https://www.douyin.com/video/1',
    desc: '一条视频',
    author: '某人',
    comments: ['好看', '有点东西'],
  });
  assert.match(text, /标题：一条视频/);
  assert.match(text, /作者：某人/);
  assert.match(text, /热评：/);
  assert.match(text, /好看/);
});

test('空摘要返回空串', () => {
  assert.equal(formatVideoSummary(null), '');
});
