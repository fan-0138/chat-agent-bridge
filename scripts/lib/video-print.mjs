/**
 * 一个片子文件的「指纹」——发之前拿它跟账本比，重命名、重编码都躲不过。
 *
 * 三样东西：
 *   - sha256：字节级指纹，同一个文件重传必中；
 *   - durationMs：时长（毫秒），同一个片子重编码后基本不变；
 *   - frames：每 2 秒抽一帧缩成 9×8 灰度算 dHash，改码率/换封装还是同一段画面。
 *
 * 走本机 ffmpeg（/opt/homebrew/bin），不联网、不装包。
 */

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

/** 文件字节的 sha256。 */
export async function fileSha256(file) {
  const hash = createHash('sha256');
  await new Promise((resolve, reject) => {
    const stream = createReadStream(file);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', resolve);
    stream.on('error', reject);
  });
  return hash.digest('hex');
}

/** 片子多长（毫秒）；读不出来就 0。 */
export async function probeDurationMs(file) {
  try {
    const { stdout } = await run(
      'ffprobe',
      ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file],
      { timeout: 30_000 },
    );
    return Math.round(Number(String(stdout).trim()) * 1000) || 0;
  } catch {
    return 0;
  }
}

/**
 * 每 fps 抽一帧（默认 2 秒一帧），缩成 9×8 灰度算 dHash。
 * 想抬 fps 就传 { fps: '1' }；片子越长帧越多，但对重编码更稳。
 */
export async function frameHashes(file, { fps = '1/2' } = {}) {
  try {
    const { stdout } = await run(
      'ffmpeg',
      ['-v', 'error', '-i', file, '-vf', `fps=${fps},scale=9:8:flags=area,format=gray`, '-f', 'rawvideo', '-'],
      { timeout: 180_000, maxBuffer: 64 * 1024 * 1024, encoding: 'buffer' },
    );
    const size = 9 * 8;
    const hashes = [];
    for (let offset = 0; offset + size <= stdout.length; offset += size) {
      const pixels = stdout.subarray(offset, offset + size);
      let bits = 0n;
      for (let y = 0; y < 8; y += 1) {
        for (let x = 0; x < 8; x += 1) {
          const left = pixels[y * 9 + x];
          const right = pixels[y * 9 + x + 1];
          bits = (bits << 1n) | (left > right ? 1n : 0n);
        }
      }
      hashes.push(bits.toString(16).padStart(16, '0'));
    }
    return hashes;
  } catch {
    return [];
  }
}

/** 三样一起取。任何一个取不到就留空，不抛错（发布流程不该因为指纹失败而崩）。 */
export async function videoPrint(file) {
  const [sha256, durationMs, frames] = await Promise.all([fileSha256(file), probeDurationMs(file), frameHashes(file)]);
  return { sha256, durationMs, frames };
}

export function escapeShell(file) {
  return JSON.stringify(file);
}