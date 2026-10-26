/**
 * 让她真的「说话」：文本 → Edge TTS → mp3 → PCM → SILK → QQ 语音消息。
 *
 * 为什么一定要 SILK：QQ 的语音消息只认 silk（AMR-NB 那一套编码），mp3/wav 发过去
 * 客户端只会显示一个坏掉的语音条。SnowLuma 收到 record 段后会自己转码上传，
 * 所以这里给它的就是标准 silk。
 *
 * 依赖两样外部东西：
 *  - `.venv-tts/bin/edge-tts`：微软 Edge 的中文神经语音（免费、不用 key、比 macOS say 自然得多）。
 *    装在仓库里的独立 venv 里，不污染系统 Python。
 *  - `ffmpeg`：mp3 → 单声道 24k pcm_s16le（silk-wasm 只吃裸 PCM 或 wav）。
 *
 * 整条链路失败时必须安静降级回文字，绝不能让一句「想跟你说句话」变成聊天卡死。
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { encode } from 'silk-wasm';

/** 模型在回复里用来标记「这句我想说出口」的记号。只在行首生效。 */
export const VOICE_MARKER = '【语音】';

/** 一天最多几条语音、两条之间至少隔多久 */
const DAY_MS = 86_400_000;

/**
 * 把模型的一段回复拆成「文字段」和「语音段」。
 * - 只有行首的「【语音】」才算指令，正文里提到这个词不会误伤；
 * - 语音段只取该行剩余内容；
 * - 返回顺序和原文一致，便于按原节奏发出去。
 * @param {string} text
 * @returns {Array<{kind: 'text'|'voice', text: string}>}
 */
export function parseVoiceSegments(text) {
  const source = String(text ?? '');
  if (!source.trim()) return [];
  if (!source.includes(VOICE_MARKER)) return [{ kind: 'text', text: source.trim() }];

  /** @type {Array<{kind: 'text'|'voice', text: string}>} */
  const segments = [];
  let buffer = [];

  const flushText = () => {
    const joined = buffer.join('\n').trim();
    buffer = [];
    if (joined) segments.push({ kind: 'text', text: joined });
  };

  for (const line of source.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith(VOICE_MARKER)) {
      flushText();
      const body = trimmed.slice(VOICE_MARKER.length).trim();
      if (body) segments.push({ kind: 'voice', text: body });
      continue;
    }
    buffer.push(line);
  }
  flushText();
  return segments;
}

/** 语音里不该念出来的东西：emoji、Markdown 记号、多余空白。 */
export function speakableText(text) {
  return String(text ?? '')
    .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{200D}\u{2B00}-\u{2BFF}]/gu, '')
    .replace(/```+/g, '')
    .replace(/[*_~`>#]/g, '')
    .replace(/\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 跑一个子进程，收集 stdout/stderr，带超时。 */
function run(command, args, { timeoutMs = 25_000, stdin = null } = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    const out = [];
    const err = [];
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      reject(new Error(`${command} 超时（${timeoutMs}ms）`));
    }, timeoutMs);
    timer.unref?.();

    child.stdout.on('data', (data) => out.push(data));
    child.stderr.on('data', (data) => err.push(data));
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`${command} 启动失败：${error.message}`));
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) resolvePromise(Buffer.concat(out));
      else
        reject(
          new Error(`${command} 退出码 ${code}：${Buffer.concat(err).toString('utf8').slice(0, 200).trim()}`),
        );
    });
    if (stdin) child.stdin.end(stdin);
    else child.stdin.end();
  });
}

export function createVoiceOut({
  config = {},
  log = console,
  now = () => Date.now(),
} = {}) {
  const enabled = config.voiceOutEnabled !== false;
  const bin = config.edgeTtsBin || '.venv-tts/bin/edge-tts';
  const ffmpeg = config.ffmpegBin || 'ffmpeg';
  const voiceName = config.voiceOutName || 'zh-CN-XiaoyiNeural';
  const pitch = config.voiceOutPitch || '+0Hz';
  const rate = config.voiceOutRate || '+5%';
  const maxChars = config.voiceOutMaxChars ?? 120;
  const maxPerDay = config.voiceOutMaxPerDay ?? 8;
  const minGapMs = Math.max(0, Number(config.voiceOutMinGapMin ?? 8) * 60_000);
  const timeoutMs = config.voiceOutTimeoutMs ?? 25_000;

  const binPath = isAbsolute(bin) ? bin : resolve(process.cwd(), bin);
  /** @type {number[]} */
  let hits = [];

  function reasonUnavailable() {
    if (!enabled) return '语音没开（QQ_VOICE_OUT=0）';
    if (!existsSync(binPath)) return `找不到 edge-tts：${binPath}`;
    return null;
  }

  const unavailable = reasonUnavailable();

  function canSpeak(at = now()) {
    const unavailableReason = reasonUnavailable();
    if (unavailableReason) return { ok: false, reason: unavailableReason };

    const cutoff = at - DAY_MS;
    hits = hits.filter((stamp) => stamp > cutoff);
    if (maxPerDay > 0 && hits.length >= maxPerDay) {
      return { ok: false, reason: `今天已经说了 ${hits.length} 条语音` };
    }
    const last = hits[hits.length - 1];
    if (last && minGapMs > 0 && at - last < minGapMs) {
      return { ok: false, reason: `离上一条语音不到 ${Math.round(minGapMs / 60_000)} 分钟` };
    }
    return { ok: true };
  }

  /**
   * 合成一条语音。
   * @param {string} raw
   * @returns {Promise<{silk: Buffer, durationMs: number, text: string}>}
   */
  async function speak(raw) {
    const reason = reasonUnavailable();
    if (reason) throw new Error(reason);

    const text = speakableText(raw).slice(0, maxChars);
    if (!text) throw new Error('没有可念的内容');

    const dir = await mkdtemp(join(tmpdir(), 'dsh-voice-'));
    try {
      const inputFile = join(dir, 'in.txt');
      const mp3File = join(dir, 'out.mp3');
      await writeFile(inputFile, text, 'utf8');

      await run(
        binPath,
        [
          '--voice',
          voiceName,
          '--pitch',
          pitch,
          '--rate',
          rate,
          '--file',
          inputFile,
          '--write-media',
          mp3File,
        ],
        { timeoutMs },
      );

      const mp3 = await readFile(mp3File);
      if (mp3.length < 512) throw new Error('TTS 返回的音频是空的');

      const pcm = await run(ffmpeg, [
        '-hide_banner',
        '-loglevel',
        'error',
        '-i',
        'pipe:0',
        '-f',
        's16le',
        '-ar',
        '24000',
        '-ac',
        '1',
        'pipe:1',
      ].map(String), { timeoutMs, stdin: mp3 });

      const silk = await encode(pcm, 24000);
      hits.push(now());
      return { silk: Buffer.from(silk.data), durationMs: silk.duration, text };
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }

  return {
    enabled: !unavailable,
    unavailable,
    voiceName,
    canSpeak,
    speak,
    stats() {
      const cutoff = now() - DAY_MS;
      hits = hits.filter((stamp) => stamp > cutoff);
      return { voice: voiceName, today: hits.length, maxPerDay, minGapMin: minGapMs / 60_000 };
    },
  };
}

export { run as runProcess };