/**
 * 视频「看一眼」：抽几张静帧交给看图模型，再把音轨丢给 whisper 转写。
 *
 * 为什么这么做：QQ 视频桥接只能拿到 mp4，模型本身看不见视频；
 * 但看几张关键静帧 + 听它说了什么，足够接话（「这像不像你」这种问题也能答）。
 */

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** 抽帧时间点：避开开头黑场和结尾 logo，按 10%~85% 均匀取。 */
export function frameTimes(durationSec, count = 3) {
  const total = Number(durationSec) || 0;
  const n = Math.max(1, Math.min(5, Number(count) || 3));
  if (!(total > 0.3)) return [0]; // 太短的片子直接取第一帧
  const start = Math.min(total * 0.1, 1.5);
  const end = Math.max(start, Math.min(total * 0.85, total - 0.1));
  if (n === 1 || end <= start) return [Number(((start + end) / 2).toFixed(3))];
  const times = [];
  for (let i = 0; i < n; i += 1) {
    times.push(Number((start + ((end - start) * i) / (n - 1)).toFixed(3)));
  }
  return times;
}

/** 只留中文/字母/数字和常用标点，转写结果别带一堆符号。 */
export function tidyTranscript(text) {
  return String(text ?? '')
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/[^\u4e00-\u9fffa-zA-Z0-9，。！？、,.!?：:；;…—\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * @param {object} options
 * @param {string} [options.ffmpegBin]
 * @param {string} [options.ffprobeBin]
 * @param {string} [options.whisperBin]
 * @param {string} [options.whisperModel]
 * @param {any} [options.vision]  createVision() 的实例
 * @param {string} [options.workDir] 抽帧/临时音频放哪
 * @param {number} [options.maxFrames]
 * @param {number} [options.timeoutMs]
 * @param {(file:string, args:string[], opts?:any)=>Promise<any>} [options.run] 便于测试注入
 */
export function createVideoProbe({
  ffmpegBin = 'ffmpeg',
  ffprobeBin = 'ffprobe',
  whisperBin = 'whisper-cli',
  whisperModel = '',
  vision = null,
  workDir = '',
  maxFrames = 3,
  timeoutMs = 180_000,
  log = console,
  run = execFileAsync,
} = {}) {
  const enabled = Boolean(workDir);
  const whisperReady = Boolean(whisperModel) && existsSync(whisperModel);

  async function duration(path) {
    const { stdout } = await run(ffprobeBin, [
      '-v',
      'error',
      '-show_entries',
      'format=duration',
      '-of',
      'csv=p=0',
      path,
    ]);
    return Number.parseFloat(String(stdout).trim()) || 0;
  }

  async function grabFrames(path, seconds) {
    const dir = join(workDir, 'frames');
    await mkdir(dir, { recursive: true });
    const stamp = Date.now();
    const out = [];
    for (const [index, at] of seconds.entries()) {
      const file = join(dir, `${stamp}-${index + 1}.jpg`);
      try {
        await run(ffmpegBin, [
          '-v',
          'error',
          '-y',
          '-ss',
          String(at),
          '-i',
          path,
          '-frames:v',
          '1',
          '-vf',
          'scale=720:-1',
          file,
        ], { timeout: 30_000 });
        if (existsSync(file)) out.push({ at, path: file });
      } catch (error) {
        log.warn?.(`视频抽帧失败（${at}s）：${error?.message ?? error}`);
      }
    }
    return out;
  }

  async function transcribe(path) {
    if (!whisperReady) return { text: '', reason: '没有 whisper 模型（QQ_WHISPER_MODEL）' };
    const wav = join(workDir, `audio-${Date.now()}.wav`);
    try {
      await run(ffmpegBin, ['-v', 'error', '-y', '-i', path, '-vn', '-ar', '16000', '-ac', '1', wav], {
        timeout: 60_000,
      });
      const { stdout } = await run(whisperBin, ['-m', whisperModel, '-l', 'zh', '-nt', '-f', wav], {
        timeout: Math.min(timeoutMs, 120_000),
        maxBuffer: 4 * 1024 * 1024,
      });
      return { text: tidyTranscript(stdout), reason: null };
    } catch (error) {
      return { text: '', reason: `语音转写失败：${error?.message ?? error}` };
    } finally {
      await rm(wav, { force: true }).catch(() => {});
    }
  }

  /**
   * @param {string} path 本地视频路径
   * @returns {Promise<{durationSec:number, frames:{at:number,path:string}[], shots:{at:number,evidence:string}[], transcript:string, evidence:string}|null>}
   */
  async function probe(path) {
    if (!enabled || !path) return null;
    try {
      await mkdir(workDir, { recursive: true });
      const durationSec = await duration(path);
      if (!durationSec) return null;
      const frames = await grabFrames(path, frameTimes(durationSec, maxFrames));
      const shots = [];
      if (vision?.available) {
        // 只看两张：开头一张 + 中间一张，够判断「这是什么视频」了；并发跑，省时间
        const picked = frames.length <= 2 ? frames : [frames[0], frames[Math.floor(frames.length / 2)]];
        const results = await Promise.all(
          picked.map((frame) =>
            vision
              .analyze(frame.path)
              .then((evidence) => (evidence ? { at: frame.at, evidence: String(evidence).slice(0, 2_200) } : null))
              .catch(() => null),
          ),
        );
        for (const shot of results) if (shot) shots.push(shot);
      }
      const { text: transcript, reason: transcriptReason } = await transcribe(path);
      const lines = [`视频时长约 ${durationSec.toFixed(1)} 秒；她拿到的是 ${frames.length} 张静帧，不是连续画面。`];
      for (const shot of shots) {
        lines.push(`【约 ${shot.at}s 的这一帧】`);
        lines.push(shot.evidence);
      }
      if (!shots.length) lines.push(`（这${frames.length}帧没能识别出内容${vision?.available ? '' : '：看图能力不可用'}）`);
      if (transcript) lines.push(`【音轨转写（普通话识别，可能有错字）】${transcript}`);
      else if (transcriptReason) lines.push(`（${transcriptReason}）`);
      return { durationSec, frames, shots, transcript, evidence: lines.join('\n') };
    } catch (error) {
      log.warn?.(`视频识别失败：${error?.message ?? error}`);
      return null;
    }
  }

  return {
    available: enabled,
    reason: enabled ? null : '视频识别没配工作目录',
    probe,
  };
}