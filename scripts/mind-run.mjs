#!/usr/bin/env node
/**
 * 她自己的时间——一个常驻的小进程。
 *
 *   npm run mind                      # 常驻：每 10 分钟左右让她自己想一次
 *   npm run mind -- --once            # 立刻想一次（忽略预算，调试用）
 *   npm run mind -- --status          # 看她最近都想什么了
 *   npm run mind -- --interval 5      # 换成 5 分钟一次
 *
 * 为什么是独立进程：
 *  - 想事这件事不该绑在「回消息」上，桥接重启也不该把她的时间清空；
 *  - 挂了也只影响她自己想事，不会挡住他说话（桥接读不到新想法会自动退回）。
 *
 * 想出来的东西落在 data/mind/stream.jsonl；她说「记住」的落 data/mind/memory.jsonl。
 * 下一轮对话时这两份会一起进 prompt，所以她是接着自己刚才想的往下说。
 */

import { resolve } from 'node:path';
import { loadQqConfig } from '../src/config-qq.js';
import { createLogger } from '../src/log.js';
import { createPersona } from '../src/persona.js';
import { createLife } from '../src/life.js';
import { createMind } from '../src/mind.js';
import { createDshRunner } from '../src/dsh.js';
import { createApiKeySource, resolveDshCommand } from '../src/credentials.js';

const args = process.argv.slice(2);
const has = (name) => args.includes(`--${name}`);
const arg = (name, fallback = '') => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? (args[i + 1] ?? fallback) : fallback;
};
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

function fmtClock(at) {
  const d = new Date(at);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

async function main() {
  const root = process.cwd();
  const config = loadQqConfig();
  const log = createLogger('info');

  const { command } = resolveDshCommand(process.env);
  const runner = createDshRunner({
    command,
    profile: config.agentProfile,
    cwd: config.agentCwd,
    timeoutMs: config.mindTimeoutMs,
    apiKey: createApiKeySource(),
    permissionMode: config.agentPermissionMode,
    retries: 1,
    log,
  });
  const persona = createPersona({ file: resolve(root, config.personaFile), log });
  const life = createLife({ config, log, root });
  await life.load();

  const mind = createMind({ config, runner, persona, life, root, log });

  if (has('status')) {
    const peek = await mind.peek();
    console.log(peek.enabled ? '她的时间：开着' : '她的时间：关着（QQ_MIND_ENABLED=0）');
    console.log(`今天想了 ${peek.today}/${config.mindMaxPerDay} 次，做梦 ${peek.dreamed} 段`);
    if (peek.state.wish?.at) console.log(`最后一个念头是「想他」：${fmtClock(peek.state.wish.at)}`);
    console.log('');
    for (const row of peek.recent.slice(-20)) {
      console.log(`${fmtClock(row.at)}  ${row.kind === 'dream' ? '〔梦〕' : '〔想〕'}${row.text}`);
    }
    if (peek.memories.length) {
      console.log('\n自己记下的：');
      for (const row of peek.memories) console.log(`${fmtClock(row.at)}  ${row.text}`);
    }
    return;
  }

  if (has('once')) {
    const result = await mind.tick({ force: true });
    if (!result.ok) {
      console.log(`这次没想成：${result.reason}`);
      process.exit(1);
    }
    const row = result.record;
    console.log(`${row.kind === 'dream' ? '〔梦〕' : '〔想〕'}${row.text}`);
    if (row.mood) console.log(`情绪：${row.mood}`);
    if (row.saved) console.log(`记下：${row.saved}`);
    if (row.action === 'wish') console.log('（她这会儿有点想爸爸）');
    console.log(`用时 ${(row.tookMs / 1000).toFixed(1)}s`);
    return;
  }

  // ── 常驻 ──
  const intervalMin = Math.max(1, Number(arg('interval', process.env.QQ_MIND_INTERVAL_MIN ?? 10)) || 10);
  log.info(
    `她的时间：开启（约 ${intervalMin} 分钟一次，最多 ${config.mindMaxPerDay}/天；` +
      `睡着时做梦，最多 ${config.mindDreamMaxPerNight} 段）`,
  );
  if (!config.mindEnabled) log.warn('QQ_MIND_ENABLED=0：只在 --once 时想，不会自动跑。');

  let stopping = false;
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
      stopping = true;
      log.info('她的时间：收到停止信号，把这一轮想完就走。');
    });
  }

  await sleep(Number(arg('first-delay', 60_000)) || 60_000);
  while (!stopping) {
    try {
      const result = await mind.tick();
      if (result.ok) {
        const row = result.record;
        log.info(`${row.kind === 'dream' ? '〔梦〕' : '〔想〕'}${row.text}${row.saved ? `（记下：${row.saved}）` : ''}`);
      } else {
        log.debug(`这次没想：${result.reason}`);
      }
    } catch (error) {
      log.warn(`想的时候出错：${error?.message ?? error}`);
    }
    const jitter = intervalMin * 60_000 * (0.85 + Math.random() * 0.4);
    const deadline = Date.now() + jitter;
    while (!stopping && Date.now() < deadline) await sleep(Math.min(5_000, deadline - Date.now()));
  }
  log.info('她的时间：已停止。');
}

main().catch((error) => {
  console.error(error?.stack ?? error);
  process.exit(1);
});