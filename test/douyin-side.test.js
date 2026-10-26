import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assignSides, describeSides, isUnsupportedMessage, pickInbound } from '../src/douyin-side.js';

// 数组都是「最新的在前」，和抖音 DOM 顺序一致
test('发送方判定：同一个人连发时，缺头像的继承上一条（往旧的方向继承）', () => {
  const list = assignSides([
    { text: '最后一条', own: '' }, // 最新，没头像
    { text: '中间', own: '' },
    { text: '最早（带头像）', own: 'them' },
  ]);
  assert.deepEqual(
    list.map((item) => item.from),
    ['them', 'them', 'them'],
  );
});

test('发送方判定：来回对话按头像切成两段，不会串到对面', () => {
  const list = assignSides([
    { text: '我刚发的', own: '' },
    { text: '还是我', own: 'me' },
    { text: '对方说的', own: '' },
    { text: '对方最早', own: 'them' },
  ]);
  assert.deepEqual(
    list.map((item) => item.from),
    ['me', 'me', 'them', 'them'],
  );
});

test('发送方判定：一个头像都没有就老实标 unknown，不猜', () => {
  const list = assignSides([{ text: 'a', own: '' }, { text: 'b', own: '' }]);
  assert.deepEqual(
    list.map((item) => item.from),
    ['unknown', 'unknown'],
  );
});

test('发送方判定：非法 own 值当成没读到', () => {
  const list = assignSides([{ text: 'a', own: 'maybe' }, { text: 'b', own: 'me' }]);
  assert.deepEqual(
    list.map((item) => item.from),
    ['me', 'me'],
  );
});

test('最新一条是谁发的：对面发的才算新消息', () => {
  assert.equal(pickInbound([{ from: 'them', text: '在吗' }])?.text, '在吗');
  assert.equal(pickInbound([{ from: 'me', text: '在' }]), null);
  assert.equal(pickInbound([]), null);
});

test('认不出方向时用「是不是我刚发的」兜底', () => {
  const list = [{ from: 'unknown', text: '我刚发的那句' }];
  assert.equal(pickInbound(list, (text) => text === '我刚发的那句'), null);
  assert.equal(pickInbound([{ from: 'unknown', text: '对方说的' }], () => false)?.text, '对方说的');
});

test('方向摘要给日志用', () => {
  const list = assignSides([
    { text: '你好呀', own: 'them' },
    { text: '我回一句', own: 'me' },
  ]);
  assert.equal(describeSides(list), 'TA:你好呀 | 我:我回一句');
});
test('网页版打不开的消息：认得出是占位文案（不能当成自己发的）', () => {
  assert.equal(isUnsupportedMessage('暂不支持该消息类型展示 请到抖音手机端查看'), true);
  assert.equal(isUnsupportedMessage('请到抖音手机端查'), true);
  assert.equal(isUnsupportedMessage('没事这个不重要'), false);
  assert.equal(isUnsupportedMessage(''), false);
  assert.equal(isUnsupportedMessage(null), false);
});
