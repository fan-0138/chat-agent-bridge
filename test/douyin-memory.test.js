import { test } from 'node:test';
import assert from 'node:assert/strict';
import { conversationMemoryKey } from '../src/douyin-channel.js';

const config = { allowList: ['123456789'], douyinChatSelfName: '主人' };

test('同一条鱼：抖音里跟主人聊，用的是 QQ 私聊同一份记忆 key', () => {
  assert.equal(conversationMemoryKey('主人', config), 'user_private_123456789');
});

test('同一条鱼：别人在抖音单独记，不会混进主人的时间线', () => {
  assert.equal(conversationMemoryKey('小明', config), 'douyin_小明');
  assert.equal(conversationMemoryKey('', config), 'douyin_someone');
});

test('同一条鱼：没配主人号时不乱串', () => {
  assert.equal(conversationMemoryKey('主人', { allowList: [] }), 'douyin_主人');
  // 名字前缀相同也不算同一个人
  assert.equal(conversationMemoryKey('主人家的猫', config), 'douyin_主人家的猫');
});

test('同一条鱼：改称呼也不影响（配置里的 douyinChatSelfName 说了算）', () => {
  assert.equal(conversationMemoryKey('阿爸', { allowList: ['42'], douyinChatSelfName: '阿爸' }), 'user_private_42');
  assert.equal(conversationMemoryKey('主人', { allowList: ['42'], douyinChatSelfName: '阿爸' }), 'douyin_主人');
});
