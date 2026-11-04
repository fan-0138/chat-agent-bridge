/**
 * 她的 Minecraft 睡着了没有。
 *
 * 为什么要有这个：服务端（java）和身体（body.mjs）是 launchd 常驻的，
 * 就算她不玩也在跑——身体那 20Hz 反射循环实测常占用将近一个核。
 * 没人玩、也没人看小世界的时候，让它俩先睡；要玩/要看时再叫醒。
 *
 * 「有人看」靠房间里「世界」那个页签每 30 秒 ping 一次（touchActivity），
 * 页签关掉就不 ping 了，过 idleMin 分钟自动停。
 */

import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';

const ACTIVITY_FILE = 'data/mc/activity.json';
const PLAY_PID_FILE = 'data/mc/play-daemon.pid';
const MC_CTL = 'tools/mc/mc-ctl.sh';
const MC_API = process.env.MC_API || 'http://127.0.0.1:8772';
export const DEFAULT_IDLE_MIN = 20;

const nowMs = () => Date.now();

/** 纯函数：该不该睡。 */
export function shouldSleep({ online = false, playing = false, lastTouchAt = 0, now = nowMs(), idleMin = DEFAULT_IDLE_MIN } = {}) {
  if (!online) return { sleep: false, reason: 'offline' };
  if (playing) return { sleep: false, reason: 'playing' };
  if (!lastTouchAt) return { sleep: false, reason: 'never-touched' }; // 从没记录过：不主动停，避免误杀
  const idleMs = Math.max(1, Number(idleMin) || DEFAULT_IDLE_MIN) * 60_000;
  if (now - lastTouchAt < idleMs) return { sleep: false, reason: 'recent' };
  return { sleep: true, reason: 'idle', idleMin: Math.round((now - lastTouchAt) / 60_000) };
}

export async function readActivity(root = process.cwd()) {
  try {
    const row = JSON.parse(await readFile(resolve(root, ACTIVITY_FILE), 'utf8'));
    return { lastAt: Number(row?.lastAt ?? 0) || 0, lastKind: String(row?.lastKind ?? '') };
  } catch {
    return { lastAt: 0, lastKind: '' };
  }
}

/** 记一笔「有人在用她的小世界」。写失败不影响主流程。 */
export async function touchActivity(root = process.cwd(), kind = 'view', now = nowMs()) {
  const file = resolve(root, ACTIVITY_FILE);
  try {
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, `${JSON.stringify({ lastAt: now, lastKind: kind })}\n`, 'utf8');
    return true;
  } catch {
    return false;
  }
}

/** 身体在不在线（/status 给 online）。 */
export async function mcOnline(api = MC_API, timeoutMs = 2_500) {
  try {
    const res = await fetch(`${api}/status`, { signal: AbortSignal.timeout(timeoutMs) });
    const data = await res.json();
    return Boolean(data?.online);
  } catch {
    return false;
  }
}

/** 她自己玩的进程还活着吗（play.mjs）。 */
export function playRunning(root = process.cwd()) {
  let pid = 0;
  try {
    pid = Number(execFileSync('cat', [resolve(root, PLAY_PID_FILE)], { encoding: 'utf8' }).trim());
  } catch {
    pid = 0;
  }
  if (Number.isInteger(pid) && pid > 0) {
    try {
      process.kill(pid, 0);
      const cmd = execFileSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' });
      if (cmd.includes('play.mjs')) return true;
    } catch {
      /* 进程没了 */
    }
  }
  try {
    execFileSync('pgrep', ['-f', 'tools/mc/play.mjs'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function runCtl(root, action, timeoutMs = 90_000) {
  return new Promise((done) => {
    execFile('bash', [resolve(root, MC_CTL), action], { cwd: root, timeout: timeoutMs }, (error, stdout, stderr) => {
      done({ ok: !error, error: error ? String(stderr || error.message).slice(0, 300) : '' });
    });
  });
}

/**
 * 该睡就睡。online/playing/stop 可注入（测试就不真起服务）。
 * @returns {Promise<{slept: boolean, reason: string, idleMin?: number}>}
 */
export async function maybeSleepMc({
  root = process.cwd(),
  now = nowMs(),
  idleMin = DEFAULT_IDLE_MIN,
  log = console,
  online,
  playing,
  stop,
} = {}) {
  const isOnline = typeof online === 'boolean' ? online : await mcOnline();
  const isPlaying = typeof playing === 'boolean' ? playing : playRunning(root);
  const activity = await readActivity(root);
  const verdict = shouldSleep({ online: isOnline, playing: isPlaying, lastTouchAt: activity.lastAt, now, idleMin });
  if (!verdict.sleep) return { slept: false, reason: verdict.reason };
  const stopper = stop ?? (() => runCtl(root, 'stop'));
  const result = await stopper();
  if (result?.ok === false) {
    log?.warn?.(`小世界没停下来：${result.error}`);
    return { slept: false, reason: 'stop-failed' };
  }
  await touchActivity(root, 'stop', now);
  log?.info?.(`小世界睡了（${verdict.idleMin} 分钟没人用）`);
  return { slept: true, reason: 'idle', idleMin: verdict.idleMin };
}

/**
 * 叫醒她的小世界：起服务端和身体，等到 /status 说 online。
 * @returns {Promise<boolean>}
 */
export async function wakeMc({ root = process.cwd(), api = MC_API, timeoutMs = 60_000, log = console, start, check } = {}) {
  const onlineNow = await (check ?? (() => mcOnline(api)))();
  if (onlineNow) {
    await touchActivity(root, 'wake', nowMs());
    return true;
  }
  const starter = start ?? (() => runCtl(root, 'start'));
  const started = await starter();
  if (started?.ok === false) {
    log?.warn?.(`小世界没叫醒：${started.error}`);
    return false;
  }
  const deadline = Date.now() + Math.max(5_000, timeoutMs);
  while (Date.now() < deadline) {
    if (await (check ?? (() => mcOnline(api)))()) {
      await touchActivity(root, 'wake', nowMs());
      log?.info?.('小世界醒了');
      return true;
    }
    await new Promise((done) => setTimeout(done, 1_000));
  }
  log?.warn?.('小世界起不来（等超时了）');
  return false;
}

export const _internals = { ACTIVITY_FILE, PLAY_PID_FILE, MC_CTL, MC_API };