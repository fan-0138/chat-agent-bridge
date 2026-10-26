/**
 * 她的「说话方式笔记本」。
 *
 * 为什么要单独一个文件：
 *  - persona.md 写的是「她是谁」，改一句就得通读 5000 字，而且模型会把它当剧本演；
 *  - 说话方式是**长出来的**：主人今天说「别老用唔开头」，明天给一句「你就说'知道了'」，
 *    这些得能一条条攒下来，下一条消息立刻生效，还要能删。
 *
 * 三个区：
 *  - 主人定的规矩：主人纠正的原话 → 模型自己概括或原样记下；
 *  - 主人认可的说法：主人夸过的句子，作为风格样本（学腔调，不照抄）；
 *  - 我自己想这么说话：她自己写的心得。
 *
 * 热加载：按 mtime+size 缓存，改完不用重启。
 */

import { readFile, rename, stat, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { mkdir } from 'node:fs/promises';

const MAX_RULES = 12;
const MAX_EXAMPLES = 8;
const MAX_OWN = 8;
const MAX_RULE_CHARS = 80;

const HEADER = `# 小鲸的说话方式

<!-- 这是她自己的笔记本，不是人物卡。
     桥接每条消息都会读，优先级高于 persona.md 里的说话方式（冲突时听这里的）。
     手工改也行，改完下一条消息就生效；也可以让她自己用
       node wechat-bridge/scripts/voice.mjs add "规矩"
       node wechat-bridge/scripts/voice.mjs example "原话"
       node wechat-bridge/scripts/voice.mjs own "心得"
     往里加。 -->
`;

/** 把一条规则收拾干净：去掉引导词和多余标点，太长就截断。 */
export function normalizeRule(text) {
  let value = String(text ?? '')
    .replace(/^[\s\-*·]+/, '')
    .replace(/^(她说|主人说|记住|注意|要|应该|就是|以后|下次)[：:,，\s]*/u, '')
    .replace(/\s+/g, ' ')
    .trim();
  // 只有成对完整包起来才去掉引号，别把「主人」这种引号里的词拆坏
  const quoted = value.match(/^[「『“"]([\s\S]*)[」』”"]$/);
  if (quoted) value = quoted[1].trim();
  if (value.length > MAX_RULE_CHARS) value = `${value.slice(0, MAX_RULE_CHARS - 1)}…`;
  return value;
}

/** 比较用的指纹：忽略标点/空格/大小写，避免同一条规矩存两遍。 */
export function ruleKey(text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(/[\s，。！？、,.!?…~～—\-「」『』""'']/g, '');
}

/**
 * 解析笔记本：按二级标题分区，列表项就是要记的内容。
 * @returns {{rules: string[], examples: string[], own: string[]}}
 */
export function parseVoice(markdown) {
  const out = { rules: [], examples: [], own: [] };
  let mode = null;
  for (const rawLine of String(markdown ?? '').split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('<!--')) continue;
    const heading = line.match(/^#{1,3}\s*(.+)$/);
    if (heading) {
      mode = pickMode(heading[1]);
      continue;
    }
    if (!mode) continue;
    const bullet = line.match(/^(?:[-*·]|\d+[.)、])\s+(.+)$/);
    if (!bullet) continue;
    const value = normalizeRule(bullet[1]);
    if (value) out[mode].push(value);
  }
  return out;
}

function pickMode(title) {
  if (/(规矩|规则|要求|纠正|别)/.test(title)) return 'rules';
  if (/(说法|示范|例子|认可|样板|夸)/.test(title)) return 'examples';
  if (/(自己|心得|我想|习惯)/.test(title)) return 'own';
  return null;
}

