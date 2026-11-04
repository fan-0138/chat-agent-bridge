import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BROWSE_MAX_PER_DAY,
  QZONE_MAX_PER_DAY,
  buildThoughtPrompt,
  decideBrowseTime,
  decideQzone,
  decideSideAction,
  parseMind,
} from '../src/mind.js';
import { maybeBrowse, maybeQzone } from '../scripts/mind-run.mjs';

const quiet = { debug() {}, info() {}, warn() {}, error() {} };
const at = (iso) => Date.parse(iso);
const now = at('2026-11-03T12:00:00Z');

/* ── 她自己找事做：刷抖音 ── */

test('刷抖音：浏览器没开就不刷', () => {
  assert.equal(decideBrowseTime({ state: {}, now, allow: false }).reason, 'unavailable');
});

test('刷抖音：一天最多 4 次，跨天重置', () => {
  const day = '2026-11-03';
  assert.equal(decideBrowseTime({ state: { browseDay: day, browseCount: BROWSE_MAX_PER_DAY }, now }).reason, 'daily');
  assert.equal(decideBrowseTime({ state: { browseDay: day, browseCount: BROWSE_MAX_PER_DAY - 1 }, now }).go, true);
  assert.equal(decideBrowseTime({ state: { browseDay: '2026-11-02', browseCount: 99 }, now }).go, true);
});

test('刷抖音：两次之间至少隔 60 分钟', () => {
  const verdict = decideBrowseTime({ state: { lastBrowseAt: now - 10 * 60_000 }, now });
  assert.equal(verdict.go, false);
  assert.ok(verdict.waitMin >= 1);
  assert.equal(decideBrowseTime({ state: { lastBrowseAt: now - 61 * 60_000 }, now }).go, true);
});

/* ── 她自己找事做：发说说 ── */

test('发说说：一天最多 2 次，间隔 3 小时', () => {
  assert.equal(decideQzone({ state: { qzoneDay: '2026-11-03', qzoneCount: QZONE_MAX_PER_DAY }, now }).reason, 'daily');
  assert.equal(decideQzone({ state: { lastQzoneAt: now - 60 * 60_000 }, now }).reason, 'gap');
  assert.equal(decideQzone({ state: { lastQzoneAt: now - 181 * 60_000 }, now }).go, true);
});

test('decideSideAction：未知 key 不会崩，按天计数走', () => {
  const verdict = decideSideAction({ state: { fooDay: '2026-11-03', fooCount: 1 }, now, key: 'foo', minGapMin: 30, maxPerDay: 2 });
  assert.equal(verdict.go, true);
  assert.equal(verdict.count, 1);
});

/* ── 她能选这两个动作 ── */

test('解析：做=刷 / 做=说 都能认出来', () => {
  assert.equal(parseMind('{"想":"想看看海","情绪":"闲","做":"刷","内容":"随便看看"}').action, 'browse');
  assert.equal(parseMind('{"想":"想写点东西","情绪":"软","做":"说","内容":"随便写一条"}').action, 'qzone');
});

test('想事 prompt：告诉她可以自己决定去刷、去发说说', () => {
  const prompt = buildThoughtPrompt({
    persona: '',
    lifeText: '',
    videos: [],
    recent: [],
    memories: [],
    chat: [],
    themes: [],
    now,
  });
  assert.match(prompt, /做=刷/);
  assert.match(prompt, /做=说/);
  assert.match(prompt, /你自己选/);
});

/* ── dry-run 只说不做 ── */

test('maybeBrowse / maybeQzone：dry-run 只打印，不写 state', async () => {
  const lines = [];
  const original = console.log;
  console.log = (line) => lines.push(String(line));
  const mind = {
    _state: () => ({}),
    markBrowsed: async () => {
      throw new Error('dry-run 不该写 state');
    },
    markQzone: async () => {
      throw new Error('dry-run 不该写 state');
    },
  };
  try {
    const b = await maybeBrowse({ root: '/tmp', mind, log: quiet, record: { content: '看看海' }, dry: true });
    const q = await maybeQzone({ root: '/tmp', mind, log: quiet, record: { content: '随便写一条' }, dry: true });
    assert.equal(b.reason, 'dry-run');
    assert.equal(q.reason, 'dry-run');
    assert.match(lines.join('\n'), /本来要自己去刷抖音：看看海/);
    assert.match(lines.join('\n'), /本来要发一条说说/);
  } finally {
    console.log = original;
  }
});
test('思考提示词里带上她手上没做完的事', () => {
  const prompt = buildThoughtPrompt({
    persona: '你是小鲸。',
    lifeText: '现在 23:40。',
    agendaText: '[你手上还欠着的事]\n- 重剪抖音视频（1 分钟前记下的）\n（自己记的）',
  });
  assert.match(prompt, /你手上还欠着的事/);
  assert.match(prompt, /重剪抖音视频/);
});
