#!/usr/bin/env node
/**
 * QQ 定时喊人：往 data/qq/scheduled.json 里塞任务，由常驻的 --daemon 到点发私聊。
 *
 *   node scripts/qq-remind.mjs --at "11:00" --to 123456789 --text "起床啦"   # 加一条
 *   node scripts/qq-remind.mjs --at "11:00" --text "..." --date 2026-10-25
 *   node scripts/qq-remind.mjs --list
 *   node scripts/qq-remind.mjs --daemon            # 常驻，每 15 秒看一次表
 *   node scripts/qq-remind.mjs --cancel <id>
 *
 * 时钟按系统本地时间走。机器睡眠时不会到点发，醒来后补发（宁可晚，不能丢）。
 * 发送失败不会立刻放弃：间隔从 15s 逐步拉到 2min，最多重试 30 分钟。
 * 发送走 scripts/qq-action.mjs 的 send_private_msg，不受桥接层限流影响。
 */
import { execFile, execFileSync } from 'node:child_process';
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  appendFileSync,
  existsSync,
  unlinkSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const storeFile = join(root, 'data', 'qq', 'scheduled.json');
const logFile = join(root, 'data', 'qq', 'scheduled.log');
const pidFile = join(root, 'data', 'qq', 'scheduled.pid');
const qqAction = join(root, 'scripts', 'qq-action.mjs');

/** 发送失败后的重试节奏与放弃时限 */
const RETRY_BASE_MS = 15_000;
const RETRY_MAX_MS = 120_000;
const GIVE_UP_MS = 30 * 60_000;

const args = process.argv.slice(2);
const arg = (name, fallback = '') => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] ?? fallback : fallback;
};
const has = (name) => args.includes(`--${name}`);

function log(line) {
  mkdirSync(dirname(logFile), { recursive: true });
  appendFileSync(logFile, `[${new Date().toISOString()}] ${line}\n`);
}

function loadStore() {
  try {
    const data = JSON.parse(readFileSync(storeFile, 'utf8'));
    if (Array.isArray(data?.tasks)) return data;
  } catch {}
  return { tasks: [] };
}

function saveStore(store) {
  mkdirSync(dirname(storeFile), { recursive: true });
  writeFileSync(storeFile, JSON.stringify(store, null, 2));
}

function fmt(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** "11:00" + 可选日期 -> 最近一次的时间戳（已过则顺延到明天） */
function resolveAt(at, date) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(at).trim());
  if (!m) throw new Error(`--at 要写成 HH:MM，收到 ${JSON.stringify(at)}`);
  const hh = Number(m[1]);
  const mm = Number(m[2]);
  if (hh > 23 || mm > 59) throw new Error(`--at 时间越界：${at}`);
  const now = new Date();
  let base = new Date(now);
  if (date) {
    const dm = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
    if (!dm) throw new Error(`--date 要写成 YYYY-MM-DD，收到 ${JSON.stringify(date)}`);
    base = new Date(Number(dm[1]), Number(dm[2]) - 1, Number(dm[3]));
  }
  const target = new Date(base.getFullYear(), base.getMonth(), base.getDate(), hh, mm, 0, 0);
  if (target.getTime() <= Date.now() + 5_000) target.setDate(target.getDate() + 1);
  return target.getTime();
}

function send(userId, text) {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [qqAction, '--action', 'send_private_msg', '--params', JSON.stringify({ user_id: Number(userId), message: text })],
      { cwd: root, timeout: 30_000 },
      (error, stdout, stderr) => {
        if (error) return resolve({ ok: false, error: (stderr || error.message).slice(0, 300) });
        try {
          const data = JSON.parse(stdout);
          if (data?.retcode === 0 || data?.status === 'ok') return resolve({ ok: true });
          return resolve({ ok: false, error: JSON.stringify(data).slice(0, 300) });
        } catch {
          return resolve({ ok: false, error: `回包无法解析：${stdout.slice(0, 200)}` });
        }
      },
    );
  });
}

async function addTask() {
  const at = arg('at');
  const text = arg('text');
  const to = arg('to', '123456789');
  if (!at || !text) {
    console.error('用法：--at "11:00" --text "..." [--to QQ号] [--date YYYY-MM-DD]');
    process.exit(2);
  }
  const atMs = resolveAt(at, arg('date'));
  const store = loadStore();
  const id = `r${atMs}${Math.floor(Math.random() * 1000)}`;
  store.tasks.push({ id, at: atMs, atLocal: fmt(atMs), to, text, createdAt: Date.now() });
  store.tasks.sort((a, b) => a.at - b.at);
  saveStore(store);
  console.log(`已排：${fmt(atMs)} -> ${to}：${text}`);
}

