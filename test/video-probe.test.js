import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createVideoProbe, frameTimes, tidyTranscript } from '../src/video.js';

const silentLog = { debug() {}, info() {}, warn() {}, error() {} };

/* ── 抽帧时间点 ─────────────────────────────────────── */

test('frameTimes：10 秒视频取 1s / 4.75s / 8.5s', () => {
  assert.deepEqual(frameTimes(10, 3), [1, 4.75, 8.5]);
});

test('frameTimes：极短视频不越界，只取第一帧', () => {
  assert.deepEqual(frameTimes(0.2, 3), [0]);
  assert.deepEqual(frameTimes(0, 3), [0]);
});

test('frameTimes：取帧数会被限制在 1~5', () => {
  assert.equal(frameTimes(20, 1).length, 1);
  assert.equal(frameTimes(20, 99).length, 5);
});

/* ── 转写清理 ───────────────────────────────────────── */

test('tidyTranscript：去掉方括号时间戳和奇怪符号', () => {
  assert.equal(tidyTranscript(' [00:00:01.000 --> 00:00:03.000]  这像不像你啊！ '), '这像不像你啊！');
  assert.equal(tidyTranscript(''), '');
});

/* ── probe：用注入的 run 假执行，不依赖本机 ffmpeg ──── */

function fakeRun(calls) {
  return async (bin, args) => {
    calls.push([bin, ...args]);
    if (bin === 'ffprobe') return { stdout: '6.5\n' };
    if (bin === 'whisper-cli') return { stdout: '这像不像你' };
    if (args.includes('-vf')) {
      // 抽帧：写一个占位文件，方便 probe 判断文件存在
      const target = args[args.length - 1];
      const { writeFile } = await import('node:fs/promises');
      await writeFile(target, 'jpg');
      return { stdout: '' };
    }
    return { stdout: '' };
  };
}

test('probe：抽帧 + 转写 + 视觉证据拼成一段话', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'video-probe-'));
  const calls = [];
  const vision = {
    available: true,
    async analyze(file) {
      return JSON.stringify({ image: file, summary: '一只蓝鲸玩偶在桌上' });
    },
  };
  const probe = createVideoProbe({
    workDir: dir,
    whisperModel: new URL(import.meta.url).pathname, // 只要文件存在就行
    vision,
    log: silentLog,
    run: fakeRun(calls),
  });
  const result = await probe.probe('/tmp/x.mp4');
  assert.ok(result);
  assert.equal(result.durationSec, 6.5);
  assert.equal(result.frames.length, 3);
  assert.equal(result.transcript, '这像不像你');
  assert.match(result.evidence, /视频时长约 6.5 秒/);
  assert.match(result.evidence, /蓝鲸玩偶/);
  assert.match(result.evidence, /这像不像你/);
  assert.ok(calls.some((call) => call[0] === 'whisper-cli'));
});

test('probe：没有 whisper 模型时只抽帧，转写为空', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'video-probe-'));
  const calls = [];
  const probe = createVideoProbe({
    workDir: dir,
    whisperModel: '',
    vision: null,
    log: silentLog,
    run: fakeRun(calls),
  });
  const result = await probe.probe('/tmp/x.mp4');
  assert.ok(result);
  assert.equal(result.transcript, '');
  assert.equal(result.shots.length, 0);
  assert.match(result.evidence, /没能识别出内容/);
  assert.ok(!calls.some((call) => call[0] === 'whisper-cli'));
});

test('probe：ffprobe 失败时返回 null，不抛异常', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'video-probe-'));
  const probe = createVideoProbe({
    workDir: dir,
    log: silentLog,
    run: async () => {
      throw new Error('ffprobe 不在');
    },
  });
  assert.equal(await probe.probe('/tmp/x.mp4'), null);
});

test('probe：没配工作目录就不可用', () => {
  const probe = createVideoProbe({ workDir: '', log: silentLog });
  assert.equal(probe.available, false);
  assert.match(probe.reason, /工作目录/);
});