/**
 * 「人味体检」：给她说过的话打分，找出 AI 味/人设腔的机械痕迹。
 *
 * 为什么要量化：
 *  - 「太有 AI 味」是个感觉，改起来只能靠再读一遍猜；
 *  - 拆成几条可数的指标（开头语气词、道具旁白、修饰词、长度、emoji、称呼）
 *    就能对比「改之前 41 分 → 改之后 78 分」，也能看出是哪一条在拖后腿。
 *
 * 这里只做统计，不改文本。真正去重的机械处理在 decor.js。
 */

const EMOJI = /\p{Extended_Pictographic}/gu;

// 开头就是「唔……」「嗯、」「哦」这类填充音：真人偶尔有，句句有就是扮演
const OPENER = /^(唔|嗯|诶|欸|哎|唉|哦|噢|哈|嗨|啊|呀|嗷|噫)/;

// 聊天里不该出现的书面/抒情修饰（她一张嘴就是这些，就是人设卡的腔调）
const DECOR = /(仿佛|宛如|恰似|好似|像是[^。！？\n]{0,8}一样|一般无二|一丝|些许|几分|莫名|不禁|忍不住|不由自主|轻轻地|悄悄地|静静地|缓缓地|狠狠地|微微|顿时|瞬间|刹那间|心头|心里泛起|浑身上下|整个机房|整个世界)/g;

// 「尾巴拍地」「耳朵抖」「围裙遮脸」——写小说才需要，聊天不需要
// 只算「旁白式」的身体/穿着描写；碗、饭是她真在吃的东西，不算
const PROPS = /(尾巴|尾鳍|鳍耳|鲸耳|耳朵|围裙|眼镜)/g;

// 语气词：一条里一两个正常，密度高就是演
const MODAL = /[唔哼嘛啦呜诶欸哟哇呀嗷嘞咯喔]/g;

// 段子腔/对仗：句子爱用「…，可不是…嘛」「…算什么…」这种抖机灵收尾
const PUNCHLINE = /(可不是|才算|才叫|哪个|算什么|难不成|才不是)[^。！？\n]{0,12}(嘛|吗|吧|呢)/g;

const TARGETS = {
  avgChars: [12, 55],
  openerRate: 0.2,
  propsRate: 0.05,
  decorPer100: 1.2,
  modalPer100: 7,
  emojiRate: 0.6,
  multiParaRate: 0.3,
  addressPerReply: 0.8,
};

/** @param {string} text */
function analyzeOne(text) {
  const raw = String(text ?? '');
  const chars = [...raw].length || 0;
  const emojis = raw.match(EMOJI) ?? [];
  const first = raw.trim().slice(0, 1);
  const decor = (raw.match(DECOR) ?? []).length;
  const props = (raw.match(PROPS) ?? []).length;
  const modal = (raw.match(MODAL) ?? []).length;
  const paras = raw.split(/\n{2,}/).filter((part) => part.trim()).length;
  const address = (raw.match(/主人/g) ?? []).length;

  return {
    text: raw,
    chars,
    emojis: emojis.length,
    opener: OPENER.test(raw.trim()),
    decor,
    props,
    modal,
    punchline: (raw.match(PUNCHLINE) ?? []).length,
    paras,
    address,
    decorPer100: chars > 0 ? (decor / chars) * 100 : 0,
    modalPer100: chars > 0 ? (modal / chars) * 100 : 0,
  };
}

/**
 * @param {string[]} replies 按时间顺序的她的发言
 * @param {{targets?: typeof TARGETS}} [options]
 */