/** 写回笔记本（保留三区结构）。 */
export function formatVoice({ rules = [], examples = [], own = [] }) {
  const section = (title, items, hint) => {
    const head = `## ${title}`;
    if (items.length === 0) return `${head}\n${hint}`;
    return `${head}\n${items.map((item) => `- ${item}`).join('\n')}`;
  };
  return [
    HEADER.trimEnd(),
    section('主人定的规矩', rules.slice(0, MAX_RULES), '（还没有。主人纠正你的时候，记在这。）'),
    section('主人认可的说法', examples.slice(0, MAX_EXAMPLES), '（还没有。主人说「就这样说」的时候，把原话记在这。）'),
    section('我自己想这么说话', own.slice(0, MAX_OWN), '（你自己写。想到什么记什么。）'),
    '',
  ].join('\n\n');
}

/**
 * 把笔记本渲染成 prompt 里的一段。没有内容就不占位置。
 */
export function renderVoice({ rules = [], examples = [], own = [] }) {
  const parts = [];
  if (rules.length > 0) {
    parts.push(
      '[你的说话方式·主人定的规矩]\n' +
        '（这是主人亲口教的，**比人设正文里的说话方式优先**；冲突时听这里的。别解释这些规矩，直接照做。）\n' +
        rules.map((rule) => `- ${rule}`).join('\n'),
    );
  }
  if (examples.length > 0) {
    parts.push(
      '[你的说话方式·主人认可的样子]\n' +
        '（下面这些是主人说过「就这样」的句子。学它们的腔调和长度，**别照抄内容**。）\n' +
        examples.map((item) => `- 「${item}」`).join('\n'),
    );
  }
  if (own.length > 0) {
    parts.push(
      '[你的说话方式·你自己想这么说话]\n' +
        '（你自己写下来的心得，就是你现在的样子。）\n' +
        own.map((item) => `- ${item}`).join('\n'),
    );
  }
  return parts.join('\n\n');
}

// ── 从主人消息里认「这是在教我说话」 ──────────────────────────────

