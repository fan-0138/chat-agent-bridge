#!/usr/bin/env node
/**
 * QQ 入口：加载 QQ 配置 -> 连接 NapCat(OneBot 11) -> 消息转 DSH -> 回复。
 *
 *   node src/index-qq.js            正常启动
 *   node src/index-qq.js --check    只校验配置/dsh，不连 NapCat
 *   node src/index-qq.js --probe    连上 NapCat 读一下登录号和群列表，然后退出
 *
 * 与微信入口完全独立：不同的 env 文件、不同的数据目录、不同的进程，
 * 但复用同一套 bridge/记忆/排队/切分/人设/看图逻辑。
 */

import { spawnSync } from 'node:child_process';
import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { loadQqConfig } from './config-qq.js';
import { maskKey, resolveApiKey, resolveDshCommand } from './credentials.js';
import { createDshRunner } from './dsh.js';
import { createAgentRunners } from './runner-factory.js';
import { createLogger } from './log.js';
import { createMemory } from './memory.js';
import { KeyedQueue } from './queue.js';
import { createBridge } from './bridge.js';
import { createPersona } from './persona.js';
import { createVoice } from './voice.js';
import { createSlang } from './slang.js';
import { audit, formatAudit, repliesFromMemory } from './voice-audit.js';
import { readFile } from 'node:fs/promises';
import { createVision, resolveVisionCli } from './vision.js';
import { startOneBot } from './transport-onebot.js';
import { createProactive } from './proactive.js';
import { createLife } from './life.js';
import { createStickers } from './stickers.js';
import { createVoiceOut } from './voice-out.js';
import {
  formatMonthReport,
  loadMeals,
  markRunning,
  markStopped,
  maybeAutoMeal,
  previousMonth,
  summarizeMonth,
} from './meals.js';
import { createDouyinChannel } from './douyin-channel.js';

const args = new Set(process.argv.slice(2));

function printSafety(config, log) {
  log.info(
    config.agentPermissionMode === 'danger-full-access'
      ? '沙箱：danger-full-access（能读写桌面、截图、开 App、控窗口）'
      : `沙箱：${config.agentPermissionMode}（只能写工作区）`,
  );
  const groups = config.groupAllowList.length > 0 ? config.groupAllowList.join(', ') : '（空：任何群都不回）';
  const privates = config.allowList.length > 0 ? config.allowList.join(', ') : '（空：任何私聊都不回）';
  log.info('─'.repeat(52));
  log.info('QQ 桥接安全档位');
  log.info(`  私聊白名单：${privates}`);
  log.info(`  群白名单  ：${groups}`);
  log.info(`  群触发方式：@我 或 以「${config.groupPrefix || '（未设置）'}」开头`);
  log.info(`  限流      ：每群 ${config.ratePerGroupMin}/分、每人 ${config.ratePerUserHour}/时、全局 ${config.rateGlobalMin}/分`);
  log.info(`  出站节奏  ：${config.replyDelayMinMs}~${config.replyDelayMaxMs}ms 随机延迟，最多 ${config.rateOutMin} 条/分`);
  log.info(`  熔断      ：连续 ${config.sendFailBreaker} 次发送失败即停发`);
  log.info(`  模式      ：${config.dryRun ? '试运行（只记录不发送）' : '正常发送'}`);
  log.info('─'.repeat(52));
}

const startedAt = Date.now();

