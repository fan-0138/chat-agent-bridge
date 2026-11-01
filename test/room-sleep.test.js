import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOM = resolve(HERE, '../tools/room');

/* ── 睡觉特写（2026-11-01：她真的盖被子睡，不再是坐在床沿打盹） ── */

test('页面里有睡觉特写：空床 / 被子 / 睡脸三层', async () => {
  const html = await readFile(resolve(ROOM, 'index.html'), 'utf8');
  for (const id of ['sleepScene', 'sleepBg', 'sleepDuvet', 'sleepBody']) {
    assert.match(html, new RegExp(`id="${id}"`), `页面缺 #${id}`);
  }
  for (const file of ['bed-bg.png', 'bed-duvet.png', 'sleep-body.png']) {
    assert.match(html, new RegExp(file), `页面没引用 ${file}`);
  }
});

test('睡着的时候能看到上半身，不许只剩一颗头（那样像被切开的）', async () => {
  const html = await readFile(resolve(ROOM, 'index.html'), 'utf8');
  assert.doesNotMatch(html, /id="sleepHead"/, '别再用「只有一颗头」的图');
  assert.match(html, /#sleepBody\s*\{[\s\S]{0,200}bottom:/, '上半身要落在被子沿上');
  assert.match(html, /top: 9%;/, '被子整体压下去，让被沿横着落在她腰上');
});

test('两种睡法都能选：床边特写 / 房里远景', async () => {
  const html = await readFile(resolve(ROOM, 'index.html'), 'utf8');
  assert.match(html, /id="sleepMode"/, '要有切换按钮');
  assert.match(html, /sleepview/, '要能用 ?sleepview= 固定');
  assert.match(html, /SLEEP_MODE_LABEL/, '要有模式名表');
  assert.match(html, /sleepView === 'room'/, '远景模式下不能切特写');
  assert.match(html, /localStorage/, '选过的睡法要能记住');
});

test('床头点着暖光，别让她躺在黑里', async () => {
  const build = await readFile(resolve(ROOM, 'blender/build_sleep.py'), 'utf8');
  assert.match(build, /sleep_lamp_light/, '生成脚本里要有床头灯');
  assert.match(build, /Emission Strength/, '灯罩要发光，不然是个白棍');
});

test('上床/起床是一套流程，不是直接换片段', async () => {
  const html = await readFile(resolve(ROOM, 'index.html'), 'utf8');
  assert.match(html, /async function tuckIn\(/, '缺上床（盖被子）');
  assert.match(html, /async function getUp\(/, '缺起床（掀被子）');
  assert.match(html, /is-turn/, '缺睡觉时翻身的那一下');
  assert.match(html, /wakeHoldUntil/, '叫醒后要有一阵子不再自动躺回去');
});

test('床这个热区走到床沿，别站在褥子上', async () => {
  const { HOTSPOTS, NODES } = await import('../tools/room/walk.mjs');
  const bed = HOTSPOTS.find((spot) => spot.id === 'bed');
  assert.ok(bed, '缺床的热区');
  assert.equal(bed.clip, 'sleep');
  assert.equal(bed.node, 'bedF', '床应该走到床沿再上床');
  assert.ok(NODES[bed.node], `热区指向了不存在的落脚点 ${bed.node}`);
});

test('小屋版没有床边特写时，睡觉仍能演（回落到坐着打盹）', async () => {
  const html = await readFile(resolve(ROOM, 'index.html'), 'utf8');
  // HOUSE 分支里保留 CLIPS.sleep，别让小屋直接白屏
  assert.match(html, /if \(HOUSE \|\| !SLEEP_SCENE_OK \|\| sleepView === 'room'\)[\s\S]{0,260}CLIPS\.sleep/);
});

test('睡觉的图如果同步过来了，就不能是空文件', async (t) => {
  for (const file of ['bed-bg.png', 'bed-duvet.png', 'sleep-body.png']) {
    try {
      const info = await stat(resolve(ROOM, 'assets', file));
      assert.ok(info.size > 1000, `${file} 太小了（${info.size} 字节）`);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      t.diagnostic(`跳过 ${file}：仓库不同步房间的 assets/`);
    }
  }
});
