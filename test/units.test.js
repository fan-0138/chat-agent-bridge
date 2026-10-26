import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMemory } from '../src/memory.js';
import { splitBubbles, splitReply } from '../src/split.js';
import { KeyedQueue } from '../src/queue.js';
import { buildPrompt } from '../src/prompt.js';
import { isTaskMessage } from '../src/classify.js';

const silentLog = { debug() {}, info() {}, warn() {}, error() {} };

test('记忆写入后能读回，并按 maxChars 截断', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mem-'));
  const memory = createMemory({ dir, maxTurns: 3, maxChars: 120, log: silentLog });

  await memory.append('user_a', 'user', '第一条');
  await memory.append('user_a', 'assistant', '第一条回复');
  await memory.append('user_b', 'user', '别人的消息');

  const a = await memory.load('user_a');
  assert.deepEqual(a.map((e) => e.text), ['第一条', '第一条回复']);
  const b = await memory.load('user_b');
  assert.equal(b.length, 1);

  const raw = await readFile(join(dir, 'user_a.jsonl'), 'utf8');
  assert.match(raw, /第一条回复/);
});

test('切分长消息，且代码围栏保持闭合', () => {
  const body = ['说明：', '```js', 'const a = 1;', '```', '', '结束'].join('\n');
  const chunks = splitReply(body, 25);
  assert.ok(chunks.length >= 2);
  for (const chunk of chunks) {
    const fences = chunk.match(/```/g)?.length ?? 0;
    assert.equal(fences % 2, 0, `围栏未闭合: ${chunk}`);
  }
});

test('短消息不切分', () => {
  assert.deepEqual(splitReply('你好', 100), ['你好']);
});

test('排队：同一 key 串行，不同 key 并行', async () => {
  const queue = new KeyedQueue({ globalConcurrency: 4, perKeyConcurrency: 1 });
  const order = [];
  let concurrentInSameKey = 0;

  const task = (key, ms) =>
    queue.push(key, async () => {
      if (key === 'a') concurrentInSameKey += 1;
      await new Promise((r) => setTimeout(r, ms));
      if (key === 'a') concurrentInSameKey -= 1;
      order.push(key);
    });

  await Promise.all([task('a', 30), task('a', 10), task('b', 10)]);
  assert.equal(concurrentInSameKey, 0);
  assert.equal(order.length, 3);
  assert.equal(order.filter((k) => k === 'a').length, 2);
});

test('prompt 把人设放在渠道要求之前', () => {
  const prompt = buildPrompt({
    persona: '你叫小鲸，说话有点俏皮。',
    history: [],
    text: '在吗',
    senderName: '张三',
  });
  assert.match(prompt, /\[你是谁\]/);
  assert.match(prompt, /小鲸/);
  assert.ok(prompt.indexOf('小鲸') < prompt.indexOf('[渠道]'), '人设应在渠道规则之前');
});

test('没有提供人设时不注入空段落', () => {
  const prompt = buildPrompt({ history: [], text: '你好', senderName: '张三' });
  assert.ok(!prompt.includes('[你是谁]'));
});

test('prompt 包含渠道要求、历史与当前消息', () => {
  const prompt = buildPrompt({
    history: [{ role: 'user', text: '在吗' }, { role: 'assistant', text: '在' }],
    text: '帮我看下 git 状态',
    senderName: '张三',
  });
  assert.match(prompt, /微信/);
  assert.match(prompt, /历史对话/);
  // 对方只回一个字时别当成新对话开场（「在。什么事」那种）
  assert.match(prompt, /紧接着的上一轮/);
  assert.match(prompt, /别问「在。什么事」/);
  assert.match(prompt, /帮我看下 git 状态/);
  assert.match(prompt, /张三/);
});

test('多气泡：短回复不切，长回复切成不超过 3 条且内容不丢', () => {
  assert.deepEqual(splitBubbles('唔，在。', { maxLen: 90 }), ['唔，在。']);

  const long = '主人你回来啦。人家刚刷到一个视频好好笑。还有那个饭饭呢，本鲸饿了。快点快点。';
  const bubbles = splitBubbles(long, { maxLen: 18, maxBubbles: 3 });
  assert.ok(bubbles.length >= 2 && bubbles.length <= 3, `气泡数 ${bubbles.length}`);
  assert.equal(bubbles.join(''), long, '切分不应丢字');
});

test('多气泡：代码块整条发，不切', () => {
  const code = '给你改了：\n```js\nconst a = 1;\n```\n跑一下看看。';
  assert.deepEqual(splitBubbles(code, { maxLen: 10 }), [code]);
});

test('多气泡：碎片会并进上一条，避免刷屏', () => {
  const text = '第一句在这里。唔。第三句话也在这里。';
  const bubbles = splitBubbles(text, { maxLen: 10, maxBubbles: 5 });
  assert.ok(bubbles.every((b) => b.length >= 8), `有碎片: ${JSON.stringify(bubbles)}`);
});

test('prompt：说话方式紧跟人设，且明确「人设不是台词本」', () => {
  const prompt = buildPrompt({
    persona: '你是小鲸。',
    voice: '[你的说话方式·主人定的规矩]\n- 别用唔开头',
    history: [],
    text: '在吗',
    senderName: '主人',
  });
  assert.match(prompt, /不是台词本/);
  assert.ok(prompt.indexOf('别用唔开头') < prompt.indexOf('[渠道]'), '说话方式应在渠道规则之前');
  assert.ok(prompt.indexOf('你是小鲸') < prompt.indexOf('别用唔开头'), '说话方式应在身份之后');
});

test('聊天和干活的判定：聊天走短超时', () => {
  assert.equal(isTaskMessage('在吗'), false);
  assert.equal(isTaskMessage('今天好累啊，想睡觉'), false);
  assert.equal(isTaskMessage('你抖音咋不回我消息，宝贝'), false);
  assert.equal(isTaskMessage('哈哈哈'), false);
  assert.equal(isTaskMessage(''), false);

  assert.equal(isTaskMessage('帮我查一下昨天的日志'), true);
  assert.equal(isTaskMessage('git status 看一下'), true);
  assert.equal(isTaskMessage('把这个脚本改一下'), true);
  assert.equal(isTaskMessage('```js\nconsole.log(1)\n```'), true);
  assert.equal(isTaskMessage('你去看一下那个报错'), true);
});

test('「你去试试吧」「为什么卡住了」要算干活（否则只给 60 秒必然超时）', () => {
  // 主人原话：明明是要她动手，以前全被判成聊天
  assert.equal(isTaskMessage('你去试试吧'), true);
  assert.equal(isTaskMessage('为什么卡住了，告诉我，我去修'), true);
  assert.equal(isTaskMessage('为什么卡住了'), true);
  assert.equal(isTaskMessage('卡住了'), true);
  assert.equal(isTaskMessage('抖音那边怎么没反应'), true);
  assert.equal(isTaskMessage('你再试试看'), true);

  // 但别把闲聊也拉进来
  assert.equal(isTaskMessage('我挂了'), false);
  assert.equal(isTaskMessage('为什么你老是不理我'), false);
  assert.equal(isTaskMessage('看看你这个笨蛋'), false);
  assert.equal(isTaskMessage('晚安'), false);
});

test('「找点表情包存一下」算干活，不算闲聊', () => {
  assert.equal(isTaskMessage('不会，在网上找点鲸鱼娘的表情包存一下，可以发给我看'), true);
  assert.equal(isTaskMessage('帮我找找蓝鲸贴纸'), true);
  assert.equal(isTaskMessage('下载几张图片'), true);
  assert.equal(isTaskMessage('这个搜一下'), true);
  assert.equal(isTaskMessage('哈哈哈，无聊或者找我的时候你也可以用这个哦'), false);
});
