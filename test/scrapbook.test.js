import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { albumCandidates, albumImagePath, listAlbum, saveToAlbum } from '../src/scrapbook.js';

const HOUR = 3_600_000;
const MIN = 60_000;
const NOW = new Date(2026, 10, 3, 9, 0, 0).getTime(); // 固定时间，跑多久都稳
const ago = (ms) => NOW - ms;

// 一张最小的 PNG（只要字节在，模块不解析图片内容）
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489', 'hex');

async function tempRoot(t) {
  const root = await mkdtemp(join(tmpdir(), 'scrapbook-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function put(root, rel, content) {
  const file = join(root, rel);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, content);
  return file;
}

/** 写一张图并把 mtime 拨到指定时间。 */
async function putImage(root, rel, atMs = ago(1 * HOUR), bytes = PNG) {
  const file = await put(root, rel, bytes);
  const when = new Date(atMs);
  await utimes(file, when, when);
  return file;
}

async function putIndex(root, rows) {
  const text = `${rows.map((row) => (typeof row === 'string' ? row : JSON.stringify(row))).join('\n')}\n`;
  await put(root, 'data/scrapbook/index.jsonl', text);
}

const relPaths = (items) => items.map((item) => item.relPath);

/* ── 候选：只挑两天内的图，按 mtime 倒序 ── */

test('albumCandidates：48 小时内的游戏截图和视频截图，按 mtime 倒序', async (t) => {
  const root = await tempRoot(t);
  await putImage(root, 'data/mc/shots/old.png', ago(50 * HOUR));
  await putImage(root, 'data/mc/shots/mid.png', ago(10 * HOUR));
  await putImage(root, 'data/mc/shots/new.png', ago(2 * HOUR));
  await putImage(root, 'data/douyin/shots/d1.jpg', ago(5 * HOUR));
  await putImage(root, 'data/douyin/shots/d2.png', ago(30 * HOUR));
  await putImage(root, 'data/douyin/shots/d-old.jpg', ago(60 * HOUR));
  await put(root, 'data/mc/shots/notes.txt', '不是图');
  await put(root, 'data/douyin/shots/readme.webp', '也不是候选里的格式');

  const items = await albumCandidates({ root, now: NOW });
  assert.deepEqual(relPaths(items), [
    'data/mc/shots/new.png',
    'data/douyin/shots/d1.jpg',
    'data/mc/shots/mid.png',
    'data/douyin/shots/d2.png',
  ]);

  // 字段齐全：绝对路径、kind、中文标签
  for (const item of items) {
    assert.equal(item.path, join(root, item.relPath), 'path 是绝对路径');
    assert.equal(typeof item.at, 'number');
    assert.ok(item.at > 0);
  }
  assert.equal(items[0].kind, 'game');
  assert.equal(items[0].label, '游戏截图');
  assert.equal(items.find((item) => item.kind === 'douyin').label, '刷到的视频');

  // 时间倒序
  for (let i = 1; i < items.length; i += 1) assert.ok(items[i - 1].at >= items[i].at);
});

test('albumCandidates：limit 截断，maxAgeHours 可调', async (t) => {
  const root = await tempRoot(t);
  await putImage(root, 'data/mc/shots/a.png', ago(1 * HOUR));
  await putImage(root, 'data/mc/shots/b.png', ago(2 * HOUR));
  await putImage(root, 'data/mc/shots/c.png', ago(3 * HOUR));

  assert.deepEqual(relPaths(await albumCandidates({ root, now: NOW, limit: 2 })), [
    'data/mc/shots/a.png',
    'data/mc/shots/b.png',
  ]);

  // 窗口缩到 90 分钟：只剩最近那张
  const fresh = await albumCandidates({ root, now: NOW, maxAgeHours: 1.5 });
  assert.deepEqual(relPaths(fresh), ['data/mc/shots/a.png']);

  // 窗口为 0 张的时候也安全
  assert.deepEqual(await albumCandidates({ root, now: NOW, limit: 0 }), []);
});

test('albumCandidates：目录不存在返回空数组', async (t) => {
  const root = await tempRoot(t);
  assert.deepEqual(await albumCandidates({ root, now: NOW }), []);

  // 只有空目录也一样
  await mkdir(join(root, 'data/mc/shots'), { recursive: true });
  await mkdir(join(root, 'data/douyin/shots'), { recursive: true });
  assert.deepEqual(await albumCandidates({ root, now: NOW }), []);
});

/* ── 保存：复制进相册 + index 追加 ── */

test('saveToAlbum：复制到 img、index 追加一行、listAlbum 能读回来', async (t) => {
  const root = await tempRoot(t);
  const src = await putImage(root, 'data/mc/shots/2026-11-03T08-00-00-000Z.png', ago(1 * HOUR));
  const at = ago(10 * MIN);
  const saved = await saveToAlbum({ root, srcPath: src, note: '这棵树长得怪', at, source: 'game' });

  assert.equal(saved.ok, true);
  assert.match(saved.relPath, /^data\/scrapbook\/img\/\d+-2026-11-03T08-00-00-000Z\.png$/);
  assert.equal(saved.path, join(root, saved.relPath));
  assert.deepEqual(await readFile(saved.path), PNG, '复制后内容一致');

  const index = (await readFile(join(root, 'data/scrapbook/index.jsonl'), 'utf8')).trim().split('\n');
  assert.equal(index.length, 1, '追加了一行');
  const row = JSON.parse(index[0]);
  assert.equal(row.at, at);
  assert.equal(row.path, saved.relPath);
  assert.equal(row.note, '这棵树长得怪');
  assert.equal(row.source, 'game');

  const items = await listAlbum({ root });
  assert.equal(items.length, 1);
  assert.deepEqual(items[0], { at, relPath: saved.relPath, note: '这棵树长得怪', source: 'game' });
});

test('saveToAlbum：note 压成一行并截到 80 字', async (t) => {
  const root = await tempRoot(t);
  const src = await putImage(root, 'data/douyin/shots/v.jpg', ago(1 * HOUR));
  const note = `${'一'.repeat(100)}\n第二行`; // 100 字 + 换行
  const saved = await saveToAlbum({ root, srcPath: src, note, source: 'douyin' });
  assert.equal(saved.ok, true);

  const items = await listAlbum({ root });
  assert.equal(items[0].note.length, 80, '最多 80 字');
  assert.equal(items[0].note, '一'.repeat(80));
  assert.equal(items[0].source, 'douyin');
});

test('saveToAlbum：源文件不存在 / 不是图片 / 没给路径都返回 ok:false，不抛错', async (t) => {
  const root = await tempRoot(t);
  const missing = await saveToAlbum({ root, srcPath: join(root, 'data/mc/shots/没有这张.png') });
  assert.equal(missing.ok, false);
  assert.equal(typeof missing.reason, 'string');
  assert.ok(missing.reason.length > 0);

  const text = await put(root, 'data/mc/shots/notes.txt', '不是图');
  const notImage = await saveToAlbum({ root, srcPath: text });
  assert.equal(notImage.ok, false, '扩展名不认识就不收');

  const empty = await saveToAlbum({ root, srcPath: '' });
  assert.equal(empty.ok, false);

  // 失败的时候不该建出相册文件
  await assert.rejects(readFile(join(root, 'data/scrapbook/index.jsonl')), '没有写索引');
});

/* ── 列表：倒序、坏行跳过 ── */

test('listAlbum：坏行跳过、按 at 倒序、limit 生效', async (t) => {
  const root = await tempRoot(t);
  await putIndex(root, [
    '这不是 JSON',
    '{"at":',
    { at: ago(5 * HOUR), path: 'data/scrapbook/img/五小时.png', note: '', source: 'game' },
    { at: ago(2 * HOUR), path: 'data/scrapbook/img/两小时.png', note: '两小时前', source: 'douyin' },
    { path: 'data/scrapbook/img/没有时间.png', note: '缺 at' },
    { at: '坏时间', path: 'data/scrapbook/img/坏时间.png' },
    { at: ago(3 * HOUR), note: '缺 path' },
    'null',
    { at: ago(10 * MIN), path: 'data/scrapbook/img/十分钟.png', note: '最近一张', source: 'game' },
  ]);

  const items = await listAlbum({ root });
  assert.deepEqual(relPaths(items), [
    'data/scrapbook/img/十分钟.png',
    'data/scrapbook/img/两小时.png',
    'data/scrapbook/img/五小时.png',
  ]);
  assert.equal(items[0].note, '最近一张');
  assert.equal(items[1].source, 'douyin');

  assert.deepEqual(relPaths(await listAlbum({ root, limit: 2 })), [
    'data/scrapbook/img/十分钟.png',
    'data/scrapbook/img/两小时.png',
  ]);
  assert.deepEqual(await listAlbum({ root: join(root, 'data/没这个目录') }), [], '索引不存在返回空数组');
});

/* ── 路径校验：只认图片目录里的路径 ── */

test('albumImagePath：正常路径解析成绝对路径', async (t) => {
  const root = await tempRoot(t);
  const expected = join(root, 'data/scrapbook/img/1762160000000-a.png');
  assert.equal(
    albumImagePath({ root, relPath: 'data/scrapbook/img/1762160000000-a.png' }),
    expected,
  );
  // 只写文件名也认，但同样落在 img 目录里
  assert.equal(albumImagePath({ root, relPath: '1762160000000-a.png' }), expected);
});

test('albumImagePath：../ 穿越、绝对路径、空值都返回 null', async (t) => {
  const root = await tempRoot(t);
  for (const relPath of [
    '../etc/passwd',
    '../../../../etc/passwd',
    'data/scrapbook/img/../../../etc/passwd',
    'data/scrapbook/img/../../mind/stream.jsonl',
    '..\\..\\etc\\passwd',
    '/etc/passwd',
    '/data/scrapbook/img/a.png', // 绝对路径一律不认
    'data/scrapbook/not-img/a.png',
    'data/scrapbook/imgx/a.png',
    '',
    undefined,
  ]) {
    assert.equal(albumImagePath({ root, relPath }), null, `应该挡住：${String(relPath)}`);
  }
});