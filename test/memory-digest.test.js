import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildDigestPrompt, collectMaterial, digest, parseDigest } from '../src/memory-digest.js';
import { createMemoryStore } from '../src/memory-store.js';
import { localDay } from '../src/life.js';

const quiet = { debug() {}, info() {}, warn() {}, error() {} };
// 固定在一个深夜（本地时间），素材过滤都用它
const now = new Date(2026, 10, 4, 23, 30, 0).getTime();
const day = localDay(now);

async function makeRoot({ withMaterial = true } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'digest-'));
  await mkdir(join(root, 'data/memory'), { recursive: true });
  if (withMaterial) {
    await mkdir(join(root, 'data/qq/memory'), { recursive: true });
    await writeFile(
      join(root, 'data/qq/memory/user_private_1.jsonl'),
      [
        { at: now - 3_600_000, role: 'user', text: '今天那个蒹葭你背到第几章了' },
        { at: now - 3_500_000, role: 'assistant', text: '第三章，采采那句老记混' },
        { at: now - 2 * 86_400_000, role: 'user', text: '两天前的旧话不该进来' },
      ]
        .map((row) => JSON.stringify(row))
        .join('\n') + '\n',
      'utf8',
    );
    await mkdir(join(root, 'data/mind'), { recursive: true });
    await writeFile(
      join(root, 'data/mind/stream.jsonl'),
      `${JSON.stringify({ at: now - 3_000_000, kind: 'think', text: '窗外月亮很亮，想去看看' })}\n`,
      'utf8',
    );
    await mkdir(join(root, 'data/life'), { recursive: true });
    await writeFile(
      join(root, 'data/life/meals.jsonl'),
      `${JSON.stringify({ day, at: '2026-11-04T12:00:00Z', slot: '晚饭', dish: '火锅' })}\n`,
      'utf8',
    );
    await writeFile(join(root, 'data/mind/invite.jsonl'), `${JSON.stringify({ at: now - 1_800_000, text: '一起看月亮', status: 'accepted' })}\n`, 'utf8');
    await writeFile(join(root, 'data/mind/touch.jsonl'), `${JSON.stringify({ at: now - 1_200_000, kind: 'pat', line: '嗯…' })}\n`, 'utf8');
    await writeFile(join(root, 'data/mind/state.json'), `${JSON.stringify({ plan: { day, text: '把地板接完', at: now } })}\n`, 'utf8');
  }
  return root;
}

test('解析：拿到事件和事实，坏的条目丢掉', () => {
  const raw = `
  好，整理如下：
  \`\`\`json
  {"事件":[{"标题":"一起看了月亮","细节":"窗边聊到十二点","人":["爸爸"],"重要":4},
           {"标题":"","细节":"空标题不要"},
           {"标题":"背了蒹葭","人":"不是数组","重要":9}],
   "事实":[{"关于":"他","什么":"爱吃的","内容":"西瓜"},
           {"关于":"路人","什么":"x","内容":"y"},
           {"关于":"小鲸","什么":"怕的","内容":"黑"}]}
  \`\`\`
  `;
  const parsed = parseDigest(raw);
  assert.equal(parsed.episodes.length, 2);
  assert.equal(parsed.episodes[0].title, '一起看了月亮');
  assert.equal(parsed.episodes[1].salience, 5); // 越界压回 5
  assert.deepEqual(parsed.episodes[1].people, []);
  assert.equal(parsed.facts.length, 2);
  assert.equal(parsed.facts[0].subject, '爸爸'); // 他 → 爸爸
  assert.equal(parsed.facts[1].subject, '小鲸');
  assert.equal(parseDigest('没有 JSON'), null);
  assert.equal(parseDigest(''), null);
});

test('素材：只取今天/近一天的，别把两天前的旧话翻进来', async () => {
  const root = await makeRoot();
  try {
    const material = await collectMaterial({ root, now });
    assert.equal(material.hasSomething, true);
    assert.ok(material.turns.some((line) => line.includes('蒹葭')));
    assert.ok(!material.turns.some((line) => line.includes('两天前')));
    assert.ok(material.thoughts.some((line) => line.includes('月亮')));
    assert.ok(material.meals.some((line) => line.includes('火锅')));
    assert.ok(material.acts.some((line) => line.includes('一起看月亮')));
    assert.ok(material.notes.some((line) => line.includes('摸了')));
    const prompt = buildDigestPrompt({ persona: '我是小鲸。', material, now });
    assert.match(prompt, /我是小鲸/);
    assert.match(prompt, /事件 1～4 条/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('整理：写进情景和事实，一天只跑一次，force 可以重跑', async () => {
  const root = await makeRoot();
  try {
    let calls = 0;
    const runner = {
      async run() {
        calls += 1;
        return {
          text: JSON.stringify({
            事件: [{ 标题: '一起看了月亮', 细节: '窗边聊到很晚', 人: ['爸爸'], 重要: 4 }],
            事实: [{ 关于: '爸爸', 什么: '爱吃的', 内容: '西瓜' }],
          }),
        };
      },
    };
    const first = await digest({ root, now, runner, persona: '我是小鲸。', log: quiet });
    assert.equal(first.ok, true);
    assert.equal(first.episodes.length, 1);
    assert.equal(first.facts.length, 1);
    assert.equal(calls, 1);

    const store = createMemoryStore({ root, now: () => now, log: quiet });
    const episodes = await store.readEpisodes();
    assert.equal(episodes.length, 1);
    assert.match(episodes[0].text, /窗边聊到很晚/);
    const facts = await store.readFacts();
    assert.equal(facts.length, 1);
    assert.equal(facts[0].value, '西瓜');
    assert.equal((await store.readMeta()).lastDigestDay, day);

    // 同一天再跑：不调模型
    const second = await digest({ root, now, runner, log: quiet });
    assert.equal(second.ok, false);
    assert.equal(second.reason, 'done');
    assert.equal(calls, 1);

    // force 才重跑
    const forced = await digest({ root, now, runner, force: true, log: quiet });
    assert.equal(forced.ok, true);
    assert.equal(calls, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('整理：模型失败/解析不出来就不写盘、不标记完成', async () => {
  const root = await makeRoot();
  try {
    const store = createMemoryStore({ root, now: () => now, log: quiet });
    const broken = { run: async () => ({ text: '我觉得今天挺开心的。' }) };
    const bad = await digest({ root, now, runner: broken, log: quiet });
    assert.equal(bad.ok, false);
    assert.equal(bad.reason, 'model');
    assert.equal((await store.readEpisodes()).length, 0);
    assert.equal((await store.readMeta()).lastDigestDay, undefined);

    const boom = {
      run: async () => {
        throw new Error('DSH 退出码 1');
      },
    };
    const failed = await digest({ root, now, runner: boom, log: quiet });
    assert.equal(failed.ok, false);
    assert.equal(failed.reason, 'model');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('整理：今天什么都没有就不调模型', async () => {
  const root = await makeRoot({ withMaterial: false });
  try {
    let calls = 0;
    const runner = {
      run: async () => {
        calls += 1;
        return { text: '{"事件":[],"事实":[]}' };
      },
    };
    const result = await digest({ root, now, runner, log: quiet });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'empty');
    assert.equal(calls, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});