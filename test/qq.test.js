import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocketServer } from 'ws';
import { createBridge } from '../src/bridge.js';
import { createMemory } from '../src/memory.js';
import { KeyedQueue } from '../src/queue.js';
import { buildPrompt } from '../src/prompt.js';
import { loadQqConfig } from '../src/config-qq.js';
import { createRateLimiter, extractText, normalizeEvent, startOneBot } from '../src/transport-onebot.js';

const silentLog = { debug() {}, info() {}, warn() {}, error() {} };
const SELF = '10000';

const text = (value) => ({ type: 'text', data: { text: value } });
const at = (qq) => ({ type: 'at', data: { qq: String(qq) } });

const groupEvent = (overrides = {}) => ({
  post_type: 'message',
  message_type: 'group',
  sub_type: 'normal',
  self_id: Number(SELF),
  group_id: 555555,
  user_id: 10002,
  message_id: 1,
  message: [text('你好')],
  sender: { user_id: 10002, nickname: '群友', card: '群里的小明' },
  ...overrides,
});

const privateEvent = (overrides = {}) => ({
  post_type: 'message',
  message_type: 'private',
  sub_type: 'friend',
  self_id: Number(SELF),
  user_id: 10001,
  message_id: 2,
  message: [text('你好')],
  sender: { user_id: 10001, nickname: '我' },
  ...overrides,
});

/* ── 事件归一化 ────────────────────────────────────────── */

test('私聊：正常归一化，记忆键是 private_<qq>', () => {
  const msg = normalizeEvent(privateEvent(), { selfId: SELF });
  assert.equal(msg.type, 'text');
  assert.equal(msg.senderId, '10001');
  assert.equal(msg.text, '你好');
  assert.equal(msg.conversationId, 'private_10001');
  assert.equal(msg.groupId, undefined);
});

test('私聊：群临时会话（sub_type=group）直接忽略', () => {
  const msg = normalizeEvent(privateEvent({ sub_type: 'group' }), { selfId: SELF });
  assert.equal(msg, null);
});

test('自己发的消息不回环', () => {
  assert.equal(normalizeEvent(privateEvent({ user_id: 10000 }), { selfId: SELF }), null);
});

test('群消息：不在白名单的群一个字节都不回', () => {
  const msg = normalizeEvent(groupEvent(), { selfId: SELF, groupAllowList: ['666666'], groupPrefix: '/ai' });
  assert.equal(msg, null);
});

test('群消息：白名单群里没 @ 也没前缀 -> 忽略', () => {
  const msg = normalizeEvent(groupEvent(), { selfId: SELF, groupAllowList: ['555555'], groupPrefix: '/ai' });
  assert.equal(msg, null);
});

test('群消息：@我 触发，@ 片段不会进 prompt', () => {
  const msg = normalizeEvent(groupEvent({ message: [at(SELF), text(' 帮我看下磁盘')] }), {
    selfId: SELF,
    groupAllowList: ['555555'],
    groupPrefix: '/ai',
    groupNames: new Map([['555555', '我的私人群']]),
  });
  assert.equal(msg.text, '帮我看下磁盘');
  assert.equal(msg.groupId, '555555');
  assert.equal(msg.roomName, '我的私人群');
  assert.equal(msg.conversationId, 'group_555555');
  assert.ok(!msg.text.includes('@'));
});

test('群消息：前缀触发并剥掉前缀', () => {
  const msg = normalizeEvent(groupEvent({ message: [text('/ai 你好')] }), {
    selfId: SELF,
    groupAllowList: ['555555'],
    groupPrefix: '/ai',
  });
  assert.equal(msg.text, '你好');
});

test('群消息：@别人不算触发', () => {
  const msg = normalizeEvent(groupEvent({ message: [at('10009'), text(' 你说的对')] }), {
    selfId: SELF,
    groupAllowList: ['555555'],
    groupPrefix: '/ai',
  });
  assert.equal(msg, null);
});

test('图片消息归一化成 media，并带下载地址', () => {
  const msg = normalizeEvent(
    privateEvent({ message: [{ type: 'image', data: { url: 'https://example.com/a.png', file: 'a.png' } }] }),
    { selfId: SELF },
  );
  assert.equal(msg.type, 'media');
  assert.equal(msg.image.url, 'https://example.com/a.png');
});

test('extractText：数组和 CQ 字符串都能处理', () => {
  const fromArray = extractText([text('a'), at('10009'), text('b')], SELF);
  assert.equal(fromArray.text, 'a@10009 b');
  assert.equal(fromArray.atSelf, false);

  const fromString = extractText('[CQ:at,qq=10000] 帮我看看', SELF);
  assert.equal(fromString.atSelf, true);
  assert.equal(fromString.text, '帮我看看');
});

