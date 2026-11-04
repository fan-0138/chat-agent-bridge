/**
 * 「相册 / 手账」——她可能会想收起来的那几张图。
 *
 *   import { albumCandidates, saveToAlbum, listAlbum, albumImagePath } from './scrapbook.js';
 *   const picks = await albumCandidates({ root: process.cwd() });   // 最近的游戏截图 / 视频截图
 *   await saveToAlbum({ root, srcPath: picks[0].path, note: '这棵树长得好怪', source: 'game' });
 *   const items = await listAlbum({ root, limit: 60 });             // [{ at, relPath, note, source }]
 *
 * 数据位置：data/scrapbook/img/<时间戳>-<原名>，索引是 data/scrapbook/index.jsonl（一行一条）。
 * 只收本机小图，不引依赖；缺文件、坏行、坏时间一律当没看见，不抛错。
 */

import { appendFile, copyFile, mkdir, open, readdir, stat } from 'node:fs/promises';
import { basename, extname, isAbsolute, join, resolve, sep } from 'node:path';

const HOUR = 3_600_000;
const MAX_AGE_HOURS = 48; // 只看最近两天的图
const TAIL_BYTES = 256 * 1024; // index.jsonl 会一直长，只读尾巴
const NOTE_CHARS = 80; // 手账那行字的长度上限
const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif']);

/** 候选来源：目录、扩展名、kind、给页面看的中文标签。 */
const SOURCES = [
  { dir: 'data/mc/shots', exts: ['.png'], kind: 'game', label: '游戏截图' },
  { dir: 'data/douyin/shots', exts: ['.jpg', '.png'], kind: 'douyin', label: '刷到的视频' },
];

/**
 * @typedef {{ path: string, relPath: string, at: number, kind: 'game'|'douyin', label: string }} Candidate
 * @typedef {{ at: number, relPath: string, note: string, source: string }} AlbumItem
 */

const rootOf = (root) => resolve(String(root || process.cwd()));
const imgDirOf = (root) => join(rootOf(root), 'data/scrapbook/img');
const indexPathOf = (root) => join(rootOf(root), 'data/scrapbook/index.jsonl');

/** 收成一行干净的字，最多 max 个字符。 */
function cleanText(value, max) {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function numberOr(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/** 一行一个 JSON：只读文件尾部 limit 行，坏行静默跳过。 */
async function readJsonlTail(file, limit = 400) {
  let handle = null;
  try {
    handle = await open(file, 'r');
    const { size } = await handle.stat();
    if (!size) return [];
    const start = Math.max(0, size - TAIL_BYTES);
    const length = size - start;
    const buffer = Buffer.allocUnsafe(length);
    await handle.read(buffer, 0, length, start);
    let text = buffer.toString('utf8');
    if (start > 0) {
      // 第一行可能是半截，丢掉
      const cut = text.indexOf('\n');
      text = cut >= 0 ? text.slice(cut + 1) : '';
    }
    const rows = [];
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        rows.push(JSON.parse(trimmed));
      } catch {
        /* 坏行跳过 */
      }
    }
    return rows.slice(-limit);
  } catch {
    return [];
  } finally {
    if (handle) await handle.close().catch(() => {});
  }
}

/**
 * 挑「她可能想收进相册」的图：游戏截图 + 刷到的视频截图，按 mtime 倒序，只要最近的。
 * @param {{ root?: string, now?: number, maxAgeHours?: number, limit?: number }} [options]
 * @returns {Promise<Candidate[]>}
 */
export async function albumCandidates({ root = process.cwd(), now = Date.now(), maxAgeHours = MAX_AGE_HOURS, limit = 8 } = {}) {
  try {
    const base = rootOf(root);
    const clock = numberOr(now, Date.now());
    const hours = numberOr(maxAgeHours, MAX_AGE_HOURS);
    const maxAge = (hours > 0 ? hours : MAX_AGE_HOURS) * HOUR;
    const max = Math.max(0, Math.floor(numberOr(limit, 8)));
    if (max === 0) return [];

    const found = [];
    for (const source of SOURCES) {
      const dir = join(base, source.dir);
      let names = [];
      try {
        names = await readdir(dir);
      } catch {
        continue; // 目录还没建就是还没有截图
      }
      for (const name of names) {
        const ext = extname(name).toLowerCase();
        if (!source.exts.includes(ext)) continue;
        const file = join(dir, name);
        try {
          const info = await stat(file);
          if (!info.isFile()) continue;
          const at = info.mtimeMs;
          // 太老的不要，时间坏的也不要
          if (!(at > 0) || clock - at > maxAge) continue;
          found.push({ path: file, relPath: `${source.dir}/${name}`, at, kind: source.kind, label: source.label });
        } catch {
          /* 文件刚好被删掉 / 读不到 */
        }
      }
    }
    // 两边混在一起按 mtime 倒序，取前 limit 张
    return found.sort((a, b) => b.at - a.at).slice(0, max);
  } catch {
    return [];
  }
}

