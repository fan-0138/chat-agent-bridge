/**
 * 视觉能力：headless profile 没有内置看图工具，但机器上装了 modlens
 * （@liustack/modlens，带 CLI）。桥接层直接调它的 `analyze`，把结构化证据
 * 作为文本喂给 agent——对 agent 来说这跟它自己调工具没区别。
 */

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export function resolveVisionCli(env = process.env) {
  const explicit = env.VISION_CLI?.trim();
  if (explicit) return explicit;

  const candidates = [
    join(homedir(), '.dsh/profiles/desktop/node_modules/@liustack/modlens/dist/main.js'),
    join(homedir(), '.dsh/profiles/web/node_modules/@liustack/modlens/dist/main.js'),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * @param {{cli: string|null, timeoutMs: number, enabled: boolean, log: any}} options
 */
export function createVision({ cli, timeoutMs, enabled, log }) {
  if (!enabled || !cli) {
    return {
      available: false,
      reason: !enabled ? 'VISION_ENABLED=0' : '没有找到 modlens CLI（可设 VISION_CLI 指定）',
      async analyze() {
        return null;
      },
    };
  }

  return {
    available: true,
    reason: null,
    /**
     * @param {string} imagePath
     * @param {string} [focus]
     * @returns {Promise<string|null>} 结构化 JSON 文本；失败返回 null
     */
    async analyze(imagePath, focus) {
      const args = [cli, 'analyze', '-i', imagePath, '--timeout', String(timeoutMs)];
      if (focus) args.push('--prompt', focus);
      try {
        const { stdout } = await execFileAsync(process.execPath, args, {
          timeout: timeoutMs + 15_000,
          maxBuffer: 6 * 1024 * 1024,
        });
        const text = stdout.trim();
        return text || null;
      } catch (error) {
        const detail = error?.stderr ? String(error.stderr).slice(0, 800) : (error?.message ?? String(error));
        log.warn(`看图失败 ${imagePath}: ${detail}`);
        return null;
      }
    },
  };
}
