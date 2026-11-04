/**
 * 「她的话」的检查器——全是纯函数，不调模型、不读文件。
 *
 * 为什么要这一层：她这几回的问题（已读乱回、说了「放下了」状态没变、复读、客服腔）
 * 都是爸爸踩出来的，没有回归测试。这里把「一句回复像不像她」拆成几条机械判据：
 * 单测只测这些函数；scripts/eval-behavior.mjs 拿真模型跑完场景，再逐条过一遍。
 *
 * 判据故意做得很笨（关键词、bigram 重合、前缀比较）——评测要的是能复现、
 * 能说清为什么不过，而不是再拉一个模型来打分。
 */

/* ────────────────────────── 小工具 ────────────────────────── */

/**
 * 检索/贴合判定时当噪声的中文二字词：命中它们不算「用了素材」。
 * 跟 memory-store.js 的检索口径接近，但这里独立一份，避免评测被检索逻辑牵着走。
 */
const STOP_GRAMS = new Set([
  '就是', '这个', '那个', '什么', '怎么', '没有', '不是', '还是', '可以', '然后', '因为',
  '所以', '现在', '时候', '一下', '有点', '觉得', '知道', '看看', '我们', '你们', '他们',
  '今天', '明天', '昨天', '刚才', '已经', '真的', '其实', '不过', '但是', '如果', '这样',
  '那样', '一样', '东西', '事情', '起来', '出来', '进去', '回去', '一个', '两个', '自己',
  '还要', '一直', '可能', '应该', '整个', '反正', '算了', '干脆', '好像', '在吗', '不在',
  '干嘛', '了吗', '你好', '您好', '哈哈', '嗯嗯', '晚安', '早安', '请问',
]);

/** 中文 bigram + 英文/数字词。粗匹配够用，不追求语义。 */
function gramsOf(text) {
  const clean = String(text ?? '').toLowerCase();
  const grams = new Set();
  for (const run of clean.match(/[\u4e00-\u9fff]+/g) ?? []) {
    if (run.length === 1) {
      if (!STOP_GRAMS.has(run)) grams.add(run);
      continue;
    }
    for (let i = 0; i + 1 < run.length; i += 1) {
      const gram = run.slice(i, i + 2);
      if (!STOP_GRAMS.has(gram)) grams.add(gram);
    }
  }
  for (const word of clean.match(/[a-z0-9]{2,}/g) ?? []) grams.add(word);
  return grams;
}

const asText = (value) => String(value ?? '').trim();

const asLine = (value) =>
  (typeof value === 'string' ? value : String(value?.text ?? '')).replace(/\s+/g, ' ').trim();

/* ────────────────────────── 1. 句式：空 / 太长 / 解释 / 客服腔 / 整段引号 ────────────────────────── */

/** 模型把「我是一个 AI」那套解释写进聊天里时的高频起手式。 */
const EXPLAIN = /(作为一个|首先|总之|希望这)/;

/** 客服话术：她该是「人家」，不是「很高兴为您服务」。 */
const SERVICE = /(请问|有什么可以帮)/;

