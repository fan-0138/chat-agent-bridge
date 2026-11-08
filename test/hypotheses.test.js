import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHypotheses, parseGuessNotes, parseVerdictField, formatGuesses } from '../src/hypotheses.js';

const newStore = async () => {
  const root = await mkdtemp(join(tmpdir(), 'hypo-'));
  let clock = 1_800_000_000_000;
  const now = () => clock;
  const store = createHypotheses({ root, now, log: { info() {} } });
  return { root, store, tick: (ms) => (clock += ms), now };
};

test('猜想的标记能被抠出来，正文干净', () => {
  const { text, guesses } = parseGuessNotes('他在打游戏吧，键盘声都没了【猜：他这会儿在打游戏】');
  assert.equal(text, '他在打游戏吧，键盘声都没了');
  assert.deepEqual(guesses, ['他这会儿在打游戏']);
});

test('验证标记：对 / 不对都认，能带证据', () => {
  const a = parseGuessNotes('哦，那他确实在忙【验证：2 对：他刚回我了】');
  assert.equal(a.text, '哦，那他确实在忙');
  assert.deepEqual(a.verdicts, [{ index: 2, result: 'confirmed', evidence: '他刚回我了' }]);

  const b = parseGuessNotes('想岔了【验证：1 不对：他是去上班了】');
  assert.equal(b.verdicts[0].result, 'refuted');
  assert.equal(b.verdicts[0].evidence, '他是去上班了');
});

test('没有标记时正文原样返回', () => {
  const raw = '外面下雨，机柜的风扇声听着像海浪。';
  const { text, guesses, verdicts } = parseGuessNotes(raw);
  assert.equal(text, raw);
  assert.equal(guesses.length, 0);
  assert.equal(verdicts.length, 0);
});

test('猜想存起来：重复的不加，编号按时间稳定', async () => {
  const { store, tick } = await newStore();
  await store.add({ text: '他周末大概睡到下午' });
  tick(60_000);
  await store.add({ text: '他周末大概睡到下午' });
  await store.add({ text: '那条鲸鱼视频是他拍的' });

  const open = await store.listOpen();
  assert.equal(open.length, 2);
  assert.equal(open[0].text, '他周末大概睡到下午');
  assert.equal(open[1].text, '那条鲸鱼视频是他拍的');
  assert.ok(open[0].duplicate === undefined);
});

test('改判：按编号把 open 的猜想判成 confirmed / refuted', async () => {
  const { store } = await newStore();
  await store.add({ text: '他周末大概睡到下午' });
  await store.add({ text: '他今天不想说话' });

  const confirmed = await store.resolve({ index: 1, result: 'confirmed', evidence: '两点才回我' });
  assert.equal(confirmed.status, 'confirmed');
  assert.equal(confirmed.evidence, '两点才回我');

  const left = await store.listOpen();
  assert.equal(left.length, 1);
  assert.equal(left[0].text, '他今天不想说话', '改判过的就不再占编号');
});

test('改判越界不会炸', async () => {
  const { store } = await newStore();
  assert.equal(await store.resolve({ index: 9, result: 'confirmed' }), null);
});

test('拼进 prompt 的段落带编号，没有猜想就是空串', async () => {
  const { store } = await newStore();
  assert.equal(await store.promptSection(), '');
  await store.add({ text: '他周末大概睡到下午' });
  const text = await store.promptSection();
  assert.match(text, /1\. 他周末大概睡到下午/);
  assert.match(text, /还没验证的猜想/);
});

test('formatGuesses 会写「几天前猜的」', () => {
  const now = 1_800_000_000_000;
  const text = formatGuesses([{ at: now - 2 * 86_400_000, text: '他会睡到下午', status: 'open' }], { now });
  assert.match(text, /2 天前猜的/);
});

test('落盘：一条一行 JSON', async () => {
  const { store, root } = await newStore();
  await store.add({ text: '他周末大概睡到下午' });
  const raw = await readFile(join(root, 'data/mind/hypotheses.jsonl'), 'utf8');
  const rows = raw.trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, 'open');
  assert.match(rows[0].id, /^h/);
});

test('JSON 字段里的改判也能认', () => {
  assert.deepEqual(parseVerdictField('2 对：他刚回我了'), { index: 2, result: 'confirmed', evidence: '他刚回我了' });
  assert.deepEqual(parseVerdictField('3 不对：他是去上班了'), { index: 3, result: 'refuted', evidence: '他是去上班了' });
  assert.deepEqual(parseVerdictField('1 应验'), { index: 1, result: 'confirmed', evidence: '' });
  assert.equal(parseVerdictField('不知道'), null);
  assert.equal(parseVerdictField(''), null);
});
