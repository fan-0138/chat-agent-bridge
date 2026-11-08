import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildReviewPrompt,
  createLessons,
  formatLessons,
  parseReview,
  reviewDue,
  reviewLessons,
  startOfDay,
} from '../src/lessons.js';

const quiet = { info() {}, warn() {}, debug() {}, error() {} };

const newStore = async () => {
  const root = await mkdtemp(join(tmpdir(), 'lessons-'));
  let clock = 1_800_000_000_000;
  const now = () => clock;
  const store = createLessons({ root, now, log: quiet });
  return { root, store, tick: (ms) => (clock += ms), now };
};

/** 造一份「今天聊过天」的素材，给 reviewLessons 用 */
async function seedTurns(root, at) {
  await mkdir(join(root, 'data/qq/memory'), { recursive: true });
  const rows = [
    { at, role: 'user', text: '我忙着呢，晚点聊' },
    { at: at + 1000, role: 'assistant', text: '那你忙，我不吵你了（其实心里有点不高兴）' },
  ];
  await writeFile(join(root, 'data/qq/memory/u_1.jsonl'), rows.map((row) => JSON.stringify(row)).join('\n') + '\n');
}

test('复盘 prompt 把今天的素材摆出来，只让她挑自己想错的', () => {
  const now = new Date(2026, 10, 7, 22, 30).getTime();
  const prompt = buildReviewPrompt({
    persona: '我是小鲸。',
    material: { turns: ['他说：我忙着呢，晚点聊', '你说：那你忙，我不吵你了'], thoughts: ['他是不是烦我了'], acts: [], notes: [] },
    previous: [{ text: '我说「他是不是烦我了」；以后先想他手里有没有事' }],
    now,
  });
  assert.match(prompt, /\[你是谁\]/);
  assert.match(prompt, /他说：我忙着呢/);
  assert.match(prompt, /他是不是烦我了/);
  assert.match(prompt, /\[任务\]/);
  assert.match(prompt, /想错了/);
  assert.match(prompt, /别写重复的/);
  // 不是立规矩：prompt 里不该出现「不许」「必须」这类禁令
  assert.doesNotMatch(prompt, /不许|必须/);
});

test('复盘 JSON 能解析，也认代码块和英文键名', () => {
  const a = parseReview(
    '{"教训":[{"想错了":"我说他烦我","错在哪":"漏了他刚说在忙","下次":"先想他手里有没有事"}]}',
  );
  assert.equal(a.lessons.length, 1);
  assert.deepEqual(a.lessons[0], { said: '我说他烦我', missed: '漏了他刚说在忙', next: '先想他手里有没有事' });

  const b = parseReview('```json\n{"lessons":[{"said":"我催他","next":"先看他是不是在忙"}]}\n```');
  assert.equal(b.lessons[0].said, '我催他');
  assert.equal(b.lessons[0].next, '先看他是不是在忙');
});

test('复盘 JSON：空的、坏的、超量的都不炸', () => {
  assert.deepEqual(parseReview('{"教训":[]}').lessons, []);
  assert.equal(parseReview('今天没什么'), null);
  assert.equal(parseReview(''), null);
  const many = parseReview(
    JSON.stringify({
      教训: [
        { 想错了: 'a', 下次: 'b' },
        { 想错了: 'c', 下次: 'd' },
        { 想错了: 'e', 下次: 'f' },
        { 想错了: 'g', 下次: 'h' },
      ],
    }),
  );
  assert.equal(many.lessons.length, 3, '最多三条');
  const empty = parseReview('{"教训":[{"想错了":"","错在哪":"","下次":""},{"想错了":"","下次":"先别急"}]}');
  assert.equal(empty.lessons.length, 1);
  assert.equal(empty.lessons[0].next, '先别急');
});

test('拼进 prompt 的教训是她自己的话，带上日期，没有就是空串', async () => {
  const { store } = await newStore();
  assert.equal(await store.promptSection(), '');
  await store.add({ said: '我说他烦我', missed: '他刚说在忙', next: '先想他手里有没有事' });
  const text = await store.promptSection();
  assert.match(text, /你自己复盘出来的/);
  assert.match(text, /我说「我说他烦我」/);
  assert.match(text, /漏了他刚说在忙/);
  assert.match(text, /以后先想他手里有没有事/);
});

test('教训存起来：重复的不加，只留最近 14 天的进 prompt', async () => {
  const { store, tick } = await newStore();
  const first = await store.add({ said: '我说他烦我', next: '先想他手里有没有事' });
  assert.ok(first && !first.duplicate);
  const dup = await store.add({ said: '我说他烦我', next: '别的说法' });
  assert.ok(dup.duplicate, '同一句「想错了」不重复记');
  const dupNext = await store.add({ said: '别的话', next: '先想他手里有没有事' });
  assert.ok(dupNext.duplicate, '同一条「下次」也不重复记');

  assert.equal((await store.recent()).length, 1);
  // 放老一条，14 天窗口外就不进 prompt
  await store.add({ said: '很早以前的错', next: '很早以前想的', at: Date.now() - 40 * 86_400_000 });
  const section = await store.promptSection();
  assert.doesNotMatch(section, /很早以前想的/);
});

