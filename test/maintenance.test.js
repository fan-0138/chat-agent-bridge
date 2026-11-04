import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { runMaintenance } from '../scripts/maintenance.mjs';

const execFileAsync = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');
// 固定本地时间，备份文件名（YYYY-MM-DD）跑多久都稳
const NOW = new Date(2026, 10, 4, 10, 0, 0).getTime();
const quiet = { debug() {}, info() {}, warn() {}, error() {} };

async function tempRoot(t) {
  const root = await mkdtemp(join(tmpdir(), 'maintenance-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function put(root, rel, content) {
  const file = join(root, rel);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, content, 'utf8');
  return file;
}

async function exists(file) {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
}

/** 一行一个 JSON 的测试数据。 */
function jsonl(count, prefix = 'row') {
  const rows = [];
  for (let i = 0; i < count; i += 1) rows.push(JSON.stringify({ i, text: `${prefix}-${i}` }));
  return `${rows.join('\n')}\n`;
}

function lineCount(text) {
  return text ? text.trimEnd().split('\n').length : 0;
}

/* ────────────────────────── dryRun ────────────────────────── */

test('dryRun：只返回计划，不改任何文件、不建 backups', async (t) => {
  const root = await tempRoot(t);
  await put(root, 'logs/big.log', 'x'.repeat(300));
  await put(root, 'logs/small.log', 'tiny');
  await put(root, 'data/douyin/seen.jsonl', jsonl(5007));
  await put(root, 'data/qq/audit.jsonl', jsonl(10));
  await put(root, 'data/memory/facts.jsonl', '{"a":1}\n');

  const bigSize = (await stat(join(root, 'logs/big.log'))).size;
  const seenSize = (await stat(join(root, 'data/douyin/seen.jsonl'))).size;

  const result = await runMaintenance({ root, now: () => NOW, dryRun: true, maxLogBytes: 100, log: quiet });

  assert.deepEqual(
    result.rotated.map((item) => item.file),
    ['logs/big.log'],
  );
  assert.equal(result.rotated[0].to, 'logs/big.log.1');
  assert.equal(result.rotated[0].size, bigSize);
  assert.deepEqual(
    result.trimmed.map((item) => item.file),
    ['data/douyin/seen.jsonl'],
  );
  assert.equal(result.trimmed[0].before, 5007);
  assert.equal(result.trimmed[0].after, 5000);
  assert.equal(result.backup?.path, 'backups/2026-11-04.tgz');
  assert.equal(result.backup?.bytes, 0);

  // 一个文件都没动
  assert.equal(await exists(join(root, 'logs/big.log.1')), false);
  assert.equal((await stat(join(root, 'logs/big.log'))).size, bigSize);
  assert.equal(await exists(join(root, 'logs/small.log.1')), false);
  assert.equal((await stat(join(root, 'data/douyin/seen.jsonl'))).size, seenSize);
  assert.equal(await exists(join(root, 'data/douyin/seen.jsonl.bak')), false);
  assert.equal(await exists(join(root, 'backups')), false);
});

/* ────────────────────────── 日志轮转 ────────────────────────── */

test('真跑：日志超过阈值才轮转，旧代后移，超出 keep 的清掉', async (t) => {
  const root = await tempRoot(t);
  await put(root, 'logs/big.log', 'NEW'.repeat(40));
  await put(root, 'logs/big.log.1', 'OLD1');
  await put(root, 'logs/big.log.2', 'OLD2');
  await put(root, 'logs/big.log.5', 'STALE');
  await put(root, 'logs/small.log', 'tiny');

  const result = await runMaintenance({ root, now: () => NOW, maxLogBytes: 100, keep: 2, log: quiet });

  assert.deepEqual(
    result.rotated.map((item) => item.file),
    ['logs/big.log'],
  );
  // 只 rename：原路径没了，内容在 .1；旧 .1 变 .2
  assert.equal(await exists(join(root, 'logs/big.log')), false);
  assert.equal(await readFile(join(root, 'logs/big.log.1'), 'utf8'), 'NEW'.repeat(40));
  assert.equal(await readFile(join(root, 'logs/big.log.2'), 'utf8'), 'OLD1');
  assert.equal(await exists(join(root, 'logs/big.log.5')), false, '超出 keep 的旧代要清掉');
  // 没超阈值的不动
  assert.equal(await readFile(join(root, 'logs/small.log'), 'utf8'), 'tiny');
  assert.equal(await exists(join(root, 'logs/small.log.1')), false);
});

/* ────────────────────────── jsonl 裁剪 ────────────────────────── */

test('真跑：seen/audit 各留最后 5000 行、先存 .bak；别的文件不动', async (t) => {
  const root = await tempRoot(t);
  const seenRows = [];
  for (let i = 0; i < 5003; i += 1) seenRows.push(JSON.stringify({ i, text: `seen-${i}` }));
  await put(root, 'data/douyin/seen.jsonl', `${seenRows.join('\n')}\n`);
  // audit 正好 5000 行：不该被裁，也不该留 .bak
  await put(root, 'data/qq/audit.jsonl', jsonl(5000, 'audit'));
  // 远超 5000 行，但不在白名单，必须原样
  const mind = `${Array.from({ length: 9000 }, (_, i) => JSON.stringify({ at: i, text: `think-${i}` })).join('\n')}\n`;
  await put(root, 'data/mind/stream.jsonl', mind);
  await put(root, 'data/memory/facts.jsonl', '{"subject":"爸爸","key":"名字","value":"小鲸"}\n');
  await put(root, 'data/scrapbook/index.jsonl', '{"at":1,"path":"data/scrapbook/img/a.png"}\n');

  const result = await runMaintenance({ root, now: () => NOW, log: quiet });

  assert.equal(result.trimmed.length, 1);
  assert.equal(result.trimmed[0].file, 'data/douyin/seen.jsonl');
  assert.equal(result.trimmed[0].before, 5003);
  assert.equal(result.trimmed[0].after, 5000);

  const kept = (await readFile(join(root, 'data/douyin/seen.jsonl'), 'utf8')).trimEnd().split('\n');
  assert.equal(kept.length, 5000);
  assert.equal(kept[0], seenRows[3], '保留的是最后 5000 行');
  assert.equal(kept.at(-1), seenRows.at(-1));

  const backup = (await readFile(join(root, 'data/douyin/seen.jsonl.bak'), 'utf8')).trimEnd().split('\n');
  assert.equal(backup.length, 5003, '.bak 是裁剪前的整份');

  assert.equal(await exists(join(root, 'data/qq/audit.jsonl.bak')), false);
  assert.equal(lineCount(await readFile(join(root, 'data/qq/audit.jsonl'), 'utf8')), 5000);

  // 只读：这三处一个字都不能动
  assert.equal(await readFile(join(root, 'data/mind/stream.jsonl'), 'utf8'), mind);
  assert.equal(await readFile(join(root, 'data/memory/facts.jsonl'), 'utf8'), '{"subject":"爸爸","key":"名字","value":"小鲸"}\n');
  assert.equal(await readFile(join(root, 'data/scrapbook/index.jsonl'), 'utf8'), '{"at":1,"path":"data/scrapbook/img/a.png"}\n');
});

test('裁剪只数行不解析 JSON：保留区里的坏行原样留着', async (t) => {
  const root = await tempRoot(t);
  const rows = ['这不是 JSON'];
  for (let i = 0; i < 5002; i += 1) rows.push(JSON.stringify({ i }));
  rows.splice(-2, 0, '{"坏行":'); // 落在最后 5000 行里
  await put(root, 'data/qq/audit.jsonl', `${rows.join('\n')}\n`);

  const result = await runMaintenance({ root, now: () => NOW, log: quiet });
  assert.equal(result.trimmed.length, 1);
  assert.equal(result.trimmed[0].before, rows.length);
  assert.equal(result.trimmed[0].after, 5000);

  const kept = await readFile(join(root, 'data/qq/audit.jsonl'), 'utf8');
  assert.equal(lineCount(kept), 5000);
  // 头部那行坏行跟着被裁掉了；保留区里的坏行不解析、原样留着
  assert.doesNotMatch(kept, /这不是 JSON/);
  assert.match(kept, /\{"坏行":/);
});

/* ────────────────────────── 备份 ────────────────────────── */

test('备份：清单里的路径进 tgz，doc/记忆 缺失记进 skipped', async (t) => {
  const root = await tempRoot(t);
  await put(root, 'data/memory/facts.jsonl', 'fact\n');
  await put(root, 'data/memory/episodes.jsonl', 'episode\n');
  await put(root, 'data/mind/memory.jsonl', 'mind\n');
  await put(root, 'data/mind/stream.jsonl', 'stream\n');
  await put(root, 'data/mind/longterm.jsonl', 'long\n');
  await put(root, 'data/mind/longterm-state.json', '{}\n');
  await put(root, 'data/scrapbook/index.jsonl', 'index\n');
  await put(root, 'persona.md', '# 人设\n');
  await put(root, 'persona.traits.json', '{}\n');
  // docs/记忆.md 故意不建 → 应该跳过而不是报错

  const result = await runMaintenance({ root, now: () => NOW, log: quiet });

  assert.ok(result.backup, '有东西可备份就该打包');
  assert.equal(result.backup.path, 'backups/2026-11-04.tgz');
  assert.ok(result.backup.bytes > 0);

  const archive = join(root, result.backup.path);
  assert.equal(await exists(archive), true);

  const { stdout } = await execFileAsync('tar', ['-tzf', archive]);
  for (const expected of [
    'data/memory/facts.jsonl',
    'data/mind/memory.jsonl',
    'data/mind/stream.jsonl',
    'data/mind/longterm.jsonl',
    'data/mind/longterm-state.json',
    'data/scrapbook/index.jsonl',
    'persona.md',
    'persona.traits.json',
  ]) {
    assert.ok(stdout.includes(expected), `tgz 里缺 ${expected}`);
  }
  assert.equal(stdout.includes('docs/记忆.md'), false);
  assert.match(result.skipped ?? '', /docs\/记忆\.md/);
});

test('备份保留最近 keepBackups 份：按文件名删旧的，别的文件不动', async (t) => {
  const root = await tempRoot(t);
  for (const day of ['2026-01-01', '2026-01-02', '2026-01-03', '2026-01-04', '2026-01-05']) {
    await put(root, `backups/${day}.tgz`, 'old');
  }
  await put(root, 'backups/notes.txt', '别动我');
  await put(root, 'data/memory/facts.jsonl', 'fact\n');

  const result = await runMaintenance({ root, now: () => NOW, keepBackups: 3, log: quiet });

  assert.ok(result.backup);
  assert.deepEqual((await readdir(join(root, 'backups'))).sort(), [
    '2026-01-04.tgz',
    '2026-01-05.tgz',
    '2026-11-04.tgz',
    'notes.txt',
  ]);
});

test('空目录：什么都不做、不建 backups 目录、不抛', async (t) => {
  const root = await tempRoot(t);
  const result = await runMaintenance({ root, now: () => NOW, log: quiet });
  assert.deepEqual(result.rotated, []);
  assert.deepEqual(result.trimmed, []);
  assert.equal(result.backup, null);
  assert.equal(await exists(join(root, 'backups')), false);
  assert.ok(result.warnings.some((warning) => warning.includes('没有可备份')));
});

/* ────────────────────────── 容错 ────────────────────────── */

test('坏路径不抛：logs 是文件、jsonl 读不了、backupDir 被占', async (t) => {
  const root = await tempRoot(t);
  await put(root, 'logs', '我不是目录');
  await mkdir(join(root, 'data/douyin/seen.jsonl'), { recursive: true }); // readFile → EISDIR
  await put(root, 'data/memory/facts.jsonl', 'fact\n');
  await put(root, 'backup-dir', '我是文件，不是目录');

  const result = await runMaintenance({ root, now: () => NOW, backupDir: 'backup-dir', log: quiet });

  assert.deepEqual(result.rotated, []);
  assert.deepEqual(result.trimmed, []);
  assert.equal(result.backup, null);
  assert.ok(Array.isArray(result.warnings));
  assert.ok(result.warnings.length >= 3, `失败都要记下来，实际：${result.warnings.join(' / ')}`);
});

/* ────────────────────────── CLI ────────────────────────── */

test('CLI：--dry-run 只打印计划，退出码 0、不落地', async (t) => {
  const root = await tempRoot(t);
  await put(root, 'logs/big.log', 'x'.repeat(300));
  await put(root, 'data/memory/facts.jsonl', 'fact\n');
  const script = resolve(REPO, 'scripts/maintenance.mjs');

  const { stdout } = await execFileAsync(
    process.execPath,
    [script, '--dry-run', '--root', root, '--max-log-mb', '0.00001'],
    { cwd: REPO, timeout: 30_000 },
  );

  assert.match(stdout, /dryRun/);
  assert.match(stdout, /日志轮转|轮转 logs\/big\.log/);
  assert.equal(await exists(join(root, 'logs/big.log.1')), false);
  assert.equal(await exists(join(root, 'backups')), false);
});