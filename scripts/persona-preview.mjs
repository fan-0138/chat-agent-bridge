#!/usr/bin/env node
/**
 * 看「她现在到底接到了一份什么人设」。
 *
 *   node scripts/persona-preview.mjs            # 打印最终 prompt 里的人设全文
 *   node scripts/persona-preview.mjs --traits   # 只看性格刻度那一段
 *   node scripts/persona-preview.mjs --json     # 只看刻度值（清洗过）
 *   node scripts/persona-preview.mjs --set cute=5 snark=2   # 改刻度并回显
 *
 * 改刻度也可以直接编辑 persona.traits.json —— 下一条消息生效，不用重启。
 */

import { readFile, writeFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createPersona } from '../src/persona.js';
import { normalizeTraits, renderTraits, summarizeTraits, TRAITS, DEFAULTS } from '../src/traits.js';

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);

const ROOT = resolve(import.meta.dirname, '..');
const PERSONA_FILE = resolve(ROOT, 'persona.md');
const TRAITS_FILE = resolve(ROOT, 'persona.traits.json');

const silent = { info() {}, warn: console.warn, error: console.error, debug() {} };

async function readTraits() {
  try {
    return JSON.parse(await readFile(TRAITS_FILE, 'utf8'));
  } catch {
    return null;
  }
}

async function applySet(pairs) {
  const current = await readTraits();
  const next = { ...normalizeTraits(current) };
  for (const pair of pairs) {
    const [key, value] = pair.split('=');
    if (!(key in TRAITS)) {
      console.error(`没有这个刻度：${key}`);
      console.error(`可选：${Object.keys(TRAITS).join(', ')}`);
      process.exit(1);
    }
    next[key] = Number(value);
  }
  const cleaned = normalizeTraits(next);
  const out = { _说明: '性格刻度，0-5。改完下一条消息就生效，不用重启。名字和身份在 persona.md 里。', ...cleaned };
  await writeFile(TRAITS_FILE, `${JSON.stringify(out, null, 2)}\n`, 'utf8');
  console.log(`已更新 ${TRAITS_FILE}`);
  console.log(summarizeTraits(cleaned));
}

async function main() {
  if (flag('--set')) {
    const index = argv.indexOf('--set');
    const pairs = argv.slice(index + 1).filter((item) => item.includes('='));
    if (pairs.length === 0) {
      console.error('用法：--set cute=5 snark=2');
      process.exit(1);
    }
    await applySet(pairs);
    return;
  }

  const traits = await readTraits();

  if (flag('--json')) {
    console.log(JSON.stringify(normalizeTraits(traits), null, 2));
    return;
  }
  if (flag('--traits')) {
    console.log(renderTraits(traits));
    return;
  }

  const persona = createPersona({ file: PERSONA_FILE, traitsFile: TRAITS_FILE, log: silent });
  const text = await persona();
  if (!text) {
    console.error(`人设是空的：检查 ${PERSONA_FILE}`);
    process.exit(1);
  }

  const { size } = await stat(PERSONA_FILE).catch(() => ({ size: 0 }));
  const values = normalizeTraits(traits);
  const changed = Object.keys(TRAITS).filter((key) => values[key] !== DEFAULTS[key]);

  console.log('═'.repeat(60));
  console.log(`persona.md ${size} 字节 · 最终人设 ${text.length} 字`);
  console.log(`刻度：${summarizeTraits(traits)}`);
  console.log(
    changed.length > 0
      ? `偏离默认：${changed.map((key) => `${TRAITS[key].label}${DEFAULTS[key]}→${values[key]}`).join('，')}`
      : '偏离默认：无（全是出厂值）',
  );
  console.log('═'.repeat(60));
  console.log(text);
}

main().catch((error) => {
  console.error(error?.stack ?? error);
  process.exit(1);
});