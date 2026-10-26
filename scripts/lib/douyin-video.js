/**
 * 读一条抖音视频的「摘要」：标题、作者、数据、热评。
 *
 * 用途：主人在私信里甩个视频链接过来，她要真的点开看过再回，
 * 而不是对着 URL 硬聊。
 */

import { pause, humanScroll } from './douyin-browser.mjs';

const DESC_SELECTORS = [
  '[data-e2e="video-desc"]',
  '[data-e2e="video-title"]',
  'h1',
  '[class*="video-info-detail"]',
  '[class*="videoDesc"]',
];

const AUTHOR_SELECTORS = [
  '[data-e2e="video-author-name"]',
  '[data-e2e="user-name"]',
  '[class*="author-name"]',
  '[class*="video-info"] [class*="name"]',
  'a[href*="/user/"] [class*="name"]',
];

/** 从任意文本里捞出抖音视频链接和视频 ID。 */
export function extractDouyinVideo(text) {
  const source = String(text ?? '');
  const urlMatch = source.match(/https?:\/\/(?:www\.|v\.|m\.)?douyin\.com\/[^\s"'）)]+/i);
  if (urlMatch) {
    const idMatch = urlMatch[0].match(/(?:video|note|modal_id=)\/?(\d{15,})/);
    if (idMatch) return { id: idMatch[1], url: `https://www.douyin.com/video/${idMatch[1]}` };
    return { id: null, url: urlMatch[0] };
  }
  // 只有裸 ID 的情况
  const bare = source.match(/(?:douyin\.com\/video\/)?(\d{19})\b/);
  if (bare) return { id: bare[1], url: `https://www.douyin.com/video/${bare[1]}` };
  return null;
}

/** 打开视频页，读标题/作者/热评。返回 null 表示读不到。 */
export async function readVideoSummary(page, url, { limit = 6 } = {}) {
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await pause(3_000, 4_500);
  await page.locator('text=打开声音').first().click({ timeout: 2_500 }).catch(() => {});
  await pause(500, 900);
  await page.mouse.move(900, 500).catch(() => {});
  await humanScroll(page, { steps: 2, minPx: 200, maxPx: 500 });
  await pause(1_200, 2_000);

  return page
    .evaluate(
      ({ descSelectors, authorSelectors, limit }) => {
        const pick = (selectors) => {
          for (const selector of selectors) {
            const node = document.querySelector(selector);
            const text = (node?.innerText ?? '').replace(/\s+/g, ' ').trim();
            if (text) return text;
          }
          return '';
        };

        const desc = pick(descSelectors);
        const author = pick(authorSelectors);

        const NOISE = /^(分享|回复|展开.*|\d+|\d+前·.*|\d+月前.*|\d+天前.*|刚刚|昨天.*|\.\.\.)$/;
        const comments = [...document.querySelectorAll('.comment-mainContent, [class*="comment-mainContent"]')]
          .slice(0, limit * 2)
          .map((node) => {
            const lines = (node.innerText ?? '')
              .split('\n')
              .map((line) => line.trim())
              .filter(Boolean);
            // 第一行通常是昵称，从第二行开始找正文
            const body = lines.slice(1);
            const text = body.find((line) => line.length >= 2 && !NOISE.test(line) && !/\d+前·/.test(line));
            return text ? text.slice(0, 100) : '';
          })
          .filter(Boolean)
          .slice(0, limit);

        const fallback = document.title.replace(/ - 抖音$/, '').trim();

        return { desc: desc || fallback, author, comments };
      },
      { descSelectors: DESC_SELECTORS, authorSelectors: AUTHOR_SELECTORS, limit },
    )
    .then((data) => ({ ...data, url }))
    .catch(() => null);
}

/** 拼成一段给模型看的描述。 */
export function formatVideoSummary(summary) {
  if (!summary) return '';
  const lines = [`链接：${summary.url}`];
  if (summary.desc) lines.push(`标题：${summary.desc.slice(0, 120)}`);
  if (summary.author) lines.push(`作者：${summary.author}`);
  if (summary.comments?.length) {
    lines.push('热评：');
    for (const comment of summary.comments.slice(0, 5)) lines.push(`  · ${comment}`);
  }
  return lines.join('\n');
}