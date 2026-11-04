import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_DAILY_LIMIT, WARN_RATIO, createBudget } from '../src/budget.js';
import { localDay } from '../src/life.js';

const HOUR = 3_600_000;
const START = Date.parse('2026-11-04T12:00:00+08:00');

const tempRoot = () => mkdtemp(join(tmpdir(), 'budget-'));
const cleanup = (root) => rm(root, { recursive: true, force: true });
const today = (c) => localDay(c.get());

/** 手动时钟：测「当天只提醒一次」「跨天重新提醒」，别真等一天。 */
function clock(start = START) {
  let at = start;
  return {
    now: () => at,
    get: () => at,
    advance: (ms) => {
      at += ms;
      return at;
    },
  };
}

/** 假 notify：记录每次文案；result 可以是布尔，也可以按调用顺序给值。 */
function fakeNotify(result = true) {
  const calls = [];
  const notify = async (text) => {
    calls.push(text);
    return typeof result === 'function' ? await result(text, calls.length) : result;
  };
  return { calls, notify };
}

/** 往 data/usage/usage.jsonl 塞 count 条某天的调用；badLines 放最前面模拟坏行。 */
async function seedUsage(root, count, day, { kind = 'chat', ok = true, badLines = [] } = {}) {
  await mkdir(join(root, 'data/usage'), { recursive: true });
  const lines = [...badLines];
  for (let i = 0; i < count; i += 1) {
    lines.push(JSON.stringify({ at: START + i, day, kind, ms: 100, inChars: 10, outChars: 2, ok }));
  }
  await writeFile(join(root, 'data/usage/usage.jsonl'), lines.length ? `${lines.join('\n')}\n` : '', 'utf8');
}

/** 读 budget.json 的 alertDay；不存在/坏了返回 null。 */
async function alertDayOf(root) {
  try {
    const raw = JSON.parse(await readFile(join(root, 'data/budget.json'), 'utf8'));
    return raw?.alertDay ?? null;
  } catch {
    return null;
  }
}

test('常量 + 空账本：默认每天 800 次、80% 提醒，used 0 是 ok', async () => {
  const root = await tempRoot();
  try {
    const c = clock();
    const budget = createBudget({ root, now: c.now });
    assert.equal(DEFAULT_DAILY_LIMIT, 800);
    assert.equal(WARN_RATIO, 0.8);

    const st = await budget.status();
    assert.equal(st.limit, 800);
    assert.equal(st.used, 0);
    assert.equal(st.ratio, 0);
    assert.equal(st.level, 'ok');
    assert.equal(st.warnAt, 640);
    assert.equal(st.checkedAt, c.get());
  } finally {
    await cleanup(root);
  }
});

test('用量分三档：<80% ok，>=80% warn，>=100% over', async () => {
  const root = await tempRoot();
  try {
    const c = clock();
    const day = today(c);
    const budget = createBudget({ root, now: c.now });

    for (const [count, level] of [
      [639, 'ok'],
      [640, 'warn'],
      [799, 'warn'],
      [800, 'over'],
      [801, 'over'],
    ]) {
      await seedUsage(root, count, day);
      const st = await budget.status();
      assert.equal(st.used, count, `${count} 次要数对`);
      assert.equal(st.level, level, `${count}/800 应该是 ${level}`);
      assert.ok(Math.abs(st.ratio - count / 800) < 1e-9);
    }
  } finally {
    await cleanup(root);
  }
});

test('checkOptional：ok/warn 放行，over 拒绝且 reason=budget', async () => {
  const root = await tempRoot();
  try {
    const c = clock();
    const day = today(c);
    const budget = createBudget({ root, now: c.now });

    await seedUsage(root, 100, day);
    let res = await budget.checkOptional();
    assert.equal(res.allow, true);
    assert.equal(res.reason, '');
    assert.equal(res.status.level, 'ok');

    await seedUsage(root, 700, day);
    res = await budget.checkOptional();
    assert.equal(res.allow, true, 'warn 也放行，只是该省着点');
    assert.equal(res.status.level, 'warn');

    await seedUsage(root, 800, day);
    res = await budget.checkOptional();
    assert.equal(res.allow, false);
    assert.equal(res.reason, 'budget');
    assert.equal(res.status.level, 'over');
    assert.equal(res.status.used, 800);
  } finally {
    await cleanup(root);
  }
});

test('alert：没到 warn 不喊，也不写 budget.json', async () => {
  const root = await tempRoot();
  try {
    const c = clock();
    const { calls, notify } = fakeNotify(true);
    const budget = createBudget({ root, now: c.now, notify });
    await seedUsage(root, 100, today(c));

    const res = await budget.alert();
    assert.equal(res.alerted, false);
    assert.equal(res.status.level, 'ok');
    assert.equal(calls.length, 0);
    assert.equal(await alertDayOf(root), null);
  } finally {
    await cleanup(root);
  }
});

test('alert：warn 时当天只喊一次，发出去才记 alertDay', async () => {
  const root = await tempRoot();
  try {
    const c = clock();
    const day = today(c);
    const { calls, notify } = fakeNotify(true);
    const budget = createBudget({ root, now: c.now, notify });
    await seedUsage(root, 660, day);

    const first = await budget.alert();
    assert.equal(first.alerted, true);
    assert.equal(calls.length, 1);
    assert.match(calls[0], /小鲸今天的模型调用已经用了 660\/800 次/);
    assert.equal(await alertDayOf(root), day);

    const second = await budget.alert();
    assert.equal(second.alerted, false);
    assert.equal(calls.length, 1, '同一天第二次不喊');

    // 进程重开也不喊：alertDay 在 data/budget.json 里
    const reopened = createBudget({ root, now: c.now, notify });
    assert.equal((await reopened.alert()).alerted, false);
    assert.equal(calls.length, 1);
  } finally {
    await cleanup(root);
  }
});

