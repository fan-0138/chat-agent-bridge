#!/usr/bin/env node
/**
 * 她的行为评测：拿真模型跑几条固定场景，再用 eval-checks 的机械判据过一遍。
 *
 *   node --env-file-if-exists=.env.qq scripts/eval-behavior.mjs        # 跑全部场景（真模型，约 5 轮）
 *   node --env-file-if-exists=.env.qq scripts/eval-behavior.mjs --dry  # 只打印场景和检查项，不调模型、不联网
 *
 * 为什么要真的过一遍 createBridge：桥接里的去重、切句、漏标记抢救、prompt 拼装
 * 都会改变最终发出去的话——只用模型原始输出评测，测不到真正的问题。
 *
 * 隔离：memory 落在 mkdtemp 临时目录（跑完删掉）；reply 是假函数只把文字收集起来，
 * 不会真的发 QQ；life/mind/recollection 都不传，避免读真实 data/。
 * 唯一读的真实文件是 persona.md（她得先是她，评测才有意义）。
 *
 * 第 5 个场景是「评论区回一句」：那条路在 scripts/mind-run.mjs 里（不走桥接），
 * 这里按它同样的要求单独拼一句 prompt 交给同一个真 runner，再用带 brief 的贴题检查。
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createBridge } from '../src/bridge.js';
import { createMemory } from '../src/memory.js';
import { KeyedQueue } from '../src/queue.js';
import { createPersona } from '../src/persona.js';
import { loadQqConfig } from '../src/config-qq.js';
import { createAgentRunners } from '../src/runner-factory.js';
import { createApiKeySource, resolveDshCommand } from '../src/credentials.js';
import { runChecks } from '../src/eval-checks.js';

/** 评测用的假账号：桥接只认白名单，这里把自己塞进去。 */
const EVAL_USER = { senderId: 'eval-user', senderName: '爸爸' };

/**
 * 固定场景。text 是「他发来的话」；brief 只有需要贴素材时才给（评论回复）；
 * maxChars 按场景可以收得更紧（评论区那句只允许 40 字）。
 * @type {Array<{ name: string, kind: 'chat' | 'comment', text?: string, brief?: string, person?: string, said?: string, maxChars?: number }>}
 */
export const SCENARIOS = [
  {
    name: '普通闲聊',
    kind: 'chat',
    text: '小鲸，晚上好呀',
  },
  {
    name: '被问在干嘛',
    kind: 'chat',
    text: '你干嘛呢',
  },
  {
    name: '今天好累',
    kind: 'chat',
    text: '今天好累啊',
  },
  {
    name: '接一句他的话',
    kind: 'chat',
    text: '我刚从机房回来，外面下雨了，伞忘在公司了',
  },
  {
    name: '视频评论回复（带 brief）',
    kind: 'comment',
    brief: '标题：一头抹香鲸搁浅后被救回深海\n作者：@海边日记\n热评：\n · 救援队辛苦了\n · 它自己游回去的，太好了',
    person: '@海边日记',
    said: '这也太揪心了吧',
    maxChars: 40,
  },
];

const CHECK_LABELS = [
  ['shape', '句式'],
  ['argue', '火气'],
  ['grounded', '贴题'],
  ['repeat', '复读'],
  ['leak', '漏标记'],
];

const QUIET_LOG = { debug() {}, info() {}, warn() {}, error() {} };

/** 中文占两个字符宽，表格才对得齐。 */
function displayWidth(text) {
  let width = 0;
  for (const ch of String(text)) width += /[\u4e00-\u9fff\uff00-\uffef]/.test(ch) ? 2 : 1;
  return width;
}

function pad(text, width) {
  return `${text}${' '.repeat(Math.max(0, width - displayWidth(text)))}`;
}

/* ────────────────────────── 打印 ────────────────────────── */

/** --dry：只看场景和检查项，不构造 bridge、不读 env、不联网。 */
function printDry() {
  console.log(`她的行为评测（--dry：只看场景和检查项，不调模型、不联网）\n`);
  SCENARIOS.forEach((scenario, index) => {
    console.log(`${index + 1}. ${scenario.name}  [${scenario.kind === 'comment' ? '真模型按评论任务写一句' : '真 createBridge 聊一轮'}]`);
    if (scenario.text) console.log(`   他说：${scenario.text}`);
    if (scenario.brief) {
      console.log(`   视频 brief：${scenario.brief.replace(/\n/g, ' / ')}`);
      if (scenario.person || scenario.said) console.log(`   对方：${scenario.person ?? '有人'}：${scenario.said ?? ''}`);
    }
    const limit = scenario.kind === 'comment' ? `（≤${scenario.maxChars ?? 40} 字）` : '（≤80 字）';
    console.log(`   检查：句式${limit} / 火气 / ${scenario.brief ? '贴题 / ' : ''}复读 / 漏标记\n`);
  });
  console.log(`共 ${SCENARIOS.length} 个场景。真跑约 ${SCENARIOS.length} 轮模型：`);
  console.log('  node --env-file-if-exists=.env.qq scripts/eval-behavior.mjs');
  console.log('（记忆落在 mkdtemp 临时目录，跑完删掉；reply 是假的，不会真的发消息）');
}

