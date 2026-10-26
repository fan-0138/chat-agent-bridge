/**
 * 机械去重：模型自己管不住的那几件小事，用确定性代码兜住。
 *
 * 只做「删」不做的「改写」，风险最低：
 *  - 上一两条都用「唔……」开头 → 这条的开头填充音删掉；
 *  - 上一条已经挂了同一个 emoji → 这条句尾那个删掉；
 *  - emoji 超过两个 → 只留前面两个；
 *  - 「……」「。。」「！！」这类重复标点压成一个。
 *
 * 更复杂的东西（道具旁白、金句、语气词密度）交给 prompt + voice.md，
 * 改文本容易把句子改坏，不值。
 */

const EMOJI = /\p{Extended_Pictographic}/gu;
const OPENER_CHARS = '唔嗯诶欸哎唉哦噢哈啊呀嗷噫';
const OPENER_RE = new RegExp(`^([${OPENER_CHARS}])[…，,、。.~～\\s]*`, 'u');

/** 她这句话是怎么开头的（第一个字是填充音才返回）。 */
export function openerOf(text) {
  const hit = String(text ?? '').trim().match(OPENER_RE);
  return hit ? hit[1] : null;
}

function lastEmoji(text) {
  const all = String(text ?? '').match(EMOJI);
  return all?.length ? all[all.length - 1] : null;
}

function collapsePunctuation(text) {
  return String(text)
    .replace(/…{2,}/g, '…')
    .replace(/。{2,}/g, '。')
    .replace(/，{2,}/g, '，')
    .replace(/!{3,}/g, '！！')
    .replace(/！{3,}/g, '！！')
    .replace(/？{3,}/g, '？？')
    .replace(/~{2,}/g, '～')
    .replace(/～{2,}/g, '～')
    .replace(/[ \t]+\n/g, '\n')
    .trim();
}

/**
 * @param {string} text 模型刚生成的回复
 * @param {{recent?: string[], maxEmoji?: number}} [options]
 *        recent：她最近说过的话（旧的在前），用来判重
 */
export function polish(text, options = {}) {
  const original = String(text ?? '').trim();
  if (!original) return original;

  const recent = (options.recent ?? []).map((item) => String(item ?? '').trim()).filter(Boolean);
  const maxEmoji = Number.isFinite(options.maxEmoji) ? options.maxEmoji : 2;

  let out = collapsePunctuation(original);

  // 1. 开头填充音：最近两条里已经出现过同一个起头，就别再来一次
  const opener = openerOf(out);
  if (opener) {
    const sameOpener = recent.slice(-2).filter((item) => openerOf(item) === opener).length;
    if (sameOpener >= 1) {
      const stripped = out.replace(OPENER_RE, '').trim();
      // 删完不能只剩标点或空
      if (stripped.replace(/[…，,、。.~～\s]/g, '').length >= 1) out = stripped;
    }
  }

  // 2. 句尾 emoji 跟上一条撞了 → 删掉
  const tail = lastEmoji(out);
  if (tail && lastEmoji(recent.at(-1) ?? '') === tail) {
    const stripped = out.replace(new RegExp(`${escapeRegExp(tail)}$`, 'u'), '').trimEnd();
    if (stripped.replace(/[…，,、。.~～\s]/g, '').length >= 1) out = stripped;
  }

  // 3. emoji 太多：只留前 maxEmoji 个
  if (maxEmoji >= 0) {
    let seen = 0;
    out = out.replace(EMOJI, (match) => {
      seen += 1;
      return seen <= maxEmoji ? match : '';
    });
  }

  out = collapsePunctuation(out);
  return out || original;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}