/**
 * 收一张图进相册：复制到 data/scrapbook/img/，再往 index.jsonl 追加一行。
 * 源文件不存在 / 不是图片就返回 { ok: false, reason }，不抛错。
 * @param {{ root?: string, srcPath?: string, note?: string, at?: number, source?: string }} [options]
 * @returns {Promise<{ ok: true, path: string, relPath: string } | { ok: false, reason: string }>}
 */
export async function saveToAlbum({ root = process.cwd(), srcPath, note = '', at = Date.now(), source = 'game' } = {}) {
  try {
    const base = rootOf(root);
    const raw = String(srcPath ?? '').trim();
    if (!raw) return { ok: false, reason: '没有源文件' };
    // 相对路径按 root 算（候选里给的是绝对路径，这里兼容一下手写脚本）
    const src = isAbsolute(raw) ? resolve(raw) : resolve(base, raw);
    if (!IMAGE_EXTS.has(extname(src).toLowerCase())) return { ok: false, reason: '不是图片' };

    let info = null;
    try {
      info = await stat(src);
    } catch {
      return { ok: false, reason: '源文件不存在' };
    }
    if (!info.isFile()) return { ok: false, reason: '源文件不存在' };

    const clock = numberOr(at, Date.now());
    const stamp = Math.round(clock); // 文件名里的时间戳（毫秒）
    const name = basename(src);
    const fileName = `${stamp}-${name}`;
    const dir = imgDirOf(base);
    await mkdir(dir, { recursive: true });
    const dest = join(dir, fileName);
    await copyFile(src, dest);

    const relPath = `data/scrapbook/img/${fileName}`;
    const row = {
      at: stamp,
      path: relPath,
      note: cleanText(note, NOTE_CHARS),
      source: cleanText(source, 20) || 'game',
    };
    await appendFile(indexPathOf(base), `${JSON.stringify(row)}\n`, 'utf8');
    return { ok: true, path: dest, relPath };
  } catch (error) {
    return { ok: false, reason: String(error?.message ?? error) };
  }
}

/**
 * 读相册：index.jsonl 尾巴 → 按 at 倒序 → 最多 limit 条。
 * @param {{ root?: string, limit?: number }} [options]
 * @returns {Promise<AlbumItem[]>}
 */
export async function listAlbum({ root = process.cwd(), limit = 60 } = {}) {
  try {
    const max = Math.max(0, Math.floor(numberOr(limit, 60)));
    if (max === 0) return [];
    const rows = await readJsonlTail(indexPathOf(root), Math.max(max * 4, 400));
    const items = [];
    for (const row of rows) {
      if (!row || typeof row !== 'object') continue;
      const at = numberOr(row.at, 0);
      const relPath = String(row.path ?? '').trim();
      if (!(at > 0) || !relPath) continue; // 坏行：缺时间或缺路径，跳过
      items.push({
        at,
        relPath,
        note: String(row.note ?? ''),
        source: String(row.source ?? ''),
      });
    }
    return items.sort((a, b) => b.at - a.at).slice(0, max);
  } catch {
    return [];
  }
}

/**
 * 把 index 里的相对路径解析成绝对路径；落在 data/scrapbook/img 外面的一律返回 null。
 * 防目录穿越：resolve 之后用 startsWith(图片目录 + 分隔符) 卡一道。
 * @param {{ root?: string, relPath?: string }} [options]
 * @returns {string | null}
 */
export function albumImagePath({ root = process.cwd(), relPath } = {}) {
  try {
    const text = String(relPath ?? '').trim();
    if (!text || text.includes('\0')) return null;
    const base = rootOf(root);
    const dir = resolve(imgDirOf(base));
    // index 里的路径是相对 root 的，如 data/scrapbook/img/xxx.png
    let target = resolve(base, text);
    if (!target.startsWith(dir + sep)) {
      // 再给个方便：只写文件名（xxx.png）也认，但同样必须落在图片目录里
      if (/[/\\]/.test(text) || text === '.' || text === '..') return null;
      target = resolve(dir, text);
      if (!target.startsWith(dir + sep)) return null;
    }
    return target;
  } catch {
    return null;
  }
}