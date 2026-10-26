#!/usr/bin/env node
/**
 * 把任意二维码内容渲染成 PNG，方便在没有终端二维码的场景（launchd 后台运行、
 * 远程查看日志）下扫码登录。
 *
 *   node scripts/qr.js "https://liteapp.weixin.qq.com/..." data/login-qr.png
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const QRCode = require('qrcode');

const [content, outArg] = process.argv.slice(2);
if (!content) {
  console.error('用法: node scripts/qr.js "<二维码内容>" [输出文件.png]');
  process.exit(1);
}

const out = resolve(outArg || 'data/login-qr.png');
await mkdir(dirname(out), { recursive: true });
const png = await QRCode.toBuffer(content, {
  type: 'png',
  width: 720,
  margin: 2,
  errorCorrectionLevel: 'M',
  color: { dark: '#000000', light: '#ffffff' },
});
await writeFile(out, png);
console.log(`二维码已写入 ${out}`);
