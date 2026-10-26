#!/usr/bin/env node
/**
 * 入口：加载配置 -> 登录/恢复微信 iLink 会话 -> 消息转 DSH -> 回复。
 *
 *   node src/index.js           正常启动
 *   node src/index.js --check   只校验配置与 dsh 可用性，不登录微信
 */

import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { loadConfig } from './config.js';
import { maskKey, resolveApiKey, resolveDshCommand } from './credentials.js';
import { createDshRunner } from './dsh.js';
import { createAgentRunners } from './runner-factory.js';
import { createLogger } from './log.js';
import { createMemory } from './memory.js';
import { KeyedQueue } from './queue.js';
import { createBridge } from './bridge.js';
import { createPersona } from './persona.js';
import { createVision, resolveVisionCli } from './vision.js';
import { startIlink } from './transport-ilink.js';

const args = new Set(process.argv.slice(2));

async function main() {
  const config = loadConfig();
  const log = createLogger(config.logLevel);
  const dataDir = resolve(process.cwd(), config.dataDir);
  const { command: dshCommand, source: dshSource } = resolveDshCommand(process.env);
  const keyInfo = await resolveApiKey();
  const apiKey = keyInfo?.value;

  if (config.problems.length > 0) {
    for (const problem of config.problems) log.warn(`配置问题：${problem}`);
    if (!args.has('--check')) {
      log.error('配置不完整，退出。');
      process.exit(1);
    }
  }

  if (args.has('--check')) {
    const version = spawnSync(dshCommand, ['--version'], { encoding: 'utf8' });
    log.info(`白名单：${config.allowList.join(', ') || (config.allowUnknown ? '（临时允许所有）' : '空')}`);
    log.info(`DSH 命令：${dshCommand}（来源 ${dshSource}）profile=${config.agentProfile} cwd=${config.agentCwd}`);
    log.info(
      `dsh --version => ${version.status === 0 ? version.stdout.trim() : `失败: ${version.error?.message ?? version.stderr}`}`,
    );
    log.info(`API key => ${maskKey(apiKey)}${keyInfo ? `（来源 ${keyInfo.source}）` : '（未找到，headless 可能无法调用模型）'}`);
    log.info(`数据目录：${dataDir}`);
    return;
  }

  if (!apiKey) {
    log.warn('没有找到 DEEPSEEK_API_KEY，headless 调用模型可能失败；见 README「模型凭据」一节。');
  }

  const { runner } = createAgentRunners({ config, log, dshCommand, apiKey });

  const memory = createMemory({
    dir: `${dataDir}/memory`,
    maxTurns: config.historyTurns,
    maxChars: config.historyMaxChars,
    log,
  });

  const queue = new KeyedQueue({ globalConcurrency: config.maxRunsGlobal, log });
  const persona = createPersona({ file: resolve(process.cwd(), config.personaFile), log });
  const vision = createVision({
    cli: config.visionCli ?? resolveVisionCli(process.env),
    timeoutMs: config.visionTimeoutMs,
    enabled: config.visionEnabled,
    log,
  });
  if (vision.available) log.info(`看图能力已启用（${config.visionCli ?? 'modlens'}）`);
  else log.warn(`看图能力不可用：${vision.reason}`);

  log.info(`桥接启动：dsh=${dshCommand} profile=${config.agentProfile} cwd=${config.agentCwd}`);

  /** @type {ReturnType<typeof createBridge> | undefined} */
  let bridge;

  const transport = await startIlink({
    config: { ...config, dataDir },
    log,
    onMessage: (msg) => bridge?.handle(msg),
  });

  bridge = createBridge({
    config,
    runner,
    memory,
    queue,
    log,
    reply: transport.reply,
    typing: transport.typing,
    persona,
    vision,
    onActivity: (state) => log.debug(`activity=${state}`),
  });

  const shutdown = async (signal) => {
    log.info(`收到 ${signal}，正在退出`);
    try {
      await transport.stop();
    } finally {
      process.exit(0);
    }
  };
  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
}

process.on('unhandledRejection', (error) => {
  console.error(`未处理的 rejection: ${error?.stack ?? error}`);
});

main().catch((error) => {
  console.error(error?.stack ?? error);
  process.exit(1);
});
