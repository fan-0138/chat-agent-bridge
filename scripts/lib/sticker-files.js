/** 表情包文件的纯逻辑（单独拿出来，方便单测；CLI 只是壳）。 */

/**
 * 拆 modlens 的 JSON 输出，只要 summary 和 OCR 文字。
 * 拿整段 JSON 去正则匹配会出事：里面那些 intent / notes 字段的用词会把判断带偏。
 * @returns {{summary: string, ocr: string}}
 */
export function parseVision(evidence) {
  const raw = String(evidence ?? '');
  try {
    const parsed = JSON.parse(raw);
    const result = parsed?.result ?? {};
    return { summary: String(result.summary ?? ''), ocr: String(result.ocr?.full_text ?? '') };
  } catch {
    return { summary: raw, ocr: '' };
  }
}

/**
 * 按 summary 的首句判断「有没有某个主体」（默认鲸鱼）。
 * 首句是明确的回答（「有。」「没有。」「No, ...」），比整段里搜关键字可靠。
 * @param {string} summary
 * @param {string} subject
 * @returns {boolean|null} null = 看不出来
 */
export function judgeSubject(summary, subject = '鲸') {
  const text = String(summary ?? '').trim();
  if (!text) return null;
  const first = text.split(/[。！？!?\n]/)[0].trim();
  if (!first) return null;
  const noun = String(subject ?? '鲸').trim() || '鲸';
  const hit = new RegExp(`${noun}|whale`, 'i');
  const negAny = new RegExp(`(没有|没见|未见|不是|无)[^，,]{0,8}${noun}`);
  const negLine = new RegExp(`(没有|没见|未见|不是|无)[^。！？\\n]{0,8}${noun}`);
  if (/^(没有|没|否|不是|无|no\b)/i.test(first)) return false;
  if (/^(有|是|能|可以|嗯|yes\b)/i.test(first)) return true;
  if (negAny.test(first)) return false;
  if (hit.test(first)) return true;
  if (negLine.test(text)) return false;
  return hit.test(text) ? true : null;
}

export function judgeWhale(summary) {
  return judgeSubject(summary, '鲸');
}

/** 看文件头判断真实类型（微信/QQ 不认后缀不认的图） */

/** 看文件头判断真实类型（微信/QQ 不认后缀不认的图） */
export function imageType(buf) {
  if (!buf || buf.length < 12) return null;
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return { ext: 'png', mime: 'image/png' };
  if (buf[0] === 0xff && buf[1] === 0xd8) return { ext: 'jpg', mime: 'image/jpeg' };
  if (buf.subarray(0, 4).toString('ascii') === 'GIF8') return { ext: 'gif', mime: 'image/gif' };
  if (buf.subarray(0, 4).toString('ascii') === 'RIFF' && buf.subarray(8, 12).toString('ascii') === 'WEBP') {
    return { ext: 'webp', mime: 'image/webp' };
  }
  return null;
}

/**
 * 读图片宽高。只为拦掉 60×60 那种小到看不清的图，解析不出来就返回 null。
 * @returns {{width:number, height:number}|null}
 */
export function imageSize(buf) {
  const type = imageType(buf);
  if (!type) return null;

  if (type.ext === 'png') {
    if (buf.length < 24) return null;
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }

  if (type.ext === 'gif') {
    if (buf.length < 10) return null;
    return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
  }

  if (type.ext === 'jpg') {
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) {
        i += 1;
        continue;
      }
      const marker = buf[i + 1];
      // 无长度字段的标记
      if (marker === 0xff || marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) {
        i += 2;
        continue;
      }
      const len = buf.readUInt16BE(i + 2);
      if (len < 2) return null;
      const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
      if (isSof) {
        if (i + 9 > buf.length) return null;
        return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
      }
      i += 2 + len;
    }
    return null;
  }

  // webp：VP8X 最简单，VP8 / VP8L 要按位拆
  const chunk = buf.subarray(12, 16).toString('ascii');
  if (chunk === 'VP8X' && buf.length >= 30) {
    return { width: 1 + buf.readUIntLE(24, 3), height: 1 + buf.readUIntLE(27, 3) };
  }
  if (chunk === 'VP8 ' && buf.length >= 30) {
    return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
  }
  if (chunk === 'VP8L' && buf.length >= 25) {
    const b1 = buf[21];
    const b2 = buf[22];
    const b3 = buf[23];
    const b4 = buf[24];
    return {
      width: 1 + (((b2 & 0x3f) << 8) | b1),
      height: 1 + (((b4 & 0x0f) << 10) | (b3 << 2) | ((b2 & 0xc0) >> 6)),
    };
  }
  return null;
}

/** 下一个可用的编号：现有最大数字 + 1，至少两位 */
export function nextIndex(names) {
  let max = 0;
  for (const name of names ?? []) {
    const hit = String(name).match(/^(\d{1,3})-/);
    if (hit) max = Math.max(max, Number(hit[1]));
  }
  return String(max + 1).padStart(2, '0');
}

export const STICKER_NAME = /\.(png|jpe?g|gif|webp)$/i;

/**
 * 从必应图片搜索的 HTML 里抠原图地址。
 * 实测格式是 `murl&quot;:&quot;https://...&quot;`（HTML 转义过的 JSON），
 * 也兼容没有转义的版本。
 */
export function parseBingImageUrls(html, limit = 20) {
  const text = String(html ?? '');
  const urls = [];
  const patterns = [
    /murl&quot;:&quot;(https?:\/\/[^&]+?)&quot;/g,
    /"murl"\s*:\s*"(https?:\/\/[^"]+?)"/g,
  ];
  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(text)) !== null) {
      const url = match[1].replace(/\\\//g, '/');
      if (!/\.(png|jpe?g|gif|webp)(\?|$)/i.test(url) && !url.includes('image')) continue;
      if (!urls.includes(url)) urls.push(url);
      if (urls.length >= limit) return urls;
    }
  }
  return urls;
}
