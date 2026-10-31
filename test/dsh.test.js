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
