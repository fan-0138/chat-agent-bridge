/**
 * 梗库：她自己从网上学来的说法。
 *
 * 为什么要单独存：
 *  - 模型默认的"网感"是训练数据里的，容易用五年前的梗；
 *  - 真在用的梗得一条条记：词、什么意思、怎么用、什么时候学的；
 *  - 记下来之后每次聊天给她看最近几条，用得上就用，用不上拉倒。
 *
 * 文件：data/slang.md，热加载。
 */

import { readFile, stat, writeFile, mkdir, rename } from 'node:fs/promises';
import { dirname } from 'node:path';

const MAX_ENTRIES = 40;
const SHOW = 6;
const HEADER = `# 网上学来的梗

<!-- 她自己记的：词 / 意思 / 怎么用 / 什么时候。用得上再用，别硬塞，一条消息最多一个。 -->
`;

function clean(value) {
  return String(value ?? '')
    .replace(/[\r\n]+/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/[｜|]/g, '/')
    .trim();
}

/** 解析梗库 markdown → [{term, meaning, example, date}]（越靠前越新）。 */
export function parseSlang(markdown) {
  const out = [];
  for (const rawLine of String(markdown ?? '').split('\n')) {
    const line = rawLine.trim();
    const hit = line.match(/^-\s*\*\*(.+?)\*\*\s*[:：]\s*(.*)$/);
    if (!hit) continue;
    const term = clean(hit[1]);
    const rest = hit[2] ?? '';
    const parts = rest.split('/').map((part) => part.trim());
    const meaning = clean(parts[0] ?? '');
    const example = clean((rest.match(/例[:：]\s*([^/]+)/) ?? [])[1] ?? '');
    const date = clean((rest.match(/(\d{4}-\d{2}-\d{2})/) ?? [])[1] ?? '');
    if (!term) continue;
    out.push({ term, meaning, example, date });
  }
  return out;
}

/** 写回文件（新的在前）。 */
export function formatSlang(entries) {
  const lines = entries.slice(0, MAX_ENTRIES).map((entry) => {
    const bits = [entry.meaning || '（还没想清楚怎么解释）'];
    if (entry.example) bits.push(`例：${entry.example}`);
    if (entry.date) bits.push(entry.date);
    return `- **${entry.term}**：${bits.join(' / ')}`;
  });
  return `${HEADER}\n${lines.join('\n')}\n`;
}

/** 渲染成 prompt 里的一小段。 */
export function renderSlang(entries, { show = SHOW } = {}) {
  const list = (entries ?? []).slice(0, show);
  if (list.length === 0) return '';
  const lines = list.map((entry) => {
    const extra = entry.example ? `（比如：${entry.example}）` : '';
    return `- ${entry.term}：${entry.meaning}${extra}`;
  });
  return `[最近网上学的梗]
（这些是你自己上网刷来的。**用得上的时候用**，一条消息最多一个；不懂就别硬套，套错了很尬。）
${lines.join('\n')}`;
}

/** 热加载器：改完下一条消息生效。 */
export function createSlang({ file, log }) {
  let cache = { key: 'miss', entries: [], text: '' };

  async function signature() {
    try {
      const info = await stat(file);
      return `${info.mtimeMs}:${info.size}`;
    } catch {
      return 'missing';
    }
  }

  async function load() {
    const key = await signature();
    if (key !== cache.key) {
      let body = '';
      try {
        body = await readFile(file, 'utf8');
      } catch (error) {
        if (error?.code !== 'ENOENT') log?.warn(`读取梗库失败 ${file}：${error?.message ?? error}`);
      }
      const entries = parseSlang(body);
      cache = { key, entries, text: renderSlang(entries) };
    }
    return cache;
  }

  async function add({ term, meaning, example, date }) {
    const value = clean(term);
    if (!value) return { added: false, reason: 'empty' };
    const { entries } = await load();
    const exists = entries.some((entry) => entry.term.toLowerCase() === value.toLowerCase());
    if (exists) return { added: false, reason: 'duplicate', term: value };
    const next = [
      { term: value, meaning: clean(meaning), example: clean(example), date: date || new Date().toISOString().slice(0, 10) },
      ...entries,
    ].slice(0, MAX_ENTRIES);
    await mkdir(dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    await writeFile(tmp, formatSlang(next), 'utf8');
    await rename(tmp, file);
    cache = { key: await signature(), entries: next, text: renderSlang(next) };
    log?.info?.(`梗库 +1：${value}`);
    return { added: true, term: value };
  }

  return { file, load, add, parse: parseSlang, format: formatSlang };
}
