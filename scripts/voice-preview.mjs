#!/usr/bin/env node
/**
 * 听一下她现在怎么说话（真模型，不连 QQ）。
 *
 *   node wechat-bridge/scripts/voice-preview.mjs                 # 用一句「在吗」试一下
 *   node wechat-bridge/scripts/voice-preview.mjs --say "今天好累"
 *   node wechat-bridge/scripts/voice-preview.mjs --times 3       # 同一条问三次，看她会不会一套话反复用
 *   node wechat-bridge/scripts/voice-preview.mjs --no-history    # 不带最近聊天记录
 *   node wechat-bridge/scripts/voice-preview.mjs --dry           # 只看拼出来的 prompt，不调模型
 *
 * 每次都会打印：模型原话 / 去重后的样子 / 人味分。改 persona.md 或 data/voice.md 之后跑一遍就知道有没有用。
 */

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { buildPrompt } from '../src/prompt.js';
import { polish } from '../src/decor.js';
import { createDshRunner } from '../src/dsh.js';
import { createPersona } from '../src/persona.js';
import { createVoice } from '../src/voice.js';
import { audit, formatAudit, repliesFromMemory } from '../src/voice-audit.js';
import { resolveApiKey, resolveDshCommand } from '../src/credentials.js';
import { loadQqConfig } from '../src/config-qq.js';

const ROOT = resolve(import.meta.dirname, '..');
const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const value = (name, fallback) => {
  const index = argv.indexOf(name);
  return index === -1 ? fallback : (argv[index + 1] ?? fallback);
};

/** 没带 --env-file 时手动读 .env.qq，免得每次都要记参数。 */
async function loadEnvFile(file) {
  try {
    const text = await readFile(resolve(ROOT, file), 'utf8');
    for (const line of text.split('\n')) {
      const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (!match) continue;
      const [, key, rawValue] = match;
      if (process.env[key] !== undefined) continue;
      process.env[key] = rawValue.replace(/^["']|["']$/g, '');
    }
  } catch {
    // 没有 .env.qq 就靠当前环境变量
  }
}

async function main() {
  await loadEnvFile('.env.qq');
  process.chdir(ROOT);

  const config = loadQqConfig(process.env);
  const silent = { debug() {}, info() {}, warn: (msg) => console.warn(`[warn] ${msg}`), error: console.error };

  const owner = config.allowList[0];
  const say = value('--say', '在吗');
  const times = Math.max(1, Math.min(5, Number(value('--times', 1)) || 1));

  const persona = createPersona({ file: resolve(ROOT, config.personaFile), log: silent });
  const voice = createVoice({ file: resolve(ROOT, config.voiceFile), log: silent });

  let history = [];
  if (!flag('--no-history') && owner) {
    try {
      const rows = (await readFile(resolve(ROOT, 'data/qq/memory', `user_private_${owner}.jsonl`), 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      history = rows.slice(-config.historyTurns ?? -8).map((row) => ({
        role: row.role === 'assistant' ? 'assistant' : 'user',
        text: String(row.text ?? ''),
      }));
    } catch {
      history = [];
    }
  }

  const personaText = await persona();
  const voiceText = (await voice.load()).text;
  const prompt = buildPrompt({
    persona: personaText,
    voice: voiceText,
    history,
    text: say,
    senderName: '主人',
    channel: 'qq',
  });

  console.log(`人设 ${personaText.length} 字 / ${await voice.summary()} / 历史 ${history.length} 条`);
  if (flag('--dry')) {
    console.log(`\n${'─'.repeat(60)}\n${prompt}\n${'─'.repeat(60)}`);
    return;
  }

  const { command } = resolveDshCommand(process.env);
  const keyInfo = await resolveApiKey();
  const runner = createDshRunner({
    command,
    profile: config.agentProfile,
    cwd: config.agentCwd,
    timeoutMs: config.agentTimeoutMs,
    apiKey: keyInfo?.value,
    log: silent,
  });

  const recent = repliesFromMemory(
    history.map((entry) => ({ role: entry.role, text: entry.text })),
    2,
  );

  const samples = [];
  for (let i = 1; i <= times; i += 1) {
    const started = Date.now();
    const { text: raw } = await runner.run(prompt);
    const polished = polish(raw.trim(), { recent: [...recent, ...samples], maxEmoji: config.emojiMax });
    samples.push(polished);
    console.log(`\n#${i}（${Math.round((Date.now() - started) / 1000)}s）`);
    console.log(`原话：${JSON.stringify(raw.trim())}`);
    if (polished !== raw.trim()) console.log(`去重：${JSON.stringify(polished)}`);
  }

  const report = audit(samples);
  console.log(`\n${'─'.repeat(60)}\n${formatAudit(report, { limit: 3 })}`);
}

main().catch((error) => {
  console.error(error?.stack ?? error);
  process.exit(1);
});