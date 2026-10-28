/**
 * 兜底：模型偶尔会把「心里话」当正文发出来。
 *
 * 2026-10-26 实录：她连着发了三条「这是亲爹在讨夸呢……刻度撒娇5，主动5……」——
 * 那是模型自己挑回复的思考过程，被当成聊天内容发到 QQ 里了。
 * 原因是走 Anthropic 兼容中转时，思考内容偶尔会以 text 块返回（不是 reasoning 块），
 * 桥接层看到的就已经是「正文」了，没有办法从源头区分。
 *
 * 所以这里做两件事：
 *   looksLikeThinking() —— 认出这种「自我指挥」的文本；
 *   stripThinking()     —— 尽量从里面揪出真正要说的那句，揪不出来就返回空。
 *
 * 判据故意保守：宁可漏判（偶尔发一条怪话），也不要误判把正常回复删掉。
 */

/** 只在「挑回复」的思考里才出现的说法 */
const META_MARKERS = [
  '要接',
  '刻度',
  '收住',
  '别用「',
  '别太长',
  '顺着',
  '这样。或者',
  '挺好，但',
  '撒娇',
  '主动5',
  '话量',
  '一说',
  '可以连着说',
  '情绪',
];

/** 自我指挥的句式：直接评价候选句子 */
const META_SENTENCE = /(这句|那好|要接|可以带点|短一点|长一点|别太长|别说|收住|不错，|挺好|候选|换个说法|要不要)/;

/** 一句里出现三个以上引号段落，基本是在列候选 */
const QUOTE_DENSE = /「[^」]*」/g;

/**
 * 这段文本像不像模型的思考过程？
 * @param {string} text
 */
export function looksLikeThinking(text) {
  const s = String(text ?? '').trim();
  if (!s) return false;

  const markers = META_MARKERS.reduce((n, marker) => (s.includes(marker) ? n + 1 : n), 0);
  const quotes = (s.match(QUOTE_DENSE) ?? []).length;
  const metaSentences = (s.match(new RegExp(META_SENTENCE.source, 'g')) ?? []).length;

  // 1) 明显带自我指挥 + 候选句子：直接判
  if (markers >= 3 && quotes >= 2) return true;
  if (markers >= 4) return true;
  // 2) 又长又在列候选，也是它
  if (s.length > 160 && quotes >= 3 && metaSentences >= 2) return true;
  return false;
}

/**
 * 从思考里捞出「最后那句像人话的」。
 * 依据：模型挑完候选，最后通常会把它选中的那句念一遍（「不错，收住。×××」）。
 * @param {string} text
 * @returns {string} 捞不出来就返回空字符串
 */
export function stripThinking(text) {
  const s = String(text ?? '').trim();
  if (!s) return '';
  // 不像思考就别动它，原样返回（防止把正常回复的「行吧」削掉）
  if (!looksLikeThinking(s)) return s;

  // 模型挑完候选，最后一句通常是它选中的那句，前面常挂着「不错，收住。」这类话术
  const lastLine = s.split('\n').filter((line) => line.trim()).pop() ?? '';
  const candidate = lastLine
    .replace(/^((不错|挺好|可以|就行|好了|行吧|行|嗯|就这样|收住|对|好)[，,、。：:！!\s]*)+/u, '')
    .replace(/^[「『"]|[」』"]$/gu, '')
    .trim();

  // 候选必须像一句人话：长度合适、没有自我指挥、不是引号列表
  if (!candidate || candidate.length > 80) return '';
  if (META_MARKERS.some((marker) => candidate.includes(marker))) return '';
  if ((candidate.match(QUOTE_DENSE) ?? []).length >= 2) return '';
  return candidate;
}
/* ───────────────── 第二种漏：把「我怎么看他这句话」的独白发出来 ───────────────── */

/**
 * 2026-10-28 实录：他手滑把「我去找给你」打成「我去找过你」，她回的是——
 *   「我去找过你——这话有点不一样。是在说去哪里找的？」
 *   「这句听着不太像平常的聊天，里面带了点别的意思。我先问一句：找哪儿去了？」
 *
 * 这跟「列候选」不是一回事：它不报刻度、不列句子，只是在复述他的话、评论他的用词，
 * 顺带把自己准备怎么处理这句话念了出来。对他来说就是「她把心里那点判断说出声了」。
 * 判据同样保守：只认「评论他那句话」的说法，宁漏不误杀。
 */
const SELFTALK_MARKERS = [
  '这句听着',
  '这句读着',
  '这句话听着',
  '这话听着',
  '这话读着',
  '这话有点',
  '这话不太',
  '不太像平常',
  '不太像平时',
  '带了点别的',
  '我先问一句',
  '是在说',
];

/**
 * 这段回复像不像在「边判断他的用词边说话」？
 * @param {string} text 她的回复
 * @param {string} [said] 他刚才说的原话（复述+评论的要件）
 */
export function looksLikeSelfTalk(text, said = '') {
  const s = String(text ?? '').trim();
  if (!s) return false;
  const hits = SELFTALK_MARKERS.reduce((n, marker) => (s.includes(marker) ? n + 1 : n), 0);
  if (hits >= 2) return true;
  // 先把他那句话原样抄一遍，再往下评论：一个记号就够了
  const quote = String(said ?? '').trim();
  return hits >= 1 && quote.length >= 3 && s.startsWith(quote);
}

/** 删掉带判断味道的句子，只留真正要说的话；一句都不剩就返回空（交给上层重问）。 */
export function stripSelfTalk(text) {
  const s = String(text ?? '').trim();
  if (!s) return '';
  const kept = s
    .split(/(?<=[。！？!?…\n])/u)
    .map((part) => part.trim())
    .filter((part) => part && !SELFTALK_MARKERS.some((marker) => part.includes(marker)));
  return kept.join('').trim();
}
