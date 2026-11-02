/**
 * 读他这句话：**说完了没有**、**值不值得回**。
 *
 * 为什么单独一层：
 *  - 现在的流程是「来一条消息 → 答一条」，谁说话都是「你一句我一句」的乒乓球；
 *  - 真人聊天不是这样：他会连着打三四条、说到一半换行、发个「那个……」就停住；
 *    她也不一定每句都接，有时候一个「嗯」就过去了。
 *  - 这一层只做判断，不做 I/O：判断结果交给 bridge 决定是等、是接、还是先问一句。
 *
 * 判断偏保守：宁可多答一句，也不要把一句完整的话当成半句晾着。
 */

/** 句号 / 问号 / 感叹号 / 波浪号：说完了。 */
const SENTENCE_END = /[。！？!?～~]$/;
/** 问句：这种必须回。 */
const QUESTION = /[?？]|(吗|呢|么|吧|嘛)$/;
/** 逗号、顿号、分号、冒号收尾：肯定没说完。 */
const PAUSE_END = /[，,、；;：:]$/;
/** 开引号/括号收尾：后面还有。 */
const OPEN_END = /[「『（(\[【《]$/;
/** 半句话的尾巴。只收真的会挂在那里的词，不收「的 / 了 / 我」这种正常结尾。 */
const DANGLING_WORDS = [
  '那个',
  '就是',
  '然后',
  '所以',
  '但是',
  '因为',
  '其实',
  '对了',
  '我跟你说',
  '我觉得',
  '我想',
  '要不',
  '还有',
  '或者',
  '可是',
  '不过',
  '而且',
  '如果',
  '虽然',
  '一个',
  '有点',
  '好像',
];

/**
 * 这句话像是还没说完吗？
 * @param {string} text
 * @returns {boolean}
 */
export function looksUnfinished(text) {
  const raw = String(text ?? '').trim();
  if (!raw) return false;
  if (PAUSE_END.test(raw)) return true;
  if (OPEN_END.test(raw)) return true;
  // 短句加省略号 = 拖着音没说完（「那个…」「就是…」）；长句加省略号当说完了
  if (/(…|\.{3,})$/.test(raw) && raw.length <= 14) return true;
  if (SENTENCE_END.test(raw)) return false;
  if (DANGLING_WORDS.some((word) => raw.endsWith(word))) return true;
  // 「我和」「把」「给」这种孤零零的介词尾巴
  if (/(和|跟|把|被|给)$/.test(raw) && raw.length <= 12) return true;
  return false;
}

/** 纯应答：这种消息回一句「嗯」或者干脆不接都正常。 */
const LOW_TOKENS = new Set([
  '嗯',
  '嗯嗯',
  '嗯呢',
  '哦',
  '噢',
  '喔',
  '哈',
  '嘿',
  '呵',
  '好',
  '好的',
  '好滴',
  '好呀',
  '好嘞',
  '行',
  '行吧',
  '可以',
  '收到',
  '知道',
  '知道了',
  '懂了',
  '懂了懂了',
  '哈哈',
  '哈哈哈',
  '哈哈哈哈',
  '笑死',
  '哈哈笑死',
  '草',
  '卧槽',
  '666',
  '1',
  '11',
  '111',
  'ok',
  'okk',
  'okay',
  'yes',
  'yeah',
  '对',
  '对的',
  '是的',
  '确实',
  '确实是这样',
  '在',
  '恩',
  '嗯呐',
]);

/**
 * 这条消息值不值得专门回一句。
 * 问句一律要回；超过 6 个字的一律要回；只有「嗯 / 哦 / 哈哈 / 好」这类纯应答才可能不接。
 * @param {string} text
 * @returns {boolean}
 */
export function isLowContent(text) {
  const raw = String(text ?? '').trim();
  if (!raw) return true;
  if (QUESTION.test(raw)) return false;
  if (raw.length > 6) return false;
  const core = raw
    .replace(/[\s，。！？!?~～、,.;:：…]/g, '')
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, '')
    .trim();
  if (!core) return true; // 纯表情 / 纯标点
  return LOW_TOKENS.has(core.toLowerCase());
}

/** 他没说完、又没下文时，她先问的那一句。按最近的避着用，别老「嗯？」。 */
const NUDGES = ['嗯？', '然后呢', '说呀', '说到一半就跑了', '人呢'];

/**
 * @param {string[]} recent 最近用过的几句
 * @param {() => number} [random]
 * @returns {string}
 */
export function pickNudge(recent = [], random = Math.random) {
  const last = recent[recent.length - 1] ?? '';
  const pool = NUDGES.filter((line) => line !== last);
  return pool[Math.floor(random() * pool.length)] ?? pool[0];
}