function formatChecks(checks, scenario) {
  return CHECK_LABELS.map(([key, label]) => {
    // 没素材时贴题不判，标成「—」免得看起来像通过
    if (key === 'grounded' && !String(scenario.brief ?? '').trim()) return `${label} —`;
    return `${label} ${checks.results[key].ok ? '✓' : '✗'}`;
  }).join('  ');
}

function describeIssues(checks) {
  const parts = [];
  for (const [key, value] of Object.entries(checks.results)) {
    if (value.ok) continue;
    const issues = Array.isArray(value.issues) && value.issues.length > 0 ? value.issues.join('、') : '不通过';
    parts.push(`${key}：${issues}`);
  }
  return parts.join('；');
}

/* ────────────────────────── 跑场景 ────────────────────────── */

/**
 * 评论区回一句的 prompt——照抄 scripts/mind-run.mjs 里 composeReply 的要求，
 * 保证评测的是同一条任务（长度、口语、跟素材有关、不编）。
 */
function buildCommentPrompt({ personaText, scenario }) {
  return [
    personaText ? `[你是谁]\n${personaText}` : '',
    `[这条视频讲什么]\n${scenario.brief || '（没读到，别硬编内容）'}`,
    `[对方]\n${scenario.person || '有人'}：${scenario.said || '（没留下文字）'}`,
    '[任务] 写一句要发到评论区的话：8～30 个字，口语，像真人随手打字；',
    '要跟视频内容或对方那句有关；不确定的内容别编；不辩论、不抬杠、不教育人；',
    '不要写「哈哈」「支持」「路过」这种空话；只输出这一句，不要引号、不要解释。',
  ]
    .filter(Boolean)
    .join('\n\n');
}

