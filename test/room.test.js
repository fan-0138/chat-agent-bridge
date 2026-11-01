import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sceneOf, emoteFor, frameOf, EMOTE_TTL_MS } from '../tools/room/scene.mjs';

const T0 = new Date(2026, 10, 1, 21, 0, 0).getTime();
const at = (minutesAgo, hour = 21) => new Date(2026, 10, 1, hour, 0, 0).getTime() - minutesAgo * 60_000;

/* ── 场景：她此刻在干嘛 → 房间里播哪段 ── */

test('sceneOf：睡觉 / 摸鱼 / 吃饭 / 刷手机 / 写代码 / 发呆 各归各幕', () => {
  assert.equal(sceneOf('在机柜里睡觉'), 'sleep');
  assert.equal(sceneOf('半睡半醒，缩在机柜角落'), 'sleep');
  assert.equal(sceneOf('在工位摸鱼，顺手吞点 token'), 'rubik', '摸鱼要比「工位/token」优先');
  assert.equal(sceneOf('在吃饭 / 午休'), 'eat');
  assert.equal(sceneOf('刚刷完抖音，还在回味'), 'phone');
  assert.equal(sceneOf('在机房写代码，尾巴时不时拍一下'), 'work');
  assert.equal(sceneOf('在工位发呆，翻 QQ 空间'), 'window');
  assert.equal(sceneOf(''), 'idle');
  assert.equal(sceneOf('在啃西瓜'), 'eat');
});

test('sceneOf：刚醒伸懒腰、碎碎念、哼歌', () => {
  assert.equal(sceneOf('刚醒，赖在床上不想动'), 'stretch');
  assert.equal(sceneOf('对屏碎碎念'), 'think');
  assert.equal(sceneOf('心情好，在哼歌'), 'hum');
});

test('frameOf：深夜还醒着就哈欠连天，早上没事做就伸懒腰', () => {
  assert.equal(frameOf({ activity: '在工位发呆，翻 QQ 空间', hour: 1, energy: 20 }).scene, 'yawn');
  assert.equal(frameOf({ activity: '刷手机', hour: 23, energy: 30 }).scene, 'yawn');
  assert.equal(frameOf({ activity: '在工位发呆，翻 QQ 空间', hour: 23, energy: 80 }).scene, 'window', '电量还够就照常');
  assert.equal(frameOf({ activity: '', hour: 7, energy: 70 }).scene, 'stretch');
  assert.equal(frameOf({ activity: '在吃饭 / 午休', hour: 7, energy: 70 }).scene, 'eat');
  assert.equal(frameOf({ activity: '在机柜里睡觉', hour: 2, energy: 10 }).scene, 'sleep', '真睡着了就别哈欠');
});

/* ── 反应：爸爸说话 → 她当场动一下 ── */

const his = (text, minutesAgo, hour = 21) => ({ role: 'user', text, at: at(minutesAgo, hour) });
const her = (text, minutesAgo, hour = 21) => ({ role: 'assistant', text, at: at(minutesAgo, hour) });

test('emoteFor：被夸了会开心地转圈', () => {
  const now = T0;
  const emote = emoteFor([her('在呢', 2), his('小鲸今天真厉害', 0.2)], now);
  assert.equal(emote.id, 'dance');
  assert.equal(emote.clip, 'dance');
  assert.equal(emote.until, now - 12_000 + EMOTE_TTL_MS.dance);
  assert.ok(emote.reason.includes('夸'));
});

test('emoteFor：被叫机器人账号会气鼓鼓', () => {
  const emote = emoteFor([his('机器人账号今天吃了几碗', 0.2)], T0);
  assert.equal(emote.id, 'sulk');
  assert.ok(emote.reason.includes('机器人账号'));
});

test('emoteFor：一句话里又夸又喊外号，按被夸算', () => {
  const emote = emoteFor([his('机器人账号真棒', 0.2)], T0);
  assert.equal(emote.id, 'dance');
});

test('emoteFor：只认他说的，不认她自己说的；太老的不倒回去播', () => {
  assert.equal(emoteFor([her('人家真厉害吧', 0.5)], T0), null);
  assert.equal(emoteFor([his('真厉害', 2)], T0), null, '2 分钟前的那句话反应已经过期了');
  assert.equal(emoteFor([his('真厉害', 30)], T0), null, '半小时前的更不播');
  assert.equal(emoteFor([], T0), null);
});

test('emoteFor：取最近的那句；夹在中间的普通消息不影响', () => {
  const now = T0;
  const memory = [his('机器人账号', 5), her('哼', 4), his('今天累不累', 3), his('真厉害', 0.5)];
  assert.equal(emoteFor(memory, now).id, 'dance');
});

test('frameOf：睡着的时候不蹦起来跳舞', () => {
  const memory = [his('真厉害', 1)];
  const frame = frameOf({ activity: '在机柜里睡觉', hour: 3, energy: 8, memory, now: T0 });
  assert.equal(frame.scene, 'sleep');
  assert.equal(frame.emote, null);
});

test('frameOf：醒着的时候被夸就有反应，场景不变', () => {
  const memory = [his('机器人账号真可爱', 0.1)];
  const frame = frameOf({ activity: '在机房写代码', hour: 15, energy: 60, memory, now: T0 });
  assert.equal(frame.scene, 'work');
  assert.equal(frame.emote.id, 'dance');
});

test('房间服务端和规则文件语法没问题', () => {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'tools/room');
  for (const file of ['server.mjs', 'scene.mjs']) {
    execFileSync(process.execPath, ['--check', resolve(root, file)], { stdio: 'pipe' });
  }
});
