#!/usr/bin/env node
/**
 * 她的记忆：看 / 回忆 / 手动整理。
 *
 *   node --env-file-if-exists=.env.qq scripts/memory.mjs --list
 *   node --env-file-if-exists=.env.qq scripts/memory.mjs --recall "西瓜"
 *   node --env-file-if-exists=.env.qq scripts/memory.mjs --digest          # 一天一次，已整理过会跳过
 *   node --env-file-if-exists=.env.qq scripts/memory.mjs --digest --force  # 重跑今晚
 *   node --env-file-if-exists=.env.qq scripts/memory.mjs --stats
 *   node --env-file-if-exists=.env.qq scripts/memory.mjs --forget-fact "爸爸:爱吃的"   # 划掉一条事实
 *   node --env-file-if-exists=.env.qq scripts/memory.mjs --forget-episode <at>          # 划掉一条情景（看 --list 里的时间戳）
 *
 * 睡前整理平时由 scripts/mind-run.mjs 在 22:00 之后自动跑一次；这个脚本是调试用。
 */

import { resolve } from 'node:path';
import { loadQqConfig } from '../src/config-qq.js';
import { createLogger } from '../src/log.js';
import { createPersona } from '../src/persona.js';
import { createDshRunner } from '../src/dsh.js';
import { createApiKeySource, resolveDshCommand } from '../src/credentials.js';
import { createMemoryStore } from '../src/memory-store.js';
import { digest } from '../src/memory-digest.js';

const args = process.argv.slice(2);
const has = (name) => args.includes(`--${name}`);
const arg = (name, fallback = '') => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? (args[i + 1] ?? fallback) : fallback;
};
const root = process.cwd();
const log = createLogger('info');
const store = createMemoryStore({ root, log });

const stamp = (at) => {
  const d = new Date(Number(at));
  if (!Number.isFinite(d.getTime())) return '';
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getMonth() + 1}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

async function printList() {
  const [facts, episodes, stats] = await Promise.all([store.readFacts(), store.readEpisodes({ limit: 60 }), store.stats()]);
  console.log(
    `记忆：${stats.episodes} 件事、${stats.facts} 条事实` +
      (stats.lastDigestDay ? `（上次整理 ${stats.lastDigestDay}）` : '（还没整理过）'),
  );
  if (facts.length > 0) {
    console.log('\n知道的事：');
    for (const fact of facts) console.log(`  ${fact.text}`);
  }
  if (episodes.length > 0) {
    console.log('\n记得的事：');
    for (const row of episodes) console.log(`  ${stamp(row.at)}  ${row.text}  [${row.at}]`);
  }
}

async function printRecall(query) {
  const hits = await store.recall(query);
  if (hits.length === 0) {
    console.log(`「${query}」：什么都没想起来`);
    return;
  }
  console.log(`「${query}」让她想起：`);
  for (const row of hits) console.log(`  ${stamp(row.at)}  ${row.text}（${row.kind}）`);
}

async function forgetFact(spec) {
  const [subject, key] = String(spec ?? '').split(/[:：]/);
  if (!subject || !key) {
    console.log('用法：--forget-fact "关于:什么"（比如 "爸爸:爱吃的"）');
    return;
  }
  const ok = await store.removeFact({ subject: subject.trim(), key: key.trim() });
  console.log(ok ? `划掉了：${subject.trim()}${key.trim()}` : '没找到这条事实');
}

async function forgetEpisode(spec) {
  // 格式：<时间戳> 或 <时间戳>:<标题前几个字>（同一次整理写的好几条 at 相同，用标题区分）
  const raw = String(spec ?? '');
  const [atPart, ...titleParts] = raw.split(/[:：]/);
  const at = Number(atPart);
  const title = titleParts.join(':').trim();
  if (!at) {
    console.log('用法：--forget-episode "<时间戳>" 或 "<时间戳>:<标题前几个字>"');
    return;
  }
  const ok = await store.removeEpisode({ at, title });
  console.log(ok ? `划掉了 ${stamp(at)} 那条${title ? `（${title}）` : ''}` : '没找到那条情境');
}

async function runDigest() {
  const config = loadQqConfig();
  const { command } = resolveDshCommand(process.env);
  const runner = createDshRunner({
    command,
    profile: config.agentProfile,
    cwd: config.agentCwd,
    timeoutMs: config.agentTimeoutMs,
    apiKey: createApiKeySource(),
    permissionMode: config.agentPermissionMode,
    retries: 1,
    log,
  });
  const persona = createPersona({ file: resolve(root, config.personaFile), log });
  const personaText = await persona().catch(() => '');
  const result = await digest({ root, runner, persona: personaText, log, force: has('force') });
  if (!result.ok) {
    console.log(`没整理：${result.reason}`);
    return;
  }
  for (const row of result.episodes) console.log(`事件：${row.title}`);
  for (const row of result.facts) console.log(`事实：${row.text}`);
}

try {
  if (has('forget-fact')) {
    await forgetFact(arg('forget-fact'));
  } else if (has('forget-episode')) {
    await forgetEpisode(arg('forget-episode'));
  } else if (has('recall')) {
    await printRecall(arg('recall'));
  } else if (has('digest')) {
    await runDigest();
  } else if (has('stats')) {
    console.log(JSON.stringify(await store.stats(), null, 2));
  } else {
    await printList();
  }
} catch (error) {
  console.error(String(error?.message ?? error));
  process.exit(1);
}