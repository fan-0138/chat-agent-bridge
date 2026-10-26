/** 把长回复切成微信能接受的若干段；代码块即使被切断也保持围栏成对，避免渲染错乱。 */

export function splitReply(text, limit = 1800) {
  const normalized = text.replace(/\r\n/g, '\n').trim();
  if (!normalized || normalized.length <= limit) return normalized ? [normalized] : [];

  const chunks = [];
  let current = '';

  for (const line of normalized.split('\n')) {
    if (current && current.length + line.length + 1 > limit) {
      chunks.push(current.trimEnd());
      current = '';
    }
    if (line.length > limit) {
      for (let i = 0; i < line.length; i += limit - 64) {
        chunks.push(line.slice(i, i + limit - 64));
      }
      continue;
    }
    current += `${line}\n`;
  }
  if (current.trim()) chunks.push(current.trimEnd());

  // 兜底：任何一段里代码围栏数量为奇数时，补齐闭合围栏。
  return chunks.filter(Boolean).map(closeDanglingFence);
}

function closeDanglingFence(chunk) {
  const fences = chunk.match(/^```/gm)?.length ?? 0;
  return fences % 2 === 1 ? `${chunk}\n\`\`\`` : chunk;
}

/**
 * 把回复切成「人类聊天那种」的几条短消息。
 * - 代码块 / 很短的回复：整条发，不切
 * - 按句末标点切，累积到 maxLen 一条
 * - 最多 maxBubbles 条，多出来的并进最后一条（避免刷屏）
 */
export function splitBubbles(text, { maxLen = 90, maxBubbles = 3 } = {}) {
  const normalized = String(text ?? '').replace(/\r\n/g, '\n').trim();
  if (!normalized) return [];
  if (normalized.includes('```') || normalized.length <= maxLen || maxBubbles <= 1) return [normalized];

  const sentences = normalized
    .split(/(?<=[。！？!?…~～\n])/)
    .map((s) => s.trim())
    .filter(Boolean);

  const bubbles = [];
  let current = '';
  for (const sentence of sentences) {
    if (current && (current.length + sentence.length > maxLen || bubbles.length + 1 >= maxBubbles)) {
      bubbles.push(current);
      current = sentence;
      continue;
    }
    current += sentence;
  }
  if (current) bubbles.push(current);

  if (bubbles.length > maxBubbles) {
    return [...bubbles.slice(0, maxBubbles - 1), bubbles.slice(maxBubbles - 1).join('')];
  }
  // 太短的碎片（一句"唔"）并到前一条，避免刷屏
  const merged = [];
  for (const bubble of bubbles) {
    if (merged.length > 0 && bubble.length < 8) merged[merged.length - 1] += bubble;
    else merged.push(bubble);
  }
  return merged;
}
