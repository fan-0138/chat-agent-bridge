#!/usr/bin/env node
/**
 * Prompt 预算闸门：量一下她现在每轮到底被塞了多少字、多少条「别…」。
 *
 * 为什么要有这个：每次她出问题，最省事的修法就是往 prompt 里再加一条「别 X」。
 * 加了两个月，常驻 prompt 从 6k 字长到 11k 字、负面规则上百条——她会开始顾此失彼，
 * 回的句子越来越像在躲规则，不像在说话。所以留个计数器：**新规则要替换旧规则，不能只追加**。
 *
 *   node scripts/prompt-budget.mjs           # 打印各项体积和条数
 *   node scripts/prompt-budget.mjs --check   # 超预算就退出码 1（给 CI/手动检查用）
 *
 * 预算（超过就说明该删旧的了）：
 *   常驻 prompt  ≤ 8,300 字      （不含本轮用户这句话）
 *   负面规则     ≤ 70 条        （「别/不要/不许/禁止/不准/绝不」）
 *   人设正文     ≤ 6,600 字
 *   说话方式     ≤ 1,500 字
 *
 * 说话规则只写 data/voice.md 一处；工具命令清单归 persona.md，别散到 prompt.js。
 */

import { readFile, stat } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPersona } from '../src/persona.js';
import { createVoice } from '../src/voice.js';
import { createSlang } from '../src/slang.js';
import { buildPrompt } from '../src/prompt.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// 2026-11-01 清理后的实测值冻结成上限（清理前：prompt 11.6k / 负面 119 条 / 人设 8.4k）。
// 以后只许往下调，不许往上调；真要加规则就先删同类旧规则。
const BUDGET = { prompt: 8_300, negatives: 70, persona: 6_600, voice: 1_500 };
const NEGATIVE = /别|不要|不许|禁止|不准|绝不/g;
const silent = { debug() {}, info() {}, warn() {}, error() {} };

const exists = async (path) =>
  stat(path).then(() => true).catch(() => false);

async function main() {
  const check = process.argv.includes('--check');
  const personaFile = resolve(ROOT, process.env.PERSONA_FILE?.trim() || 'persona.md');
  const voiceFile = resolve(ROOT, process.env.QQ_VOICE_FILE?.trim() || 'data/voice.md');
  const slangFile = resolve(ROOT, process.env.QQ_SLANG_FILE?.trim() || 'data/slang.md');

  const persona = (await exists(personaFile)) ? await createPersona({ file: personaFile, log: silent })() : '';
  const voice = (await exists(voiceFile)) ? (await createVoice({ file: voiceFile, log: silent }).load()).text : '';
  const slang = (await exists(slangFile)) ? (await createSlang({ file: slangFile, log: silent }).load()).text : '';

  const prompt = buildPrompt({
    persona,
    voice,
    slang,
    history: [],
    notes: [],
    text: '（这一句不算预算）',
    senderName: '爸爸',
    channel: 'qq',
  });

  const rows = [
    ['常驻 prompt', prompt.length, BUDGET.prompt],
    ['  人设正文', persona.length, BUDGET.persona],
    ['  说话方式', voice.length, BUDGET.voice],
    ['  梗', slang.length, Infinity],
    ['负面规则', (prompt.match(NEGATIVE) ?? []).length, BUDGET.negatives],
  ];

  console.log('Prompt 预算\n');
  let over = false;
  for (const [name, value, limit] of rows) {
    const bad = value > limit;
    if (bad) over = true;
    const tail = limit === Infinity ? '' : ` / 上限 ${limit}`;
    console.log(`  ${bad ? '✗' : '✓'} ${name.padEnd(12)} ${String(value).padStart(6)}${tail}`);
  }
  console.log('\n（字数不含历史对话和本轮消息；历史另有 9000 字上限）');

  if (over) {
    console.log('\n超了。按注释里的规矩来：先删掉同类旧规则再写新的，别只往上加。');
    if (check) process.exitCode = 1;
  }
}

await main();