/* ── 限流 ──────────────────────────────────────────────── */

test('限流：每群每分钟上限，超出直接拒绝且不影响别的群', () => {
  let clock = 1_000_000;
  const limiter = createRateLimiter({ perGroupMinute: 2, perUserHour: 100, globalMinute: 100, now: () => clock });
  const hit = () => limiter.check({ userId: '10002', groupId: '555555' });

  assert.equal(hit().ok, true);
  limiter.record({ userId: '10002', groupId: '555555' });
  assert.equal(hit().ok, true);
  limiter.record({ userId: '10002', groupId: '555555' });

  const blocked = hit();
  assert.equal(blocked.ok, false);
  assert.match(blocked.reason, /该群 2 条\/分钟/);

  // 另一个群不受影响
  assert.equal(limiter.check({ userId: '10002', groupId: '777777' }).ok, true);

  // 61 秒后窗口滑过
  clock += 61_000;
  assert.equal(hit().ok, true);
});

test('限流：每人每小时上限', () => {
  let clock = 0;
  const limiter = createRateLimiter({ perUserHour: 1, perGroupMinute: 100, globalMinute: 100, now: () => clock });
  limiter.record({ userId: '10002', groupId: '555555' });
  assert.equal(limiter.check({ userId: '10002', groupId: '999999' }).ok, false);
  assert.equal(limiter.check({ userId: '10003', groupId: '999999' }).ok, true);
});

/* ── 配置 ──────────────────────────────────────────────── */

test('QQ 配置：默认保守档，没白名单会报问题', () => {
  const config = loadQqConfig({});
  assert.equal(config.channel, 'qq');
  assert.equal(config.dryRun, false);
  assert.equal(config.ratePerGroupMin, 5);
  assert.equal(config.replyDelayMinMs, 600);
  assert.equal(config.allowUnknown, false);
  assert.ok(config.problems.some((p) => p.includes('QQ_ALLOW_LIST')));
});

test('QQ 配置：指到非本机地址会被警告', () => {
  const config = loadQqConfig({ QQ_ALLOW_LIST: '10001', QQ_WS_URL: 'ws://10.0.0.2:3001' });
  assert.ok(config.problems.some((p) => p.includes('非本机地址')));
});

test('QQ 配置：正常配置无问题项，且支持 dry-run', () => {
  const config = loadQqConfig({
    QQ_ALLOW_LIST: '10001, 10002',
    QQ_GROUP_ALLOW_LIST: '555555',
    QQ_DRY_RUN: '1',
    QQ_REPLY_DELAY_MIN_MS: '10',
  });
  assert.deepEqual(config.problems, []);
  assert.equal(config.dryRun, true);
  assert.deepEqual(config.allowList, ['10001', '10002']);
  assert.deepEqual(config.groupAllowList, ['555555']);
  assert.equal(config.replyDelayMinMs, 10);
});

/* ── prompt 与记忆 ─────────────────────────────────────── */

test('QQ 渠道 prompt 讲的是 QQ，不是微信', () => {
  const prompt = buildPrompt({ history: [], text: '在吗', senderName: '小明', channel: 'qq', roomName: '我的私人群' });
  assert.match(prompt, /QQ/);
  assert.ok(!prompt.includes('微信'));
  assert.match(prompt, /群聊「我的私人群」/);
});

test('群聊记忆按群隔离，而不是按发言人混在一起', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'qq-mem-'));
  const memory = createMemory({ dir, maxTurns: 4, maxChars: 2000, log: silentLog });
  const sent = [];
  const bridge = createBridge({
    config: { allowList: ['10002'], allowUnknown: false, replyAck: false, ackDelayMs: 10, maxReplyChars: 100, channel: 'qq' },
    runner: { async run() { return { text: 'ok', durationMs: 1 }; } },
    memory,
    queue: new KeyedQueue({ globalConcurrency: 2 }),
    log: silentLog,
    reply: async (msg, body) => sent.push({ msg, body }),
  });

  await bridge.handle({
    type: 'text',
    id: 'g1',
    text: '你好',
    senderId: '10002',
    senderName: '小明',
    isSelf: false,
    groupId: '555555',
    conversationId: 'group_555555',
  });

  const files = await readdir(dir);
  assert.ok(files.includes('user_group_555555.jsonl'), `实际文件：${files.join(',')}`);
  const raw = await readFile(join(dir, 'user_group_555555.jsonl'), 'utf8');
  assert.match(raw, /你好/);
  // 回复要带回群上下文，传输层才发得出群消息
  assert.equal(sent[0].msg.groupId, '555555');
});