/** pid 是否真的还是我们这个 daemon（防 stale pid 撞到别的进程） */
function isOurDaemon(pid) {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  try {
    const out = execFileSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' });
    return out.includes('qq-remind.mjs');
  } catch {
    return false;
  }
}

async function daemon() {
  // 单实例：已经有一个在跑就别再起第二个。
  // pid 文件可能是上次硬杀留下的，先确认这个 pid 真是 qq-remind，不然会以为自己在跑。
  mkdirSync(dirname(pidFile), { recursive: true });
  if (existsSync(pidFile)) {
    const old = Number(readFileSync(pidFile, 'utf8').trim());
    if (old && old !== process.pid && isOurDaemon(old)) {
      console.log(`已有 daemon 在跑（pid ${old}），退出`);
      process.exit(3);
    }
  }
  writeFileSync(pidFile, String(process.pid));
  log(`daemon 启动 pid=${process.pid}`);

  let stopping = false;
  const cleanup = () => {
    try {
      if (Number(readFileSync(pidFile, 'utf8').trim()) === process.pid) unlinkSync(pidFile);
    } catch {}
  };
  const stop = (signal) => {
    stopping = true;
    log(`daemon 收到退出信号 ${signal}`);
    cleanup();
    process.exit(0);
  };
  process.on('SIGINT', () => stop('SIGINT'));
  process.on('SIGTERM', () => stop('SIGTERM'));

  // 起来先看一眼有没有睡过去/挂掉期间错过的，错过的照样补发（宁可晚，不能丢）
  const overdue = loadStore().tasks.filter((t) => t.at <= Date.now());
  if (overdue.length > 0) log(`启动时发现 ${overdue.length} 条已过点，稍后补发`);

  while (!stopping) {
    const store = loadStore();
    const now = Date.now();
    for (const task of store.tasks.filter((t) => t.at <= now)) {
      const attempts = task.attempts || 0;
      // 失败后逐步拉长间隔，别每 15 秒怼一次
      const wait = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * Math.max(1, attempts));
      if (task.lastAttemptAt && now - task.lastAttemptAt < wait) continue;

      const result = await send(task.to, task.text);
      if (result.ok) {
        const lateSec = Math.round((now - task.at) / 1000);
        log(
          `已发送 ${task.id} -> ${task.to} @ ${task.atLocal}${lateSec > 60 ? `（迟到 ${lateSec}s）` : ''}：${task.text.slice(0, 60)}`,
        );
        store.tasks = store.tasks.filter((t) => t.id !== task.id);
      } else {
        task.attempts = attempts + 1;
        task.lastAttemptAt = now;
        const late = now - task.at;
        if (late > GIVE_UP_MS) {
          log(`放弃 ${task.id}（迟到 ${Math.round(late / 60_000)} 分钟，试了 ${task.attempts} 次）：${result.error}`);
          store.tasks = store.tasks.filter((t) => t.id !== task.id);
        } else {
          log(`发送失败 ${task.id}（第 ${task.attempts} 次，${Math.round(wait / 1000)}s 后再试）：${result.error}`);
        }
      }
      saveStore(store);
    }
    await new Promise((r) => setTimeout(r, 15_000));
  }
}

const cmd = has('daemon') ? 'daemon' : has('list') ? 'list' : has('cancel') ? 'cancel' : 'add';
if (cmd === 'daemon') await daemon();
else if (cmd === 'list') {
  const { tasks } = loadStore();
  if (tasks.length === 0) console.log('（没有待发的）');
  for (const t of tasks) console.log(`${t.id}  ${t.atLocal}  -> ${t.to}  ${t.text}`);
} else if (cmd === 'cancel') {
  const id = args[args.indexOf('--cancel') + 1];
  const store = loadStore();
  const before = store.tasks.length;
  store.tasks = store.tasks.filter((t) => t.id !== id);
  saveStore(store);
  console.log(before === store.tasks.length ? `没找到 ${id}` : `已取消 ${id}`);
} else await addTask();