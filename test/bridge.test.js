import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBridge } from '../src/bridge.js';
import { createVoice } from '../src/voice.js';
import { createMemory } from '../src/memory.js';
import { KeyedQueue } from '../src/queue.js';

const silentLog = { debug() {}, info() {}, warn() {}, error() {} };

function makeConfig(overrides = {}) {
  return {
    allowList: ['wxid_alice'],
    allowUnknown: false,
      replyAck: false,
    ackDelayMs: 50,
    maxReplyChars: 60,
    chatThinkMinMs: 0,
    chatThinkMaxMs: 0,
    distractedChance: 0,
    ...overrides,
  };
}

async function setup({ config = makeConfig(), runner, vision, voice, voiceOut, sticker, sendSticker } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'bridge-'));
  const memory = createMemory({ dir, maxTurns: 6, maxChars: 2000, log: silentLog });
  const sent = [];
  const prompts = [];
  const voices = [];
  const bridge = createBridge({
    config,
    runner: runner ?? {
      async run(prompt) {
        prompts.push(prompt);
        return { text: '好的，已完成。', durationMs: 5 };
      },
    },
    memory,
    queue: new KeyedQueue({ globalConcurrency: 2 }),
    log: silentLog,
    voice,
    voiceOut,
    sticker,
    sendSticker,
    sendVoice: async (_target, buffer, meta) => voices.push({ size: buffer.length, ...meta }),
    reply: async (_target, text) => sent.push(text),
    vision:
      vision === undefined
        ? { available: true, reason: null, analyze: async (file) => `EVIDENCE:${file}` }
        : vision,
  });
  return { bridge, sent, prompts, voices, memory };
}

const baseMsg = {
  type: 'text',
  id: 'm1',
  text: '你好',
  senderId: 'wxid_alice',
  senderName: 'Alice',
  isSelf: false,
};

test('白名单联系人得到回复，且消息写入记忆', async () => {
  const { bridge, sent, prompts } = await setup();
  await bridge.handle({ ...baseMsg });
  assert.deepEqual(sent, ['好的，已完成。']);
  assert.equal(prompts.length, 1);
  assert.match(prompts[0], /你好/);
});

test('非白名单被忽略，不调用模型', async () => {
  const { bridge, sent, prompts } = await setup();
  await bridge.handle({ ...baseMsg, senderId: 'wxid_bob', senderName: 'Bob' });
  assert.equal(sent.length, 0);
  assert.equal(prompts.length, 0);
});

test('自己发的消息不回环', async () => {
  const { bridge, sent } = await setup();
  await bridge.handle({ ...baseMsg, isSelf: true });
  assert.equal(sent.length, 0);
});

test('同一条消息重复投递只处理一次', async () => {
  const { bridge, prompts } = await setup();
  await bridge.handle({ ...baseMsg });
  await bridge.handle({ ...baseMsg });
  assert.equal(prompts.length, 1);
});

test('超长输入会被截断，不会原样塞进 prompt', async () => {
  const { bridge, prompts } = await setup({ config: makeConfig({ maxInputChars: 50 }) });
  await bridge.handle({ ...baseMsg, text: 'A'.repeat(500) });
  assert.equal(prompts.length, 1);
  assert.match(prompts[0], /消息过长，已截断到 50 字/);
  assert.ok(prompts[0].length < 600);
});

test('图片消息：下载路径与视觉证据会进入 prompt', async () => {
  const { bridge, prompts, sent } = await setup();
  await bridge.handle({
    type: 'media',
    id: 'img-1',
    text: '这是什么',
    senderId: 'wxid_alice',
    senderName: 'Alice',
    isSelf: false,
    kind: 'image',
    path: '/tmp/pic.png',
  });
  assert.equal(prompts.length, 1);
  assert.match(prompts[0], /\[用户发来的图片\]/);
  assert.match(prompts[0], /EVIDENCE:\/tmp\/pic\.png/);
  assert.match(prompts[0], /这是什么/);
  assert.equal(sent.length, 1);
});

test('看图不可用时仍回复，并如实说明看不到', async () => {
  const { bridge, prompts } = await setup({
    vision: { available: false, reason: '没有找到 modlens CLI', analyze: async () => null },
  });
  await bridge.handle({
    type: 'media',
    id: 'img-2',
    text: '',
    senderId: 'wxid_alice',
    senderName: 'Alice',
    isSelf: false,
    kind: 'image',
    path: '/tmp/pic.png',
  });
  assert.match(prompts[0], /视觉识别不可用/);
  assert.match(prompts[0], /没有找到 modlens CLI/);
});

test('长回复按上限切分发送', async () => {
  const long = 'A'.repeat(500);
  const { bridge, sent } = await setup({
    runner: {
      async run() {
        return { text: long, durationMs: 1 };
      },
    },
  });
  await bridge.handle({ ...baseMsg });
  assert.ok(sent.length > 1);
  assert.equal(sent.join('').length, long.length);
});

