#!/usr/bin/env node
/**
 * 照镜子：看看自己长什么样。
 *
 *   node scripts/look-self.mjs                 # 空间里那身（白毛衣、格裙、鲸鱼耳）
 *   node scripts/look-self.mjs --video         # 抖音那条里的女仆装（从视频抽一帧看）
 *   node scripts/look-self.mjs --image <路径>  # 看任意一张（比如爸爸发来的图）
 *
 * 为什么要这个东西：她能背设定，但真问「你现在什么样」，
 * 设定和立绘/视频对不上时就说不清。给个能看见自己的口子，比多写两句人设管用。
 */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
const argv = process.argv.slice(2);
const arg = (name, fallback = '') => {
  const i = argv.indexOf(name);
  return i >= 0 ? (argv[i + 1] ?? fallback) : fallback;
};

const root = resolve(import.meta.dirname, '..');
const wantVideo = argv.includes('--video');
const explicit = arg('--image');

function resolveModlens() {
  const candidates = [
    process.env.VISION_CLI?.trim(),
    join(homedir(), '.dsh/profiles/desktop/node_modules/@liustack/modlens/dist/main.js'),
    join(homedir(), '.dsh/profiles/web/node_modules/@liustack/modlens/dist/main.js'),
  ].filter(Boolean);
  return candidates.find((file) => existsSync(file)) ?? null;
}

const cli = resolveModlens();
if (!cli) {
  console.error('找不到 modlens（看图工具），VEISION_CLI 也没配。');
  process.exit(2);
}

let image = explicit;
let videoPath = '';
if (!image) {
  if (wantVideo) {
    videoPath = join(root, 'data/video/xixi-doubao-10s-vertical.mp4');
    image = join(root, 'data/qq/inbox/self-look.jpg');
    await run('ffmpeg', ['-v', 'error', '-y', '-ss', '3', '-i', videoPath, '-frames:v', '1', '-vf', 'scale=540:-1', image]);
  } else {
    image = join(root, 'tools/room/assets/xixi.png');
  }
}

if (!existsSync(image)) {
  console.error(`没有这张图：${image}`);
  process.exit(2);
}

const prompt = '用第一人称描述这个角色：头发什么颜色长短、脸上有什么、穿什么、身上/背后的特征、手里拿着什么。只描述看得见的，别猜设定。';
const { stdout } = await run(
  process.execPath,
  [cli, 'analyze', '-i', image, '--timeout', '60000', '--prompt', prompt],
  { timeout: 90_000, maxBuffer: 6 * 1024 * 1024 },
);
const text = String(stdout || '').trim();
if (!text) {
  console.error('看图工具没返回内容。');
  process.exit(2);
}
console.log(text);