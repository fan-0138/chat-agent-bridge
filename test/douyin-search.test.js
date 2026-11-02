import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

test('刷抖音支持「搜她自己想看的」', async () => {
  const feed = await readFile(join(ROOT, 'scripts', 'douyin-feed.mjs'), 'utf8');
  assert.match(feed, /--query/);
  assert.match(feed, /douyin\.com\/search\//);
  // 搜索接口的返回是 data:[{aweme_info}]，要拆一层
  assert.match(feed, /aweme_info/);

  const life = await readFile(join(ROOT, 'src', 'life.js'), 'utf8');
  assert.match(life, /takeSearch/);
  assert.match(life, /args\.push\('--query', query\)/);
  // 代刷通道也要能搜（浏览器被私信通道占着时走这条）
  const channel = await readFile(join(ROOT, 'src', 'douyin-channel.js'), 'utf8');
  assert.match(channel, /general\\\/search/);
  assert.match(channel, /request\.query/);
});

test('她脑子里「想看」的东西会被取走一次', async () => {
  const mind = await readFile(join(ROOT, 'src', 'mind.js'), 'utf8');
  assert.match(mind, /'想看'/);
  assert.match(mind, /pendingSearch/);
  assert.match(mind, /takeSearch/);
});