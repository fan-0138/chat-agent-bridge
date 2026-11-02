import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOM = join(HERE, '..', 'tools', 'room');

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

test('白天 / 黄昏两张房间图都在（仓库里不带 assets，本地有夜图才查）', async () => {
  const hasAssets = await exists(join(ROOM, 'assets', 'room-bg.png'));
  if (!hasAssets) return; // 开源仓库只同步代码，不同步二进制素材
  assert.equal(await exists(join(ROOM, 'assets', 'room-bg-day.png')), true);
  assert.equal(await exists(join(ROOM, 'assets', 'room-bg-dusk.png')), true);
});

test('房间页按时间换图，并且能 ?time= 钉死', async () => {
  const html = await readFile(join(ROOM, 'index.html'), 'utf8');
  assert.match(html, /ROOM_BG_BY_SLOT/);
  assert.match(html, /room-bg-day\.png/);
  assert.match(html, /room-bg-dusk\.png/);
  assert.match(html, /QUERY\.get\('time'\)/);
  assert.match(html, /slot-day/);
  assert.match(html, /slot-dusk/);
  // 娃娃屋有自己的白天/夜晚切图，别被这套覆盖
  assert.match(html, /if \(HOUSE\) return;/);
});

test('渲图和后期脚本都在（能重跑出这两张图）', async () => {
  assert.equal(await exists(join(ROOM, 'blender', 'render_time.py')), true);
  assert.equal(await exists(join(ROOM, 'blender', 'post_time.py')), true);
  const script = await readFile(join(ROOM, 'blender', 'render_time.py'), 'utf8');
  assert.match(script, /sun_window/);
  assert.match(script, /sky_fill/);
  assert.match(script, /PRESET/);
});