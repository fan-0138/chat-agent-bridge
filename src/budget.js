/**
 * 预算守卫：每天模型调用有个上限，到 80% 提醒一次，超了就只砍非必要调用。
 *
 * 为什么按「次数」不按钱：单价随时会变，算出来的费用是假的；次数是能看住的硬指标。
 * 用量本身由 src/usage.js 的 summarizeUsage 记，这里只负责读它、算档位、当天提醒一次。
 * data/budget.json 只记「哪天提醒过」——文件坏了、写不进去都只当没记，绝不抛。
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { localDay } from './life.js';
import { summarizeUsage } from './usage.js';

export const DEFAULT_DAILY_LIMIT = 800; // 每天模型调用上限（次数，不是钱）
export const WARN_RATIO = 0.8; // 到 80% 就该省着点了

/** now 按约定是函数（Date.now），也兼容直接给毫秒数；取不到就用当下。 */
function stampOf(now) {
  try {
    const value = typeof now === 'function' ? now() : now;
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? Math.round(n) : Date.now();
  } catch {
    return Date.now();
  }
}

/** 读提醒记录。坏文件/不存在/权限问题都当空，永远不抛。 */
async function readState(file) {
  try {
    const raw = JSON.parse(await readFile(file, 'utf8'));
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  } catch {
    return {};
  }
}

/** 先写临时文件再 rename：进程被杀时不会留半个 JSON 把下次读弄坏。写不进去就算了。 */
async function writeState(file, state) {
  try {
    await mkdir(dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    await writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
    await rename(tmp, file);
  } catch {
    // 静默：顶多下次再提醒一遍，不能因为记账把她弄挂
  }
}

/** 喊人的文案：说清楚用掉多少、别太吓人。 */
function alertText(status) {
  return `小鲸今天的模型调用已经用了 ${status.used}/${status.limit} 次。再花下去可能要等明天，我先省着点。`;
}

/**
 * @param {{root?: string, now?: (() => number) | number, limit?: number, warnRatio?: number,
 *          notify?: (text: string) => Promise<boolean>|boolean}} [options]
 */
export function createBudget({
  root = process.cwd(),
  now = Date.now,
  limit = DEFAULT_DAILY_LIMIT,
  warnRatio = WARN_RATIO,
  notify = async () => false,
} = {}) {
  const file = resolve(root, 'data/budget.json');

  // 传坏了就退回默认值：预算守卫自己不能被一个错配置搞失灵
  const rawLimit = Number(limit);
  const dailyLimit = Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : DEFAULT_DAILY_LIMIT;
  const rawWarn = Number(warnRatio);
  const warn = Number.isFinite(rawWarn) && rawWarn > 0 && rawWarn <= 1 ? rawWarn : WARN_RATIO;
  const warnAt = Math.ceil(dailyLimit * warn); // 到多少次开始提醒

  /** 由用量算一份状态；ratio 是 0~1（超过 1 就是真超了）。 */
  function makeStatus(used, checkedAt) {
    const calls = Math.max(0, Math.floor(Number(used) || 0));
    const ratio = calls / dailyLimit;
    const level = ratio >= 1 ? 'over' : ratio >= warn ? 'warn' : 'ok';
    return { limit: dailyLimit, used: calls, ratio, level, warnAt, checkedAt };
  }

  /** status() → { limit, used, ratio, level, warnAt, checkedAt }；用量读不到就当 0 次。 */
  async function status() {
    const checkedAt = stampOf(now);
    let used = 0;
    try {
      const summary = await summarizeUsage({ root, now: checkedAt });
      used = summary?.total?.calls;
    } catch {
      used = 0; // 统计坏了不能被当成「已经用超」把想事关掉
    }
    return makeStatus(used, checkedAt);
  }

  /**
   * checkOptional() → { allow, reason, status }
   * 非必要调用（想事/摸头那一句/约定那句/睡前整理/看视频）用它。
   * 只有 over 才拒；warn 放行但状态是 warn，让调用方自己省着点。
   */
  async function checkOptional() {
    const current = await status();
    if (current.level === 'over') return { allow: false, reason: 'budget', status: current };
    return { allow: true, reason: '', status: current };
  }

  /** 提醒本体：warn/over 且今天还没提醒过才发；notify 返回 true 才把当天记下来。 */
  async function alertOnce() {
    const current = await status();
    if (current.level === 'ok') return { alerted: false, status: current };

    const day = localDay(current.checkedAt);
    const state = await readState(file);
    if (state.alertDay === day) return { alerted: false, status: current }; // 今天已经喊过了

    let sent = false;
    try {
      sent = (await notify(alertText(current))) === true;
    } catch {
      sent = false; // 喊人失败只当没发出去，下条再试
    }
    if (sent) await writeState(file, { ...state, alertDay: day });
    // 返回 false/抛错就不写 alertDay：下一次 alert() 还会再试
    return { alerted: sent, status: current };
  }

  // 并发 alert 串成一条链：不然两个请求同时进来会各喊一次
  let queue = Promise.resolve();
  function alert() {
    const run = queue.then(() => alertOnce()).catch(() => ({ alerted: false, status: makeStatus(0, stampOf(now)) }));
    queue = run.then(
      () => {},
      () => {},
    );
    return run;
  }

  return { status, checkOptional, alert };
}