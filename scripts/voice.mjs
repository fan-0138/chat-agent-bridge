#!/usr/bin/env node
/**
 * 她自己的说话笔记本 CLI。
 *
 *   node wechat-bridge/scripts/voice.mjs list                 看现在记了什么
 *   node wechat-bridge/scripts/voice.mjs add "别用唔开头"      加一条规矩
 *   node wechat-bridge/scripts/voice.mjs example "知道了，马上弄"   记一句主人认可的说法
 *   node wechat-bridge/scripts/voice.mjs own "先答再解释"       记一条自己的心得
 *   node wechat-bridge/scripts/voice.mjs rm 3                删掉第 3 条（按 list 的编号）
 *   node wechat-bridge/scripts/voice.mjs audit [--recent 60] [--file <jsonl>]   给最近说过的话打分
 *
 * 手工编辑 data/voice.md 也一样，热加载，下一条消息生效。
 */

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createVoice } from '../src/voice.js';
import { audit, formatAudit, repliesFromMemory } from '../src/voice-audit.js';

const root = process.cwd();
const args = process.argv.slice(2);
const command = (args[0] || 'list').toLowerCase();
const rest = args.slice(1);

function flag(name, fallback) {
  const index = args.indexOf(name);
  if (index === -1) return fallback;
  return args[index + 1] ?? fallback;
}

const voice = createVoice({ file: resolve(root, process.env.QQ_VOICE_FILE || 'data/voice.md') });

async function readReplies(file, limit) {
  const path = file
    ? resolve(root, file)
    : resolve(root, 'data/qq/memory/user_private_123456789.jsonl');
  const rows = (await readFile(path, 'utf8'))
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
  return repliesFromMemory(rows, limit);
}

async function main() {
  const text = rest.join(' ').trim();

  if (command === 'list' || command === 'ls') {
    const data = await voice.list();
    const groups = [
      ['主人定的规矩', data.rules],
      ['主人认可的说法', data.examples],
      ['我自己想这么说话', data.own],
    ];
    let index = 0;
    for (const [title, items] of groups) {
      console.log(`\n${title}（${items.length}）`);
      if (items.length === 0) console.log('  （空）');
      for (const item of items) {
        index += 1;
        console.log(`  ${String(index).padStart(2)}. ${item}`);
      }
    }
    console.log(`\n文件：${voice.file}`);
    return;
  }

  if (command === 'add' || command === 'rule' || command === 'example' || command === 'own') {
    if (!text) {
      console.error('要写什么？例如：voice.mjs add "别每句都用唔开头"');
      process.exitCode = 1;
      return;
    }
    const kind = command === 'add' || command === 'rule' ? 'rule' : command;
    const result = await voice.add(kind, text);
    if (result.added) console.log(`已记下：${result.value}`);
    else if (result.reason === 'duplicate') console.log(`已经记过了：${result.value}`);
    else console.log('没记：内容为空');
    return;
  }

  if (command === 'rm' || command === 'remove') {
    const index = Number(text);
    if (!Number.isInteger(index) || index < 1) {
      console.error('给个编号，先 voice.mjs list 看一下。');
      process.exitCode = 1;
      return;
    }
    const result = await voice.remove(index);
    console.log(result.removed ? `已删掉：${result.value}` : '编号超出范围');
    return;
  }

  if (command === 'audit') {
    const limit = Number(flag('--recent', 60)) || 60;
    const file = flag('--file', '');
    try {
      const replies = await readReplies(file, limit);
      const report = audit(replies);
      console.log(formatAudit(report, { limit: 6 }));
      const worst = report.items
        .filter((item) => item.opener || item.props > 0)
        .slice(-3);
      if (worst.length > 0) {
        console.log('\n露馅的例子：');
        for (const item of worst) console.log(`· ${item.text.replace(/\n+/g, ' ').slice(0, 70)}`);
      }
    } catch (error) {
      console.error(`读不到聊天记录：${error?.message ?? error}`);
      process.exitCode = 1;
    }
    return;
  }

  console.log(`用法：
  voice.mjs list
  voice.mjs add "规矩"
  voice.mjs example "原话"
  voice.mjs own "心得"
  voice.mjs rm <编号>
  voice.mjs audit [--recent 60]`);
}

main().catch((error) => {
  console.error(error?.stack ?? error);
  process.exit(1);
});