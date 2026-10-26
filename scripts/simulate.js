#!/usr/bin/env node
/**
 * 本地模拟器：不接微信，直接在终端里验证「消息 -> DSH -> 回复」全链路。
 * 用的是和真实微信完全相同的 bridge / 记忆 / 排队 / 切分逻辑。
 *
 *   node scripts/simulate.js
 *   node scripts/simulate.js "帮我看下这个仓库的 git 状态"
 */

import readline from 'node:readline/promises';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { loadConfig } from '../src/config.js';
import { createDshRunner } from '../src/dsh.js';
import { createLogger } from '../src/log.js';
import { createMemory } from '../src/memory.js';
import { KeyedQueue } from '../src/queue.js';
import { createBridge } from '../src/bridge.js';
import { createPersona } from '../src/persona.js';
import { createVision, resolveVisionCli } from '../src/vision.js';
import { resolveApiKey, resolveDshCommand } from '../src/credentials.js';

const SENDER_ID = 'local-terminal';
const SENDER_NAME = '本机终端';

async function main() {
  const base = loadConfig(process.env);
  const log = createLogger(process.env.LOG_LEVEL || 'info');
  const config = { ...base, allowList: [SENDER_ID], allowUnknown: false, replyAck: false };
  const { command } = resolveDshCommand(process.env);
  const keyInfo = await resolveApiKey();

  const runner = createDshRunner({
    command,
    profile: config.agentProfile,
    cwd: config.agentCwd,
    timeoutMs: config.agentTimeoutMs,
    apiKey: keyInfo?.value,
    log,
  });
  const memory = createMemory({
    dir: resolve(process.cwd(), 'data/simulate-memory'),
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

  const bridge = createBridge({
    config,
    runner,
    memory,
    queue,
    log,
    persona,
    vision,
    reply: async (_target, text) => {
      process.stdout.write(`\n\x1b[36m助手\x1b[0m> ${text}\n\n> `);
    },
  });

  const ask = async (text) => {
    await bridge.handle({
      type: 'text',
      id: randomUUID(),
      text,
      senderId: SENDER_ID,
      senderName: SENDER_NAME,
      isSelf: false,
      mentionSelf: true,
    });
  };

  const argv = process.argv.slice(2);
  const imageIndex = argv.indexOf('--image');
  if (imageIndex !== -1) {
    const imagePath = argv[imageIndex + 1];
    if (!imagePath) {
      log.error('--image 后面需要图片路径');
      return;
    }
    log.info(`模拟图片消息：${imagePath}`);
    await bridge.handle({
      type: 'media',
      id: randomUUID(),
      text: argv.filter((_, i) => i !== imageIndex && i !== imageIndex + 1).join(' ').trim(),
      senderId: SENDER_ID,
      senderName: SENDER_NAME,
      isSelf: false,
      kind: 'image',
      path: resolve(imagePath),
    });
    return;
  }

  const scripted = argv.join(' ').trim();
  if (scripted) {
    await ask(scripted);
    return;
  }

  log.info(`模拟器就绪：${command} headless（cwd=${config.agentCwd}）`);
  log.info('输入消息回车发送，输入 /reset 清空上下文，Ctrl-C 退出。');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  process.stdout.write('\n> ');
  for await (const line of rl) {
    const text = line.trim();
    if (!text) {
      process.stdout.write('> ');
      continue;
    }
    if (text === '/reset') {
      await memory.clear('user_local-terminal');
      process.stdout.write('已清空上下文\n> ');
      continue;
    }
    try {
      await ask(text);
    } catch (error) {
      log.error(`${error?.stack ?? error}`);
    }
    process.stdout.write('> ');
  }
  rl.close();
}

main().catch((error) => {
  console.error(error?.stack ?? error);
  process.exit(1);
});
