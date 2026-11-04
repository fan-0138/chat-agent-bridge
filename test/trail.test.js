import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { collectTrail } from '../src/trail.js';

const MIN = 60_000;
const HOUR = 3_600_000;
const NOW = Date.UTC(2026, 10, 3, 9, 0, 0); // 固定时间，跑多久都稳
const ago = (ms) => NOW - ms;
const iso = (ms) => new Date(ms).toISOString();

async function tempRoot(t) {
  const root = await mkdtemp(join(tmpdir(), 'trail-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function put(root, rel, content) {
  const file = join(root, rel);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, content, 'utf8');
}

async function putJsonl(root, rel, rows) {
  const text = rows.map((row) => (typeof row === 'string' ? row : JSON.stringify(row))).join('\n');
  await put(root, rel, `${text}\n`);
}

const byKind = (items, kind) => items.filter((item) => item.kind === kind);

test('collectTrail：八个来源都汇进同一条时间线', async (t) => {
  const root = await tempRoot(t);
  const videoUrl = 'https://www.douyin.com/video/1234567890';
  await putJsonl(root, 'data/mind/stream.jsonl', [
    { at: ago(10 * MIN), kind: 'think', text: '  她在想   一件 事 ', mood: '平静', action: 'none' },
    { at: ago(20 * MIN), kind: 'dream', text: '梦到机房下雪了', mood: '恍惚', action: 'remember' },
  ]);
  await putJsonl(root, 'data/mind/memory.jsonl', [{ at: ago(30 * MIN), text: '她记下了一件事' }]);
  await putJsonl(root, 'data/mind/comments.jsonl', [
    { at: ago(40 * MIN), url: videoUrl, text: '说一句', ok: true },
    { at: ago(50 * MIN), url: 'https://www.douyin.com/video/999', text: '没发出去的话', ok: false },
  ]);
  await putJsonl(root, 'data/mc/sessions.jsonl', [
    {
      startedAt: iso(ago(60 * MIN)),
      minutes: 4,
      turns: 8,
      goal: '砍点木头',
      position: { x: 1.2, y: 70, z: -3.4 },
      inventory: [
        { name: 'oak_log', count: 3 },
        { name: 'cobblestone', count: 64 },
        { name: 'bread', count: 16 },
      ],
    },
  ]);
  await putJsonl(root, 'data/qq/qzone-posts.jsonl', [
    { at: ago(70 * MIN), content: '今天发了一条说说' },
    { at: ago(75 * MIN), text: '用 text 字段的说说' },
  ]);
  await putJsonl(root, 'data/douyin/seen.jsonl', [
    { id: '1234567890', desc: '一条视频', author: '某作者', seenAt: iso(ago(80 * MIN)), url: videoUrl },
  ]);
  await put(
    root,
    'data/douyin/comment-result.json',
    JSON.stringify({ at: ago(90 * MIN), ok: false, comment: '这条没发出去', cid: null }),
  );
  await put(
    root,
    'data/life/state.json',
    JSON.stringify({ activity: '刚刷完抖音，还在回味', activitySince: ago(100 * MIN) }),
  );

  const items = await collectTrail({ root, now: NOW });
  const kinds = new Set(items.map((item) => item.kind));
  for (const kind of ['thought', 'dream', 'note', 'comment', 'game', 'qzone', 'video', 'browse']) {
    assert.ok(kinds.has(kind), `少了 ${kind}`);
  }

  // 时间倒序
  for (let i = 1; i < items.length; i += 1) {
    assert.ok(items[i - 1].at >= items[i].at, '必须按时间倒序');
  }
  // 每个元素都有约定的字段
  for (const item of items) {
    assert.equal(typeof item.at, 'number');
    assert.equal(typeof item.title, 'string');
    assert.ok(item.title.length > 0);
    assert.equal(typeof item.source, 'string');
  }

  const thought = byKind(items, 'thought')[0];
  assert.equal(thought.title, '她在想 一件 事');
  assert.equal(thought.detail, '平静', 'action=none 时 detail 只写情绪');
  assert.equal(thought.source, 'stream.jsonl');

  const dream = byKind(items, 'dream')[0];
  assert.equal(dream.title, '梦到机房下雪了');
  assert.equal(dream.detail, '恍惚 · 动作：remember');

  assert.equal(byKind(items, 'note')[0].title, '她记下了一件事');

  const commentOk = items.find((item) => item.source === 'comments.jsonl' && item.title === '说一句');
  assert.match(commentOk.detail, /1234567890/);
  assert.match(commentOk.detail, /@某作者/, '能从 seen 认出作者就带上');
  assert.equal(commentOk.ok, true);
  const commentFail = items.find((item) => item.source === 'comments.jsonl' && item.title === '没发出去的话');
  assert.match(commentFail.detail, /没发出去/);
  assert.equal(commentFail.ok, false, '页面按 ok=false 标红');
  const result = items.find((item) => item.source === 'comment-result.json');
  assert.equal(result.title, '这条没发出去');
  assert.equal(result.detail, '失败');
  assert.equal(result.ok, false);

  const game = byKind(items, 'game')[0];
  assert.equal(game.title, '在游戏里玩了 4 分钟：砍点木头');
  assert.match(game.detail, /位置 \(1, 70, -3\)/);
  assert.match(game.detail, /背包 oak_log×3、cobblestone×64/);

  const qzone = byKind(items, 'qzone');
  assert.deepEqual(
    qzone.map((item) => item.title).sort(),
    ['今天发了一条说说', '用 text 字段的说说'].sort(),
  );

  const video = byKind(items, 'video')[0];
  assert.equal(video.title, '一条视频');
  assert.equal(video.detail, '@某作者');
  assert.equal(video.source, 'seen.jsonl');

  const browse = byKind(items, 'browse')[0];
  assert.equal(browse.title, '刚刷完抖音，还在回味');
  assert.equal(browse.at, ago(100 * MIN));
  assert.equal(browse.source, 'state.json');
});

test('collectTrail：按时间倒序，limit 在去重之后截断', async (t) => {
  const root = await tempRoot(t);
  await putJsonl(root, 'data/mind/stream.jsonl', [
    { at: ago(5 * MIN), kind: 'think', text: '五分钟前' },
    { at: ago(15 * MIN), kind: 'think', text: '十五分钟前' },
    { at: ago(25 * MIN), kind: 'think', text: '二十五分钟前' },
  ]);
  await putJsonl(root, 'data/mind/memory.jsonl', [{ at: ago(10 * MIN), text: '十分钟前记下的' }]);

  const two = await collectTrail({ root, now: NOW, limit: 2 });
  assert.deepEqual(
    two.map((item) => item.at),
    [ago(5 * MIN), ago(10 * MIN)],
  );

  const all = await collectTrail({ root, now: NOW, limit: 80 });
  assert.equal(all.length, 4);
  for (let i = 1; i < all.length; i += 1) assert.ok(all[i - 1].at >= all[i].at);
});

test('collectTrail：只留最近 48 小时', async (t) => {
  const root = await tempRoot(t);
  await putJsonl(root, 'data/mind/stream.jsonl', [
    { at: ago(47 * HOUR), kind: 'think', text: '还在窗口里' },
    { at: ago(48 * HOUR), kind: 'think', text: '正好四十八小时' },
    { at: ago(49 * HOUR), kind: 'think', text: '超过窗口的' },
  ]);
  const items = await collectTrail({ root, now: NOW });
  const titles = items.map((item) => item.title);
  assert.ok(titles.includes('还在窗口里'));
  assert.ok(titles.includes('正好四十八小时'), '边界上要留');
  assert.ok(!titles.includes('超过窗口的'), '超过 48 小时要丢');
});

test('collectTrail：同 kind + 标题前 20 字，15 分钟内只留一条', async (t) => {
  const root = await tempRoot(t);
  await putJsonl(root, 'data/mind/stream.jsonl', [
    { at: ago(2 * MIN), kind: 'think', text: '一模一样的一句话' },
    { at: ago(10 * MIN), kind: 'think', text: '一模一样的一句话' },
    { at: ago(30 * MIN), kind: 'think', text: '一模一样的一句话' },
    // 前 20 字相同、后面不同，也算重复
    { at: ago(5 * MIN), kind: 'think', text: '一二三四五六七八九十一二三四五六七八九十甲' },
    { at: ago(12 * MIN), kind: 'think', text: '一二三四五六七八九十一二三四五六七八九十乙' },
  ]);
  await putJsonl(root, 'data/qq/qzone-posts.jsonl', [{ at: ago(3 * MIN), content: '一模一样的一句话' }]);

  const items = await collectTrail({ root, now: NOW });
  const thoughts = byKind(items, 'thought');
  const same = thoughts.filter((item) => item.title === '一模一样的一句话');
  assert.equal(same.length, 2, '15 分钟内留最新的那条，30 分钟前那条另算');
  assert.deepEqual(
    same.map((item) => item.at),
    [ago(2 * MIN), ago(30 * MIN)],
  );
  const longSame = thoughts.filter((item) => item.title.startsWith('一二三四五六七八九十'));
  assert.equal(longSame.length, 1, '前 20 字一样就算重复');
  assert.equal(longSame[0].at, ago(5 * MIN));
  assert.equal(byKind(items, 'qzone').length, 1, '不同 kind 不互相去重');
});

test('collectTrail：坏 JSON、坏行、缺字段都静默跳过', async (t) => {
  const root = await tempRoot(t);
  await putJsonl(root, 'data/mind/stream.jsonl', [
    '这不是 JSON',
    '{"at":',
    JSON.stringify({ kind: 'think', text: '没有时间' }),
    JSON.stringify({ at: '坏时间', kind: 'think', text: '时间坏了' }),
    JSON.stringify({ at: ago(6 * MIN), kind: 'unknown', text: '不认识的类型' }),
    JSON.stringify({ at: ago(5 * MIN), kind: 'think', text: '好的' }),
    '',
  ]);
  await putJsonl(root, 'data/mind/comments.jsonl', ['null', JSON.stringify({ at: ago(7 * MIN) })]);
  await putJsonl(root, 'data/mc/sessions.jsonl', [JSON.stringify({ startedAt: '不是时间', goal: '没开始' })]);
  await putJsonl(root, 'data/qq/qzone-posts.jsonl', ['{"at":']);
  await putJsonl(root, 'data/douyin/seen.jsonl', ['[1,2,3]', JSON.stringify({ id: '1', desc: '' })]);
  await putJsonl(root, 'data/mind/memory.jsonl', ['']);
  await put(root, 'data/life/state.json', '{oops');
  await put(root, 'data/douyin/comment-result.json', 'null');

  const items = await collectTrail({ root, now: NOW });
  assert.deepEqual(
    items.map((item) => item.title),
    ['好的'],
  );
});

test('collectTrail：文件都不存在时返回空数组', async (t) => {
  const root = await tempRoot(t);
  const items = await collectTrail({ root, now: NOW });
  assert.deepEqual(items, []);
  assert.ok(Array.isArray(items));
});

test('collectTrail：seen.jsonl 只读尾部 200 行', async (t) => {
  const root = await tempRoot(t);
  const rows = [];
  for (let i = 0; i < 250; i += 1) {
    rows.push({
      id: String(i),
      desc: `${i < 50 ? '头部' : '尾部'}视频 ${i}`,
      author: '作者',
      seenAt: iso(ago((250 - i) * 1000)),
      url: `https://www.douyin.com/video/${i}`,
    });
  }
  await putJsonl(root, 'data/douyin/seen.jsonl', rows);

  const items = await collectTrail({ root, now: NOW });
  assert.equal(items.length, 80, '默认 limit 80');
  assert.ok(items.every((item) => item.source === 'seen.jsonl'));
  assert.ok(items.every((item) => item.title.startsWith('尾部')), '头部 50 行不该被读到');
});

test('collectTrail：评论成功/失败、认不出作者就不带 @', async (t) => {
  const root = await tempRoot(t);
  const url = 'https://www.douyin.com/video/424242';
  await putJsonl(root, 'data/mind/comments.jsonl', [
    { at: ago(5 * MIN), url, text: '这句没发出去', ok: false },
    { at: ago(6 * MIN), url, text: '这句发出去了', ok: true },
  ]);
  await put(root, 'data/douyin/comment-result.json', JSON.stringify({ at: ago(2 * MIN), ok: true, comment: '最近一次评论', cid: '123' }));

  const items = await collectTrail({ root, now: NOW });
  const failed = items.find((item) => item.title === '这句没发出去');
  assert.equal(failed.detail, `${url} · 没发出去`, '认不出作者就不带 @');
  assert.equal(failed.ok, false);

  const sent = items.find((item) => item.title === '这句发出去了');
  assert.equal(sent.detail, url);
  assert.equal(sent.ok, true);

  const result = items.find((item) => item.source === 'comment-result.json');
  assert.equal(result.detail, '成功');
  assert.equal(result.ok, true);
});