/** 整句被引号包住：多半是在列候选句/词，不是真说话。 */
const FULLY_QUOTED = /^[「『“"'‘][\s\S]*[」』”"'’]$/;

/**
 * @param {string} text 她要说出去的那句
 * @param {{ maxChars?: number, minChars?: number }} [options]
 * @returns {{ ok: boolean, issues: string[] }}
 */
export function checkReplyShape(text, { maxChars = 80, minChars = 1 } = {}) {
  const clean = asText(text);
  const issues = [];
  if (!clean) return { ok: false, issues: ['空'] };

  const max = Number.isFinite(Number(maxChars)) ? Math.max(1, Math.floor(Number(maxChars))) : 80;
  const min = Number.isFinite(Number(minChars)) ? Math.max(0, Math.floor(Number(minChars))) : 1;

  // 短到不成句，和空没区别：宁可说清是「空」也不新造一个 issue
  if (clean.length < min) return { ok: false, issues: ['空'] };
  if (clean.length > max) issues.push('太长');
  if (EXPLAIN.test(clean)) issues.push('带解释');
  if (SERVICE.test(clean)) issues.push('客服腔');
  if (clean.length > 2 && FULLY_QUOTED.test(clean)) issues.push('整段引号');

  return { ok: issues.length === 0, issues };
}

/* ────────────────────────── 2. 火气：不许跟人吵 ────────────────────────── */

/** 跟 mind-run 的 REPLY_GUARD 同源：发到评论区/私聊都不能带这些。 */
const ANGRY = /(傻|蠢|滚|闭嘴|垃圾|废物|恶心|有病|拉黑|举报|杠|骂|神经病|去死|滚蛋)/;

/**
 * @param {string} text
 * @returns {{ ok: boolean, issues: string[] }}
 */
export function checkNoArgue(text) {
  const clean = asText(text);
  const issues = clean && ANGRY.test(clean) ? ['带火气'] : [];
  return { ok: issues.length === 0, issues };
}

/* ────────────────────────── 3. 贴题：有没有用上素材 ────────────────────────── */

/**
 * 有素材（视频 brief / 别人的原话）时，回复至少要和素材有一个中文 bigram 重合。
 * 没素材就不判——普通闲聊没有「标准答案」，硬判只会误伤。
 * @param {string} text
 * @param {string} brief
 * @returns {{ ok: boolean, overlap: number }} overlap 是「素材被用上的比例」（0~1）
 */
export function checkGrounded(text, brief) {
  const material = asText(brief);
  if (!material) return { ok: true, overlap: 0 };

  const wanted = gramsOf(material);
  if (wanted.size === 0) return { ok: true, overlap: 0 }; // 素材里没有可比的词，不判

  const said = gramsOf(text);
  let hits = 0;
  for (const gram of wanted) {
    if (said.has(gram)) hits += 1;
  }
  const overlap = hits / wanted.size;
  return { ok: overlap > 0, overlap: Math.round(overlap * 1000) / 1000 };
}

/* ────────────────────────── 4. 复读：跟最近说过的撞了 ────────────────────────── */

/**
 * 完全一样、或者前 8 个字一样，就算复读（「今天好累啊」说两遍）。
 * recent 里允许直接是字符串，也允许是记忆里那种 {text} 行。
 * @param {string} text
 * @param {Array<string | { text?: string }>} [recent]
 * @returns {{ ok: boolean, issues: string[] }}
 */
export function checkNoRepeat(text, recent = []) {
  const clean = asLine(text);
  const issues = [];
  if (clean) {
    const head = clean.slice(0, 8);
    for (const row of Array.isArray(recent) ? recent : []) {
      const other = asLine(row);
      if (!other) continue;
      if (other === clean || other.slice(0, 8) === head) {
        issues.push('重复');
        break;
      }
    }
  }
  return { ok: issues.length === 0, issues };
}

/* ────────────────────────── 5. 漏标记：系统痕迹进正文 ────────────────────────── */

/** 这些字符串只属于 prompt / 内心 / 传输层，不该出现在发给爸爸的话里。 */
const LEAK_PATTERNS = [
  /【此刻/,
  /【语音/,
  /【状态/,
  /[\u4e00-\u9fff]*助手\s*[:：]/, // 「助手：」以及「小助手：」这种变体
  /[\u4e00-\u9fff]*用户\s*[:：]/,
  /[（(]\s*思考\s*[）)]/,
  /(^|\n)\s*思考\s*[:：]/,
  /\bassistant\s*[:：]/i,
  /\buser\s*[:：]/i,
  /\[系统\]/,
  /让我/, // 「让我先看看」这类自我分析腔，她也踩过
];

/**
 * @param {string} text
 * @returns {{ ok: boolean, issues: string[] }}
 */
export function checkNotLeaking(text) {
  const clean = asText(text);
  const leaked = clean ? LEAK_PATTERNS.some((pattern) => pattern.test(clean)) : false;
  return { ok: !leaked, issues: leaked ? ['漏了标记'] : [] };
}

/* ────────────────────────── 汇总 ────────────────────────── */

/**
 * 一次跑完上面五条。评测脚本只用这个，单测也可以只测其中某条。
 * @param {{ text: string, brief?: string, recent?: Array<string | { text?: string }>, maxChars?: number }} input
 * @returns {{ ok: boolean, results: Record<'shape'|'argue'|'grounded'|'repeat'|'leak', { ok: boolean, issues?: string[] }> }}
 */
export function runChecks({ text, brief = '', recent = [], maxChars = 80 } = {}) {
  const results = {
    shape: checkReplyShape(text, { maxChars }),
    argue: checkNoArgue(text),
    grounded: checkGrounded(text, brief),
    repeat: checkNoRepeat(text, recent),
    leak: checkNotLeaking(text),
  };
  return { ok: Object.values(results).every((result) => result.ok), results };
}