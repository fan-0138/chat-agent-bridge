/**
 * 人设加载：读 persona.md（她是谁）+ persona.traits.json（性格刻度），拼成最终人设。
 * 两个文件都按 mtime 热加载 —— 改完下一条消息就生效，不用重启。
 */

import { readFile, stat } from 'node:fs/promises';
import { renderTraits, summarizeTraits } from './traits.js';

// 人设正文 + 刻度一共塞进 context 的上限。
// 2026-10-25：加了「黏人」那节后正文 6176 字，6500 已经会截掉结尾，放宽到 7200。
export const MAX_CHARS = 8_600;

async function signature(path) {
  try {
    const info = await stat(path);
    return `${info.mtimeMs}:${info.size}`;
  } catch {
    return 'missing';
  }
}

/**
 * @param {{file: string, traitsFile?: string, log?: any}} options
 * @returns {() => Promise<string>}
 */
export function createPersona({ file, traitsFile = file.replace(/\.md$/i, '.traits.json'), log }) {
  /** @type {{text: string, key: string}} */
  let cache = { text: '', key: '' };

  async function readTraits() {
    try {
      return JSON.parse(await readFile(traitsFile, 'utf8'));
    } catch (error) {
      if (error?.code !== 'ENOENT') log?.warn(`读取性格刻度失败 ${traitsFile}：${error?.message ?? error}`);
      return null;
    }
  }

  return async function getPersona() {
    const key = `${await signature(file)}|${await signature(traitsFile)}`;
    if (key === cache.key) return cache.text;

    let body = '';
    try {
      body = (await readFile(file, 'utf8')).trim();
    } catch (error) {
      if (error?.code !== 'ENOENT') log?.warn(`读取人设失败 ${file}：${error?.message ?? error}`);
    }

    if (!body) {
      // 人设文件都没有，就别只扔一堆刻度进去
      cache = { text: '', key };
      log?.warn(
        `没有找到人设文件 ${file}：先 cp persona.example.md persona.md，再照自己的喜好改（改完不用重启）`,
      );
      return '';
    }

    const rawTraits = await readTraits();
    const dials = renderTraits(rawTraits);
    // 先截正文再拼刻度，别把刻度截掉一半
    const budget = Math.max(0, MAX_CHARS - dials.length - 2);
    if (body.length > budget) {
      log?.warn(`人设正文 ${body.length} 字，超过上限，结尾被截掉 ${body.length - budget} 字（改 persona.md 或调 MAX_CHARS）`);
    }
    const head = body.slice(0, budget);
    const text = `${head}\n\n${dials}`;
    cache = { text, key };
    log?.info(`人设已加载：${file}（${body.length} 字）+ 刻度 ${summarizeTraits(rawTraits)}`);
    return text;
  };
}