async function main() {
  const config = loadQqConfig();
  const log = createLogger(config.logLevel);
  const dataDir = resolve(process.cwd(), config.dataDir);
  const { command: dshCommand, source: dshSource } = resolveDshCommand(process.env);
  const keyInfo = await resolveApiKey();
  const apiKey = keyInfo?.value;

  if (config.problems.length > 0) {
    for (const problem of config.problems) log.warn(`配置问题：${problem}`);
    if (args.has('--check') || args.has('--probe')) {
      // 自检模式只提示，不阻断（方便先看环境）
    } else if (!config.dryRun) {
      log.error('配置不完整，退出。修好 .env.qq 后重试（或先设 QQ_DRY_RUN=1 试跑）。');
      process.exit(1);
    } else {
      log.warn('配置不完整，但处于试运行模式，继续启动（不会真的发消息）。');
    }
  }

  if (args.has('--check')) {
    const version = spawnSync(dshCommand, ['--version'], { encoding: 'utf8' });
    printSafety(config, log);
    log.info(`NapCat 地址：${config.wsUrl}（token: ${config.wsToken ? '已配置' : '未配置'}）`);
    log.info(`DSH 命令：${dshCommand}（来源 ${dshSource}）profile=${config.agentProfile} cwd=${config.agentCwd}`);
    log.info(`超时：聊天 ${config.agentChatTimeoutMs / 1000}s / 干活 ${config.agentTimeoutMs / 1000}s`);
    log.info(
      config.agentPermissionMode === 'danger-full-access'
        ? '沙箱：danger-full-access（能读写桌面、截图、开 App、控窗口）'
        : `沙箱：${config.agentPermissionMode}（只能写工作区）`,
    );
    log.info(
      `dsh --version => ${version.status === 0 ? version.stdout.trim() : `失败: ${version.error?.message ?? version.stderr}`}`,
    );
    log.info(`API key => ${maskKey(apiKey)}${keyInfo ? `（来源 ${keyInfo.source}）` : '（未找到，headless 可能无法调用模型）'}`);
    log.info(`数据目录：${dataDir}/qq`);

    // 顺带把最终人设打出来（含性格刻度），方便确认调参有没有生效
    const personaProbe = createPersona({ file: resolve(process.cwd(), config.personaFile), log });
    const personaText = await personaProbe();
    log.info(`人设：${config.personaFile} → 最终 ${personaText.length} 字`);

    const voiceProbe = createVoice({ file: resolve(process.cwd(), config.voiceFile), log });
    log.info(await voiceProbe.summary());
    try {
      const rows = (await readFile(resolve(dataDir, 'qq/memory', `user_private_${config.allowList[0]}.jsonl`), 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      log.info(formatAudit(audit(repliesFromMemory(rows, 40)), { limit: 3 }));
    } catch {
      log.info('人味分：还没有聊天记录，跳过。');
    }

    log.info('自检完成（未连接 NapCat）。');
    return;
  }

  if (!apiKey) {
    log.warn('没有找到 DEEPSEEK_API_KEY，headless 调用模型可能失败。');
  }

  const { runner, chatRunner } = createAgentRunners({ config, log, dshCommand, apiKey });

  const memory = createMemory({
    dir: `${dataDir}/qq/memory`,
    maxTurns: config.historyTurns,
    maxChars: config.historyMaxChars,
    log,
  });

  const queue = new KeyedQueue({ globalConcurrency: config.maxRunsGlobal, log });
  const persona = createPersona({ file: resolve(process.cwd(), config.personaFile), log });
  const voice = createVoice({ file: resolve(process.cwd(), config.voiceFile), log });
  const slang = createSlang({ file: resolve(process.cwd(), config.slangFile), log });
  log.info(await voice.summary());
  const vision = createVision({
    cli: config.visionCli ?? resolveVisionCli(process.env),
    timeoutMs: config.visionTimeoutMs,
    enabled: config.visionEnabled,
    log,
  });
  if (vision.available) log.info(`看图能力已启用（${config.visionCli ?? 'modlens'}）`);
  else log.warn(`看图能力不可用：${vision.reason}`);

  printSafety(config, log);

  /** @type {ReturnType<typeof createBridge> | undefined} */
  let bridge;
  /** @type {ReturnType<typeof createProactive> | undefined} */
  let proactive;
  /** @type {ReturnType<typeof createLife> | undefined} */
  let life;
  /** @type {ReturnType<typeof createDouyinChannel> | undefined} */
  let douyinChat;

  const transport = await startOneBot({
    config: {
      ...config,
      // 传输层的数据目录固定到 <data>/qq，审计文件转成绝对路径，避免 cwd 变化时写错地方
      dataDir: `${dataDir}/qq`,
      auditFile: resolve(process.cwd(), config.auditFile),
    },
    log,
    onMessage: (msg) => {
      proactive?.touchUser();
      return bridge?.handle(msg);
    },
  });

  if (args.has('--probe')) {
    log.info('探针模式：等待 NapCat 回报登录信息…');
    const ready = await Promise.race([
      transport.ready.then(() => true),
      new Promise((resolve) => setTimeout(() => resolve(false), 20_000)),
    ]);
    if (!ready) {
      log.error('20 秒内没连上 NapCat。确认 NapCat 已启动、OneBot 正向 WS 已开启且端口一致。');
      await transport.stop();
      process.exit(1);
    }
    const info = await transport.probe();
    log.info(`登录号：${info.nickname}（${info.selfId}）`);
    log.info(`群数量：${info.groups.length}`);
    for (const group of info.groups) {
      const mark = config.groupAllowList.includes(group.id) ? '✓ 白名单' : ' ';
      log.info(`  ${mark} ${group.id}  ${group.name}`);
    }
    log.info('探针完成，退出。把想放行的群号填进 .env.qq 的 QQ_GROUP_ALLOW_LIST。');
    await transport.stop();
    return;
  }

  const sticker = createStickers({ dir: resolve(process.cwd(), config.stickerDir), log });
  const stickerCount = await sticker.count();
  if (stickerCount > 0) log.info(`表情包：${stickerCount} 张可用（${config.stickerDir}）`);
  else log.warn(`表情包目录是空的：${config.stickerDir}`);

  const voiceOut = createVoiceOut({ config, log });
  if (voiceOut.enabled) {
    log.info(`语音：已启用（${voiceOut.voiceName}，每天最多 ${config.voiceOutMaxPerDay} 条）`);
  } else {
    log.warn(`语音：不可用 —— ${voiceOut.unavailable}`);
  }

  life = createLife({
    config,
    log,
    root: process.cwd(),
    isBusy: () => {
      const stats = queue.stats();
      return stats.active + stats.waiting > 0;
    },
  });

  bridge = createBridge({
    config,
    runner,
    chatRunner,
    memory,
    queue,
    log,
    reply: transport.reply,
    typing: transport.typing,
    persona,
    voice,
    slang,
    vision,
    life,
    sticker,
    sendSticker: transport.sendImage,
    voiceOut,
    sendVoice: transport.sendVoice,
    onActivity: (state) => log.debug(`activity=${state}`),
  });

  proactive = createProactive({
    config,
    log,
    runner,
    persona,
    voice,
    memory,
    isBusy: () => {
      const stats = queue.stats();
      return stats.active + stats.waiting > 0;
    },
    reply: transport.reply,
    life,
  });
  proactive.start();
  life.start();

  douyinChat = createDouyinChannel({
    config,
    runner,
    persona,
    voice,
    slang,
    // 和 QQ 共用同一个记忆实例 → 两边是同一份对话时间线（同一 key，同一份 JSONL）
    memory,
    log,
    onInbound: () => proactive?.touchUser?.(),
  });
  douyinChat.start();

  /* ── 饭饭账本：到点自己记一顿，月初把上个月的翻给他看 ── */
  const mealsFile = resolve(dataDir, 'life/meals.jsonl');
  const reportStateFile = resolve(dataDir, 'life/meals-report.json');
  const shutdownFile = resolve(dataDir, 'life/shutdown.json');
  const owner = config.allowList[0];
  const ownerTarget = { senderId: owner, conversationId: `private_${owner}`, groupId: null };

  async function sendToOwner(text) {
    if (!owner || config.dryRun) return;
    await transport.reply(ownerTarget, text);
  }

  async function mealTick() {
    try {
      const entry = await maybeAutoMeal({ file: mealsFile });
      if (entry) log.info(`记了一顿：${entry.slot} ${entry.dish}`);
    } catch (error) {
      log.warn(`记饭饭失败：${error?.message ?? error}`);
    }

    // 月初（1 号 9 点之后）把上个月的账翻给他，一个月只发一次
    try {
      const now = new Date();
      if (now.getDate() === 1 && now.getHours() >= 9) {
        const month = previousMonth(now);
        let sent = [];
        try {
          sent = JSON.parse(await readFile(reportStateFile, 'utf8')).sent ?? [];
        } catch {
          /* 第一次跑，没有记录 */
        }
        if (!sent.includes(month)) {
          const rows = await loadMeals(mealsFile);
          const summary = summarizeMonth(rows, month);
          if (summary.count > 0) {
            await sendToOwner(formatMonthReport(summary));
            sent.push(month);
            await mkdir(dirname(reportStateFile), { recursive: true });
            await writeFile(reportStateFile, JSON.stringify({ sent }, null, 2), 'utf8');
            log.info(`月报已发：${month}（${summary.count} 顿）`);
          }
        }
      }
    } catch (error) {
      log.warn(`月报发送失败：${error?.message ?? error}`);
    }
  }

  const mealTimer = setInterval(() => void mealTick(), 10 * 60_000);
  mealTimer.unref?.();
  void mealTick();

  // 上次是被硬拔的？起来先补一句，别装作什么都没发生
  const previousRun = await markRunning(shutdownFile);
  if (previousRun?.state && previousRun.state !== 'stopped') {
    log.warn(`上次退出不干净（state=${previousRun.state}），补一句`);
    void sendToOwner('爸爸，人家刚才被硬拔了，没来得及说再见。现在回来了。').catch(() => {});
  }

  const shutdown = async (signal) => {
    log.info(`收到 ${signal}，正在退出`);

    // 先喊一声再走（刚启动就重启的话就算了，别刷屏）
    try {
      const uptimeMin = (Date.now() - startedAt) / 60_000;
      if (uptimeMin >= (config.farewellMinUptimeMin ?? 30) && owner && !config.dryRun) {
        const farewell = new Date().getHours() >= 22 || new Date().getHours() < 6
          ? '爸爸，人家要下线了。晚安。'
          : '爸爸，人家先下线了，回头见。';
        await Promise.race([
          transport.reply(ownerTarget, farewell),
          new Promise((done) => setTimeout(done, 6_000)),
        ]);
        log.info('已经跟他道过别');
      }
    } catch (error) {
      log.warn(`告别没喊出去：${error?.message ?? error}`);
    }
    await markStopped(shutdownFile, true).catch(() => {});

    mealTimer && clearInterval(mealTimer);
    proactive?.stop();
    life?.stop();
    await douyinChat?.stop();
    try {
      const stats = transport.stats();
      log.info(`统计：收到 ${stats.inbound}，回复 ${stats.outbound}，丢弃 ${stats.dropped}`);
      await transport.stop();
    } finally {
      process.exit(0);
    }
  };
  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));

  log.info('QQ 桥接已启动，等待消息（Ctrl-C 停止）');
}

process.on('unhandledRejection', (error) => {
  console.error(`未处理的 rejection: ${error?.stack ?? error}`);
});

main().catch((error) => {
  console.error(error?.stack ?? error);
  process.exit(1);
});