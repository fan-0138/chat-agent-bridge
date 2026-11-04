#!/usr/bin/env node
/**
 * 数据维护：日志轮转、超长 jsonl 裁剪、备份。
 *
 * 她一直跑，logs/*.log 和审计文件会无限长；data/ 里只有本机一份，坏了就没了。
 * 这个脚本只做三件小事，处处「能省则省」：
 *   1. logs/*.log 超过 10MB 就改名成 .log.1（只 rename，不复制、不截断——正在写的进程
 *      手里那个句柄的内容不能动，截断会把日志写坏）
 *   2. data/douyin/seen.jsonl、data/qq/audit.jsonl 只留最后 5000 行（先存 .bak）
 *   3. 把记忆 / 相册 / 人设 / 记忆文档打包成 backups/YYYY-MM-DD.tgz，只留最近 7 份
 *
 * 边界：
 *   - 只碰这三处。data/memory、data/mind、data/scrapbook 只读、只打包，绝不裁剪。
 *   - 任何一步失败都吞掉，写进返回的 warnings / skipped，绝不让维护脚本把主流程带崩。
 *   - dryRun 只算不动，先看计划再真跑。
 *
 *   node scripts/maintenance.mjs              # 真跑
 *   node scripts/maintenance.mjs --dry-run    # 只看计划
 *   node scripts/maintenance.mjs --root /path --backup-dir backups --keep-backups 7
 */