/* ── 与 NapCat 的集成（本地假 OneBot 服务端）──────────────── */

async function startFakeNapCat({ failSend = false } = {}) {
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  // 必须等 listening 之后 address() 才有端口
  await new Promise((resolve, reject) => {
    wss.once('listening', resolve);
    wss.once('error', reject);
  });
  const actions = [];
  /** @type {Set<any>} */
  const clients = new Set();

  wss.on('connection', (socket) => {
    clients.add(socket);
    socket.on('close', () => clients.delete(socket));
    socket.on('message', (raw) => {
      const frame = JSON.parse(raw.toString('utf8'));
      actions.push({ action: frame.action, params: frame.params });
      const reply = (data) => socket.send(JSON.stringify({ status: 'ok', retcode: 0, data, echo: frame.echo }));

      if (frame.action === 'get_login_info') reply({ user_id: 10000, nickname: '测试机器人' });
      else if (frame.action === 'get_group_list') reply([{ group_id: 555555, group_name: '我的私人群' }]);
      else if (failSend) socket.send(JSON.stringify({ status: 'failed', retcode: 100, data: null, echo: frame.echo }));
      else reply({ message_id: 1 });
    });
  });

  const port = wss.address().port;
  return {
    wss,
    actions,
    url: `ws://127.0.0.1:${port}`,
    emit(event) {
      const payload = JSON.stringify(event);
      for (const socket of clients) socket.send(payload);
    },
  };
}

function transportConfig(overrides = {}) {
  return {
    wsUrl: 'ws://127.0.0.1:1',
    wsToken: '',
    selfId: '',
    groupAllowList: ['555555'],
    groupPrefix: '/ai',
    allowList: ['10001'],
    dryRun: false,
    replyDelayMinMs: 1,
    replyDelayMaxMs: 3,
    ratePerGroupMin: 2,
    ratePerUserHour: 100,
    rateGlobalMin: 100,
    rateOutMin: 100,
    sendFailBreaker: 2,
    maxReconnect: 1,
    maxMediaBytes: 1024 * 1024,
    dataDir: '/tmp/qq-test',
    auditFile: '/tmp/qq-test/audit.jsonl',
    ...overrides,
  };
}

async function waitFor(predicate, timeoutMs = 3_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return false;
}

test('集成：连上 NapCat，群里 @我 -> 发送 send_group_msg 到对应群', async () => {
  const fake = await startFakeNapCat();
  const received = [];
  const transport = await startOneBot({
    config: transportConfig({ wsUrl: fake.url }),
    log: silentLog,
    onMessage: async (msg) => {
      received.push(msg);
      await transport.reply(msg, '这是一条回复');
    },
  });

  try {
    assert.ok(await waitFor(() => transport.stats().connected), '应该连上');
    assert.ok(await waitFor(() => transport.stats().selfId === '10000'), '应该读到登录号');

    fake.emit(
      groupEvent({
        message_id: 42,
        message: [at(SELF), text(' 帮我看下磁盘')],
      }),
    );

    assert.ok(await waitFor(() => fake.actions.some((a) => a.action === 'send_group_msg')), '应该发出群消息');
    const send = fake.actions.find((a) => a.action === 'send_group_msg');
    assert.equal(send.params.group_id, 555555);
    assert.equal(send.params.message, '这是一条回复');
    assert.equal(received[0].conversationId, 'group_555555');
  } finally {
    await transport.stop();
    await new Promise((resolve) => fake.wss.close(resolve));
  }
});

test('集成：群里没触发就不发任何消息', async () => {
  const fake = await startFakeNapCat();
  const transport = await startOneBot({
    config: transportConfig({ wsUrl: fake.url }),
    log: silentLog,
    onMessage: async (msg) => transport.reply(msg, '不该发'),
  });

  try {
    assert.ok(await waitFor(() => transport.stats().connected));
    fake.emit(groupEvent({ message: [text('今天天气不错')] }));
    fake.emit(groupEvent({ message: [at('10009'), text(' 对')] }));
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(fake.actions.filter((a) => a.action.startsWith('send')).length, 0);
  } finally {
    await transport.stop();
    await new Promise((resolve) => fake.wss.close(resolve));
  }
});