test('alert：notify 返回 false 不记当天，下一次再试', async () => {
  const root = await tempRoot();
  try {
    const c = clock();
    const day = today(c);
    const outcomes = [false, true];
    const { calls, notify } = fakeNotify(() => outcomes.shift() ?? true);
    const budget = createBudget({ root, now: c.now, notify });
    await seedUsage(root, 640, day);

    const first = await budget.alert();
    assert.equal(first.alerted, false);
    assert.equal(calls.length, 1);
    assert.equal(await alertDayOf(root), null, '没发出去不能记当天');

    const second = await budget.alert();
    assert.equal(second.alerted, true);
    assert.equal(calls.length, 2);
    assert.equal(await alertDayOf(root), day);
  } finally {
    await cleanup(root);
  }
});

test('alert：notify 抛错被吞掉，不记当天，恢复后会重试', async () => {
  const root = await tempRoot();
  try {
    const c = clock();
    const day = today(c);
    const calls = [];
    const throwing = async (text) => {
      calls.push(text);
      throw new Error('QQ 网关连不上');
    };
    const budget = createBudget({ root, now: c.now, notify: throwing });
    await seedUsage(root, 700, day);

    const first = await budget.alert(); // 能正常返回就是没抛
    assert.equal(first.alerted, false);
    assert.equal(calls.length, 1);
    assert.equal(await alertDayOf(root), null);

    const retry = fakeNotify(true);
    const reopened = createBudget({ root, now: c.now, notify: retry.notify });
    const second = await reopened.alert();
    assert.equal(second.alerted, true);
    assert.equal(retry.calls.length, 1);
    assert.equal(await alertDayOf(root), day);
  } finally {
    await cleanup(root);
  }
});

test('alert：已经 over 也提醒（当天只一次）', async () => {
  const root = await tempRoot();
  try {
    const c = clock();
    const { calls, notify } = fakeNotify(true);
    const budget = createBudget({ root, now: c.now, notify });
    await seedUsage(root, 900, today(c));

    const res = await budget.alert();
    assert.equal(res.alerted, true);
    assert.equal(res.status.level, 'over');
    assert.match(calls[0], /用了 900\/800 次/);

    assert.equal((await budget.alert()).alerted, false);
    assert.equal(calls.length, 1);
  } finally {
    await cleanup(root);
  }
});

test('alert：跨天重新提醒一次', async () => {
  const root = await tempRoot();
  try {
    const c = clock();
    const day1 = today(c);
    const { calls, notify } = fakeNotify(true);
    const budget = createBudget({ root, now: c.now, notify });
    await seedUsage(root, 640, day1);
    assert.equal((await budget.alert()).alerted, true);
    assert.equal(await alertDayOf(root), day1);

    c.advance(26 * HOUR);
    const day2 = today(c);
    assert.notEqual(day2, day1);
    await seedUsage(root, 640, day2);

    const second = await budget.alert();
    assert.equal(second.alerted, true, '新的一天该再提醒一次');
    assert.equal(calls.length, 2);
    assert.equal(await alertDayOf(root), day2);
  } finally {
    await cleanup(root);
  }
});

test('坏文件不抛：usage 坏行跳过，budget.json 坏了当空', async () => {
  const root = await tempRoot();
  try {
    const c = clock();
    const day = today(c);
    await seedUsage(root, 640, day, {
      badLines: ['这不是 JSON {{{', '{"at":0}', '{"at":123,"kind":""}', '[]'],
    });
    await mkdir(join(root, 'data'), { recursive: true });
    await writeFile(join(root, 'data/budget.json'), '这不是 JSON {{{', 'utf8');

    const { calls, notify } = fakeNotify(true);
    const budget = createBudget({ root, now: c.now, notify });

    const st = await budget.status(); // 不抛
    assert.equal(st.used, 640, '坏行不算调用次数');
    assert.equal(st.level, 'warn');

    const res = await budget.alert();
    assert.equal(res.alerted, true);
    assert.match(calls[0], /640\/800/);

    // 坏了也能被下一次提醒修复成合法 JSON
    const saved = JSON.parse(await readFile(join(root, 'data/budget.json'), 'utf8'));
    assert.equal(saved.alertDay, day);
  } finally {
    await cleanup(root);
  }
});

test('可配置上限和提醒比例；非法配置退回默认', async () => {
  const root = await tempRoot();
  try {
    const c = clock();
    const day = today(c);
    const budget = createBudget({ root, now: c.now, limit: 10, warnRatio: 0.5 });
    let st = await budget.status();
    assert.equal(st.limit, 10);
    assert.equal(st.warnAt, 5);

    await seedUsage(root, 4, day);
    assert.equal((await budget.status()).level, 'ok');
    await seedUsage(root, 5, day);
    st = await budget.status();
    assert.equal(st.level, 'warn');
    await seedUsage(root, 10, day);
    assert.equal((await budget.status()).level, 'over');

    const weird = createBudget({ root, now: c.now, limit: 0, warnRatio: 9 });
    st = await weird.status();
    assert.equal(st.limit, 800);
    assert.equal(st.warnAt, 640);
  } finally {
    await cleanup(root);
  }
});

test('并发 alert：同一天只喊一次', async () => {
  const root = await tempRoot();
  try {
    const c = clock();
    const { calls, notify } = fakeNotify(true);
    const budget = createBudget({ root, now: c.now, notify });
    await seedUsage(root, 640, today(c));

    const results = await Promise.all([budget.alert(), budget.alert(), budget.alert()]);
    assert.equal(calls.length, 1);
    assert.equal(results.filter((item) => item.alerted).length, 1);
  } finally {
    await cleanup(root);
  }
});