export function audit(replies, options = {}) {
  const targets = { ...TARGETS, ...(options.targets ?? {}) };
  const items = replies.map(analyzeOne).filter((item) => item.chars > 0);
  const n = items.length;
  if (n === 0) {
    return {
      score: null,
      count: 0,
      metrics: {},
      penalties: [],
      summary: '没有可分析的她说过的话。',
      items: [],
    };
  }

  const sum = (pick) => items.reduce((acc, item) => acc + pick(item), 0);
  const totalChars = sum((item) => item.chars) || 1;

  const metrics = {
    count: n,
    avgChars: round(sum((item) => item.chars) / n, 1),
    avgParas: round(sum((item) => item.paras) / n, 2),
    openerRate: round(sum((item) => (item.opener ? 1 : 0)) / n, 3),
    propsRate: round(sum((item) => (item.props > 0 ? 1 : 0)) / n, 3),
    propsPerReply: round(sum((item) => item.props) / n, 2),
    decorPer100: round((sum((item) => item.decor) / totalChars) * 100, 2),
    modalPer100: round((sum((item) => item.modal) / totalChars) * 100, 2),
    emojiRate: round(sum((item) => (item.emojis > 0 ? 1 : 0)) / n, 3),
    emojiPerReply: round(sum((item) => item.emojis) / n, 2),
    // 两条短气泡是正常聊天；长回复还分段才像小作文
    multiParaRate: round(sum((item) => (item.paras > 1 && item.chars > 50 ? 1 : 0)) / n, 3),
    addressPerReply: round(sum((item) => item.address) / n, 2),
    punchlinePerReply: round(sum((item) => item.punchline) / n, 2),
  };

  /**
   * 每项权重合计 100；某项达标就得满分，超标按「目标/实际」比例给分。
   * 这样分数不会一崩到底，改掉一项就能看见它涨。
   */
  const checks = [
    ['开头语气词', metrics.openerRate, targets.openerRate, 22, '条', '每条都以「唔…」开头 → 一眼假'],
    ['道具旁白', metrics.propsRate, targets.propsRate, 18, '条', '「尾巴拍地 / 耳朵抖 / 围裙遮脸」这类旁白'],
    ['多段', metrics.multiParaRate, targets.multiParaRate, 12, '条', '一条消息还分两三段，像小作文'],
    ['语气词密度', metrics.modalPer100, targets.modalPer100, 10, '每百字', '唔哼嘛啦呜 堆在一起'],
    ['抒情修饰', metrics.decorPer100, targets.decorPer100, 10, '每百字', '仿佛 / 一丝 / 不禁 / 心里泛起…'],
    ['emoji 覆盖', metrics.emojiRate, targets.emojiRate, 9, '条', '每条都挂一个，像签名不是情绪'],
    ['抖机灵收尾', metrics.punchlinePerReply, 0.25, 8, '条', '每条都想补一句金句'],
    ['称呼', metrics.addressPerReply, targets.addressPerReply, 5, '条', '「主人」叫得太勤'],
    ['平均长度', metrics.avgChars, targets.avgChars[1], 6, '字', '太长，真人不打这么整齐的长句'],
  ];

  const penalties = [];
  let gained = 0;
  for (const [label, value, target, weight, unit, why] of checks) {
    const ratio = value <= target || value <= 0 ? 1 : target / value;
    gained += weight * ratio;
    if (ratio >= 1) continue;
    penalties.push({
      label,
      value,
      target,
      unit,
      why,
      lost: round(weight * (1 - ratio), 1),
    });
  }

  // 太短、像敷衍，也单列
  const [minLen] = targets.avgChars;
  if (metrics.avgChars < minLen) {
    const ratio = metrics.avgChars / minLen;
    gained -= 6 * (1 - ratio);
    penalties.push({
      label: '平均长度',
      value: metrics.avgChars,
      target: minLen,
      unit: '字',
      why: '太短，像敷衍',
      lost: round(6 * (1 - ratio), 1),
    });
  }

  const score = Math.max(0, Math.min(100, Math.round(gained)));

  return {
    score,
    count: n,
    metrics,
    penalties: penalties.sort((a, b) => b.lost - a.lost),
    summary: verdict(score),
    items,
  };
}

function verdict(score) {
  if (score >= 85) return '像真人在打字';
  if (score >= 70) return '基本像人，还有几处露馅';
  if (score >= 55) return '一半人一半设定卡';
  if (score >= 35) return '明显在演人设';
  return '人设卡成精';
}

function round(value, digits = 1) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/** 从记忆文件的行里取出「她说过的话」。 */
export function repliesFromMemory(rows, limit = 60) {
  const out = [];
  for (const row of rows) {
    if (!row || row.role !== 'assistant') continue;
    const text = String(row.text ?? '').trim();
    if (text) out.push(text);
  }
  return limit > 0 ? out.slice(-limit) : out;
}

/** 给终端看的短报告。 */
export function formatAudit(report, { limit = 4 } = {}) {
  if (!report || report.score === null) return report?.summary ?? '没有可分析的样本。';
  const m = report.metrics;
  const lines = [
    `人味分 ${report.score}/100（${report.summary}）｜样本 ${report.count} 条`,
    `平均 ${m.avgChars} 字 / ${m.avgParas} 段，唔开头 ${pct(m.openerRate)}，带道具 ${pct(m.propsRate)}，emoji ${pct(m.emojiRate)}，多段 ${pct(m.multiParaRate)}`,
    `修饰 ${m.decorPer100}/百字，语气词 ${m.modalPer100}/百字，称呼 ${m.addressPerReply}/条`,
  ];
  if (report.penalties.length > 0) {
    lines.push('主要扣分：');
    for (const item of report.penalties.slice(0, limit)) {
      lines.push(`  - ${item.label} ${item.value}（目标 ≤${item.target}）：${item.why}  −${item.lost}`);
    }
  }
  return lines.join('\n');
}

function pct(value) {
  return `${Math.round(value * 100)}%`;
}