/**
 * 解析 DSH 的可执行入口与模型凭据。
 *
 * 背景：PATH 上的 `dsh`（/opt/homebrew/bin/dsh）可能是旧版本，读不了当前格式的
 * `~/.dsh/.credentials.yaml`；桌面版 App 自带 0.2.x 的 CLI，与 GUI 同版本、共用凭据，
 * 因此优先使用它。
 */

import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const BUNDLED_CLI_CANDIDATES = [
  '/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh',
  '/Applications/DSH Desktop.app/Contents/Resources/runtime/cli/bin/dsh',
];

const API_KEY_NAMES = ['DEEPSEEK_API_KEY'];

/** 优先用显式配置，其次找桌面版自带 CLI，最后退回 PATH 上的 dsh。 */
export function resolveDshCommand(env = process.env) {
  const explicit = env.AGENT_CLI?.trim();
  if (explicit) return { command: explicit, source: 'env' };
  for (const candidate of BUNDLED_CLI_CANDIDATES) {
    if (existsSync(candidate)) return { command: candidate, source: 'bundled' };
  }
  return { command: 'dsh', source: 'path' };
}

/**
 * 从环境变量或 ~/.dsh/.credentials.yaml 读取 API key。
 * 兼容两种文件格式：
 *   扁平： DEEPSEEK_API_KEY: sk-xxx
 *   旧版： refs:\n  DEEPSEEK_API_KEY: sk-xxx
 * 返回值只用于子进程环境变量，不写日志、不落盘。
 */
export async function resolveApiKey({ env = process.env, home = homedir() } = {}) {
  for (const name of API_KEY_NAMES) {
    const value = env[name]?.trim();
    if (value) return { name, value, source: 'env' };
  }

  const file = join(home, '.dsh', '.credentials.yaml');
  let text;
  try {
    text = await readFile(file, 'utf8');
  } catch {
    return null;
  }

  for (const name of API_KEY_NAMES) {
    const match = text.match(new RegExp(`^\\s*${name}:\\s*(.+?)\\s*$`, 'm'));
    if (!match) continue;
    const value = match[1].replace(/^['"]|['"]$/g, '').trim();
    if (value) return { name, value, source: file };
  }
  return null;
}

/**
 * 每次取 key 都重新读一遍（环境变量优先，其次 credentials.yaml）。
 *
 * 以前 key 只在启动时解析一次：主人在桌面版里换了 key，桥接还抱着旧的，
 * 要重启才好——2026-10-31 就是这么卡的。现在每次 spawn 现取，换完下一条消息就生效。
 */
export function createApiKeySource({ env = process.env, home = homedir() } = {}) {
  return async () => {
    const resolved = await resolveApiKey({ env, home });
    return resolved?.value ?? null;
  };
}

export function maskKey(value) {
  if (!value) return '(未找到)';
  if (value.length <= 10) return `${value.slice(0, 2)}***`;
  return `${value.slice(0, 5)}***${value.slice(-4)}`;
}
