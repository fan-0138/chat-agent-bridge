/**
 * 会话记忆：headless 每次都是全新会话，所以桥接层为每个联系人/群维护一份滚动记录，
 * 拼进下一次 prompt。存 JSONL，重启不丢。
 */

import { appendFile, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

const COMPACT_BYTES = 256 * 1024;

export function createMemory({ dir, maxTurns, maxChars, log }) {
  /** @type {Map<string, Array<{role: 'user'|'assistant', text: string}>>} */
  const cache = new Map();

  const fileFor = (key) => join(dir, `${sanitize(key)}.jsonl`);

  async function load(key) {
    if (cache.has(key)) return cache.get(key);
    const file = fileFor(key);
    let entries = [];
    try {
      const raw = await readFile(file, 'utf8');
      entries = raw
        .split('\n')
        .filter(Boolean)
        .map((line) => {
          try {
            return JSON.parse(line);
          } catch {
            return null;
          }
        })
        .filter((entry) => entry && typeof entry.text === 'string' && entry.text.length > 0)
        .map((entry) => ({ role: entry.role === 'assistant' ? 'assistant' : 'user', text: entry.text }));
    } catch (error) {
      if (error.code !== 'ENOENT') log.warn(`读取记忆失败 ${file}: ${error.message}`);
    }
    const trimmed = trimEntries(entries, maxTurns, maxChars);
    cache.set(key, trimmed);
    return trimmed;
  }

  async function append(key, role, text) {
    const entries = await load(key);
    entries.push({ role, text });
    const next = trimEntries(entries, maxTurns, maxChars);
    cache.set(key, next);

    const file = fileFor(key);
    await mkdir(dirname(file), { recursive: true });
    await appendFile(file, `${JSON.stringify({ role, text, at: Date.now() })}\n`, 'utf8');

    // 文件增长到一定程度后按内存视图重写，避免无限膨胀。
    if (await fileSize(file) > COMPACT_BYTES) {
      const compact = next.map((entry) => JSON.stringify(entry)).join('\n');
      const tmp = `${file}.tmp`;
      await writeFile(tmp, compact ? `${compact}\n` : '', 'utf8');
      await rename(tmp, file);
    }
  }

  async function clear(key) {
    cache.set(key, []);
    const file = fileFor(key);
    try {
      await writeFile(file, '', 'utf8');
    } catch (error) {
      log.warn(`清空记忆失败 ${file}: ${error.message}`);
    }
  }

  return { load, append, clear };
}

function trimEntries(entries, maxTurns, maxChars) {
  let kept = entries.slice(-maxTurns * 2);
  let total = 0;
  const reversed = [];
  for (let i = kept.length - 1; i >= 0; i -= 1) {
    total += kept[i].text.length;
    if (total > maxChars && reversed.length > 0) break;
    reversed.push(kept[i]);
  }
  return reversed.reverse();
}

async function fileSize(file) {
  try {
    const info = await stat(file);
    return info.size;
  } catch {
    return 0;
  }
}

function sanitize(key) {
  return key.replace(/[^a-zA-Z0-9_.@-]/g, '_').slice(0, 120);
}