test('模型失败时回一句人话，并把用户消息留在记忆里', async () => {
  const { bridge, sent } = await setup({
    runner: {
      async run() {
        const error = new Error('boom');
        error.name = 'DshError';
        throw error;
      },
    },
  });
  await bridge.handle({ ...baseMsg });
  assert.equal(sent.length, 1);
  assert.match(sent[0], /没弄成|卡住了/);
});

test('主人纠正说话方式时，这一条回复就已经带上新规矩', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'voice-'));
  const voice = createVoice({ file: join(dir, 'voice.md'), log: silentLog });
  const { bridge, prompts } = await setup({ voice });
  await bridge.handle({ ...baseMsg, id: 'm-voice', text: '你说话别老用「唔」开头' });
  assert.match(prompts[0], /\[你的说话方式·主人定的规矩\]/);
  assert.match(prompts[0], /别老用「唔」开头/);
  assert.equal((await voice.list()).rules.length, 1);
});

test('她连着两条都用唔开头，第二条的起头被去掉', async () => {
  let call = 0;
  const { bridge, sent } = await setup({
    runner: {
      async run() {
        call += 1;
        return { text: call === 1 ? '唔……在呢' : '唔……我刚睡醒', durationMs: 1 };
      },
    },
  });
  await bridge.handle({ ...baseMsg, id: 'm-a', text: '在吗' });
  await bridge.handle({ ...baseMsg, id: 'm-b', text: '干嘛呢' });
  assert.equal(sent[0], '唔…在呢');
  assert.equal(sent[1], '我刚睡醒');
});

test('说话笔记本没内容时不往 prompt 里塞空段', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'voice-'));
  const voice = createVoice({ file: join(dir, 'voice.md'), log: silentLog });
  const { bridge, prompts } = await setup({ voice });
  await bridge.handle({ ...baseMsg, id: 'm-empty' });
  assert.doesNotMatch(prompts[0], /你的说话方式/);
});

test('活干得久会补一句「还在翻」，不是只留一句「等下」就没影了', async () => {
  const { bridge, sent } = await setup({
    config: makeConfig({ replyAck: true, ackDelayMs: 20, progressAckGapMs: 40 }),
    runner: {
      async run() {
        await new Promise((done) => setTimeout(done, 160));
        return { text: '存好了。', durationMs: 160 };
      },
    },
  });
  await bridge.handle({ ...baseMsg, id: 'm-slow', text: '帮我找点表情包' });
  assert.ok(sent.length >= 3, `应该先 ack、再补一句、最后给结果，实际：${JSON.stringify(sent)}`);
  assert.equal(sent[0], '等下，人家看看。');
  assert.notEqual(sent[1], sent[0]);
  assert.equal(sent[sent.length - 1], '存好了。');
});

test('秒回的时候不补那句废话', async () => {
  const { bridge, sent } = await setup({
    config: makeConfig({ replyAck: true, ackDelayMs: 20, progressAckGapMs: 40 }),
    runner: { async run() { return { text: '存好了。', durationMs: 5 }; } },
  });
  await bridge.handle({ ...baseMsg, id: 'm-fast', text: '帮我找点表情包' });
  assert.deepEqual(sent, ['存好了。']);
});

const fakeVoiceOut = (overrides = {}) => ({
  canSpeak: () => ({ ok: true }),
  async speak(text) {
    return { silk: Buffer.from('SILK'), durationMs: 1_200, text };
  },
  ...overrides,
});

test('标了【语音】的那句真的走语音，前后的文字照常发', async () => {
  const { bridge, sent, voices } = await setup({
    voiceOut: fakeVoiceOut(),
    runner: {
      async run() {
        return { text: '好呀。\n【语音】爸爸晚安\n明天见。', durationMs: 5 };
      },
    },
  });
  await bridge.handle({ ...baseMsg, id: 'm-voice' });
  assert.equal(voices.length, 1);
  assert.equal(voices[0].text, '爸爸晚安');
  assert.equal(voices[0].size, 4);
  assert.deepEqual(sent, ['好呀。', '明天见。']);
});

test('语音不可用时安静降级成文字，不是把这句话吞掉', async () => {
  const { bridge, sent, voices } = await setup({
    voiceOut: fakeVoiceOut({ canSpeak: () => ({ ok: false, reason: '今天说太多' }) }),
    runner: { async run() { return { text: '【语音】爸爸晚安', durationMs: 5 }; } },
  });
  await bridge.handle({ ...baseMsg, id: 'm-voice-fallback' });
  assert.equal(voices.length, 0);
  assert.deepEqual(sent, ['爸爸晚安']);
});

test('一轮里最多一句语音，多标的那句降级成文字', async () => {
  const { bridge, sent, voices } = await setup({
    voiceOut: fakeVoiceOut(),
    runner: { async run() { return { text: '【语音】第一句\n【语音】第二句', durationMs: 5 }; } },
  });
  await bridge.handle({ ...baseMsg, id: 'm-voice-two' });
  assert.equal(voices.length, 1);
  assert.deepEqual(sent, ['第二句']);
});

