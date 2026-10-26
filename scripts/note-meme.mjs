#!/usr/bin/env node
/**
 * 把今天学到的梗记进梗库（她自己的笔记本）。
 *
 *   node scripts/note-meme.mjs --term "YYDS" --meaning "永远的神，夸操作/夸人" --example "这波 yyds"
 *   node scripts/note-meme.mjs --list
 *
 * 记的时候写人话：什么意思、什么场合适用、举一个例子。
 * 一条消息最多用一个梗，用错了比不用更尬。
 */

import { resolve } from 'node:path';
import { createSlang } from '../src/slang.js';

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const option = (name, fallback) => {
  const index = argv.indexOf(name);
  return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback;
};

const file = resolve(process.cwd(), process.env.QQ_SLANG_FILE || 'data/slang.md');
const slang = createSlang({ file, log: { info() {}, warn: console.warn, error: console.error } });

if (flag('--list') || (!option('--term', '') && !flag('--term'))) {
  const { entries } = await slang.load();
  console.log(`梗库（${entries.length} 条）：${file}`);
  for (const entry of entries.slice(0, 30)) {
    console.log(`- ${entry.term}：${entry.meaning}${entry.example ? `（例：${entry.example}）` : ''} ${entry.date}`);
  }
  process.exit(0);
}

const term = option('--term', '').trim();
if (!term) {
  console.error('用法：note-meme.mjs --term "词" --meaning "什么意思" [--example "怎么用"]');
  process.exit(1);
}

const result = await slang.add({
  term,
  meaning: option('--meaning', ''),
  example: option('--example', ''),
  date: option('--date', ''),
});
if (result.added) console.log(`记下了：${result.term}`);
else if (result.reason === 'duplicate') console.log(`已经记过了：${result.term}`);
else console.log('没记：词是空的');
