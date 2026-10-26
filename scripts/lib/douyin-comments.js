/**
 * 抖音评论区：读评论 / 发评论。
 *
 * 结构（2026-10 线上实测）：
 *   评论区标题      .comment-title（「全部评论」）
 *   输入框容器      .comment-input-inner-container（占位文字「留下你的精彩评论吧」）
 *   单条评论        .comment-item-info-wrap + .comment-mainContent
 *
 * 抖音网页版评论区没有稳定 data-e2e，所以选择器都带兜底。
 */

import { pause, humanScroll } from './douyin-browser.mjs';
import { awemeIdFromUrl, buildMentionPayload, findCommentCidByText, lookupMention, publishComment, resolveReplyPlan } from './douyin-comment-api.js';

const INPUTS = [
  '.comment-input-inner-container',
  '[class*="comment-input-inner"]',
  '[class*="commentInput"]',
];

const ITEMS = ['.comment-item-info-wrap', '[class*="comment-item-info"]'];

async function prepare(page, url) {
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await pause(3_000, 4_500);
  await page.locator('text=打开声音').first().click({ timeout: 2_500 }).catch(() => {});
  await pause(500, 900);
  // 评论区在右侧，滚一下让它加载
  await page.mouse.move(900, 500).catch(() => {});
  await humanScroll(page, { steps: 2, minPx: 200, maxPx: 500 });
  await pause(1_200, 2_000);
}

/** 读当前视频的评论：[{author, text, likes}] */
export async function readComments(page, url, limit = 8) {
  await prepare(page, url);
  return page
    .evaluate(
      ({ itemSelectors, limit }) => {
        const nodes = itemSelectors.flatMap((selector) => [...document.querySelectorAll(selector)]);
        const unique = [...new Set(nodes)].slice(0, limit);
        return unique.map((node) => {
          const text = (node.innerText || '').replace(/\s+/g, ' ').trim();
          const author = text.slice(0, 12).split(' ')[0] ?? '';
          return { author, text: text.slice(0, 120) };
        });
      },
      { itemSelectors: ITEMS, limit },
    )
    .catch(() => []);
}

/**
 * 发一条评论 / 回复某条评论，可选 @ 某人。
 *
 * 全部走页面内 fetch（2026-10-25 重新实测过，结论跟早期不同）：
 *  - 服务端**不会**剥掉 text_extra 里的 sec_uid，只要按 UI 的格式带全
 *    {user_id, sec_uid, type:0, start, end}，返回的 comment.text_extra 里原样保留；
 *  - 反倒是走 UI 点发送会被风控拦下：响应 200、body 空、头里带
 *    x-tt-verify-passport-decision（verify_reason=gateway_biz_verify_with_face），
 *    要人脸二次验证 —— 无头环境没人验证，表现就是「点了没反应」。
 * 所以要真 @ 也走 fetch：先查候选（lookupMention）拿 user_id/sec_uid，再带上 text_extra 发。
 *
 * @param {{page: any, url: string, text: string, mention?: string, replyText?: string, dryRun?: boolean}} options
 */
export async function postComment(page, url, text, { mention = '', replyText = '', replyCid = '', rootCid: explicitRoot = '', dryRun = false } = {}) {
  if (!text || !text.trim()) return { ok: false, reason: '评论内容为空' };
  const awemeId = awemeIdFromUrl(url);
  if (!awemeId) return { ok: false, reason: '视频链接里没有 19 位 id，打不开' };

  // 先保证页面在抖音域下：后面所有接口都是相对路径 fetch
  if (!String(page.url() ?? '').includes('douyin.com')) {
    await page.goto('https://www.douyin.com/', { waitUntil: 'domcontentloaded', timeout: 45_000 }).catch(() => {});
    await pause(2_500, 3_500);
  }

  // 要真 @：查候选拿 user_id + sec_uid（跟 UI 点选时进 editor 的那个 token 同源）
  let mentionTag = null;
  if (mention) {
    mentionTag = await lookupMention(page, mention);
    if (!mentionTag) return { ok: false, reason: `@ 候选里没搜到「${mention}」（昵称对不对？）` };
  }

  let rootCid = '';
  let replyToCid = '';
  // 优先用明确的 cid（at-inbox 里就带着 commentId）：不用在评论区里按文字大海捞针
  if (replyCid || replyText) {
    const cid = replyCid || (await findCommentCidByText(page, awemeId, replyText));
    if (!cid) return { ok: false, reason: `评论区里找不到含「${replyText}」的那条` };
    // 已知楼根就直接用，别再翻评论区（翻楼接口实测会挂，能少一次就少一次）
    const plan = explicitRoot
      ? { ok: true, root: String(explicitRoot), replyTo: String(cid) === String(explicitRoot) ? '' : String(cid), how: 'explicit' }
      : await resolveReplyPlan(page, { awemeId, replyCid: cid });
    if (!plan.ok) return { ok: false, reason: plan.hint ?? '判不出楼根，已中止（不瞎猜）' };
    rootCid = plan.root;
    replyToCid = plan.replyTo;
  }

  const payload = mentionTag ? buildMentionPayload(text, mentionTag) : null;
  const fullText = payload ? payload.text : text.trim();
  const textExtra = payload ? payload.textExtra : null;

  if (dryRun) return { ok: true, dryRun: true, comment: fullText, textExtra, mention: mentionTag, replyText: replyText || undefined };

  // 楼根是从通知里精确拿到的，就不用再回去翻一遍楼（那个接口实测会挂）
  const result = await publishComment(page, { awemeId, text: fullText, rootCid, replyToCid, textExtra, verify: !explicitRoot });
  const ok = result.ok && result.placement?.ok !== false;
  return {
    ...result,
    ok,
    comment: fullText,
    mention: mentionTag ?? undefined,
    replyText: replyText || undefined,
    replyCid: replyToCid || undefined,
    reason: ok ? undefined : result.placement?.note ?? result.error ?? `没拿到 cid（HTTP ${result.http}）`,
  };
}
