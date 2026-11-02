import { test } from 'node:test';
import assert from 'node:assert/strict';
import { looksUnfinished, isLowContent, pickNudge } from '../src/reader.js';

test('没说完的句子认得出来', () => {
  for (const text of ['那个…', '我觉得', '所以', '今天我和', '你好，', '「', '就是…', '我跟你说']) {
    assert.equal(looksUnfinished(text), true, text);
  }
});

test('说完了的句子不硬等', () => {
  for (const text of ['今天好累。', '今天好累', '在吗', '好的', '你吃了吗？', '我想你了', '走了']) {
    assert.equal(looksUnfinished(text), false, text);
  }
});

test('长句的省略号当说完了，短句当没说完', () => {
  assert.equal(looksUnfinished('今天在机房待了一整天，风扇一直响，我有点累…'), false);
  assert.equal(looksUnfinished('我有点累…'), true);
});

test('纯应答不一定要回', () => {
  for (const text of ['嗯', '哦', '哈哈', '好的', '在', '1', '🐳']) {
    assert.equal(isLowContent(text), true, text);
  }
});

test('问句、长句、带内容的话都要回', () => {
  for (const text of ['在吗', '你吃了吗？', '今天好累', '嗯？', '好的我知道了', '这个表情包好看吗']) {
    assert.equal(isLowContent(text), false, text);
  }
});

test('追问不连着用同一句', () => {
  const line = pickNudge(['嗯？'], () => 0);
  assert.notEqual(line, '嗯？');
  assert.ok(line.length > 0);
});