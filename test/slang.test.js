import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseSlang, formatSlang, renderSlang, createSlang } from '../src/slang.js';

const silent = { info() {}, warn() {}, error() {}, debug() {} };

test('梗库：parse 能读出词 / 意思 / 例句 / 日期', () => {
  const md = `# 梗
- **典**：典中典，说某人某话很典型 / 例：又是这套，太典了 / 2026-10-20
- **破防**：被戳中，绷不住了 / 2026-10-18`;
  const entries = parseSlang(md);
  assert.equal(entries.length, 2);
  assert.equal(entries[0].term, '典');
  assert.equal(entries[0].meaning, '典中典，说某人某话很典型');
  assert.equal(entries[0].example, '又是这套，太典了');
  assert.equal(entries[0].date, '2026-10-20');
  assert.equal(entries[1].example, '');
});

test('梗库：format 与 parse 能往返', () => {
  const entries = [{ term: '栓Q', meaning: '无语+感谢的混合', example: '栓Q了', date: '2026-10-21' }];
  assert.deepEqual(parseSlang(formatSlang(entries)), entries);
});

test('梗库：渲染成 prompt 段落，空库不占位', () => {
  assert.equal(renderSlang([]), '');
  const text = renderSlang([{ term: '典', meaning: '典型', example: '太典了', date: '' }]);
  assert.match(text, /最近网上学的梗/);
  assert.match(text, /一条消息最多一个/);
  assert.match(text, /- 典：典型（比如：太典了）/);
});

test('梗库：add 去重、热加载生效', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'slang-'));
  const file = join(dir, 'slang.md');
  const slang = createSlang({ file, log: silent });
  assert.equal((await slang.load()).text, '');
  assert.equal((await slang.add({ term: '典', meaning: '典型' })).added, true);
  assert.equal((await slang.add({ term: '典', meaning: '换个意思' })).added, false);
  const loaded = await slang.load();
  assert.equal(loaded.entries.length, 1);
  assert.match(loaded.text, /最近网上学的梗/);
});

test('梗库：最多保留 40 条，新条目在最前', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'slang-'));
  const slang = createSlang({ file: join(dir, 'slang.md'), log: silent });
  for (let i = 0; i < 45; i += 1) await slang.add({ term: `词${i}`, meaning: 'x' });
  const { entries } = await slang.load();
  assert.equal(entries.length, 40);
  assert.equal(entries[0].term, '词44');
});
