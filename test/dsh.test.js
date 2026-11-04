import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDshRunner } from '../src/dsh.js';

const silentLog = { debug() {}, info() {}, warn() {}, error() {} };

async function mockBinary(script) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-mock-'));
  const file = join(dir, 'dsh');
  await writeFile(file, `#!/bin/sh\n${script}\n`, 'utf8');
  await chmod(file, 0o755);
  return file;
}

function runnerFor(command, timeoutMs = 5_000) {
  return createDshRunner({
    command,
    profile: 'headless',
    cwd: process.cwd(),
    timeoutMs,
    log: silentLog,
  });
}

test('把 dsh 的最后一段输出作为回复返回', async () => {
  const bin = await mockBinary('printf "思考中...\\n\\n这是最终回复。\\n"');
  const result = await runnerFor(bin).run('你好');
  assert.equal(result.text, '思考中...\n\n这是最终回复。');
});

test('非零退出码抛出 DshError 并带 stderr', async () => {
  const bin = await mockBinary('echo "model auth failed" >&2; exit 3');
  await assert.rejects(runnerFor(bin).run('你好'), (error) => {
    assert.equal(error.name, 'DshError');
    assert.equal(error.code, 3);
    assert.match(error.stderr, /model auth failed/);
    return true;
  });
});

test('超时会杀掉子进程并标记 timedOut', async () => {
  const bin = await mockBinary('sleep 30');
  const started = Date.now();
  await assert.rejects(runnerFor(bin, 300).run('你好'), (error) => {
    assert.equal(error.timedOut, true);
    return true;
  });
  assert.ok(Date.now() - started < 5_000, '超时后应尽快返回');
});

test('空输出视为失败，避免把空消息发到微信', async () => {
  const bin = await mockBinary('printf "   \\n"');
  await assert.rejects(runnerFor(bin).run('你好'), /没有返回任何文本/);
});

test('ANSI 控制码会被清掉', async () => {
  const bin = await mockBinary('printf "\\033[31m红色\\033[0m 回复\\n"');
  const result = await runnerFor(bin).run('你好');
  assert.equal(result.text, '红色 回复');
});

test('权限模式会传进 dsh 子进程（cleanEnv 会滤掉 DSH_*，必须显式塞回）', async () => {
  const bin = await mockBinary('printf "MODE=%s\\n" "$DSH_PERMISSION_MODE"');
  const runner = createDshRunner({
    command: bin,
    profile: 'headless',
    cwd: process.cwd(),
    timeoutMs: 5_000,
    permissionMode: 'danger-full-access',
    log: silentLog,
  });
  const result = await runner.run('跑一下');
  assert.match(result.text, /MODE=danger-full-access/);
});

test('没配权限模式就不设（用 dsh 自己的默认 workspace-write）', async () => {
  const bin = await mockBinary('printf "MODE=[%s]\\n" "$DSH_PERMISSION_MODE"');
  const result = await runnerFor(bin).run('跑一下');
  assert.match(result.text, /MODE=\[\]/);
});

test('换 key 不用重启：每次调用都现取', async () => {
  const bin = await mockBinary('printf "%s\\n" "$DEEPSEEK_API_KEY"');
  let current = 'sk-old-key';
  const runner = createDshRunner({
    command: bin,
    profile: 'headless',
    cwd: process.cwd(),
    timeoutMs: 5_000,
    log: silentLog,
    apiKey: async () => current,
  });
  const first = await runner.run('hi');
  assert.equal(first.text.trim(), 'sk-old-key');
  current = 'sk-new-key';
  const second = await runner.run('hi');
  assert.equal(second.text.trim(), 'sk-new-key', '第二次应该拿到新 key，不用重启');
});

test('usage 钩子：成功、失败、超时都记，重试各记一次，钩子抛错不影响聊天', async () => {
  const seen = [];
  const usage = (record) => {
    seen.push(record);
  };

  // 成功：ok、字数、耗时都对得上
  const okBin = await mockBinary('printf "回答了一句话\\n"');
  const okRunner = createDshRunner({
    command: okBin,
    profile: 'headless',
    cwd: process.cwd(),
    timeoutMs: 5_000,
    log: silentLog,
    usage,
  });
  const prompt = '你好呀';
  const result = await okRunner.run(prompt);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].ok, true);
  assert.equal(seen[0].inChars, prompt.length);
  assert.equal(seen[0].outChars, result.text.length);
  assert.ok(seen[0].ms >= 0);

  // 失败（非零退出）也要记，ok:false
  seen.length = 0;
  const badBin = await mockBinary('echo "model auth failed" >&2; exit 3');
  const badRunner = createDshRunner({
    command: badBin,
    profile: 'headless',
    cwd: process.cwd(),
    timeoutMs: 5_000,
    log: silentLog,
    usage,
  });
  await assert.rejects(badRunner.run('你好'));
  assert.equal(seen.length, 1);
  assert.equal(seen[0].ok, false);
  assert.equal(seen[0].inChars, 2);
  assert.equal(seen[0].outChars, 0);

  // 超时也算一次调用
  seen.length = 0;
  const slowBin = await mockBinary('sleep 30');
  const slowRunner = createDshRunner({
    command: slowBin,
    profile: 'headless',
    cwd: process.cwd(),
    timeoutMs: 300,
    log: silentLog,
    usage,
  });
  await assert.rejects(slowRunner.run('你好'), (error) => error.timedOut === true);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].ok, false);

  // 钩子自己抛错，绝不能把聊天带崩
  const throwingRunner = createDshRunner({
    command: okBin,
    profile: 'headless',
    cwd: process.cwd(),
    timeoutMs: 5_000,
    log: silentLog,
    usage: () => {
      throw new Error('统计炸了');
    },
  });
  const still = await throwingRunner.run('你好');
  assert.equal(still.text, '回答了一句话');

  // 偶发失败重试：每一次尝试各记一笔
  seen.length = 0;
  const counter = join(await mkdtemp(join(tmpdir(), 'dsh-usage-')), 'n');
  const retryBin = await mockBinary(
    `n=$(cat "${counter}" 2>/dev/null || echo 0); n=$((n+1)); echo $n > "${counter}"; ` +
      'if [ "$n" -eq 1 ]; then echo "socket hang up" >&2; exit 1; fi; printf "第二次成功\\n"',
  );
  const retryRunner = createDshRunner({
    command: retryBin,
    profile: 'headless',
    cwd: process.cwd(),
    timeoutMs: 5_000,
    log: silentLog,
    usage,
  });
  const second = await retryRunner.run('再来');
  assert.equal(second.text, '第二次成功');
  assert.equal(seen.length, 2, '重试的两次尝试各记一笔');
  assert.deepEqual(seen.map((record) => record.ok), [false, true]);
});