test('集成：限流生效，同群超过上限的消息不回', async () => {
  const fake = await startFakeNapCat();
  const transport = await startOneBot({
    config: transportConfig({ wsUrl: fake.url, ratePerGroupMin: 2 }),
    log: silentLog,
    onMessage: async (msg) => transport.reply(msg, '回复'),
  });

  try {
    assert.ok(await waitFor(() => transport.stats().connected));
    for (let i = 0; i < 5; i += 1) {
      fake.emit(groupEvent({ message_id: 100 + i, message: [at(SELF), text(` 第 ${i} 条`)] }));
    }
    assert.ok(await waitFor(() => fake.actions.filter((a) => a.action === 'send_group_msg').length >= 2));
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.equal(fake.actions.filter((a) => a.action === 'send_group_msg').length, 2, '第 3 条起应被限流');
    assert.equal(transport.stats().dropped >= 3, true, '应记录丢弃数');
  } finally {
    await transport.stop();
    await new Promise((resolve) => fake.wss.close(resolve));
  }
});

test('集成：dry-run 时只记录不发送', async () => {
  const fake = await startFakeNapCat();
  const transport = await startOneBot({
    config: transportConfig({ wsUrl: fake.url, dryRun: true }),
    log: silentLog,
    onMessage: async (msg) => transport.reply(msg, '只记录不发送'),
  });

  try {
    assert.ok(await waitFor(() => transport.stats().connected));
    fake.emit(groupEvent({ message: [at(SELF), text(' 测试')] }));
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(fake.actions.filter((a) => a.action.startsWith('send')).length, 0);
    assert.equal(transport.stats().outbound, 0);
  } finally {
    await transport.stop();
    await new Promise((resolve) => fake.wss.close(resolve));
  }
});

test('集成：连续发送失败触发熔断，之后不再尝试', async () => {
  const fake = await startFakeNapCat({ failSend: true });
  const transport = await startOneBot({
    config: transportConfig({ wsUrl: fake.url, sendFailBreaker: 2, ratePerGroupMin: 100 }),
    log: silentLog,
    onMessage: async (msg) => {
      await transport.reply(msg, '会失败').catch(() => {});
    },
  });

  try {
    assert.ok(await waitFor(() => transport.stats().connected));
    fake.emit(groupEvent({ message_id: 201, message: [at(SELF), text(' 一')] }));
    fake.emit(groupEvent({ message_id: 202, message: [at(SELF), text(' 二')] }));
    assert.ok(await waitFor(() => transport.stats().breakerOpen), '两次失败后应熔断');
    const countBefore = fake.actions.filter((a) => a.action === 'send_group_msg').length;

    fake.emit(groupEvent({ message_id: 203, message: [at(SELF), text(' 三')] }));
    await new Promise((resolve) => setTimeout(resolve, 300));
    const countAfter = fake.actions.filter((a) => a.action === 'send_group_msg').length;
    assert.equal(countAfter, countBefore, '熔断后不应再发');
  } finally {
    await transport.stop();
    await new Promise((resolve) => fake.wss.close(resolve));
  }
});
/* ── 配置向导模式（首次接入自动识别自己的 QQ/群号）───────── */

test('配置向导：未白名单的群消息也会被归一化（只为记录群号）', () => {
  const msg = normalizeEvent(groupEvent(), {
    selfId: SELF,
    groupAllowList: [],
    groupPrefix: '/ai',
    setupMode: true,
  });
  assert.ok(msg);
  assert.equal(msg.groupId, '555555');
});

test('集成：配置向导只打印 ID，不回复、不调模型', async () => {
  const fake = await startFakeNapCat();
  const warns = [];
  const log = { ...silentLog, warn: (message) => warns.push(String(message)) };
  let called = 0;
  const transport = await startOneBot({
    config: transportConfig({ wsUrl: fake.url, setupMode: true, allowList: [] }),
    log,
    onMessage: async () => {
      called += 1;
    },
  });

  try {
    assert.ok(await waitFor(() => transport.stats().connected));
    fake.emit(
      privateEvent({ message_id: 777, user_id: 20001, message: [{ type: 'text', data: { text: 'hi' } }] }),
    );
    assert.ok(await waitFor(() => warns.some((w) => w.includes('SETUP_DETECTED=20001'))), '应打印检测到的 QQ');
    assert.equal(called, 0, '向导模式不应调模型');
    assert.equal(fake.actions.filter((a) => a.action.startsWith('send')).length, 0, '向导模式不应发送');
  } finally {
    await transport.stop();
    await new Promise((resolve) => fake.wss.close(resolve));
  }
});