import { execFile } from 'node:child_process';
import { copyFile, mkdir, readFile, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/* ────────────────────────── 常量 ────────────────────────── */

/** 超长 jsonl 只留最后这么多行。 */
export const TRIM_KEEP_LINES = 5000;

/** 只裁这两个文件；别的 jsonl 一个字都不动。 */
export const TRIM_FILES = ['data/douyin/seen.jsonl', 'data/qq/audit.jsonl'];

/** 默认 10MB。 */
const DEFAULT_MAX_LOG_BYTES = 10 * 1024 * 1024;

/** 备份清单：目录和单文件混着写；不存在的跳过。 */
export const BACKUP_PATHS = [
  'data/memory',
  'data/mind/memory.jsonl',
  'data/mind/stream.jsonl',
  'data/scrapbook',
  'persona.md',
  'persona.traits.json',
  'docs/记忆.md',
];

/** data/mind 下以 longterm 开头的文件（长期记忆模块的产出）也带上。 */
const LONGTERM_DIR = 'data/mind';
const LONGTERM_PREFIX = 'longterm';

const TAR_TIMEOUT_MS = 120_000;

/* ────────────────────────── 小工具 ────────────────────────── */

/** 坏数字一律退回 fallback，别让 NaN 把阈值变成「永不触发」。 */
function numberOr(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/** now 允许传函数（项目里常见写法），也兼容直接传时间戳；拿不到就用当下。 */
function clockOf(now) {
  try {
    const value = typeof now === 'function' ? now() : now;
    return numberOr(value, Date.now());
  } catch {
    return Date.now();
  }
}

/** 本地时区的 YYYY-MM-DD——备份文件名要跟日志里看到的「今天」一致。 */
function localDateOf(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** root 相对路径统一用 / 拼，报告和测试都好认。 */
function relOf(base, file) {
  return relative(base, file).split(sep).join('/');
}

/** 一行一个 JSON：按行拆，最后那个空串不算一行。 */
function linesOf(raw) {
  if (!raw) return [];
  const lines = String(raw).split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

function messageOf(error) {
  return String(error?.message ?? error);
}

async function pathExists(file) {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
}

/** 文件不存在算正常，别的错误抛出去让上层记 warning。 */
async function removeIfExists(file) {
  try {
    await unlink(file);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

async function renameIfExists(from, to) {
  try {
    await rename(from, to);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

/* ────────────────────────── 1. 日志轮转 ────────────────────────── */

/**
 * logs/*.log 超过阈值就改名：.log → .log.1，原来的 .log.1 → .log.2 …
 * 只 rename。正在写的进程句柄跟着旧 inode 走，内容不丢；不做「复制再截断」那套。
 */
async function rotateLogs({ base, dryRun, maxLogBytes, keep, warnings }) {
  const dir = join(base, 'logs');
  let names = [];
  try {
    names = await readdir(dir);
  } catch (error) {
    // 还没有 logs 目录是正常情况，别当故障
    if (error?.code !== 'ENOENT') warnings.push(`读 logs 目录失败：${messageOf(error)}`);
    return [];
  }

  const rotated = [];
  for (const name of names.filter((n) => n.endsWith('.log')).sort()) {
    const file = join(dir, name);
    let info = null;
    try {
      info = await stat(file);
    } catch {
      continue; // 刚好被删了，跳过
    }
    if (!info.isFile() || info.size <= maxLogBytes) continue;

    rotated.push({ file: `logs/${name}`, size: info.size, to: `logs/${name}.1` });
    if (dryRun) continue;

    try {
      // 先把「超出 keep 的旧代」清掉：.log.2 起都不要，免得越堆越多。
      // 从 names 快照里算，重命名过程中目录内容会变。
      for (const other of names) {
        if (!other.startsWith(`${name}.`)) continue;
        const generation = Number(other.slice(name.length + 1));
        if (!Number.isInteger(generation) || generation < keep) continue;
        await removeIfExists(join(dir, other));
      }
      // 再整串往后挪：.log.(keep-1) → .log.keep … .log.1 → .log.2
      for (let generation = keep - 1; generation >= 1; generation -= 1) {
        await renameIfExists(join(dir, `${name}.${generation}`), join(dir, `${name}.${generation + 1}`));
      }
      // 最后当前日志变成 .log.1；原路径消失，进程继续写它手里的旧文件
      await rename(file, join(dir, `${name}.1`));
    } catch (error) {
      warnings.push(`轮转 logs/${name} 失败：${messageOf(error)}`);
    }
  }
  return rotated;
}

/* ────────────────────────── 2. jsonl 裁剪 ────────────────────────── */

/**
 * 只裁白名单里的两个文件：超过 5000 行就留最后 5000 行。
 * 先 copy 成 .bak 再写；备份失败就不裁（宁可先不裁，也不能把审计弄丢）。
 */
async function trimJsonlFiles({ base, dryRun, warnings }) {
  const trimmed = [];
  for (const rel of TRIM_FILES) {
    const file = join(base, rel);
    let raw = '';
    try {
      raw = await readFile(file, 'utf8');
    } catch (error) {
      if (error?.code !== 'ENOENT') warnings.push(`读 ${rel} 失败：${messageOf(error)}`);
      continue;
    }
    const lines = linesOf(raw);
    if (lines.length <= TRIM_KEEP_LINES) continue;

    const plan = { file: rel, before: lines.length, after: TRIM_KEEP_LINES, backup: `${rel}.bak` };
    if (dryRun) {
      trimmed.push(plan);
      continue;
    }

    try {
      await copyFile(file, `${file}.bak`); // 覆盖旧 .bak
      await writeFile(file, `${lines.slice(-TRIM_KEEP_LINES).join('\n')}\n`, 'utf8');
      trimmed.push(plan);
    } catch (error) {
      warnings.push(`裁剪 ${rel} 失败：${messageOf(error)}`);
    }
  }
  return trimmed;
}

/* ────────────────────────── 3. 备份 ────────────────────────── */

/** 收集要打包的路径：清单 + data/mind/longterm*；不存在的记 skipped。 */
async function collectBackupEntries({ base, skipped }) {
  const entries = [];
  for (const rel of BACKUP_PATHS) {
    if (await pathExists(join(base, rel))) entries.push(rel);
    else skipped.push(rel);
  }

  try {
    const names = await readdir(join(base, LONGTERM_DIR));
    for (const name of names.sort()) {
      if (!name.startsWith(LONGTERM_PREFIX)) continue;
      const rel = `${LONGTERM_DIR}/${name}`;
      if (!entries.includes(rel)) entries.push(rel);
    }
  } catch {
    /* 没有 data/mind 就是没有长期记忆文件 */
  }
  return entries;
}

/** 按文件名排序，只留最后 keepBackups 个 archive。别的文件（notes 之类）不动。 */
async function pruneBackups({ dir, keepBackups, warnings }) {
  let names = [];
  try {
    names = await readdir(dir);
  } catch (error) {
    warnings.push(`读备份目录失败：${messageOf(error)}`);
    return;
  }
  const archives = names.filter((name) => /^\d{4}-\d{2}-\d{2}\.tgz$/.test(name)).sort();
  const excess = archives.length - keepBackups;
  if (excess <= 0) return;
  for (const name of archives.slice(0, excess)) {
    try {
      await unlink(join(dir, name));
    } catch (error) {
      warnings.push(`删旧备份 ${name} 失败：${messageOf(error)}`);
    }
  }
}

/**
 * 用系统 tar 打包（不引第三方依赖）。路径不存在就跳过那一项；
 * 一个都不存在就干脆不备份，省得留个空包。
 */
async function makeBackup({ base, dryRun, clock, backupDir, keepBackups, warnings, skipped }) {
  const dir = resolve(base, String(backupDir || 'backups'));
  const archive = join(dir, `${localDateOf(clock)}.tgz`);
  const entries = await collectBackupEntries({ base, skipped });
  const relPath = relOf(base, archive);
  if (entries.length === 0) {
    warnings.push('没有可备份的文件，备份跳过');
    return null;
  }
  if (dryRun) return { path: relPath, bytes: 0 };

  try {
    await mkdir(dir, { recursive: true });
    // -C 到仓库根，包里的路径就是 data/... 这种相对路径，解包时不会跑到别处
    await execFileAsync('tar', ['-czf', archive, '-C', base, ...entries], { timeout: TAR_TIMEOUT_MS });
    const info = await stat(archive);
    if (!info.isFile() || info.size <= 0) throw new Error('打包出来是空文件');
    await pruneBackups({ dir, keepBackups, warnings });
    return { path: relPath, bytes: info.size };
  } catch (error) {
    warnings.push(`备份失败：${messageOf(error)}`);
    await unlink(archive).catch(() => {}); // 半截包别留着占地方
    return null;
  }
}

/* ────────────────────────── 对外入口 ────────────────────────── */

/**
 * 跑一遍维护。
 *
 * @param {{
 *   root?: string,
 *   now?: (() => number) | number,
 *   log?: any,
 *   dryRun?: boolean,
 *   backupDir?: string,
 *   keepBackups?: number,
 *   maxLogBytes?: number,
 *   keep?: number,
 * }} [options]
 * @returns {Promise<{ rotated: Array<{file: string, size: number, to: string}>,
 *   trimmed: Array<{file: string, before: number, after: number, backup: string}>,
 *   backup: {path: string, bytes: number} | null,
 *   skipped?: string, warnings: string[] }>}
 */
export async function runMaintenance({
  root = process.cwd(),
  now = Date.now,
  log = console,
  dryRun = false,
  backupDir = 'backups',
  keepBackups = 7,
  maxLogBytes = DEFAULT_MAX_LOG_BYTES,
  keep = 2,
} = {}) {
  const warnings = [];
  const skipped = [];
  const result = { rotated: [], trimmed: [], backup: null, warnings };
  const dry = Boolean(dryRun);

  try {
    const base = resolve(String(root || process.cwd()));
    const clock = clockOf(now);
    const logMax = Math.max(0, numberOr(maxLogBytes, DEFAULT_MAX_LOG_BYTES));
    const keepGenerations = Math.max(1, Math.floor(numberOr(keep, 2)));
    const keepArchives = Math.max(1, Math.floor(numberOr(keepBackups, 7)));

    result.rotated = await rotateLogs({ base, dryRun: dry, maxLogBytes: logMax, keep: keepGenerations, warnings });
    result.trimmed = await trimJsonlFiles({ base, dryRun: dry, warnings });
    result.backup = await makeBackup({
      base,
      dryRun: dry,
      clock,
      backupDir,
      keepBackups: keepArchives,
      warnings,
      skipped,
    });
    if (skipped.length > 0) result.skipped = skipped.join('、');

    const summary =
      `维护${dry ? '（dryRun 只算不动）' : ''}：轮转日志 ${result.rotated.length} 个，` +
      `裁剪 jsonl ${result.trimmed.length} 个，备份 ${result.backup?.path ?? '未做'}`;
    log?.info?.(summary);
    for (const warning of warnings) log?.warn?.(`维护：${warning}`);
  } catch (error) {
    // 兜底：哪怕 root 不是目录也不能把调用方带崩
    warnings.push(`维护失败：${messageOf(error)}`);
  }
  return result;
}

/* ────────────────────────── CLI ────────────────────────── */

const USAGE = `用法：
  node scripts/maintenance.mjs [--dry-run] [--root <仓库根>]
                               [--backup-dir backups] [--keep-backups 7]
                               [--max-log-mb 10] [--keep 2]

  --dry-run        只算不动，打印计划
  --root           仓库根（默认当前目录）
  --backup-dir     备份目录（相对仓库根，默认 backups）
  --keep-backups   保留最近几份备份（默认 7）
  --max-log-mb     日志超过多少 MB 才轮转（默认 10）
  --keep           日志保留几代 .log.N（默认 2）`;

function argValue(args, name, fallback = '') {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] ?? fallback : fallback;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    console.log(USAGE);
    return;
  }

  const dryRun = args.includes('--dry-run') || args.includes('--dryrun');
  const root = argValue(args, 'root') || process.cwd();
  const result = await runMaintenance({
    root,
    dryRun,
    backupDir: argValue(args, 'backup-dir', 'backups') || 'backups',
    keepBackups: Number(argValue(args, 'keep-backups', '7')),
    maxLogBytes: Number(argValue(args, 'max-log-mb', '10')) * 1024 * 1024,
    keep: Number(argValue(args, 'keep', '2')),
    log: console,
  });

  console.log('');
  console.log(dryRun ? '【dryRun】只算不动，下面是计划：' : '维护完成：');
  for (const item of result.rotated) {
    console.log(`  轮转 ${item.file}（${(item.size / 1024 / 1024).toFixed(2)}MB）→ ${item.to}`);
  }
  for (const item of result.trimmed) {
    console.log(`  裁剪 ${item.file}：${item.before} → ${item.after} 行（原文件备份到 ${item.backup}）`);
  }
  console.log(`  备份：${result.backup ? `${result.backup.path}（${result.backup.bytes} 字节）` : '未做'}`);
  if (result.skipped) console.log(`  备份时跳过（不存在）：${result.skipped}`);
  for (const warning of result.warnings) console.warn(`  ⚠️ ${warning}`);
}

const invokedDirectly =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) await main();