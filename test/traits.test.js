import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TRAITS, DEFAULTS, clampLevel, normalizeTraits, renderTraits, summarizeTraits } from '../src/traits.js';
import { createPersona, MAX_CHARS } from '../src/persona.js';

const silent = { info() {}, warn() {}, error() {}, debug() {} };

test('性格刻度：每个刻度都有 0-5 共 6 档描述', () => {
  for (const [key, trait] of Object.entries(TRAITS)) {
    assert.equal(trait.levels.length, 6, `${key} 档位不对`);
    assert.ok(trait.label.length > 0);
    for (const level of trait.levels) assert.ok(level.length >= 6, `${key} 有档位描述太短`);
  }
});

test('性格刻度：默认值覆盖全部刻度且在合法范围内', () => {
  assert.deepEqual(Object.keys(DEFAULTS).sort(), Object.keys(TRAITS).sort());
  for (const value of Object.values(DEFAULTS)) {
    assert.ok(Number.isInteger(value) && value >= 0 && value <= 5);
  }
});

test('性格刻度：clampLevel 夹紧越界并拒绝非法值', () => {
  assert.equal(clampLevel(9), 5);
  assert.equal(clampLevel(-3), 0);
  assert.equal(clampLevel(2.6), 3);
  assert.equal(clampLevel('4'), 4);
  assert.equal(clampLevel('abc'), null);
  assert.equal(clampLevel(null), null);
  assert.equal(clampLevel(undefined), null);
});

test('性格刻度：normalizeTraits 丢未知键、夹越界、非法回落默认', () => {
  const cleaned = normalizeTraits({ tsundere: 9, cute: -2, snark: 'x', 未知刻度: 5, talk: 1 });
  assert.equal(cleaned.tsundere, 5);
  assert.equal(cleaned.cute, 0);
  assert.equal(cleaned.snark, DEFAULTS.snark);
  assert.equal(cleaned.talk, 1);
  assert.equal('未知刻度' in cleaned, false);
  assert.deepEqual(Object.keys(cleaned).sort(), Object.keys(TRAITS).sort());
});

test('性格刻度：空输入回落到全部默认值', () => {
  assert.deepEqual(normalizeTraits(null), { ...DEFAULTS });
  assert.deepEqual(normalizeTraits('nope'), { ...DEFAULTS });
  assert.deepEqual(normalizeTraits([]), { ...DEFAULTS });
});

test('性格刻度：渲染结果包含每个刻度的档位描述', () => {
  const text = renderTraits({ tsundere: 5, cute: 0, snark: 2 });
  assert.match(text, /\[性格刻度\]/);
  assert.match(text, /傲娇 5\/5：嘴上全是刺/);
  assert.match(text, /撒娇 0\/5：不撒娇/);
  assert.match(text, /毒舌 2\/5/);
  for (const trait of Object.values(TRAITS)) assert.match(text, new RegExp(trait.label));
});

test('性格刻度：摘要是一行可读文本', () => {
  const summary = summarizeTraits(DEFAULTS);
  assert.match(summary, /傲娇3/);
  assert.match(summary, /憨3/);
  assert.ok(!summary.includes('\n'));
});

test('人设拼接：正文 + 刻度，且正文缺席时不硬塞刻度', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'persona-'));
  const personaFile = join(dir, 'persona.md');
  const traitsFile = join(dir, 'persona.traits.json');
  await writeFile(personaFile, '你是测试角色。', 'utf8');
  await writeFile(traitsFile, JSON.stringify({ tsundere: 5, cute: 0 }), 'utf8');

  const persona = createPersona({ file: personaFile, traitsFile, log: silent });
  const text = await persona();
  assert.match(text, /你是测试角色/);
  assert.match(text, /\[性格刻度\]/);
  assert.match(text, /傲娇 5\/5/);
  assert.ok(text.indexOf('你是测试角色') < text.indexOf('[性格刻度]'), '正文要在刻度前面');

  // 正文文件不存在 => 返回空串，不要只剩刻度
  const ghost = createPersona({ file: join(dir, 'nope.md'), traitsFile, log: silent });
  assert.equal(await ghost(), '');
});

test('人设拼接：刻度文件缺失时用默认值，不报错', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'persona-'));
  const personaFile = join(dir, 'persona.md');
  await writeFile(personaFile, '你是测试角色。', 'utf8');

  const persona = createPersona({ file: personaFile, traitsFile: join(dir, 'missing.json'), log: silent });
  const text = await persona();
  assert.match(text, /傲娇 3\/5/);
});

test('人设拼接：改了刻度文件，下一次调用就变（热加载）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'persona-'));
  const personaFile = join(dir, 'persona.md');
  const traitsFile = join(dir, 'persona.traits.json');
  await writeFile(personaFile, '你是测试角色。', 'utf8');
  await writeFile(traitsFile, JSON.stringify({ snark: 0 }), 'utf8');

  const persona = createPersona({ file: personaFile, traitsFile, log: silent });
  assert.match(await persona(), /毒舌 0\/5/);

  await writeFile(traitsFile, JSON.stringify({ snark: 5 }), 'utf8');
  const future = new Date(Date.now() + 60_000);
  await utimes(traitsFile, future, future);

  assert.match(await persona(), /毒舌 5\/5/);
});

test('人设拼接：截断只切正文，不切掉刻度块', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'persona-'));
  const personaFile = join(dir, 'persona.md');
  const traitsFile = join(dir, 'persona.traits.json');
  await writeFile(personaFile, '正'.repeat(20_000), 'utf8');
  await writeFile(traitsFile, JSON.stringify(DEFAULTS), 'utf8');

  const persona = createPersona({ file: personaFile, traitsFile, log: silent });
  const text = await persona();
  assert.ok(text.length <= MAX_CHARS, `拼出来 ${text.length} 字，超过上限 ${MAX_CHARS}`);
  assert.match(text, /\[性格刻度\]/);
  assert.match(text, /憨 3\/5：时不时出洋相/, '刻度块要完整保留');
});