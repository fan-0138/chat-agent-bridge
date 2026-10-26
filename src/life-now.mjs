#!/usr/bin/env node
/**
 * 生活状态调试工具。
 *
 *   node src/life-now.mjs                 # 看「她现在在干嘛」，不刷
 *   node src/life-now.mjs --browse        # 立刻刷一轮抖音并挑一条待分享的
 *   node src/life-now.mjs --prompt        # 打印会注入对话的那段 prompt
 *   node src/life-now.mjs --reset         # 清空生活状态（重来）
 *
 * 需要 .env.qq 里的配置：node --env-file-if-exists=.env.qq src/life-now.mjs
 * （package.json 里 npm run life 已带好了）
 */

import { readFile, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import { loadQqConfig } from './config-qq.js';
import { createLogger } from './log.js';
import { createLife, describeLife, currentActivity, formatShare, freshShare, localDay } from './life.js';

const argv = new Set(process.argv.slice(2));

async function main() {
  const config = loadQqConfig();
  const log = createLogger('info');
  const life = createLife({ config, log, root: process.cwd() });

  if (argv.has('--reset')) {
    const file = resolve(process.cwd(), config.lifeStateFile);
    await unlink(file).catch(() => {});
    console.log(`已清空生活状态：${file}`);
    return;
  }

  await life.load();

  if (argv.has('--browse')) {
    console.log('开始刷抖音（30–60 秒，窗口在屏幕外）…');
    const picked = await life.browseAndPick();
    if (!picked) {
      console.log('没刷到可分享的东西。');
    } else {
      console.log('');
      console.log('挑中的这条：');
      console.log(formatShare(picked));
    }
    console.log('');
  }

  const { state, activity } = await life.peek();
  const now = Date.now();
  console.log('─── 此刻 ───');
  console.log(describeLife(state, now));
  console.log(`活动来源：${activity.fromRecord ? '记录' : '时段默认值'}${activity.ageMin ? `（${activity.ageMin} 分钟前记的）` : ''}`);
  console.log(`今天：刷了 ${state.browseDay === localDay(now) ? state.browseCount : 0}/${config.lifeBrowseMaxPerDay} 次`);
  console.log(`看过 ${state.seenIds.length} 条，去重缓存上限 600`);

  const share = freshShare(state, now);
  console.log('');
  if (share) {
    console.log('─── 待分享（下次主动找主人时用）───');
    console.log(formatShare(share.item));
    console.log(`（${Math.round((now - share.at) / 60_000)} 分钟前刷到的）`);
  } else {
    console.log('─── 待分享 ───\n（空）');
  }

  if (argv.has('--prompt')) {
    console.log('');
    console.log('─── 注入对话的 prompt 段落 ───');
    console.log(await life.promptSection());
  }
}

main().catch((error) => {
  console.error(error?.stack ?? error);
  process.exit(1);
});