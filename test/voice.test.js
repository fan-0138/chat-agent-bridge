import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  normalizeRule,
  ruleKey,
  parseVoice,
  formatVoice,
  renderVoice,
  detectFeedback,
  createVoice,
} from '../src/voice.js';
import { audit, repliesFromMemory, formatAudit } from '../src/voice-audit.js';

const silent = { info() {}, warn() {}, error() {}, debug() {} };

test('说话笔记：normalizeRule 去引导词/剥成对引号/压空格', () => {
  assert.equal(normalizeRule('- 别用唔开头'), '别用唔开头');
  assert.equal(normalizeRule('记住：别老说唔'), '别老说唔');
  assert.equal(normalizeRule('「知道了，马上弄」'), '知道了，马上弄');
  // 只剥成对的最外层引号，里面的「主人」不能被拆
  assert.equal(normalizeRule('「主人」一条里最多叫一次'), '「主人」一条里最多叫一次');
  assert.equal(normalizeRule('  别   啰嗦  '), '别 啰嗦');
  assert.equal(normalizeRule(''), '');
  assert.equal([...normalizeRule('啊'.repeat(200))].length, 80);
});

test('说话笔记：ruleKey 忽略标点空格', () => {
  assert.equal(ruleKey('别，老说「唔」！'), ruleKey('别老说唔'));
  assert.notEqual(ruleKey('别老说唔'), ruleKey('别老说嗯'));
});

test('说话笔记：parseVoice 按三个区收条目', () => {
  const md = `# 标题

## 主人定的规矩
- 别用唔开头
1. 别分段
<!-- 注释不该进来 -->

## 主人认可的说法
- 「知道了」

## 我自己想这么说话
- 先答再解释
`;
  assert.deepEqual(parseVoice(md), {
    rules: ['别用唔开头', '别分段'],
    examples: ['知道了'],
    own: ['先答再解释'],
  });
});

test('说话笔记：formatVoice 与 parseVoice 能往返', () => {
  const data = {
    rules: ['别用唔开头', '别分段'],
    examples: ['知道了，马上弄'],
    own: ['不懂就说不懂'],
  };
  assert.deepEqual(parseVoice(formatVoice(data)), data);
  // 空文件也要能解析成空数组
  assert.deepEqual(parseVoice(formatVoice({})), { rules: [], examples: [], own: [] });
});

test('说话笔记：renderVoice 带上「优先于人设正文」，空内容不占位', () => {
  const text = renderVoice({ rules: ['别用唔开头'], examples: ['知道了'], own: ['先答再说'] });
  assert.match(text, /比人设正文里的说话方式优先/);
  assert.match(text, /- 别用唔开头/);
  assert.match(text, /「知道了」/);
  assert.match(text, /- 先答再说/);
  assert.equal(renderVoice({}), '');
});

test('识别主人是不是在教她说话', () => {
  assert.deepEqual(detectFeedback('#说话 别老说唔'), { kind: 'rule', value: '别老说唔' });
  assert.deepEqual(detectFeedback('#说法 知道了，马上弄'), { kind: 'example', value: '知道了，马上弄' });
  assert.deepEqual(detectFeedback('别老用「唔」开头'), { kind: 'rule', value: '别老用「唔」开头' });
  assert.deepEqual(detectFeedback('你说话别这么啰嗦'), { kind: 'rule', value: '你说话别这么啰嗦' });
  assert.deepEqual(detectFeedback('以后你就说「嗯」'), { kind: 'example', value: '嗯' });

  // 不相干的别乱记
  assert.equal(detectFeedback('别熬夜'), null);
  assert.equal(detectFeedback('你要不要刷会儿抖音'), null);
  assert.equal(detectFeedback('晚安'), null);
  assert.equal(detectFeedback('#说话'), null);
  // 太长的不自动记，交给她自己判断
  assert.equal(detectFeedback(`说话${'别'.repeat(90)}`), null);
});

test('说话笔记：add/去重/上限/删除', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'voice-'));
  const file = join(dir, 'voice.md');
  const voice = createVoice({ file, log: silent });

  assert.equal((await voice.load()).text, '');
  assert.equal((await voice.add('rule', '别用唔开头')).added, true);
  // 换个标点也算重复
  assert.equal((await voice.add('rule', '别，用唔开头！')).added, false);
  assert.equal((await voice.add('example', '知道了')).added, true);
  assert.equal((await voice.add('own', '先答再解释')).added, true);

  const data = await voice.list();
  assert.deepEqual(data, { rules: ['别用唔开头'], examples: ['知道了'], own: ['先答再解释'] });

  // 上限 12 条，最旧的先丢
  for (let i = 0; i < 15; i += 1) await voice.add('rule', `规矩${i}`);
  const trimmed = await voice.list();
  assert.equal(trimmed.rules.length, 12);
  assert.equal(trimmed.rules.at(-1), '规矩14');

  const removed = await voice.remove(1);
  assert.equal(removed.removed, true);
  // 15 条里最旧的 3 条已经被挤掉了，第 1 条是「规矩3」
  assert.equal(removed.value, '规矩3');
  assert.equal((await voice.list()).rules.includes('规矩3'), false);

  // 落盘的文件能被重新解析（热加载用）
  assert.deepEqual(parseVoice(await readFile(file, 'utf8')), await voice.list());
});

test('说话笔记：capture 认出纠正就写进去', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'voice-'));
  const voice = createVoice({ file: join(dir, 'voice.md'), log: silent });
  const result = await voice.capture('你说话别老带emoji');
  assert.equal(result.added, true);
  assert.equal((await voice.list()).rules.length, 1);
  assert.equal(await voice.capture('今天吃什么'), null);
});

test('人味分：全是人设腔的句子分数很低', () => {
  const theatrical = Array.from(
    { length: 10 },
    () => '唔……本鲸的尾巴都拍地上了，整个机房都在抖🍚\n\n哼，才不是想你呢😤',
  );
  const report = audit(theatrical);
  assert.ok(report.score < 55, `分数应偏低，实际 ${report.score}`);
  assert.ok(report.penalties.some((item) => item.label === '开头语气词'));
  assert.ok(report.penalties.some((item) => item.label === '道具旁白'));
  assert.ok(report.metrics.openerRate > 0.9);
});

test('人味分：正常短句分数很高', () => {
  const plain = [
    '知道了，我等下就弄，别催',
    '这事我没做过，得先试试看',
    '行吧，你说什么都对',
    '饿了，你吃了没',
    '等我十分钟',
  ];
  const report = audit(plain);
  assert.ok(report.score >= 85, `分数应偏高，实际 ${report.score}`);
  assert.equal(report.metrics.propsRate, 0);
  assert.equal(report.metrics.openerRate, 0);
});

test('人味分：只统计她说的话，报告有人话摘要', () => {
  const rows = [
    { role: 'user', text: '你好' },
    { role: 'assistant', text: '在呢' },
    { role: 'assistant', text: '' },
    { role: 'user', text: '干嘛' },
  ];
  assert.deepEqual(repliesFromMemory(rows), ['在呢']);
  const formatted = formatAudit(audit(['在呢']), { limit: 2 });
  assert.match(formatted, /人味分 \d+\/100/);
  assert.match(formatAudit(audit([])), /没有可分析/);
});