#!/usr/bin/env node
/**
 * 看看自己住的地方：把房间那张 Blender 渲的图，交给看图工具描述一遍。
 *
 *   node scripts/look-room.mjs            # 夜里那版（默认）
 *   node scripts/look-room.mjs --day      # 白天
 *   node scripts/look-room.mjs --dusk     # 黄昏
 *   node scripts/look-room.mjs --curtain  # 夜里、窗帘拉上
 *
 * 为什么要这个：房间是给她住的地方，但她的感知全是文字（state.json / 记忆 / 聊天），
 * 屋子改造完她是不知道的——除非给她一条能「看见」的通道。和 look-self.mjs 一样，
 * 只描述看得见的，别让她背设定。
 */
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const argv = process.argv.slice(2);
const root = resolve(import.meta.dirname, '..');

const pick = argv.includes('--curtain')
  ? 'room-bg-curtain.png'
  : argv.includes('--day')
    ? 'room-bg-day.png'
    : argv.includes('--dusk')
      ? 'room-bg-dusk.png'
      : 'room-bg.png';

const image = join(root, 'tools/room/assets', pick);
if (!existsSync(image)) {
  console.error(`没有这张图：${image}`);
  process.exit(2);
}

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
  console.error('找不到 modlens（看图工具），VISION_CLI 也没配。');
  process.exit(2);
}

const prompt = [
  '用第一人称说清楚这间屋子：多大、地上铺了什么、左边右边各是什么区域、',
  '有哪些家具（桌子/床/书架/沙发之类）、墙上有啥、灯在哪、窗外能看到什么。',
  '只描述这张图里看得见的，别猜设定，别抒情。',
].join('');

/** 看图工具偶尔会「JSON 没闭合」直接报错退出——它其实已经把答案写在 stderr 里了，
 *  这里把它捞出来拼成人话，别因为格式问题她什么都看不见。 */
function salvage(stderr) {
  const raw = String(stderr ?? '');
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) return '';
  const slice = raw.slice(start, end + 1);
  let data = null;
  try {
    data = JSON.parse(slice);
  } catch {
    return '';
  }
  const parts = [];
  const push = (v) => {
    if (typeof v === 'string' && v.trim()) parts.push(v.trim());
  };
  const walk = (node, depth = 0) => {
    if (!node || depth > 6) return;
    if (Array.isArray(node)) {
      for (const item of node) walk(item, depth + 1);
      return;
    }
    if (typeof node !== 'object') return;
    for (const [key, value] of Object.entries(node)) {
      if (['summary', 'text', 'description', 'object', 'notes'].includes(key)) {
        if (Array.isArray(value)) value.forEach(push);
        else push(value);
      } else {
        walk(value, depth + 1);
      }
    }
  };
  walk(data);
  return [...new Set(parts)].join('；');
}

let text = '';
try {
  const { stdout } = await run(
    process.execPath,
    [cli, 'analyze', '-i', image, '--timeout', '60000', '--prompt', prompt],
    { timeout: 90_000, maxBuffer: 6 * 1024 * 1024 },
  );
  text = String(stdout || '').trim();
} catch (error) {
  text = salvage(error?.stderr);
  if (!text) {
    console.error(String(error?.stderr ?? error?.message ?? error).slice(0, 800));
    process.exit(2);
  }
}
if (!text) {
  console.error('看图工具没返回内容。');
  process.exit(2);
}

// modlens 回的是结构化 JSON；她要看的是「这屋子长什么样」，所以把 summary 抽出来，
// 拼上视觉备注，别的（ocr/layout 元数据）不用念给她听。
try {
  const data = JSON.parse(text);
  const result = data?.result ?? data;
  const lines = [];
  if (result?.summary) lines.push(String(result.summary).trim());
  const notes = result?.visual?.notes;
  if (Array.isArray(notes) && notes.length > 0) lines.push(`细节：${notes.join('；')}`);
  const style = result?.visual?.style;
  if (style) lines.push(`画面风格：${style}`);
  if (lines.length > 0) {
    console.log(lines.join('\n'));
    process.exit(0);
  }
} catch {
  /* 不是 JSON 就原样输出 */
}
console.log(text);