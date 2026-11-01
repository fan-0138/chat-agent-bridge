#!/usr/bin/env node
/**
 * 试写 / 试发她的 QQ 空间说说。
 *
 *   node scripts/qzone-write.mjs              试写一条，只打印不发送（看素材/角度/正文）
 *   node scripts/qzone-write.mjs --count 3    连写三条，看会不会又绕回机房空调
 *   node scripts/qzone-write.mjs --prompt     把这次完整的提示词打出来（调 prompt 用）
 *   node scripts/qzone-write.mjs --post       真发一条（走和桥接同一个 qq-action）
 *
 * 想省事可以用 npm run qzone -- --count 3（会自动读 .env.qq）。
 */

import { resolve } from 'node:path';
import { loadQqConfig } from '../src/config-qq.js';
import { createApiKeySource, resolveDshCommand } from '../src/credentials.js';
import { createAgentRunners } from '../src/runner-factory.js';
import { createLogger } from '../src/log.js';
import { createMemory } from '../src/memory.js';
import { createPersona } from '../src/persona.js';
import { createVoice } from '../src/voice.js';
import { createLife } from '../src/life.js';
import { createQzonePoster } from '../src/qzone.js';

const argv = process.argv.slice(2);
const flag = (name) => {
  const index = argv.indexOf(name);
  if (index === -1) return null;
  const value = argv[index + 1];
  argv.splice(index, value && !value.startsWith('--') ? 2 : 1);
  return value && !value.startsWith('--') ? value : '';
};
const count = Number(flag('--count') ?? 1);
const post = argv.includes('--post');
const showPrompt = argv.includes('--prompt');
if (post) argv.splice(argv.indexOf('--post'), 1);
if (showPrompt) argv.splice(argv.indexOf('--prompt'), 1);

const root = process.cwd();
const config = loadQqConfig(process.env);
const log = createLogger(process.env.LOG_LEVEL || 'warn');

const target = config.allowList?.[0];
if (!target) {
  console.error('白名单里没有对象，没法模拟她给谁写说说。');
  process.exit(1);
}

const { command: dshCommand } = resolveDshCommand(process.env);
const { runner } = createAgentRunners({ config, log, dshCommand, apiKey: createApiKeySource() });
const memory = createMemory({ dir: resolve(root, config.dataDir, 'qq/memory'), maxTurns: config.historyTurns, maxChars: config.historyMaxChars, log });
const persona = createPersona({ file: resolve(root, config.personaFile), log });
const voice = createVoice({ file: resolve(root, config.voiceFile), log });
const life = createLife({ config, log, root });

const poster = createQzonePoster({ config, log, runner, persona, voice, life, root });
const history = await memory.load(`user_private_${target}`);

if (post) {
  const result = await poster.post({ history });
  if (result.sent) console.log(`已发：${result.content}`);
  else console.log(`没发：${result.reason ?? '未知原因'}`);
  process.exit(result.sent ? 0 : 1);
}

const samples = [];
for (let i = 0; i < Math.max(1, Math.min(count, 5)); i += 1) {
  const result = await poster.draft({ history, extraPosts: samples });
  if (showPrompt && result.prompt) {
    console.log('─'.repeat(60));
    console.log(result.prompt);
    console.log('─'.repeat(60));
  }
  if (result.skipped) {
    console.log(`[${i + 1}] 跳过：${result.reason}`);
    break;
  }
  samples.push({ content: result.content, angle: result.angle?.id });
  const ttl = result.angle?.text ? `（角度：${result.angle.id}）` : '';
  console.log(`[${i + 1}] ${result.content} ${ttl}`);
}