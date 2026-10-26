#!/usr/bin/env node
/**
 * 离线回放：不需要 NapCat、不需要模型、不需要 QQ 号。
 * 用真实的 normalizeEvent + 真实限流器 + 真实 bridge（模型换成桩），
 * 逐条说明「这条消息会不会触发、触发后发给谁、回复什么」。
 *
 *   node scripts/simulate-qq.js
 *
 * 想验证真实模型链路，用微信那边的 scripts/simulate.js，或装好 NapCat 后用
 * npm run probe:qq 探针。
 */

import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBridge } from '../src/bridge.js';
import { createMemory } from '../src/memory.js';
import { KeyedQueue } from '../src/queue.js';
import { createRateLimiter, normalizeEvent } from '../src/transport-onebot.js';

const silentLog = { debug() {}, info() {}, warn() {}, error() {} };

const SELF_ID = '10000';
const ME = '10001';
const FRIEND = '10002';
const STRANGER = '99999';
const MY_GROUP = '555555';
const OTHER_GROUP = '666666';

// 演示用配置：故意设得比默认更严一点，好让限流能在几行内看到效果
const config = {
  channel: 'qq',
  allowList: [ME, FRIEND],
  allowUnknown: false,
  allowListHint: 'QQ_ALLOW_LIST',
  groupAllowList: [MY_GROUP],
  groupPrefix: '/ai',
  ratePerGroupMin: 3,
  ratePerUserHour: 20,
  rateGlobalMin: 50,
  replyAck: false,
  maxReplyChars: 300,
  maxInputChars: 600,
};

const groupNames = new Map([[MY_GROUP, '我的私人群']]);
const limiter = createRateLimiter({
  perGroupMinute: config.ratePerGroupMin,
  perUserHour: config.ratePerUserHour,
  globalMinute: config.rateGlobalMin,
});

let nextId = 1;
const event = (overrides) => ({
  post_type: 'message',
  self_id: Number(SELF_ID),
  message_id: nextId++,
  time: Math.floor(Date.now() / 1000),
  ...overrides,
});

const privateText = (userId, text, nickname = '某人') => ({
  ...event({
    message_type: 'private',
    sub_type: 'friend',
    user_id: Number(userId),
    message: [{ type: 'text', data: { text } }],
    sender: { user_id: Number(userId), nickname },
  }),
});

const groupText = (groupId, userId, segments, nickname = '群友') => ({
  ...event({
    message_type: 'group',
    sub_type: 'normal',
    group_id: Number(groupId),
    user_id: Number(userId),
    message: segments,
    sender: { user_id: Number(userId), nickname },
  }),
});

const text = (value) => ({ type: 'text', data: { text: value } });
const at = (qq) => ({ type: 'at', data: { qq: String(qq) } });

const scenarios = [
  ['私聊我本人', privateText(ME, '帮我看下这台机器的磁盘占用', '我')],
  ['私聊好友', privateText(FRIEND, '今天几号', '好友')],
  ['私聊陌生人', privateText(STRANGER, '你好', '陌生人')],
  ['群里没 @ 也没前缀', groupText(MY_GROUP, FRIEND, [text('今天天气不错')])],
  ['群里 @我（第 1 条）', groupText(MY_GROUP, FRIEND, [at(SELF_ID), text(' 帮我看下 git 状态')])],
  ['群里用前缀（第 2 条）', groupText(MY_GROUP, FRIEND, [text('/ai 磁盘还剩多少')])],
  ['群不在白名单里 @我', groupText(OTHER_GROUP, FRIEND, [at(SELF_ID), text(' 在吗')])],
  ['同一群第 3 条', groupText(MY_GROUP, FRIEND, [at(SELF_ID), text(' 那内存呢')])],
  ['同一群第 4 条（应被限流）', groupText(MY_GROUP, FRIEND, [at(SELF_ID), text(' 那 CPU 呢')])],
  ['同一群第 5 条（仍被限流）', groupText(MY_GROUP, FRIEND, [at(SELF_ID), text(' 那负载呢')])],
];

async function main() {
  const dir = await mkdtemp(join(tmpdir(), 'qq-sim-'));
  const memory = createMemory({ dir, maxTurns: 4, maxChars: 2000, log: silentLog });
  const queue = new KeyedQueue({ globalConcurrency: 2 });

  const sent = [];
  const bridge = createBridge({
    config,
    runner: {
      async run() {
        return { text: '（桩回复）收到，这是模拟回复。', durationMs: 3 };
      },
    },
    memory,
    queue,
    log: silentLog,
    reply: async (msg, body) => sent.push({ target: msg.groupId ? `群 ${msg.groupId}` : `私聊 ${msg.senderId}`, body }),
  });

  console.log(`演示配置：私聊白名单=${config.allowList.join('/')}  群白名单=${config.groupAllowList.join('/')}  触发=@我 或 ${config.groupPrefix}\n`);

  let index = 0;
  for (const [label, raw] of scenarios) {
    index += 1;
    const msg = normalizeEvent(raw, {
      selfId: SELF_ID,
      groupAllowList: config.groupAllowList,
      groupPrefix: config.groupPrefix,
      groupNames,
    });

    console.log(`${index}. ${label}`);

    if (!msg) {
      console.log('   → 忽略（没触发或不在白名单，一个字节都不回）\n');
      continue;
    }

    const verdict = limiter.check({ userId: msg.senderId, groupId: msg.groupId });
    if (!verdict.ok) {
      console.log(`   → 限流丢弃：${verdict.reason}\n`);
      continue;
    }
    limiter.record({ userId: msg.senderId, groupId: msg.groupId });

    const before = sent.length;
    await bridge.handle(msg);
    const replies = sent.slice(before);
    if (replies.length === 0) {
      console.log('   → 触发但没发出去（看日志）\n');
      continue;
    }
    console.log(`   → 触发 · 记忆键 ${msg.conversationId}`);
    for (const reply of replies) console.log(`     发给 ${reply.target}：${reply.body}`);
    console.log('');
  }

  const stats = limiter.stats();
  console.log(`限流窗口统计：全局 ${stats.globalLastMinute}/分，用户 ${stats.users} 个，群 ${stats.groups} 个`);
  console.log('\n结论：只有「白名单内 + @我或前缀」的消息会消耗模型和发出消息，其余静默。');
}

main().catch((error) => {
  console.error(error?.stack ?? error);
  process.exit(1);
});