#!/usr/bin/env node
/**
 * 上网冲浪：看看今天网上在聊什么（不用登录、不开浏览器）。
 *
 *   node scripts/surf.mjs                       # 微博 + 头条 + B站，各 8 条
 *   node scripts/surf.mjs --source bili --limit 15
 *   node scripts/surf.mjs --json                # 给程序用
 *
 * 学梗用这个：先看热搜，再挑真在用的词记进梗库（scripts/note-meme.mjs）。
 */

import { SOURCES, fetchSource } from './lib/surf-sources.js';

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const option = (name, fallback) => {
  const index = argv.indexOf(name);
  return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback;
};

const limit = Math.max(1, Math.min(30, Number(option('--limit', 8)) || 8));
const wanted = String(option('--source', 'all')).trim();
const names = wanted === 'all' ? ['weibo', 'toutiao', 'bili'] : wanted.split(',').map((x) => x.trim()).filter((x) => x in SOURCES);
if (names.length === 0) {
  console.error(`没有这个来源。可选：${Object.keys(SOURCES).join(' / ')} / all`);
  process.exit(1);
}

const results = await Promise.all(names.map((name) => fetchSource(name, { limit })));
const ok = results.filter((item) => item.ok);

if (flag('--json')) {
  console.log(JSON.stringify({ at: Date.now(), results }, null, 2));
} else {
  for (const result of results) {
    if (!result.ok) {
      console.log(`\n【${result.label ?? result.source}】拿不到：${result.error}`);
      continue;
    }
    console.log(`\n【${result.label}】`);
    result.items.forEach((item, index) => {
      const hot = item.hot > 10000 ? ` ${(item.hot / 10000).toFixed(1)}万` : '';
      console.log(`${String(index + 1).padStart(2)}. ${item.title}${item.tag ? ` [${item.tag}]` : ''}${hot}`);
    });
  }
  if (ok.length === 0) {
    console.log('\n全挂了 —— 可能是网络或对方改版。');
    process.exitCode = 1;
  }
}