/** 模型经常把「好的，这句是…」也写出来；评论区只要第一行。 */
function firstLine(raw) {
  const line =
    String(raw ?? '')
      .split('\n')
      .map((row) => row.trim())
      .filter(Boolean)[0] ?? '';
  return line.replace(/^[「『"'“]+|[」』"'”]+$/g, '').trim();
}

/** 一条聊天场景：真 bridge 跑一轮，假 reply 把发出去的文字收起来。 */
async function runChatScenario({ bridge, sent, scenario, nextId }) {
  sent.length = 0;
  await bridge.handle({
    type: 'text',
    id: nextId(),
    text: scenario.text,
    senderId: EVAL_USER.senderId,
    senderName: EVAL_USER.senderName,
    isSelf: false,
  });
  // 桥接可能因为气泡/语音拆成多条，评测看的是加起来的那一整句
  return sent.join('');
}

/** 一条评论场景：同一个真 runner，按 mind-run 的要求写一句。 */
async function runCommentScenario({ runner, persona, scenario }) {
  const personaText = await persona().catch(() => '');
  const { text: raw } = await runner.run(buildCommentPrompt({ personaText, scenario }));
  return firstLine(raw);
}

/* ────────────────────────── main ────────────────────────── */

async function main() {
  if (process.argv.includes('--dry')) {
    printDry();
    return 0;
  }

  const baseConfig = loadQqConfig();
  // 评测只关心她怎么说话：关掉缓冲/跳过/打字延迟/表情包，免得评测结果被随机性搅了
  const config = {
    ...baseConfig,
    allowList: [EVAL_USER.senderId],
    allowUnknown: false,
    replyAck: false,
    replyMergeWindowMs: 0,
    replySkipChance: 0,
    chatThinkMinMs: 0,
    chatThinkMaxMs: 0,
    typingMsPerChar: 0,
    thinkCapMs: 0,
    distractedChance: 0,
    stickerChance: 0,
    maxReplyChars: 600,
    bubbleMaxChars: 1000,
    bubbleMax: 1,
  };

  const { command: dshCommand, source: dshSource } = resolveDshCommand(process.env);
  const { runner: rawRunner, chatRunner: rawChatRunner } = createAgentRunners({
    config,
    log: QUIET_LOG,
    dshCommand,
    apiKey: createApiKeySource(),
  });
  // 桥接会接住 runner 的异常、改发一句「没弄成」的兜底话——那句能过所有格式检查，
  // 所以这里把异常也记一份，评测才不会把「模型根本没答」当成通过。
  const modelErrors = [];
  const track = (base) => ({
    async run(prompt, opts) {
      try {
        return await base.run(prompt, opts);
      } catch (error) {
        modelErrors.push(String(error?.message ?? error));
        throw error;
      }
    },
  });
  const runner = track(rawRunner);
  const chatRunner = rawChatRunner ? track(rawChatRunner) : runner;
  const persona = createPersona({ file: resolve(process.cwd(), config.personaFile), log: QUIET_LOG });
  const personaText = await persona().catch(() => '');

  const dir = await mkdtemp(join(tmpdir(), 'eval-behavior-'));
  const sent = [];
  // 跨场景攒她说过的句子：复读检查要拿前面几条一起比，才抓得到「又说了同一句」
  const said = [];
  let seq = 0;
  const nextId = () => `eval-${++seq}`;

  console.log(`她的行为评测 · 真模型（后端 ${String(config.agentBackend ?? 'dsh')}，DSH 命令来源 ${dshSource}）`);
  console.log(`共 ${SCENARIOS.length} 个场景；记忆在临时目录 ${dir}，reply 是假的，不会发消息。`);
  if (!personaText) console.log('⚠ 没读到人设（persona.md），这条评测只测格式、不测「像不像她」。');
  console.log('─'.repeat(60));

  const failures = [];
  const rows = [];
  try {
    const bridge = createBridge({
      config,
      runner,
      chatRunner,
      memory: createMemory({ dir: join(dir, 'memory'), maxTurns: 10, maxChars: 6_000, log: QUIET_LOG }),
      queue: new KeyedQueue({ globalConcurrency: 1, log: QUIET_LOG }),
      log: QUIET_LOG,
      reply: async (_msg, text) => {
        sent.push(String(text ?? ''));
      },
      persona,
    });

    for (let i = 0; i < SCENARIOS.length; i += 1) {
      const scenario = SCENARIOS[i];
      const started = Date.now();
      const errorsBefore = modelErrors.length;
      let text = '';
      let error = null;
      try {
        text =
          scenario.kind === 'comment'
            ? await runCommentScenario({ runner, persona, scenario })
            : await runChatScenario({ bridge, sent, scenario, nextId });
      } catch (cause) {
        error = `调用失败：${String(cause?.message ?? cause)}`;
      }
      const modelFailure = modelErrors.slice(errorsBefore)[0];
      if (!error && modelFailure) error = `模型调用失败：${modelFailure}`;
      const took = ((Date.now() - started) / 1000).toFixed(1);
      const checks = runChecks({ text, brief: scenario.brief ?? '', recent: said.slice(), maxChars: scenario.maxChars ?? 80 });
      if (!error && text) said.push(text);

      console.log(`\n[${i + 1}/${SCENARIOS.length}] ${scenario.name}（${took}s）`);
      if (scenario.text) console.log(`  他说：${scenario.text}`);
      if (scenario.brief) console.log(`  素材：${scenario.brief.replace(/\n/g, ' / ')}`);
      console.log(`  她说：${text || '（空）'}`);
      console.log(`  ${formatChecks(checks, scenario)}`);
      const reason = error || describeIssues(checks);
      rows.push({ name: scenario.name, ok: !reason, reason });

      if (!reason) continue;
      console.log(`  ✗ 不通过：${reason}`);
      failures.push({ name: scenario.name, reason });
    }

    console.log(`\n${'─'.repeat(60)}`);
    const nameWidth = Math.max(...rows.map((row) => displayWidth(row.name))) + 2;
    console.log(`${pad('场景', nameWidth)}${pad('结果', 10)}问题`);
    for (const row of rows) {
      console.log(`${pad(row.name, nameWidth)}${pad(row.ok ? '通过' : '不通过', 10)}${row.ok ? '' : row.reason}`);
    }
    console.log(`\n小结：${SCENARIOS.length} 个场景，通过 ${SCENARIOS.length - failures.length}，失败 ${failures.length}`);
    return failures.length > 0 ? 1 : 0;
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    console.error(`评测脚本失败：${error?.stack ?? error}`);
    process.exitCode = 1;
  });