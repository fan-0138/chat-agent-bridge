/**
 * 表情包仓库：data/stickers/ 里的本地图片。
 *
 * 她偶尔会在聊天里丢一张表情包 —— 比任何语气词都更像真人。
 * 目录按 mtime 热加载，扔一张新图进去立刻能用，不用重启。
 *
 * 支持的格式：png / jpg / jpeg / gif / webp
 */

import { readdir, stat } from 'node:fs/promises';
import { extname, resolve } from 'node:path';

const EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp']);

/**
 * @param {{dir: string, log?: any}} options
 */
export function createStickers({ dir, log }) {
  const root = resolve(dir);
  /** @type {{files: string[], mtimeMs: number}} */
  let cache = { files: [], mtimeMs: 0 };

  async function refresh() {
    try {
      const info = await stat(root);
      if (info.mtimeMs === cache.mtimeMs) return cache.files;
      const entries = await readdir(root, { withFileTypes: true });
      const files = entries
        .filter((entry) => entry.isFile() && EXTENSIONS.has(extname(entry.name).toLowerCase()))
        .map((entry) => resolve(root, entry.name))
        .sort();
      cache = { files, mtimeMs: info.mtimeMs };
      log?.info(`表情包已加载：${files.length} 张（${root}）`);
      return files;
    } catch (error) {
      if (error?.code !== 'ENOENT') log?.warn(`读取表情包目录失败 ${root}：${error?.message ?? error}`);
      cache = { files: [], mtimeMs: 0 };
      return [];
    }
  }

  return {
    refresh,
    async count() {
      return (await refresh()).length;
    },
    /** 随机挑一张；目录为空返回 null。 */
    async pick() {
      const files = await refresh();
      if (files.length === 0) return null;
      return files[Math.floor(Math.random() * files.length)];
    },
  };
}