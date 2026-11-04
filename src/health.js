/**
 * 她的身体状态。
 *
 * 昨晚 DSH 403，她连着 1 小时多想不了事，25 条 WARN 全埋在 logs/mind.log 里，爸爸完全不知道。
 * 这里记每个组件的「连续失败」：连着失败到阈值就在 QQ 上喊一句；房间页再用 status() 看她是不是卡着。
 *
 * 这个模块自己不 console.log、也不直接发 QQ：喊人用调用方传进来的 notify，日志级别由调用方定。
 * data/health.json 只是状态缓存——读坏了当空、写失败了拉倒，「记录健康」绝不能反过来把她弄挂。
 */

import { readFileSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

export const FAIL_ALERT_AFTER = 3; // 连续几次失败才喊人（第一次、第二次不烦他）
export const ALERT_COOLDOWN_MS = 6 * 3_600_000; // 喊过一次后 6 小时内不再喊

/** 房间页/巡检认识的组件。顺序固定，返回的结构就稳定。 */
export const COMPONENTS = ['chat', 'mind', 'pat', 'video', 'qzone'];

const LABELS = {
  chat: '聊天',
  mind: '想事',
  pat: '摸摸',
  video: '看视频',
  qzone: '空间',
};

/** 出事了去哪儿看。认不出的组件就让去 logs/ 翻，别指错路。 */
const LOG_HINTS = {
  chat: 'logs/qq-bridge.log',
  mind: 'logs/mind.log',
};

const ERROR_LIMIT = 200; // lastError 落盘上限
const ALERT_ERROR_LIMIT = 80; // 发出去的文案别太长

function emptyState() {
  return { alertedAt: 0, components: {} };
}

function positiveAt(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** 单个组件状态归一化：缺字段/字段类型不对都当 0 处理。 */
function normalizeComponent(raw) {
  const data = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  return {
    failStreak: Math.max(0, Math.floor(Number(data.failStreak) || 0)),
    lastError: typeof data.lastError === 'string' ? data.lastError.slice(0, ERROR_LIMIT) : '',
    lastFailAt: positiveAt(data.lastFailAt),
    lastOkAt: positiveAt(data.lastOkAt),
  };
}

/** 把 decode 出来的东西归一化成 { alertedAt, components }；坏形状一律当空。 */
function parseState(raw) {
  const data = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const components = {};
  if (data.components && typeof data.components === 'object' && !Array.isArray(data.components)) {
    for (const [name, value] of Object.entries(data.components)) {
      if (typeof name === 'string' && name) components[name] = normalizeComponent(value);
    }
  }
  return { alertedAt: positiveAt(data.alertedAt), components };
}

/** 读状态。坏文件/不存在/权限问题都当空，永远不抛。 */
async function readState(file) {
  try {
    return parseState(JSON.parse(await readFile(file, 'utf8')));
  } catch {
    return emptyState();
  }
}

/** status() 是同步的，单独留一个同步读；同样永不抛。 */
function readStateSync(file) {
  try {
    return parseState(JSON.parse(readFileSync(file, 'utf8')));
  } catch {
    return emptyState();
  }
}

/**
 * 先写临时文件再 rename：进程被杀/断电时不会留下半个 JSON 把下次读弄坏。
 * 写不进去就算了——健康统计不能影响她说话。
 */
async function writeState(file, state) {
  try {
    await mkdir(dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    await writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
    await rename(tmp, file);
  } catch {
    // 静默：状态丢了顶多下次从头数失败
  }
}

/** 错误压成一行再截断：日志里带换行、带堆栈都不适合塞进 JSON/QQ 文案。 */
function errorText(error) {
  let text = '';
  if (error instanceof Error) text = error.message;
  else if (typeof error === 'string') text = error;
  else if (error != null) {
    try {
      text = JSON.stringify(error);
    } catch {
      text = String(error);
    }
  }
  return String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, ERROR_LIMIT);
}

/** 喊人的文案：短、像人话、说清哪个组件 + 为什么 + 去哪儿看。 */
function alertText(component, streak, error) {
  const label = LABELS[component] ?? component;
  const reason = error ? `（${error.slice(0, ALERT_ERROR_LIMIT)}）` : '';
  const where = LOG_HINTS[component] ?? 'logs/';
  return `小鲸这边卡住了：${label}连续 ${streak} 次失败${reason}。你要是看到这条，去 ${where} 看一眼。`;
}

/**
 * @param {{root?: string, now?: () => number, notify?: (text: string) => Promise<boolean>|boolean}} options
 */
export function createHealth({ root = process.cwd(), now = Date.now, notify = async () => false } = {}) {
  const file = resolve(root, 'data/health.json');

  function safeNow() {
    try {
      const at = Number(now());
      return Number.isFinite(at) ? at : Date.now();
    } catch {
      return Date.now();
    }
  }

  // record 可能被桥接、想事循环同时调用。串成一条链，免得后写覆盖先写。
  let queue = Promise.resolve();

  async function recordOnce(update) {
    let alerted = false;
    try {
      const component = String(update?.component ?? '').trim();
      if (!component) return { alerted };
      // 明确 ok:true 才算成功；调用方漏传时按失败算，宁可多数一次也别漏掉故障
      const ok = update?.ok === true;
      const at = safeNow();
      const state = await readState(file);
      const prev = normalizeComponent(state.components[component]);
      const next = { ...prev };

      if (ok) {
        next.failStreak = 0;
        next.lastOkAt = at;
      } else {
        next.failStreak = prev.failStreak + 1;
        next.lastError = errorText(update?.error);
        next.lastFailAt = at;
      }
      state.components[component] = next;

      // 全局冷却：喊过一次之后，不管哪个组件到阈值，6 小时内都先不打扰他
      const cooling = state.alertedAt > 0 && at - state.alertedAt <= ALERT_COOLDOWN_MS;
      if (!ok && next.failStreak >= FAIL_ALERT_AFTER && !cooling) {
        let sent = false;
        try {
          sent = (await notify(alertText(component, next.failStreak, next.lastError))) === true;
        } catch {
          sent = false; // 喊人失败只当下次再喊，不能把 record 带崩
        }
        if (sent) {
          state.alertedAt = at;
          alerted = true;
        }
        // 返回 false（没发出去）就不写 alertedAt：下一条失败还会再试一次
      }

      await writeState(file, state);
    } catch {
      // 永不抛：健康记录出问题就静默
    }
    return { alerted };
  }

  /**
   * record({ component, ok, error }) → Promise<{ alerted }>
   * 更新失败计数；必要时 await notify(文案)。不管 notify 说什么、文件写不写得进去，都不抛。
   */
  function record(update) {
    const run = queue.then(() => recordOnce(update)).catch(() => ({ alerted: false }));
    queue = run.then(
      () => {},
      () => {},
    );
    return run;
  }

  /**
   * status() → { ok, checkedAt, components, failing }
   * 给房间页/巡检看：只要某组件失败数还没清零就算 failing（阈值只决定喊不喊人）。
   * options.now 可注入固定时间（测试用）。
   */
  function status(options = {}) {
    const override = Number(options?.now);
    const checkedAt = Number.isFinite(override) && override > 0 ? override : safeNow();
    const state = readStateSync(file);
    const names = [...COMPONENTS, ...Object.keys(state.components).filter((name) => !COMPONENTS.includes(name))];
    const components = {};
    const failing = [];

    for (const name of names) {
      const current = normalizeComponent(state.components[name]);
      const failingNow = current.failStreak > 0;
      components[name] = {
        failing: failingNow,
        streak: current.failStreak,
        lastError: current.lastError || null,
        lastFailAt: current.lastFailAt || null,
        lastOkAt: current.lastOkAt || null,
      };
      if (failingNow) {
        failing.push({ component: name, streak: current.failStreak, lastError: current.lastError || null });
      }
    }

    return { ok: failing.length === 0, checkedAt, components, failing };
  }

  return { record, status };
}