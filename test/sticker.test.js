import { test } from 'node:test';
import assert from 'node:assert/strict';
import { imageSize, imageType, judgeWhale, nextIndex, parseVision } from '../scripts/lib/sticker-files.js';

test('存表情包：只认文件头，不认后缀', () => {
  assert.equal(imageType(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]))?.ext, 'png');
  assert.equal(imageType(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0]))?.ext, 'jpg');
  assert.equal(imageType(Buffer.from('GIF89a______'))?.ext, 'gif');
  const webp = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0, 0, 0, 0]), Buffer.from('WEBP')]);
  assert.equal(imageType(webp)?.ext, 'webp');
  assert.equal(imageType(Buffer.from('<html>not an image</html>')), null);
  assert.equal(imageType(Buffer.from('')), null);
});

test('存表情包：编号接着现有的往下排', () => {
  assert.equal(nextIndex([]), '01');
  assert.equal(nextIndex(['01-a.png', '02-b.png']), '03');
  assert.equal(nextIndex(['15-a.png', '09-b.jpg']), '16');
  assert.equal(nextIndex(['随便一张.png']), '01');
});

test('存表情包：能读出宽高（用来拦 60×60 那种小图）', () => {
  const png = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png, 0);
  png.writeUInt32BE(320, 16);
  png.writeUInt32BE(240, 20);
  assert.deepEqual(imageSize(png), { width: 320, height: 240 });

  const gif = Buffer.alloc(13);
  gif.write('GIF89a', 0, 'ascii');
  gif.writeUInt16LE(60, 6);
  gif.writeUInt16LE(60, 8);
  assert.deepEqual(imageSize(gif), { width: 60, height: 60 });

  const parts = [Buffer.from([0xff, 0xd8])];
  const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0]);
  const sof = Buffer.alloc(17);
  sof[0] = 0xff;
  sof[1] = 0xc0;
  sof.writeUInt16BE(17, 2);
  sof[4] = 8;
  sof.writeUInt16BE(690, 5);
  sof.writeUInt16BE(700, 7);
  const jpeg = Buffer.concat([parts[0], app0, sof]);
  assert.deepEqual(imageSize(jpeg), { width: 700, height: 690 });

  const webp = Buffer.alloc(30);
  webp.write('RIFF', 0, 'ascii');
  webp.write('WEBP', 8, 'ascii');
  webp.write('VP8X', 12, 'ascii');
  webp.writeUIntLE(599, 24, 3);
  webp.writeUIntLE(339, 27, 3);
  assert.deepEqual(imageSize(webp), { width: 600, height: 340 });

  assert.equal(imageSize(Buffer.from('<html>nope</html>')), null);
  assert.equal(imageSize(Buffer.alloc(0)), null);
});

test('存表情包：按首句判断有没有鲸（整段 JSON 搜关键字会把动漫妹子放进来）', () => {
  assert.equal(judgeWhale('没有。图中只是一位白发蓝眼、戴白色花朵发饰的Q版动漫角色。'), false);
  assert.equal(judgeWhale('有。图里是一条蓝白配色的鲸鱼卡通图标。'), true);
  assert.equal(judgeWhale('No, there is no whale in this picture.'), false);
  assert.equal(judgeWhale('The image displays a stylized blue whale icon.'), true);
  assert.equal(judgeWhale(''), null);
});

test('存表情包：拆看图工具的输出，只认 summary 和 OCR 文字', () => {
  const raw = JSON.stringify({ image: '/x.png', result: { summary: '有。鲸鱼', ocr: { full_text: '图精灵 616PIC.COM' } } });
  const parsed = parseVision(raw);
  assert.equal(parsed.summary, '有。鲸鱼');
  assert.equal(parsed.ocr, '图精灵 616PIC.COM');
  assert.equal(parseVision('不是 JSON').summary, '不是 JSON');
});
