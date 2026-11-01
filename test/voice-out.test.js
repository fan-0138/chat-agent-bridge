import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseVoiceSegments, speakableText, createVoiceOut, VOICE_MARKER } from '../src/voice-out.js';

test('没有标记的回复整段都是文字', () => {
  assert.deepEqual(parseVoiceSegments('在呢，刚睡醒。'), [{ kind: 'text', text: '在呢，刚睡醒。' }]);
});

test('行首标记的那一行变成语音，前后文字保持原顺序', () => {
  const segments = parseVoiceSegments('好呀。\n【语音】爸爸晚安\n明天见。');
  assert.deepEqual(segments, [
    { kind: 'text', text: '好呀。' },
    { kind: 'voice', text: '爸爸晚安' },
    { kind: 'text', text: '明天见。' },
  ]);
});

test('正文里提到标记不算指令，只有行首才算', () => {
  const segments = parseVoiceSegments('我刚学会用【语音】这个说法。');
  assert.deepEqual(segments, [{ kind: 'text', text: '我刚学会用【语音】这个说法。' }]);
});

test('连续两行语音拆成两段，空标记行直接丢掉', () => {
  const segments = parseVoiceSegments('【语音】第一句\n【语音】\n【语音】第二句');
  assert.deepEqual(segments, [
    { kind: 'voice', text: '第一句' },
    { kind: 'voice', text: '第二句' },
  ]);
});

test('空回复不产生任何段', () => {
  assert.deepEqual(parseVoiceSegments('   '), []);
  assert.deepEqual(parseVoiceSegments(null), []);
});

test('多行文字会重新拼回去，不丢换行', () => {
  const segments = parseVoiceSegments('第一行\n第二行\n【语音】嗯\n第三行');
  assert.deepEqual(segments[0], { kind: 'text', text: '第一行\n第二行' });
  assert.deepEqual(segments[2], { kind: 'text', text: '第三行' });
});

test('念出口前把 emoji 和 Markdown 记号去掉', () => {
  assert.equal(speakableText('**爸爸**晚安🐳'), '爸爸晚安');
  assert.equal(speakableText('看这个 [链接](https://example.com)'), '看这个');
  assert.equal(VOICE_MARKER, '【语音】');
});

test('找不到 edge-tts 时明确不可用，而不是悄悄失败', () => {
  const voiceOut = createVoiceOut({ config: { edgeTtsBin: '/nonexistent/edge-tts' }, log: {} });
  assert.equal(voiceOut.enabled, false);
  assert.match(voiceOut.unavailable, /edge-tts/);
  assert.equal(voiceOut.canSpeak().ok, false);
});

test('关掉开关时即使装好了也不发', async () => {
  const voiceOut = createVoiceOut({ config: { voiceOutEnabled: false, edgeTtsBin: process.execPath }, log: {} });
  assert.equal(voiceOut.canSpeak().ok, false);
  await assert.rejects(() => voiceOut.speak('你好'), /语音没开/);
});
/* ── 声音复刻（GPT-SoVITS）接入（2026-11-02） ───────────────── */

test('默认还是 edge：不配就用微软那套', () => {
  const voice = createVoiceOut({
    config: { voiceOutEnabled: true, edgeTtsBin: '/bin/echo' },
    log: { info() {}, warn() {}, error() {} },
  });
  const stats = voice.stats();
  assert.equal(stats.provider, 'edge');
});

test('选了 gpt-sovits 但没配参考音频：明确说不可用，不瞎合成', () => {
  const voice = createVoiceOut({
    config: { voiceOutEnabled: true, voiceProvider: 'gpt-sovits', ttsRefAudio: '' },
    log: { info() {}, warn() {}, error() {} },
  });
  assert.equal(voice.enabled, false);
  assert.match(voice.unavailable, /参考音频/);
});

test('参考音频不存在也拦住（别等 90 秒超时）', () => {
  const voice = createVoiceOut({
    config: {
      voiceOutEnabled: true,
      voiceProvider: 'gpt-sovits',
      ttsRefAudio: '/tmp/definitely-not-here-4821.wav',
    },
    log: { info() {}, warn() {}, error() {} },
  });
  assert.equal(voice.enabled, false);
  assert.match(voice.unavailable, /找不到参考音频/);
});

test('响度归一默认开着，可以用空字符串关掉', () => {
  // 合成电平 -22~-23 LUFS，手机外放像蚊子叫；默认过一遍 loudnorm 拉到 -16
  const voice = createVoiceOut({
    config: { voiceOutEnabled: true, edgeTtsBin: '/bin/echo' },
    log: { info() {}, warn() {}, error() {} },
  });
  assert.equal(voice.loudnorm, 'loudnorm=I=-16:TP=-1.5:LRA=11');

  const off = createVoiceOut({
    config: { voiceOutEnabled: true, edgeTtsBin: '/bin/echo', voiceLoudnorm: '' },
    log: { info() {}, warn() {}, error() {} },
  });
  assert.equal(off.loudnorm, '');
});

test('情绪参数有默认值，也能被配置覆盖', () => {
  const voice = createVoiceOut({
    config: { voiceOutEnabled: true, edgeTtsBin: '/bin/echo' },
    log: { info() {}, warn() {}, error() {} },
  });
  assert.equal(voice.ttsTemperature, 1.4);

  const louder = createVoiceOut({
    config: { voiceOutEnabled: true, edgeTtsBin: '/bin/echo', ttsTemperature: 1.2, ttsTopK: 20 },
    log: { info() {}, warn() {}, error() {} },
  });
  assert.equal(louder.ttsTemperature, 1.2);
  assert.equal(louder.ttsTopK, 20);
});