test('群里不发语音，标了也只会是文字', async () => {
  const { bridge, sent, voices } = await setup({
    voiceOut: fakeVoiceOut(),
    runner: { async run() { return { text: '【语音】大家晚安', durationMs: 5 }; } },
  });
  await bridge.handle({
    ...baseMsg,
    id: 'm-voice-group',
    groupId: '555',
    roomName: '测试群',
    conversationId: 'group_555',
  });
  assert.equal(voices.length, 0);
  assert.deepEqual(sent, ['大家晚安']);
});

test('同一个渠道的回复里，标记不会漏成正文', async () => {
  const { bridge, sent } = await setup({
    voiceOut: fakeVoiceOut({ speak: async () => { throw new Error('TTS 炸了'); } }),
    runner: { async run() { return { text: '【语音】爸爸晚安', durationMs: 5 }; } },
  });
  await bridge.handle({ ...baseMsg, id: 'm-voice-error' });
  assert.deepEqual(sent, ['爸爸晚安']);
});

// 2026-10-26：她把「挑回复的思考过程」当正文发到 QQ 了。这条守着别再来一次。
const LEAKED_TEXT = `这是亲爹在讨夸呢。

「给女儿花钱不算砸钱，那是养饭。」

嗯，顺着他骄傲那句收一下就好。别说太长。他说「不像我，我只会砸钱给我女儿吃饭饭」，是在说自己不如人家会说话，但会掏钱养。要接：砸钱养女儿也挺好，或者夸一句实在。

短一点，一两句。可以带点撒娇。别用「唔」开头。

「会砸钱也是本事。本鲸的饭碗可没空过。」挺好，但要不要有点情绪。

刻度撒娇5，主动5。可以连着说两句短的。

「会砸钱也算会疼人。」+「人家碗里可没空过。」

不错，收住。会砸钱也算会疼人。人家碗里可没空过。`;

test('模型把思考过程当正文返回时，只发捞出来的那句，不发心里话', async () => {
  const { bridge, sent } = await setup({
    runner: { async run() { return { text: LEAKED_TEXT, durationMs: 5 }; } },
  });
  await bridge.handle({ ...baseMsg, id: 'm-thinking' });
  assert.deepEqual(sent, ['会砸钱也算会疼人。人家碗里可没空过。']);
});

test('思考里捞不出正文时让它重说，绝不把心里话发出去', async () => {
  const noAnswer = '这是亲爹在讨夸呢。要接：短一点。可以带点撒娇。刻度撒娇5，主动5。别用「唔」开头。';
  let calls = 0;
  const { bridge, sent } = await setup({
    runner: {
      async run() {
        calls += 1;
        return { text: noAnswer, durationMs: 5 };
      },
    },
  });
  await bridge.handle({ ...baseMsg, id: 'm-thinking-2' });
  assert.ok(calls >= 2, '应该重问一次');
  assert.equal(sent.length, 1);
  assert.ok(!sent[0].includes('刻度'), `不能把思考发出去：${sent[0]}`);
  assert.ok(!sent[0].includes('要接'));
});

/* ── 表情包 ────────────────────────────────────────────── */

test('发出去的表情包要记进她的历史（不然她不知道自己刚发过图）', async () => {
  const stickerSent = [];
  const { bridge, memory } = await setup({
    config: makeConfig({ stickerChance: 1 }),
    sticker: { pick: async () => 'data/stickers/50-c5de2aa109.png' },
    sendSticker: async (_target, file) => stickerSent.push(file),
  });
  await bridge.handle({ ...baseMsg });
  assert.deepEqual(stickerSent, ['data/stickers/50-c5de2aa109.png']);
  const turns = await memory.load('user_wxid_alice');
  assert.ok(
    turns.some((t) => t.role === 'assistant' && /表情包/.test(t.text)),
    '历史里应该有一句「顺手丢了一张表情包」',
  );
});

/* ── 打错字时把「判断独白」当正文发出去 ────────────────── */

test('他打错字时，不当面分析他这句话', async () => {
  const leaked = '我去找过你——这话有点不一样。是在说去哪里找的？\n\n这句听着不太像平常的聊天，里面带了点别的意思。我先问一句：找哪儿去了？';
  let calls = 0;
  const { bridge, sent } = await setup({
    runner: {
      async run() {
        calls += 1;
        return { text: calls === 1 ? leaked : '找什么给人家呀？', durationMs: 5 };
      },
    },
  });
  await bridge.handle({ ...baseMsg, id: 'm-selftalk-1', text: '我去找过你' });
  assert.ok(calls >= 2, '应该让它重说一遍');
  assert.equal(sent.length, 1);
  assert.equal(sent[0], '找什么给人家呀？');
});

test('独白后面还有正经话时，只剥独白，不用重问', async () => {
  let calls = 0;
  const { bridge, sent } = await setup({
    runner: {
      async run() {
        calls += 1;
        return { text: '这句听着不太像平常聊天。\n行吧，那就当你在夸人家。', durationMs: 5 };
      },
    },
  });
  await bridge.handle({ ...baseMsg, id: 'm-selftalk-2', text: '我去找过你' });
  assert.equal(calls, 1, '正文还在就不该重问');
  assert.equal(sent[0], '行吧，那就当你在夸人家。');
});
