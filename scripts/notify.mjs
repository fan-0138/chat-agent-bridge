#!/usr/bin/env node
/**
 * 给爸爸的 QQ 发一句话——故障通知专用通道。
 *
 *   node scripts/notify.mjs "要说的话"             # 真发：私聊 .env.qq 里 QQ_ALLOW_LIST 的第一个人
 *   node scripts/notify.mjs --dry-run "要说的话"    # 只打印收件人和文本，不联网、不发消息
 *
 * 发送走 scripts/qq-action.mjs 的 send_private_msg（和 scripts/qq-remind.mjs 定时喊人同一条路，
 * 不受桥接层限流影响）。成功 exit 0；失败 exit 1，原因写到 stderr——
 * 调用方（src/health.js 的 notify）只看成败，所以「为什么没发出去」得留给人看。
 *
 * 其它参数：--to <QQ号> 临时换收件人；--env <文件> 换 env 文件（默认仓库根 .env.qq）。
 */
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const qqAction = join(root, 'scripts', 'qq-action.mjs');

function printUsage() {
  console.error('用法：node scripts/notify.mjs [--dry-run] [--to QQ号] [--env 文件] "要说的话"');
}

/** 自带一个最小 .env 解析：只认 KEY=VALUE，去掉包在外面的引号；读不到就当空。 */
function loadEnv(file) {
  const env = {};
  try {
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
      if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch {
    // 没有 .env.qq 就靠当前环境变量
  }
  return env;
}

/** QQ_ALLOW_LIST 可能是逗号、空格、中文逗号混着写的，第一个号就是收件人。 */
function firstRecipient(raw) {
  return String(raw ?? '')
    .split(/[,\s，、]+/)
    .map((item) => item.trim())
    .find(Boolean) ?? '';
}

/** 调 qq-action 发私聊。回包解析和失败原因都照 qq-remind 的 send() 来。 */
function send(userId, message, envFile) {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [
        qqAction,
        '--action',
        'send_private_msg',
        '--params',
        JSON.stringify({ user_id: Number(userId), message }),
        ...(envFile ? ['--env', envFile] : []),
      ],
      { cwd: root, timeout: 30_000 },
      (error, stdout, stderr) => {
        if (error) {
          const reason = String(stderr || error.message || '未知错误').trim();
          return resolve({ ok: false, error: reason.slice(0, 300) });
        }
        try {
          const data = JSON.parse(stdout);
          if (data?.retcode === 0 || data?.status === 'ok') return resolve({ ok: true });
          return resolve({ ok: false, error: `网关回包失败：${JSON.stringify(data).slice(0, 300)}` });
        } catch {
          return resolve({ ok: false, error: `回包无法解析：${String(stdout).slice(0, 200)}` });
        }
      },
    );
  });
}

// ---- 参数 ----
const args = process.argv.slice(2);
let dryRun = false;
let toOverride = '';
let envFile = join(root, '.env.qq');
const words = [];

for (let i = 0; i < args.length; i += 1) {
  const item = args[i];
  if (item === '--dry-run' || item === '-n') {
    dryRun = true;
    continue;
  }
  if (item === '--to') {
    toOverride = args[i + 1] ?? '';
    i += 1;
    continue;
  }
  if (item === '--env') {
    envFile = args[i + 1] ?? '';
    i += 1;
    continue;
  }
  if (item === '--help' || item === '-h') {
    printUsage();
    process.exit(0);
  }
  words.push(item);
}

const text = words.join(' ').trim();
if (!text) {
  printUsage();
  process.exit(1);
}

const env = { ...loadEnv(envFile), ...process.env };
const to = (toOverride || firstRecipient(env.QQ_ALLOW_LIST)).trim();
if (!to) {
  console.error(`不知道发给谁：${envFile} 里没有 QQ_ALLOW_LIST（也可以用 --to <QQ号> 指定）`);
  process.exit(1);
}
if (!/^\d+$/.test(to)) {
  console.error(`收件人 QQ 号看起来不对：${JSON.stringify(to)}`);
  process.exit(1);
}

if (dryRun) {
  console.log(`[dry-run] 收件人：${to}`);
  console.log(`[dry-run] 文本：${text}`);
  console.log('[dry-run] 没有联网，也没有发消息。');
  process.exit(0);
}

const result = await send(to, text, envFile);
if (!result.ok) {
  console.error(`发送失败：${result.error}`);
  process.exit(1);
}
console.log(`已发送 -> ${to}：${text.slice(0, 60)}`);