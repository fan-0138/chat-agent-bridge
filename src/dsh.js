/**
 * DSH 调用层：把一条用户消息交给 `dsh --profile headless "<task>"`，
 * 拿回最后一条 assistant 文本。
 *
 * 选择 headless 一次性入口的原因：
 *  - 它是官方文档化的非交互入口（`dsh --profile headless "task"`），不依赖 GUI、端口或登录态；
 *  - 失败模式简单：退出码非 0 即失败，stderr 带错误信息；
 *  - 不需要逆向 Web 端的 RPC/Typert 协议。
 * 代价：每次调用都会冷启动一个 profile 进程（通常 1~3 秒），并且没有原生多轮记忆，
 * 因此上下文由 memory.js 在桥接层拼接。
 */

import { spawn } from 'node:child_process';

const MAX_CAPTURE_BYTES = 4 * 1024 * 1024;
const ANSI = /\u001B\[[0-9;?]*[ -/]*[@-~]/g;

export class DshError extends Error {
  constructor(message, { code, timedOut, stderr, durationMs } = {}) {
    super(message);
    this.name = 'DshError';
    this.code = code;
    this.timedOut = timedOut ?? false;
    this.stderr = stderr ?? '';
    this.durationMs = durationMs ?? 0;
  }
}

export function cleanEnv(env) {
  const next = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    // 父进程自己的会话变量会渗进子进程，导致 headless 行为异常；保留 DSH_HOME 以便自定义安装位置。
    if (key.startsWith('DSH_') && key !== 'DSH_HOME') continue;
    next[key] = value;
  }
  return next;
}

export function stripAnsi(text) {
  return text.replace(ANSI, '');
}

/**
 * 哪些失败值得重试：模型服务端偶发的 SSE 断流 / 连接重置 / 5xx / 限流。
 * 注意：超时和「退出码正常但没输出」不算 —— 重试只会让人多等一遍。
 */
const TRANSIENT_PATTERN =
  /(MALFORMED_RESPONSE|SSE event type mismatch|socket hang up|ECONNRESET|ETIMEDOUT|EAI_AGAIN|EPIPE|\b50[234]\b|overloaded|rate.?limit|temporarily unavailable)/i;

export function isTransientError(error) {
  if (!error) return false;
  if (error.timedOut) return false;
  return TRANSIENT_PATTERN.test(String(error.stderr ?? '')) || TRANSIENT_PATTERN.test(String(error.message ?? ''));
}

export function tidyOutput(text) {
  return stripAnsi(text)
    .replace(/\r\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * @param {{
 *   command: string,
 *   profile: string,
 *   cwd: string,
 *   timeoutMs: number,
 *   log: {debug: Function, info: Function, warn: Function, error: Function},
 * }} options
 */
export function createDshRunner(options) {
  const { command, profile, cwd, timeoutMs, apiKey, log } = options;

  /**
   * @param {string} prompt
   * @param {{signal?: AbortSignal}} [runOptions]
   */
  async function run(prompt, runOptions = {}) {
    // 服务端偶发断流（实测见过 MALFORMED_RESPONSE）重试一次就好，别让人白等
    const maxAttempts = options.retries ?? 2;
    let lastError;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        return await runOnce(prompt, runOptions);
      } catch (error) {
        lastError = error;
        if (attempt >= maxAttempts || !isTransientError(error)) throw error;
        log.warn(`DSH 偶发失败，重试第 ${attempt} 次：${String(error?.message ?? error)}`);
        await new Promise((done) => setTimeout(done, 1_200 * attempt));
      }
    }
    throw lastError;
  }

  async function runOnce(prompt, runOptions = {}) {
    const started = Date.now();
    const args = ['--profile', profile, prompt];

    log.debug(`spawn ${command} --profile ${profile} <${prompt.length} chars>`);

    const env = cleanEnv(process.env);
    if (apiKey) env.DEEPSEEK_API_KEY ??= apiKey;
    // cleanEnv 会把 DSH_* 全过滤掉，所以沙箱档位得在这里显式塞回去。
    // danger-full-access 同时让审批策略变 never（headless 没人能点同意，ask 就等于拒绝）。
    if (options.permissionMode) env.DSH_PERMISSION_MODE = options.permissionMode;

    const child = spawn(command, args, {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true, // 独立进程组，超时可整组杀掉
    });

    let stdout = '';
    let stderr = '';
    let overflow = false;

    const capture = (chunk, into) => {
      if (into.length > MAX_CAPTURE_BYTES) {
        overflow = true;
        return;
      }
      into += chunk.toString('utf8');
      return into;
    };

    child.stdout.on('data', (chunk) => {
      stdout = capture(chunk, stdout);
    });
    child.stderr.on('data', (chunk) => {
      stderr = capture(chunk, stderr);
    });

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child, 'SIGTERM');
      setTimeout(() => killTree(child, 'SIGKILL'), 5_000).unref();
    }, timeoutMs);
    timer.unref();

    const onAbort = () => {
      killTree(child, 'SIGTERM');
    };
    runOptions.signal?.addEventListener('abort', onAbort, { once: true });

    try {
      const { code, signal } = await new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('close', (exitCode, exitSignal) => resolve({ code: exitCode, signal: exitSignal }));
      });

      const durationMs = Date.now() - started;

      if (timedOut) {
        throw new DshError(`DSH 超时（${Math.round(timeoutMs / 1000)}s）`, {
          timedOut: true,
          stderr: tidyOutput(stderr),
          durationMs,
        });
      }
      if (code !== 0) {
        const detail = tidyOutput(stderr) || tidyOutput(stdout);
        throw new DshError(`DSH 退出码 ${code ?? signal}`, {
          code: code ?? undefined,
          stderr: detail.slice(0, 4_000),
          durationMs,
        });
      }
      if (overflow) {
        throw new DshError('DSH 输出过大，已中止', { durationMs });
      }

      const text = tidyOutput(stdout);
      if (!text) {
        throw new DshError('DSH 没有返回任何文本', { durationMs });
      }
      return { text, durationMs };
    } finally {
      clearTimeout(timer);
      runOptions.signal?.removeEventListener?.('abort', onAbort);
    }
  }

  return { run };
}

function killTree(child, signal) {
  if (child.killed || child.exitCode !== null) return;
  try {
    if (child.pid) process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      /* 进程已消失 */
    }
  }
}