const STYLE_WORDS = /(说话|语气|措辞|用词|叫法|称呼|开头|结尾|口气|口吻|腔调|台词|人设|表情|emoji|标点|字数|句子|词|废话|长|短)/i;
const CORRECT_WORDS = /(别|不要|不用|少用|少点|少些|太多|太长|太啰嗦|太作|太假|太干|太甜|太腻|太油|收一点|收敛|改改|改掉|去掉|换个|说人话|正常点|简单点|短点|有点假|老是这样|每次都)/;
const EXAMPLE_WORDS = /(应该说|就应该说|就说|这样说|换成这样说|改成|以后就这么说|这么回)/;
const QUOTED = /[「『“"]([^」』”"]{1,60})[」』”"]/;

/**
 * 判断主人这句话是不是在教她说话；是的话返回要记的东西。
 * 只认「明确的纠正式表达 + 说话相关词」，避免把「别熬夜」当成规矩。
 * @returns {{kind: 'rule'|'example', value: string} | null}
 */
export function detectFeedback(text) {
  const raw = String(text ?? '').trim();
  if (!raw) return null;

  // 明确的命令：主人不用猜她想不想要
  const command = raw.match(/^#\s*(说话|规矩|规则|教她?|记住了?)\s+(.+)$/s);
  if (command) {
    const value = normalizeRule(command[2]);
    return value ? { kind: 'rule', value } : null;
  }
  const exampleCommand = raw.match(/^#\s*(说法|示范|例子|这样?说)\s+(.+)$/s);
  if (exampleCommand) {
    const value = normalizeRule(exampleCommand[2]);
    return value ? { kind: 'example', value } : null;
  }

  const quoted = raw.match(QUOTED)?.[1];
  if (quoted && EXAMPLE_WORDS.test(raw)) {
    const value = normalizeRule(quoted);
    return value ? { kind: 'example', value } : null;
  }

  if (!STYLE_WORDS.test(raw) || !CORRECT_WORDS.test(raw)) return null;
  if ([...raw].length > 80) return null; // 太长的多半是在聊别的，让她自己判断要不要记
  const value = normalizeRule(
    quoted && EXAMPLE_WORDS.test(raw) ? quoted : raw.replace(/[。！!～~]+$/u, ''),
  );
  return value ? { kind: 'rule', value } : null;
}

/**
 * @param {{file: string, log?: any}} options
 */
export function createVoice({ file, log }) {
  /** @type {{data: {rules: string[], examples: string[], own: string[]}, key: string, text: string}} */
  let cache = { data: { rules: [], examples: [], own: [] }, key: 'miss', text: '' };

  async function signature() {
    try {
      const info = await stat(file);
      return `${info.mtimeMs}:${info.size}`;
    } catch {
      return 'missing';
    }
  }

  async function readRaw() {
    try {
      return await readFile(file, 'utf8');
    } catch (error) {
      if (error?.code !== 'ENOENT') log?.warn(`读取说话方式失败 ${file}：${error?.message ?? error}`);
      return '';
    }
  }

  async function load() {
    const key = await signature();
    if (key !== cache.key) {
      const data = parseVoice(await readRaw());
      const text = renderVoice(data);
      cache = { data, key, text };
      log?.debug?.(`说话方式已加载：规矩 ${data.rules.length} 条 / 说法 ${data.examples.length} 条`);
    }
    return cache;
  }

  async function save(data) {
    const body = formatVoice(data);
    await mkdir(dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    await writeFile(tmp, body, 'utf8');
    await rename(tmp, file);
    cache = { data, key: await signature(), text: renderVoice(data) };
  }

  /** 加一条（去重、限量，旧的先丢）。 */
  async function add(kind, text) {
    const value = normalizeRule(text);
    if (!value) return { added: false, reason: 'empty' };
    const bucket = kind === 'example' ? 'examples' : kind === 'own' ? 'own' : 'rules';
    const { data } = await load();
    const key = ruleKey(value);
    if (data[bucket].some((item) => ruleKey(item) === key)) {
      return { added: false, reason: 'duplicate', value };
    }
    const next = { rules: [...data.rules], examples: [...data.examples], own: [...data.own] };
    next[bucket] = [...next[bucket], value].slice(-(bucket === 'rules' ? MAX_RULES : bucket === 'examples' ? MAX_EXAMPLES : MAX_OWN));
    await save(next);
    log?.info?.(`说话方式 +1（${bucket}）：${value}`);
    return { added: true, value };
  }

  /** 删掉一条（序号从 1 开始，跨三个区连续编号）。 */
  async function remove(index) {
    const { data } = await load();
    const all = [
      ...data.rules.map((value) => ['rules', value]),
      ...data.examples.map((value) => ['examples', value]),
      ...data.own.map((value) => ['own', value]),
    ];
    const hit = all[Number(index) - 1];
    if (!hit) return { removed: false, reason: 'range' };
    const [bucket, value] = hit;
    const next = { rules: [...data.rules], examples: [...data.examples], own: [...data.own] };
    next[bucket] = next[bucket].filter((item) => item !== value);
    await save(next);
    log?.info?.(`说话方式 -1（${bucket}）：${value}`);
    return { removed: true, value };
  }

  /** 认主人消息里的学说话意图；认出来就写进去。 */
  async function capture(text) {
    const hit = detectFeedback(text);
    if (!hit) return null;
    const result = await add(hit.kind === 'example' ? 'example' : 'rule', hit.value);
    return { ...hit, ...result };
  }

  /** 给自检/审计用的一行摘要。 */
  async function summary() {
    const { data } = await load();
    const total = data.rules.length + data.examples.length + data.own.length;
    if (total === 0) return `说话笔记本：空（${file}）`;
    return `说话笔记：规矩 ${data.rules.length} / 说法 ${data.examples.length} / 心得 ${data.own.length}`;
  }

  async function list() {
    const { data } = await load();
    return data;
  }

  return { file, load, add, remove, capture, summary, list, detectFeedback };
}