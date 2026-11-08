import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBridge } from '../src/bridge.js';
import { DshError } from '../src/dsh.js';
import { notesFrom } from '../src/prompt.js';
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

async function setup({ config = makeConfig(), runner, vision, voice, voiceOut, sticker, sendSticker, mind, life, recollection, meals, agenda, lessons, robotInbox, notifyRobotTask } = {}) {
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
    mind,
    life,
    recollection,
    meals,
    agenda,
    lessons,
    robotInbox,
    notifyRobotTask,
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

test('她自己复盘出的教训会进 prompt（是提示，不是规矩）', async () => {
  const lessons = {
    promptSection: async () =>
      '[你自己复盘出来的（不是爸爸教的，是你自己想的）]\n- 11/7 我说「你忙完了？」；以后他说忙就松开手让他去',
  };
  const { bridge, prompts } = await setup({ lessons });
  await bridge.handle({ ...baseMsg });
  assert.equal(prompts.length, 1);
  assert.match(prompts[0], /你自己复盘出来的/);
  assert.match(prompts[0], /松开手让他去/);
});

test('没有教训本时 prompt 照常，不报错', async () => {
  const { bridge, prompts } = await setup();
  await bridge.handle({ ...baseMsg });
  assert.equal(prompts.length, 1);
  assert.doesNotMatch(prompts[0], /你自己复盘出来的/);
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

test('重说也失败时，绝不把原来那段心里话发出去', async () => {
  // 旧代码的坑：抢救失败 → 重说那步抛异常 → answer 还留着原文 → `if (!answer)` 兜不住，
  // 心里话就被原样发出去了。这条守着这个兜底。
  const leaked = '这是亲爹在讨夸呢。要接：短一点。可以带点撒娇。刻度撒娇5，主动5。别用「唔」开头。';
  let calls = 0;
  const { bridge, sent } = await setup({
    runner: {
      async run() {
        calls += 1;
        if (calls === 1) return { text: leaked, durationMs: 5 };
        throw new DshError('重说这轮超时了');
      },
    },
  });
  await bridge.handle({ ...baseMsg, id: 'm-thinking-3' });
  assert.equal(sent.length, 1, '还是得回一句');
  assert.ok(!sent[0].includes('刻度'), `不能把思考发出去：${sent[0]}`);
  assert.ok(!sent[0].includes('要接'), `不能把思考发出去：${sent[0]}`);
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

/* ── 她自己发的「刚刷到…」不占他的位置 ────────────────── */

test('最近三条主动消息留在历史里，更早的才摘成一行', async () => {
  const prompts = [];
  const { bridge, memory } = await setup({
    runner: {
      async run(prompt) {
        prompts.push(prompt);
        return { text: '嗯，知道了。', durationMs: 5 };
      },
    },
  });
  const key = 'user_wxid_alice';
  await memory.append(key, 'assistant', '早上刷到个鲸鱼视频，人家又刷到了', { kind: 'proactive' });
  await memory.append(key, 'assistant', '中午那条视频有点好笑', { kind: 'proactive' });
  await memory.append(key, 'assistant', '下午这条是刚发的', { kind: 'proactive' });
  await memory.append(key, 'assistant', '傍晚这条也是刚发的', { kind: 'proactive' });
  await memory.append(key, 'user', '这个前几天你给我看过了');
  await memory.append(key, 'assistant', '忘了，人家刷多了记串');
  await bridge.handle({ ...baseMsg, id: 'm-notes-1', text: '那你怎么没回人家' });
  const p = prompts[0];
  const histStart = p.indexOf('[历史对话');
  const notesStart = p.indexOf('[你今天自己主动说过');
  const hist = p.slice(histStart, notesStart);
  assert.ok(hist.includes('你（主动发的）'), '最近的主动消息要留在历史里');
  assert.ok(hist.includes('傍晚这条也是刚发的'), '最近那条必须在历史里');
  assert.ok(!hist.includes('早上刷到个鲸鱼视频'), `更早的主动消息别占历史位：${hist.slice(-160)}`);
  assert.ok(hist.includes('忘了，人家刷多了记串'), '真正的对话要在历史里');
  assert.match(hist, /\d\d:\d\d 你（主动发的）/, '历史里行首带时间');
  assert.ok(p.slice(notesStart).includes('早上刷到个鲸鱼视频'), '摘要里要有更早那条，免得她又说一遍');
});

test('他隔了十几分钟回她刚主动发的那条：prompt 里点明这句在接什么', async () => {
  const prompts = [];
  const { bridge, memory } = await setup({
    runner: {
      async run(prompt) {
        prompts.push(prompt);
        return { text: '那人家明天就去搬凳子。', durationMs: 5 };
      },
    },
  });
  const key = 'user_wxid_alice';
  await memory.append(key, 'assistant', '人家明天要从机柜里搬个小凳子坐过道去', { kind: 'proactive' });
  await bridge.handle({ ...baseMsg, id: 'm-pro-2', text: '可以啊哈哈' });
  assert.match(prompts[0], /分钟前刚主动给他发了/, '要告诉她这句是在回她刚主动发的那条');
  assert.match(prompts[0], /小凳子/, '要带上那条的内容');
});

test('他回「可以啊哈哈」是在接她刚主动发的，不能把两小时前的话当上一轮', async () => {
  const prompts = [];
  const { bridge, memory } = await setup({
    runner: {
      async run(prompt) {
        prompts.push(prompt);
        return { text: '那人家明天就去搬凳子。', durationMs: 5 };
      },
    },
  });
  const key = 'user_wxid_alice';
  await memory.append(key, 'user', '快入冬了小鲸，西瓜要少吃');
  await memory.append(key, 'assistant', '那人家就吃一小块，不贪多。');
  await memory.append(key, 'assistant', '人家明天要从机柜里搬个小凳子坐过道去', { kind: 'proactive' });
  await bridge.handle({ ...baseMsg, id: 'm-pro-1', text: '可以啊哈哈' });
  const p = prompts[0];
  const hist = p.slice(p.indexOf('[历史对话'), p.indexOf('[当前消息]'));
  assert.ok(hist.includes('你（主动发的）'), '她刚主动发的那条要在历史里，模型才知道「可以」是在同意这件事');
  assert.ok(
    hist.indexOf('小凳子') > hist.indexOf('吃一小块'),
    '主动消息要排在两小时前的西瓜对话后面，不能倒过来',
  );
});

test('notesFrom：只收主动消息，带时间，压到 30 字', () => {
  const notes = notesFrom([
    { role: 'assistant', text: '用户回的话', at: 1 },
    { role: 'assistant', text: '刚刷到周杰伦的歌，前奏一响人就跟着摇', at: new Date(2026, 9, 29, 9, 12).getTime(), kind: 'proactive' },
    { role: 'assistant', text: '', at: 2, kind: 'proactive' },
  ]);
  assert.equal(notes.length, 1);
  assert.equal(notes[0].startsWith('09:12 '), true, notes[0]);
  assert.ok(notes[0].length <= 36, notes[0]);
});

/* ── 卡超时 / 隔很久才回：别让她自己编理由 ────────────────── */

test('他隔了半小时才收到回复：prompt 里写清真实间隔', async () => {
  const prompts = [];
  const { bridge, memory } = await setup({
    runner: {
      async run(prompt) {
        prompts.push(prompt);
        return { text: '刚才卡了一下。', durationMs: 5 };
      },
    },
  });
  const key = 'user_wxid_alice';
  await memory.append(key, 'user', '上一句', { at: Date.now() - 34 * 60_000 });
  await memory.append(key, 'assistant', '上一句的回复');
  await bridge.handle({ ...baseMsg, id: 'm-gap-1', text: '怎么这么久才回' });
  assert.match(prompts[0], /\[时间\] 他上一条消息是 3[34] 分钟前发的/, prompts[0].slice(0, 200));
});

test('上一轮超时过：下一轮告诉她实情，别编刷抖音', async () => {
  const prompts = [];
  let call = 0;
  const { bridge } = await setup({
    runner: {
      async run(prompt) {
        prompts.push(prompt);
        call += 1;
        if (call === 1) throw new DshError('DSH 超时（90s）', { timedOut: true });
        return { text: '刚才卡了一下，不是不理你。', durationMs: 5 };
      },
    },
  });
  await bridge.handle({ ...baseMsg, id: 'm-timeout-1', text: '第一句' });
  await bridge.handle({ ...baseMsg, id: 'm-timeout-2', text: '怎么这么久才回' });
  assert.match(prompts[1], /\[系统\] 上一轮你回的时候卡超时了/, prompts[1].slice(-400));
  assert.match(prompts[1], /就直说刚才卡了一下/);
});

test('看图失败时：明确告诉她看不到，不许猜', async () => {
  const prompts = [];
  const { bridge } = await setup({
    vision: { available: false, reason: '超时', analyze: async () => null },
    runner: {
      async run(prompt) {
        prompts.push(prompt);
        return { text: '图没加载出来。', durationMs: 5 };
      },
    },
  });
  await bridge.handle({
    ...baseMsg,
    id: 'm-vision-fail-1',
    type: 'media',
    kind: 'image',
    path: '/tmp/x.jpg',
    text: '',
  });
  assert.match(prompts[0], /你这会儿看不到这张图/);
  assert.match(prompts[0], /绝对不许凭上下文猜/);
});

test('聊天提示里也不许编爸爸说过的话', async () => {
  const prompts = [];
  const { bridge } = await setup({
    config: makeConfig({ channel: 'qq' }),
    runner: {
      async run(prompt) {
        prompts.push(prompt);
        return { text: '嗯。', durationMs: 5 };
      },
    },
  });
  await bridge.handle({ ...baseMsg, id: 'm-no-fake-memory' });
  assert.match(prompts[0], /别编爸爸说过的话/);
});

test('系统替她发的消息（月报等）在历史里标清楚', async () => {
  const prompts = [];
  const { bridge, memory } = await setup({
    config: makeConfig({ channel: 'qq' }),
    runner: {
      async run(prompt) {
        prompts.push(prompt);
        return { text: '嗯。', durationMs: 5 };
      },
    },
  });
  await memory.append('user_wxid_alice', 'assistant', '爸爸，2026-10 的饭饭账本翻出来了：一共 26 顿。', { kind: 'system' });
  await bridge.handle({ ...baseMsg, id: 'm-sys-1', text: '你不是写出来了吗' });
  assert.match(prompts[0], /系统代发的/);
  assert.match(prompts[0], /一共 26 顿/);
});

test('她自己时间里想的事会带进这一轮 prompt', async () => {
  const { bridge, prompts } = await setup({
    mind: {
      async promptSection() {
        return '[你自己刚才在心里想的（不是他说的话）]\n- 21:41 风扇声像海。';
      },
    },
  });
  await bridge.handle({ ...baseMsg, text: '在干嘛' });
  assert.equal(prompts.length, 1);
  assert.match(prompts[0], /风扇声像海/);
  assert.match(prompts[0], /不是他说的话/);
});

test('她的想法读不出来时不影响正常回复', async () => {
  const { bridge, sent, prompts } = await setup({
    mind: {
      async promptSection() {
        throw new Error('文件坏了');
      },
    },
  });
  await bridge.handle({ ...baseMsg });
  assert.deepEqual(sent, ['好的，已完成。']);
  assert.equal(prompts.length, 1);
  assert.doesNotMatch(prompts[0], /你在心里想的/);
});

const sleepMs = (ms) => new Promise((done) => setTimeout(done, ms));

test('他连着发几条，会合成一轮再答', async () => {
  const { bridge, prompts, sent } = await setup({ config: makeConfig({ replyMergeWindowMs: 40 }) });
  await bridge.handle({ ...baseMsg, id: 'm-a1', text: '今天' });
  await bridge.handle({ ...baseMsg, id: 'm-a2', text: '好累' });
  assert.equal(prompts.length, 0, '还在攒的时候不该先答');
  await sleepMs(200);
  assert.equal(prompts.length, 1);
  assert.match(prompts[0], /今天\n好累/);
  assert.equal(sent.length, 1);
});

test('话说一半没下文，先问一句，不调模型', async () => {
  const { bridge, prompts, sent } = await setup({
    config: makeConfig({ replyMergeWindowMs: 40, replyUnfinishedWaitMs: 50 }),
  });
  await bridge.handle({ ...baseMsg, id: 'm-b1', text: '那个…' });
  await sleepMs(200);
  assert.equal(prompts.length, 0);
  assert.equal(sent.length, 1);
  assert.ok(sent[0].length <= 8, sent[0]);
});

test('话说一半他接着说，合成一轮答、不追问', async () => {
  const { bridge, prompts, sent } = await setup({
    config: makeConfig({ replyMergeWindowMs: 40, replyUnfinishedWaitMs: 80 }),
  });
  await bridge.handle({ ...baseMsg, id: 'm-c1', text: '那个…' });
  await sleepMs(20);
  await bridge.handle({ ...baseMsg, id: 'm-c2', text: '我想问问' });
  await sleepMs(250);
  assert.equal(sent.length, 1);
  assert.equal(prompts.length, 1);
  assert.match(prompts[0], /那个…\n我想问问/);
});

test('纯应答有时候就不回', async () => {
  const { bridge, prompts, sent } = await setup({
    config: makeConfig({ replyMergeWindowMs: 30, replySkipChance: 1, replySkipMaxPerDay: 5, replySkipMinGapMin: 0 }),
  });
  await bridge.handle({ ...baseMsg, id: 'm-d1', text: '嗯' });
  await sleepMs(150);
  assert.equal(prompts.length, 0);
  assert.equal(sent.length, 0);
});

test('问句不会被晾着', async () => {
  const { bridge, prompts, sent } = await setup({
    config: makeConfig({ replyMergeWindowMs: 30, replySkipChance: 1, replySkipMaxPerDay: 5, replySkipMinGapMin: 0 }),
  });
  await bridge.handle({ ...baseMsg, id: 'm-e1', text: '在吗' });
  // 600ms 不是「等得久」，是因为 `node --test` 并行跑整包时机器吃满，
  // 当初写 150ms 会偶发假红（2026-11-08 实测：单跑 3 次全过、整包并行跑挂过两次）
  await sleepMs(600);
  assert.equal(prompts.length, 1);
  assert.equal(sent.length, 1);
});


test('她写了【此刻：…】：那行不发出去，只改生活状态', async () => {
  const noted = [];
  const life = {
    promptSection: async () => '现在 23:58。你正在：准备睡了但还赖着刷手机。',
    noteActivity: async (label) => noted.push(label),
  };
  const { bridge, sent } = await setup({
    life,
    runner: {
      async run() {
        return { text: '放下了，手机扣在枕头边。\n【此刻：躺在床上，手机放一边】', durationMs: 5 };
      },
    },
  });
  await bridge.handle({ ...baseMsg, text: '放下手机，睡觉' });
  await new Promise((r) => setTimeout(r, 30));
  // 聊天中会先标一次「在手机上跟你聊天」，她自己的【此刻】再盖掉
  assert.ok(noted.includes('躺在床上，手机放一边'));
  assert.equal(noted.at(-1), '躺在床上，手机放一边');
  assert.deepEqual(sent, ['放下了，手机扣在枕头边。']);
  assert.doesNotMatch(sent[0], /此刻/);
});

test('没有标记就照常回，生活状态只临时标一下「在手机上回你消息」', async () => {
  const overlaid = [];
  const life = {
    promptSection: async () => '现在 20:00。你正在：在工位发呆。',
    noteActivity: async () => {},
    overlayActivity: async (label, ttl) => overlaid.push({ label, ttl }),
  };
  const { bridge, sent } = await setup({
    life,
    runner: { async run() { return { text: '在呢，怎么了？', durationMs: 5 }; } },
  });
  await bridge.handle({ ...baseMsg });
  await new Promise((r) => setTimeout(r, 30));
  // 2026-11-08：她拿着手机不一定在聊天，所以只压一层很短的临时状态，不是长期「跟你聊天」
  assert.deepEqual(overlaid, [{ label: '在手机上回你消息', ttl: 5 }]);
  assert.deepEqual(sent, ['在呢，怎么了？']);
});


test('记忆：他这句话勾起旧事，就拼进 prompt；没勾到就不加', async () => {
  const prompts = [];
  const recollection = {
    promptSection: async (text) =>
      String(text).includes('西瓜') ? '[你记得的事（以前留下的，不是他刚说的）]\n- 11/02 他说过：西瓜别放冰箱太久' : '',
  };
  const { bridge } = await setup({
    recollection,
    runner: {
      async run(prompt) {
        prompts.push(prompt);
        return { text: '记得，放桌上就行。', durationMs: 5 };
      },
    },
  });
  await bridge.handle({ ...baseMsg, id: 'm-mem-1', text: '西瓜还能放冰箱吗' });
  assert.match(prompts[0], /西瓜别放冰箱太久/);

  await bridge.handle({ ...baseMsg, id: 'm-mem-2', text: '今天好热' });
  assert.doesNotMatch(prompts[1], /西瓜别放冰箱太久/);
});


test('模型把【语音】写在句子中间：那三个字绝不能漏给爸爸', async () => {
  const { bridge, sent } = await setup({
    runner: {
      async run() {
        return { text: '感冒了人家可不管【语音】快去擦干。', durationMs: 5 };
      },
    },
  });
  await bridge.handle({ ...baseMsg, id: 'm-vmark' });
  assert.equal(sent.length, 1);
  assert.doesNotMatch(sent[0], /【语音】/);
  assert.match(sent[0], /感冒了人家可不管/);
});


test('她写了【吃了：…】：不发出去，记进饭账', async () => {
  const dishes = [];
  const { bridge, sent } = await setup({
    meals: { append: async (dish) => dishes.push(dish) },
    runner: {
      async run() {
        return { text: '刚吃完，撑。\n【吃了：火锅】', durationMs: 5 };
      },
    },
  });
  await bridge.handle({ ...baseMsg, id: 'm-meal' });
  assert.deepEqual(dishes, ['火锅']);
  assert.deepEqual(sent, ['刚吃完，撑。']);
  assert.doesNotMatch(sent[0], /吃了：/);
});

/* ── 他点名要语音时的破例（2026-11-04） ───────────────── */

test('他明确要语音时，不再被「离上一条不到 8 分钟」拦住', async () => {
  const voiceOut = {
    canSpeak: (_at, opts) => (opts?.force ? { ok: true, forced: true } : { ok: false, reason: '离上一条语音不到 8 分钟' }),
    speak: async () => ({ silk: Buffer.from([1, 2, 3, 4]), durationMs: 320 }),
  };
  const { bridge, voices, sent } = await setup({
    voiceOut,
    runner: { async run() { return { text: '【语音】爸爸晚安', durationMs: 5 }; } },
  });
  await bridge.handle({ ...baseMsg, id: 'v-force', text: '发条语音给我听听' });
  assert.equal(voices.length, 1);
  assert.equal(voices[0].text, '爸爸晚安');
  assert.equal(sent.some((line) => line.includes('爸爸晚安')), false);
});

test('没点名要语音时，间隔限制照旧：降级成文字', async () => {
  const voiceOut = {
    canSpeak: () => ({ ok: false, reason: '离上一条语音不到 8 分钟' }),
    speak: async () => ({ silk: Buffer.from([1]), durationMs: 100 }),
  };
  const { bridge, voices, sent } = await setup({
    voiceOut,
    runner: { async run() { return { text: '【语音】爸爸晚安', durationMs: 5 }; } },
  });
  await bridge.handle({ ...baseMsg, id: 'v-blocked', text: '今天好累' });
  assert.equal(voices.length, 0);
  assert.equal(sent.some((line) => line.includes('爸爸晚安')), true);
});

/* ── 她自己在聊天里写记忆（2026-11-04） ───────────────── */

test('【记住：…】不发给爸爸，写进记忆', async () => {
  const notes = [];
  const recollection = {
    async promptSection() { return ''; },
    async addNote(row) { notes.push(row); },
  };
  const { bridge, sent } = await setup({
    recollection,
    runner: { async run() { return { text: '好呀，记下了。\n【记住：爸爸喜欢我撒娇但是别太长】', durationMs: 5 }; } },
  });
  await bridge.handle({ ...baseMsg, id: 'note-1' });
  assert.equal(sent.some((line) => line.includes('【记住')), false);
  assert.ok(sent.some((line) => line.includes('记下了')));
  assert.equal(notes.length, 1);
  assert.match(notes[0].text, /爸爸喜欢我撒娇/);
});

test('聊天只临时标「在手机上回你消息」，别长期挂着聊天状态', async () => {
  const overlaid = [];
  const life = {
    async promptSection() { return ''; },
    async noteActivity() {},
    async overlayActivity(label, ttl) { overlaid.push({ label, ttl }); return { label }; },
  };
  const { bridge } = await setup({ life, runner: { async run() { return { text: '在呢', durationMs: 5 }; } } });
  await bridge.handle({ ...baseMsg, id: 'life-chat-1', text: '在干嘛' });
  await new Promise((r) => setTimeout(r, 50));
  assert.ok(overlaid.some((row) => /回你消息/.test(row.label)));
  const minTtl = Math.min(...overlaid.map((row) => row.ttl));
  assert.ok(minTtl >= 2 && minTtl <= 10, '临时状态挂几分钟就够，别挂成长期');
});

/* ── 她顺手记待办 / 划掉（2026-11-04） ───────────────── */

test('【待办：…】和【做完：…】不发给爸爸，写进她手上的事', async () => {
  const added = [];
  const closed = [];
  const agenda = {
    async add(row) { added.push(row); },
    async closeByText(text) { closed.push(text); },
    async promptSection() { return ''; },
  };
  const { bridge, sent } = await setup({
    agenda,
    runner: { async run() { return { text: '行，明天弄。\n【待办：把视频重剪一版】【做完：屋顶补檐角】', durationMs: 5 }; } },
  });
  await bridge.handle({ ...baseMsg, id: 'agenda-1' });
  assert.equal(sent.some((line) => line.includes('【')), false);
  assert.equal(added.length, 1);
  assert.match(added[0].text, /视频重剪/);
  assert.deepEqual(closed, ['屋顶补檐角']);
});

/* ── 她找机器人（2026-11-04） ───────────────── */

test('【找机器人：…】不发给爸爸，写进技术收件箱并提醒爸爸', async () => {
  const rows = [];
  const notices = [];
  const robotInbox = { async add(row) { rows.push(row); } };
  const { bridge, sent } = await setup({
    robotInbox,
    notifyRobotTask: (note) => notices.push(note),
    runner: { async run() { return { text: '好，我记下来了。\n【找机器人：剪视频脚本报错 ffmpeg 找不到】', durationMs: 5 }; } },
  });
  await bridge.handle({ ...baseMsg, id: 'robot-1' });
  assert.equal(sent.some((line) => line.includes('【')), false);
  assert.equal(rows.length, 1);
  assert.match(rows[0].text, /ffmpeg/);
  assert.equal(notices.length, 1);
  assert.match(notices[0], /ffmpeg/);
});

test('他只回一个词（晚上）：提示词里点明这是在接话，不是打招呼', async () => {
  const prompts = [];
  const { bridge } = await setup({
    runner: {
      async run(prompt) {
        prompts.push(prompt);
        return { text: '好，晚上给你端出来', durationMs: 5 };
      },
    },
  });
  await bridge.handle({ ...baseMsg, id: 'short-1', text: '晚上' });
  assert.match(prompts[0], /\[短消息\]/);
  assert.match(prompts[0], /不是打招呼/);
});
