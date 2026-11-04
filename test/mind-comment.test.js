import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildThoughtPrompt,
  createMind,
  decideComment,
  formatCommentSection,
  formatVideoList,
  parseCommentContent,
  pickVideos,
  summarizeComment,
} from '../src/mind.js';
import { maybeComment } from '../scripts/mind-run.mjs';

const quiet = { debug() {}, info() {}, warn() {}, error() {} };
const at = (iso) => Date.parse(iso);

const videoA = { url: 'https://www.douyin.com/video/1', author: '甲', desc: '第一条', at: at('2026-11-03T08:00:00Z') };
const videoB = { url: 'https://www.douyin.com/video/2', author: '乙', desc: '第二条', at: at('2026-11-02T08:00:00Z') };

/* ── 解析「序号 | 想说的话」 ── */

test('评论内容：带序号就选那条，文字去掉序号', () => {
  const parsed = parseCommentContent('2 | 这条也太离谱了', [videoA, videoB]);
  assert.equal(parsed.index, 2);
  assert.equal(parsed.video.url, videoB.url);
  assert.equal(parsed.text, '这条也太离谱了');
});

test('评论内容：全角竖线、冒号都能认', () => {
  assert.equal(parseCommentContent('1｜好家伙', [videoA]).text, '好家伙');
  assert.equal(parseCommentContent('1：好家伙', [videoA]).text, '好家伙');
});

test('评论内容：没写序号就挑第一条', () => {
  const parsed = parseCommentContent('随便说一句', [videoA, videoB]);
  assert.equal(parsed.index, 0);
  assert.equal(parsed.video.url, videoA.url);
  assert.equal(parsed.text, '随便说一句');
});

test('评论内容：序号越界退回第一条，不丢这句话', () => {
  const parsed = parseCommentContent('9 | 还是说一句', [videoA, videoB]);
  assert.equal(parsed.video.url, videoA.url);
  assert.equal(parsed.text, '还是说一句');
});

test('评论内容：空的就返回 null', () => {
  assert.equal(parseCommentContent('', [videoA]), null);
  assert.equal(parseCommentContent('   ', [videoA]), null);
});

/* ── 能不能去说 ── */

test('评论闸：没开浏览器 / 没在线就不去', () => {
  assert.equal(decideComment({ state: {}, online: false }).go, false);
});

test('评论闸：一天最多 3 条', () => {
  const now = at('2026-11-03T12:00:00Z');
  const day = '2026-11-03';
  assert.equal(decideComment({ state: { commentDay: day, commentCount: 3 }, now, online: true }).reason, 'daily');
  assert.equal(decideComment({ state: { commentDay: day, commentCount: 2 }, now, online: true }).go, true);
});

test('评论闸：两次之间至少隔 40 分钟，跨天就重置', () => {
  const now = at('2026-11-03T12:00:00Z');
  const fresh = decideComment({ state: { lastCommentAt: now - 10 * 60_000 }, now, online: true });
  assert.equal(fresh.go, false);
  assert.equal(fresh.reason, 'gap');
  assert.ok(fresh.waitMin >= 1);
  assert.equal(decideComment({ state: { lastCommentAt: now - 41 * 60_000 }, now, online: true }).go, true);
  // 昨天的计数不算今天的
  assert.equal(decideComment({ state: { commentDay: '2026-11-02', commentCount: 3 }, now, online: true }).go, true);
});

/* ── 挑视频 ── */

test('挑视频：去重、按时间倒序、过期限的不算', () => {
  const now = at('2026-11-03T12:00:00Z');
  const rows = [
    { url: 'https://www.douyin.com/video/1', desc: '重复的那条', author: '甲', seenAt: '2026-11-03T09:00:00Z' },
    { url: 'https://www.douyin.com/video/1', desc: '重复的那条', author: '甲', seenAt: '2026-11-03T08:00:00Z' },
    { id: '2', desc: '更新的那条', author: '乙', seenAt: '2026-11-03T11:00:00Z' },
    { url: 'https://www.douyin.com/video/3', desc: '太旧的那条', author: '丙', seenAt: '2026-10-20T11:00:00Z' },
  ];
  const picked = pickVideos(rows, now);
  assert.equal(picked.length, 2);
  assert.equal(picked[0].desc, '更新的那条');
  assert.equal(picked[1].desc, '重复的那条');
  assert.equal(picked[0].url, 'https://www.douyin.com/video/2');
});

