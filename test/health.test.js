import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ALERT_COOLDOWN_MS, COMPONENTS, FAIL_ALERT_AFTER, createHealth } from '../src/health.js';

const HOUR = 3_600_000;
const KNOWN = ['chat', 'mind', 'pat', 'video', 'qzone'];

const tempRoot = () => mkdtemp(join(tmpdir(), 'health-'));
const cleanup = (root) => rm(root, { recursive: true, force: true });

/** 手动时钟：测冷却边界，别真等 6 小时。 */
function clock(start = Date.parse('2026-11-04T12:00:00Z')) {
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

/** 假 notify：记录每次文案；result 可以是布尔，也可以是按调用顺序给值的函数。 */
function fakeNotify(result = true) {
  const calls = [];
  const notify = async (text) => {
    calls.push(text);
    return typeof result === 'function' ? await result(text, calls.length) : result;
  };
  return { calls, notify };
}

async function readSaved(root) {
  return JSON.parse(await readFile(join(root, 'data/health.json'), 'utf8'));
}

const failMind = (health, error = 'DSH 退出码 1') => health.record({ component: 'mind', ok: false, error });

test('常量：连续 3 次才喊，冷却 6 小时', () => {
  assert.equal(FAIL_ALERT_AFTER, 3);
  assert.equal(ALERT_COOLDOWN_MS, 6 * HOUR);
  assert.deepEqual(COMPONENTS, KNOWN);
});

test('status：空目录也有稳定结构，所有组件都在且没有失败', async () => {
  const root = await tempRoot();
  try {
    const c = clock();
    const health = createHealth({ root, now: c.now });
    const st = health.status();

    assert.equal(st.ok, true);
    assert.equal(st.checkedAt, c.get());
    assert.deepEqual(st.failing, []);
    for (const name of KNOWN) {
      assert.ok(st.components[name], `缺组件 ${name}`);
      assert.deepEqual(Object.keys(st.components[name]).sort(), [
        'failing',
        'lastError',
        'lastFailAt',
        'lastOkAt',
        'streak',
      ]);
      assert.equal(st.components[name].failing, false);
      assert.equal(st.components[name].streak, 0);
      assert.equal(st.components[name].lastError, null);
      assert.equal(st.components[name].lastFailAt, null);
      assert.equal(st.components[name].lastOkAt, null);
    }
    // 巡检/测试可以固定时间
    assert.equal(health.status({ now: 1_700_000_000_000 }).checkedAt, 1_700_000_000_000);
  } finally {
    await cleanup(root);
  }
});

test('连续失败到 3 次才喊人，文案像人话，且跨实例接着数', async () => {
  const root = await tempRoot();
  try {
    const c = clock();
    const { calls, notify } = fakeNotify(true);
    const health = createHealth({ root, now: c.now, notify });

    await failMind(health);
    await failMind(health);
    assert.equal(calls.length, 0, '前两次失败不该喊人');

    // 想事进程重开（新实例），失败次数要从 data/health.json 接着数
    const reopened = createHealth({ root, now: c.now, notify });
    await failMind(reopened);

    assert.equal(calls.length, 1, '第三次失败喊一次');
    assert.match(calls[0], /^小鲸这边卡住了：想事连续 3 次失败/);
    assert.match(calls[0], /DSH 退出码 1/);
    assert.match(calls[0], /去 logs\/mind\.log 看一眼/);

    const saved = await readSaved(root);
    assert.equal(saved.alertedAt, c.get());
    assert.equal(saved.components.mind.failStreak, 3);
  } finally {
    await cleanup(root);
  }
});

test('冷却期内不重复喊，过了冷却还在失败再喊一次', async () => {
  const root = await tempRoot();
  try {
    const c = clock();
    const { calls, notify } = fakeNotify(true);
    const health = createHealth({ root, now: c.now, notify });

    await failMind(health);
    await failMind(health);
    await failMind(health);
    assert.equal(calls.length, 1);

    c.advance(1 * HOUR);
    await failMind(health);
    await failMind(health);
    assert.equal(calls.length, 1, '6 小时冷却内不该再喊');

    c.advance(ALERT_COOLDOWN_MS);
    await failMind(health);
    assert.equal(calls.length, 2, '过了冷却还在失败，再喊一次');
    assert.match(calls[1], /想事连续 6 次失败/);
  } finally {
    await cleanup(root);
  }
});

test('冷却边界：刚好等于冷却时间仍在冷却内，多 1ms 才再喊', async () => {
  const root = await tempRoot();
  try {
    const c = clock();
    const { calls, notify } = fakeNotify(true);
    const health = createHealth({ root, now: c.now, notify });

    await failMind(health);
    await failMind(health);
    await failMind(health);
    assert.equal(calls.length, 1);

    c.advance(ALERT_COOLDOWN_MS); // 距今 == 冷却时间，不满足「> 冷却」
    await failMind(health);
    assert.equal(calls.length, 1, '正好 6 小时那一刻还算冷却内');

    c.advance(1);
    await failMind(health);
    assert.equal(calls.length, 2, '超过 1ms 就该再喊');
  } finally {
    await cleanup(root);
  }
});

test('成功一次就清零，新的 streak 不到 3 次不喊', async () => {
  const root = await tempRoot();
  try {
    const c = clock();
    const { calls, notify } = fakeNotify(true);
    const health = createHealth({ root, now: c.now, notify });

    await failMind(health);
    await failMind(health);
    await failMind(health);
    assert.equal(calls.length, 1);

    await health.record({ component: 'mind', ok: true });
    const st = health.status();
    assert.equal(st.ok, true);
    assert.equal(st.components.mind.streak, 0);
    assert.equal(st.components.mind.failing, false);
    assert.ok(st.components.mind.lastOkAt, '成功要记 lastOkAt');

    // 很久以后重新连着失败：旧的那次喊过不该被重复记
    c.advance(ALERT_COOLDOWN_MS + HOUR);
    await failMind(health);
    await failMind(health);
    assert.equal(calls.length, 1, '新 streak 才 2 次，不该喊');
    await failMind(health);
    assert.equal(calls.length, 2);
    assert.match(calls[1], /想事连续 3 次失败/);
  } finally {
    await cleanup(root);
  }
});

test('notify 返回 false：不写 alertedAt，下一条失败再试', async () => {
  const root = await tempRoot();
  try {
    const c = clock();
    const outcomes = [false, true];
    const { calls, notify } = fakeNotify(() => outcomes.shift() ?? true);
    const health = createHealth({ root, now: c.now, notify });

    await failMind(health);
    await failMind(health);
    await failMind(health);
    assert.equal(calls.length, 1, '到阈值试了一次，但没发出去');
    assert.equal((await readSaved(root)).alertedAt, 0, '没发出去不能记 alertedAt');

    await failMind(health);
    assert.equal(calls.length, 2, '下一条失败再试');
    assert.equal((await readSaved(root)).alertedAt, c.get(), '真发出去了才写 alertedAt');

    await failMind(health);
    assert.equal(calls.length, 2, '写进冷却后不再喊');
  } finally {
    await cleanup(root);
  }
});

test('notify 抛错被吞掉：record 不抛，冷却里没记，恢复后还能重试', async () => {
  const root = await tempRoot();
  try {
    const c = clock();
    const calls = [];
    const notify = async (text) => {
      calls.push(text);
      throw new Error('QQ 网关连不上');
    };
    const health = createHealth({ root, now: c.now, notify });

    // notify 一直抛错，但 record 必须正常 resolve（这里能 await 完就是没抛）
    for (let i = 0; i < 3; i += 1) await failMind(health);
    assert.equal(calls.length, 1);
    assert.equal((await readSaved(root)).alertedAt, 0);

    const st = health.status();
    assert.equal(st.ok, false);
    assert.deepEqual(st.failing, [{ component: 'mind', streak: 3, lastError: 'DSH 退出码 1' }]);

    // 换一个能发出去的 notify：下一条失败会重新试
    const retry = fakeNotify(true);
    const reopened = createHealth({ root, now: c.now, notify: retry.notify });
    await failMind(reopened);
    assert.equal(retry.calls.length, 1);
    assert.equal((await readSaved(root)).alertedAt, c.get());
  } finally {
    await cleanup(root);
  }
});

test('多组件各自计数，一个清零不影响别的', async () => {
  const root = await tempRoot();
  try {
    const c = clock();
    const { calls, notify } = fakeNotify(true);
    const health = createHealth({ root, now: c.now, notify });

    await health.record({ component: 'chat', ok: false, error: '发送失败' });
    await health.record({ component: 'chat', ok: false, error: '发送失败' });
    await health.record({ component: 'mind', ok: false, error: 'DSH 退出码 1' });
    await health.record({ component: 'video', ok: true });
    assert.equal(calls.length, 0, '都没到阈值，不该喊');

    let st = health.status();
    assert.equal(st.ok, false);
    assert.equal(st.components.chat.streak, 2);
    assert.equal(st.components.mind.streak, 1);
    assert.equal(st.components.video.streak, 0);
    assert.equal(st.components.video.failing, false);
    assert.deepEqual(st.failing.map((f) => f.component), ['chat', 'mind']);

    // chat 好了：只清 chat，mind 还连着失败
    await health.record({ component: 'chat', ok: true });
    st = health.status();
    assert.equal(st.components.chat.streak, 0);
    assert.equal(st.components.chat.failing, false);
    assert.equal(st.components.mind.streak, 1);
    assert.equal(st.components.mind.failing, true);
    assert.deepEqual(st.failing, [{ component: 'mind', streak: 1, lastError: 'DSH 退出码 1' }]);
  } finally {
    await cleanup(root);
  }
});

test('冷却按全局算：刚喊过一次，另一个组件到阈值也先不喊', async () => {
  const root = await tempRoot();
  try {
    const c = clock();
    const { calls, notify } = fakeNotify(true);
    const health = createHealth({ root, now: c.now, notify });

    await failMind(health);
    await failMind(health);
    await failMind(health);
    assert.equal(calls.length, 1);

    await health.record({ component: 'chat', ok: false, error: '发送失败' });
    await health.record({ component: 'chat', ok: false, error: '发送失败' });
    await health.record({ component: 'chat', ok: false, error: '发送失败' });
    assert.equal(calls.length, 1, '全局冷却中，chat 到 3 次也不喊');

    c.advance(ALERT_COOLDOWN_MS + 1);
    await failMind(health);
    assert.equal(calls.length, 2);
    assert.match(calls[1], /想事连续 4 次失败/);
  } finally {
    await cleanup(root);
  }
});

test('坏文件不抛：当空处理，下一次 record 重写成合法 JSON', async () => {
  const root = await tempRoot();
  try {
    const c = clock();
    await mkdir(join(root, 'data'), { recursive: true });
    await writeFile(join(root, 'data/health.json'), '这不是 JSON {{{', 'utf8');

    const { calls, notify } = fakeNotify(true);
    const health = createHealth({ root, now: c.now, notify });

    let st;
    assert.doesNotThrow(() => {
      st = health.status();
    });
    assert.equal(st.ok, true);
    assert.deepEqual(st.failing, []);

    for (let i = 0; i < 3; i += 1) {
      await health.record({ component: 'pat', ok: false, error: '摸头反应写盘失败' });
    }
    assert.equal(calls.length, 1);
    assert.match(calls[0], /摸摸连续 3 次失败/);
    assert.match(calls[0], /去 logs\/ 看一眼/); // pat 没有专属日志，别指错路

    const saved = await readSaved(root);
    assert.equal(saved.components.pat.failStreak, 3);
    assert.equal(saved.alertedAt, c.get());

    // 合法 JSON 但形状不对的，也当空
    for (const payload of ['[]', '{"components":"nope"}', 'null']) {
      await writeFile(join(root, 'data/health.json'), payload, 'utf8');
      assert.equal(health.status().ok, true);
      await assert.doesNotReject(() => health.record({ component: 'qzone', ok: true }));
    }
  } finally {
    await cleanup(root);
  }
});

test('lastError 最多 200 字，喊人的文案不会太长', async () => {
  const root = await tempRoot();
  try {
    const c = clock();
    const { calls, notify } = fakeNotify(true);
    const health = createHealth({ root, now: c.now, notify });

    const long = 'x'.repeat(500);
    await failMind(health, long);
    await failMind(health, long);
    await failMind(health, long);

    const st = health.status();
    assert.equal(st.components.mind.lastError.length, 200);
    assert.equal(calls.length, 1);
    assert.ok(calls[0].includes('x'.repeat(80)), '文案里保留前 80 字错误信息');
    assert.equal(calls[0].includes('x'.repeat(81)), false, '文案里不要整段 500 字');
  } finally {
    await cleanup(root);
  }
});

test('record 参数缺失也不抛，坏调用当无事发生', async () => {
  const root = await tempRoot();
  try {
    const c = clock();
    const health = createHealth({ root, now: c.now });

    await assert.doesNotReject(() => health.record());
    await assert.doesNotReject(() => health.record({ component: '   ', ok: false }));
    assert.equal(health.status().ok, true);
    assert.deepEqual(health.status().failing, []);
  } finally {
    await cleanup(root);
  }
});