test('落盘：一条一行 JSON，带日期', async () => {
  const { store, root } = await newStore();
  await store.add({ said: '我说他烦我', missed: '他刚说在忙', next: '先想他手里有没有事' });
  const raw = await readFile(join(root, 'data/mind/lessons.jsonl'), 'utf8');
  const rows = raw.trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(rows.length, 1);
  assert.match(rows[0].id, /^l/);
  assert.match(rows[0].day, /^\d{4}-\d{2}-\d{2}$/);
});

test('formatLessons 上限条数，空数组返回空串', () => {
  assert.equal(formatLessons([]), '');
  const rows = Array.from({ length: 5 }, (_, i) => ({ at: Date.now(), said: `第 ${i} 句`, next: `第 ${i} 个想法` }));
  const text = formatLessons(rows, { limit: 2 });
  assert.match(text, /第 4 句/);
  assert.doesNotMatch(text, /第 0 句/);
});

test('复盘到点没有：22 点后算到点，白天不算', () => {
  assert.equal(reviewDue({ now: new Date(2026, 10, 7, 21, 59).getTime() }), false);
  assert.equal(reviewDue({ now: new Date(2026, 10, 7, 22, 0).getTime() }), true);
  assert.equal(reviewDue({ now: new Date(2026, 10, 8, 1, 30).getTime() }), false);
  const at = new Date(2026, 10, 7, 15, 20).getTime();
  assert.equal(startOfDay(at), new Date(2026, 10, 7, 0, 0).getTime());
});

test('跑一次复盘：写进教训本，一天只跑一次，force 能重跑', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lessons-run-'));
  const now = new Date(2026, 10, 7, 22, 40).getTime();
  await seedTurns(root, now - 3 * 3_600_000);

  const calls = [];
  const runner = {
    run: async (prompt) => {
      calls.push(prompt);
      return { text: '{"教训":[{"想错了":"我说他烦我","错在哪":"他刚说在忙","下次":"先想他手里有没有事"}]}' };
    },
  };

  const first = await reviewLessons({ root, now, runner, log: quiet });
  assert.equal(first.ok, true);
  assert.equal(first.lessons.length, 1);
  assert.match(calls[0], /他说：我忙着呢/);

  const second = await reviewLessons({ root, now, runner, log: quiet });
  assert.deepEqual(second, { ok: false, reason: 'done' });

  const forced = await reviewLessons({ root, now, runner, log: quiet, force: true });
  assert.equal(forced.ok, true);
  assert.equal(forced.lessons.length, 0, '同一条不重复记');

  const meta = JSON.parse(await readFile(join(root, 'data/mind/lessons.json'), 'utf8'));
  assert.equal(meta.wrote, 0);
  const rows = (await readFile(join(root, 'data/mind/lessons.jsonl'), 'utf8')).trim().split('\n');
  assert.equal(rows.length, 1);
});

test('复盘：今天没素材就不调模型；模型胡说也不记成做过', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lessons-empty-'));
  const now = new Date(2026, 10, 7, 22, 40).getTime();
  let called = 0;
  const runner = { run: async () => { called += 1; return { text: '{"教训":[]}' }; } };

  const empty = await reviewLessons({ root, now, runner, log: quiet });
  assert.deepEqual(empty, { ok: false, reason: 'empty' });
  assert.equal(called, 0);

  await seedTurns(root, now - 3_600_000);
  const later = now + 31 * 60_000;
  const bad = await reviewLessons({ root, now: later, runner: { run: async () => ({ text: '今天挺好的' }) }, log: quiet });
  assert.deepEqual(bad, { ok: false, reason: 'model' });
  // 没成：只记「试过」，不记「今天复盘过了」，也不写教训
  const meta = JSON.parse(await readFile(join(root, 'data/mind/lessons.json'), 'utf8'));
  assert.equal(meta.lastAttemptAt, later);
  assert.equal(meta.lastReviewDay, undefined);
  await assert.rejects(readFile(join(root, 'data/mind/lessons.jsonl'), 'utf8'));

  const noRunner = await reviewLessons({ root, now: later, log: quiet });
  assert.deepEqual(noRunner, { ok: false, reason: 'no-runner' });
});

test('复盘失败后半小时内不重试，过了就补', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lessons-gap-'));
  const now = new Date(2026, 10, 7, 22, 40).getTime();
  await seedTurns(root, now - 3_600_000);

  const bad = await reviewLessons({ root, now, runner: { run: async () => ({ text: '瞎写' }) }, log: quiet });
  assert.deepEqual(bad, { ok: false, reason: 'model' });

  const soon = await reviewLessons({ root, now: now + 5 * 60_000, runner: { run: async () => ({ text: '瞎写' }) }, log: quiet });
  assert.deepEqual(soon, { ok: false, reason: 'gap' });

  const retry = await reviewLessons({
    root,
    now: now + 31 * 60_000,
    runner: { run: async () => ({ text: '{"教训":[{"想错了":"我催他","下次":"先看他忙不忙"}]}' }) },
    log: quiet,
  });
  assert.equal(retry.ok, true);
  assert.equal(retry.lessons.length, 1);
});
test('教训也带进独处 prompt（做梦那轮不带）', async () => {
  const { buildThoughtPrompt } = await import('../src/mind.js');
  const text = buildThoughtPrompt({ persona: '我是小鲸。', lessonText: '[你自己复盘出来的]\n- 他说忙就松开手' });
  assert.match(text, /松开手/);
  const plain = buildThoughtPrompt({ persona: '我是小鲸。' });
  assert.doesNotMatch(plain, /你自己复盘出来的/);
});
