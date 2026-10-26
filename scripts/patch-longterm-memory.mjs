#!/usr/bin/env node
/**
 * dsh-longterm-memory@0.1.4 在非 Windows 上有一个写死路径分隔符的 bug：
 *   join(root, record.path.split('/').join('\\'))
 * 在 macOS/Linux 上会生成带反斜杠的怪文件名，随后被“移动清理”逻辑删掉，
 * 表现为：memory_save 写进 journal，但 .md 文件不落地、索引恒为空、召回为空。
 *
 * 本脚本把这些调用改成直接用正斜杠路径（幂等，可重复执行）。
 *
 *   node scripts/patch-longterm-memory.mjs            # 打补丁
 *   node scripts/patch-longterm-memory.mjs --check    # 只检查
 *
 * 注意：插件升级/重装会覆盖 node_modules，升级后需要再跑一次。
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const profileIndex = process.argv.indexOf('--profile');
const PROFILE = profileIndex >= 0 ? process.argv[profileIndex + 1] : 'headless';
const ROOT = join(homedir(), '.dsh', 'profiles', PROFILE, 'node_modules', 'dsh-longterm-memory');
const FILES = [
  'lib/host/core/repository.js',
  'lib/host/core/indexing.js',
  'lib/host/core/service.js',
];
const NEEDLE = ".split('/').join('" + '\\\\' + "')";
const checkOnly = process.argv.includes('--check');

if (!existsSync(ROOT)) {
  console.error(`没找到插件目录：${ROOT}`);
  process.exit(2);
}

let total = 0;
for (const rel of FILES) {
  const file = join(ROOT, rel);
  if (!existsSync(file)) {
    console.warn(`跳过（不存在）：${rel}`);
    continue;
  }
  const src = readFileSync(file, 'utf8');
  const hits = src.split(NEEDLE).length - 1;
  total += hits;
  if (hits === 0) {
    console.log(`已打过补丁：${rel}`);
    continue;
  }
  if (checkOnly) {
    console.log(`需要打补丁：${rel}（${hits} 处）`);
    continue;
  }
  if (!existsSync(`${file}.orig`)) writeFileSync(`${file}.orig`, src);
  writeFileSync(file, src.split(NEEDLE).join(''));
  console.log(`已修补：${rel}（${hits} 处）`);
}
console.log(checkOnly ? `\n共需修补 ${total} 处` : `\n完成，共修补 ${total} 处`);