test('视频清单：编号 + 作者 + 标题', () => {
  const text = formatVideoList([videoA, videoB]);
  assert.match(text, /^1\. @甲 · 第一条/m);
  assert.match(text, /^2\. @乙 · 第二条/m);
});

/* ── 她记得自己说过 ── */

test('评论摘要：说成了才说，失败/过期都不说', () => {
  const now = at('2026-11-03T12:00:00Z');
  assert.match(summarizeComment({ at: now - 3_600_000, ok: true, text: '这也太离谱了' }, now), /这也太离谱了/);
  assert.equal(summarizeComment({ at: now - 3_600_000, ok: false, text: '没发出去' }, now), '');
  assert.equal(summarizeComment({ at: now - 48 * 3_600_000, ok: true, text: '前天说的' }, now), '');
  assert.equal(formatCommentSection(''), '');
  assert.match(formatCommentSection('今天在评论区说了句「好」'), /评论区/);
});

/* ── 想事的 prompt 里得有这些材料 ── */

test('想事 prompt：带上视频清单和「评论」这个动作', () => {
  const prompt = buildThoughtPrompt({
    persona: '你是小鲸',
    lifeText: '在发呆',
    playText: '',
    videos: [videoA, videoB],
    recent: [],
    memories: [],
    chat: [],
    themes: [],
    now: at('2026-11-03T12:00:00Z'),
  });
  assert.match(prompt, /你刚刷到的视频/);
  assert.match(prompt, /@甲 · 第一条/);
  assert.match(prompt, /做=评论/);
  assert.match(prompt, /\| 想说的话/);
});

test('没有视频时 prompt 不出现空标题', () => {
  const prompt = buildThoughtPrompt({
    persona: '',
    lifeText: '',
    videos: [],
    recent: [],
    memories: [],
    chat: [],
    themes: [],
    now: at('2026-11-03T12:00:00Z'),
  });
  assert.doesNotMatch(prompt, /\[你刚刷到的视频/);
});

/* ── tick 会去读视频清单；说「评论」时记下这条动作 ── */

test('tick：说要评论时把内容和动作记下来，并在 prompt 里带上视频', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mind-comment-'));
  try {
    await mkdir(join(dir, 'data/douyin'), { recursive: true });
    await mkdir(join(dir, 'data/mind'), { recursive: true });
    await writeFile(
      join(dir, 'data/douyin/seen.jsonl'),
      `${JSON.stringify({ id: '1', desc: '鲸鱼搁浅了', author: '甲', seenAt: '2026-11-03T08:00:00Z' })}\n`,
      'utf8',
    );
    const prompts = [];
    const runner = {
      async run(prompt) {
        prompts.push(prompt);
        return { text: '{"想":"想去说一句","情绪":"无聊","做":"评论","内容":"1 | 这条看着真疼"}' };
      },
    };
    const mind = createMind({ config: { mindEnabled: true }, runner, root: dir, now: () => at('2026-11-03T12:00:00Z'), log: quiet });
    const result = await mind.tick({ force: true });
    assert.equal(result.ok, true);
    assert.equal(result.record.action, 'comment');
    assert.equal(result.record.content, '1 | 这条看着真疼');
    assert.match(prompts[0], /鲸鱼搁浅了/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

/* ── mind-run 的 dry-run 只打印，不发 ── */

test('maybeComment：dry-run 打印目标，不促发进程、不落 state', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mind-comment-dry-'));
  const lines = [];
  const original = console.log;
  console.log = (line) => lines.push(String(line));
  try {
    const mind = {
      recentVideos: async () => [videoA],
      _state: () => ({}),
      markCommented: async () => {
        throw new Error('dry-run 不该写 state');
      },
    };
    const result = await maybeComment({ root: dir, mind, log: quiet, record: { content: '1 | 想说一句' }, dry: true });
    assert.equal(result.started, false);
    assert.equal(result.reason, 'dry-run');
    assert.match(lines.join('\n'), /本来要在这条下面说：「想说一句」/);
  } finally {
    console.log = original;
    await rm(dir, { recursive: true, force: true });
  }
});