import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildThoughtPrompt, createMind } from '../src/mind.js';

const quiet = { debug() {}, info() {}, warn() {}, error() {} };
const config = {
  mindEnabled: true,
  mindMaxPerDay: 48,
  mindMinGapMin: 6,
  mindInjectThoughts: 3,
  mindInjectMemories: 5,
  mindInjectTtlH: 4,
};

async function makeRoot() {
  const root = await mkdtemp(join(tmpdir(), 'mind-touch-'));
  await mkdir(join(root, 'data/mind'), { recursive: true });
  return root;
}

test('独处 prompt：摸头和约定各占一段，没东西就不占', () => {
  const prompt = buildThoughtPrompt({
    persona: '',
    lifeText: '',
    touchText: '[他刚才摸了摸你的头]\n3 分钟前他伸手摸了摸你的头，你当时「嗯…」。',
    inviteText: '[你约了他一起做件事]\n2 小时前你说「今晚一起看月亮」，他还没回。',
  });
  assert.match(prompt, /他刚才摸了摸你的头/);
  assert.match(prompt, /今晚一起看月亮/);

  const plain = buildThoughtPrompt({ persona: '我是小鲸。' });
  assert.doesNotMatch(plain, /他刚才摸了摸你的头/);
  assert.doesNotMatch(plain, /你约了他/);
});

test('对话 prompt：她刚被摸过头、有约定时带进上下文', async () => {
  const root = await makeRoot();
  try {
    // 固定在一个不睡觉的时刻，别让测试结果跟着真实钟点变
    const now = new Date(2026, 10, 4, 20, 0, 0).getTime();
    await writeFile(
      join(root, 'data/mind/touch-state.json'),
      `${JSON.stringify({ day: 'x', count: 2, streak: 2, lastAt: now - 60_000, lastLine: '嗯…' })}\n`,
      'utf8',
    );
    await writeFile(
      join(root, 'data/mind/invite.json'),
      `${JSON.stringify({ id: '1', text: '今晚一起看月亮', at: now - 3_600_000, status: 'pending', answeredAt: 0, doneAt: 0 })}\n`,
      'utf8',
    );
    const mind = createMind({ config, root, log: quiet, now: () => now });
    const text = await mind.promptSection();
    assert.match(text, /他刚才摸了摸你的头/);
    assert.match(text, /1 分钟前/);
    assert.match(text, /你约了他一起做件事/);
    assert.match(text, /今晚一起看月亮/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('她自己在想事时，真的把摸头和约定喂给模型', async () => {
  const root = await makeRoot();
  try {
    const now = new Date(2026, 10, 4, 20, 0, 0).getTime();
    await writeFile(
      join(root, 'data/mind/touch-state.json'),
      `${JSON.stringify({ day: 'x', count: 1, streak: 1, lastAt: now - 5 * 60_000, lastLine: '干嘛呀' })}\n`,
      'utf8',
    );
    await writeFile(
      join(root, 'data/mind/invite.json'),
      `${JSON.stringify({ id: '1', text: '一起背《蒹葭》', at: now - 3_600_000, status: 'accepted', answeredAt: now - 1_800_000, doneAt: 0 })}\n`,
      'utf8',
    );
    let seen = '';
    const mind = createMind({
      config,
      root,
      log: quiet,
      now: () => now,
      runner: {
        run: async (prompt) => {
          seen = prompt;
          return { text: '{"想":"有点热","情绪":"乱","做":"none","内容":""}' };
        },
      },
    });
    const result = await mind.tick({ force: true });
    assert.equal(result.ok, true);
    assert.match(seen, /他刚才摸了摸你的头/);
    assert.match(seen, /你们约好了/);
    assert.match(seen, /一起背《蒹葭》/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
