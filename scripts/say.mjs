#!/usr/bin/env node
/**
 * 试听 / 试发她的语音。
 *
 *   node scripts/say.mjs "爸爸晚安"                     合成一条，存到 data/voice-out/，并在本机播一遍
 *   node scripts/say.mjs --send "爸爸晚安"              合成后真的发到你的 QQ（走桥接同一套发送逻辑）
 *   node scripts/say.mjs --voice zh-CN-XiaoxiaoNeural "..."   换个音色试
 *   node scripts/say.mjs --list                         列出可用的中文音色
 *
 * 想换默认音色就改 .env.qq 里的 QQ_VOICE_NAME，不用改代码。
 */

import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { decode } from 'silk-wasm';
import { loadQqConfig } from '../src/config-qq.js';
import { createLogger } from '../src/log.js';
import { startOneBot } from '../src/transport-onebot.js';
import { createVoiceOut } from '../src/voice-out.js';

const argv = process.argv.slice(2);
const flag = (name) => {
  const index = argv.indexOf(name);
  if (index === -1) return null;
  const value = argv[index + 1];
  argv.splice(index, value && !value.startsWith('--') ? 2 : 1);
  return value && !value.startsWith('--') ? value : '';
};
const send = argv.includes('--send');
if (send) argv.splice(argv.indexOf('--send'), 1);
const listVoices = argv.includes('--list');
if (listVoices) argv.splice(argv.indexOf('--list'), 1);
const voiceName = flag('--voice');
const text = argv.join(' ').trim();

const log = createLogger({ level: process.env.LOG_LEVEL || 'info' });
const config = loadQqConfig(process.env);
if (voiceName) config.voiceOutName = voiceName;

if (listVoices) {
  const bin = resolve(process.cwd(), config.edgeTtsBin);
  await new Promise((resolvePromise) => {
    const child = spawn(bin, ['--list-voices'], { stdio: 'inherit' });
    child.on('close', resolvePromise);
  });
  process.exit(0);
}

if (!text) {
  console.error('用法：node scripts/say.mjs [--voice 音色] [--send] "要说的话"');
  process.exit(1);
}

const voiceOut = createVoiceOut({ config, log });
if (voiceOut.unavailable) {
  console.error(`语音不可用：${voiceOut.unavailable}`);
  process.exit(1);
}

const verdict = voiceOut.canSpeak();
if (send && !verdict.ok) {
  console.error(`现在不该发语音：${verdict.reason}`);
  process.exit(1);
}

console.log(`音色：${voiceOut.voiceName}`);
const startedAt = Date.now();
const result = await voiceOut.speak(text);
console.log(`合成完成：${Math.round(result.durationMs / 1000)}s，silk ${result.silk.length}B，耗时 ${Date.now() - startedAt}ms`);

// 存一份 silk 备查（QQ 里那条语音的原始文件就是它）
const outDir = resolve(process.cwd(), 'data/voice-out');
await mkdir(outDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0, 14);
const silkPath = join(outDir, `${stamp}.silk`);
await writeFile(silkPath, result.silk);
console.log(`已保存：${silkPath}`);

// 本机听一遍：silk → wav（qq 之外的播放器都听不了 silk）
const pcm = await decode(result.silk, 24000);
const wavPath = join(outDir, `${stamp}.wav`);
await writeFile(wavPath, wavFromPcm(Buffer.from(pcm.data), 24000));
if (!send) {
  console.log(`本机试听：${wavPath}`);
  const player = spawn('afplay', [wavPath], { stdio: 'ignore' });
  player.on('error', () => console.log(`（打不开播放器，手动播：open ${wavPath}）`));
  player.on('close', () => process.exit(0));
  setTimeout(() => process.exit(0), 30_000);
} else {
  // 真发：复用桥接的 OneBot 发送逻辑（含节流、审计），发完就退
  const owner = config.allowList[0];
  if (!owner) {
    console.error('QQ_ALLOW_LIST 是空的，不知道发给谁');
    process.exit(1);
  }
  const transport = await startOneBot({
    config: { ...config, dataDir: `${config.dataDir}/qq`, auditFile: resolve(process.cwd(), config.auditFile) },
    log,
    onMessage: () => {},
  });
  await transport.ready;
  const target = { senderId: owner, conversationId: `private_${owner}`, groupId: null };
  await transport.sendVoice(target, result.silk, { text, durationMs: result.durationMs });
  console.log(`已发到 QQ ${owner}`);
  await transport.stop();
  process.exit(0);
}

function wavFromPcm(pcmBuffer, sampleRate) {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcmBuffer.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcmBuffer.length, 40);
  return Buffer.concat([header, pcmBuffer]);
}