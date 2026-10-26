/**
 * QQ 通道的配置：和环境变量一一对应，全部带 QQ_ 前缀，避免和微信通道互相污染。
 * 和 config.js 一样，缺配置不崩，返回 problems 让 --check 一次说清。
 *
 * 安全默认值（这份默认值就是「保守档」）：
 *  - 私聊白名单为空 => 谁都不回；
 *  - 群白名单为空 => 任何群都不回；
 *  - 只有 @我 或前缀才触发；
 *  - 每条回复前 0.6~2.5 秒随机延迟，出站每分钟最多 15 条；
 *  - 连续 5 次发送失败即熔断。
 */

import { DEFAULTS as BASE, readBool, readInt, readList } from './config.js';

const DEFAULTS = {
  dataDir: 'data',
  wsUrl: 'ws://127.0.0.1:3001',
  groupPrefix: '/ai',
  replyDelayMinMs: 600,
  replyDelayMaxMs: 2_500,
  ratePerGroupMin: 5,
  ratePerUserHour: 20,
  rateGlobalMin: 12,
  rateOutMin: 15,
  sendFailBreaker: 5,
  maxReconnect: 12,
  maxReplyChars: 1_200,
  bubbleMaxChars: 90,
  bubbleMax: 3,
  chatThinkMinMs: 400,
  chatThinkMaxMs: 1_200,
  typingMsPerChar: 12,
  thinkCapMs: 1_800,
  distractedChance: 0.03,
  distractedMinMs: 3_000,
  distractedMaxMs: 8_000,
  turnGraceMs: 2_500,
  proactiveEnabled: false,
  proactiveMaxPerDay: 3,
  proactiveMinGapMin: 90,
  proactiveAfterIdleMin: 45,
  proactiveQuietStart: 1,
  proactiveQuietEnd: 9,
  proactiveChance: 0.12,
  proactiveTickMs: 600_000,
  proactiveDouyinChance: 0.2,
  proactiveCommentChance: 0.6,
  proactiveQzoneChance: 0.12,
  douyinMention: '',
  douyinChatSelfName: '主人',
  // ── 生活状态 / 自己刷抖音 ──
  lifeEnabled: false,
  lifeTickMs: 1_800_000,
  lifeBrowseMaxPerDay: 3,
  lifeBrowseMinGapMin: 120,
  lifeBrowseChance: 0.3,
  lifeBrowseScroll: 6,
  lifeBrowseTimeoutMs: 180_000,
  lifeStateFile: 'data/life/state.json',
  lifeLikePerBrowse: 1,
  lifeLikeMaxPerDay: 3,
  stickerChance: 0.18,
  stickerDir: 'data/stickers',
  // ── 真的说出口：QQ 语音消息 ──
  voiceOutEnabled: true,
  voiceOutName: 'zh-CN-XiaoyiNeural',
  voiceOutPitch: '+0Hz',
  voiceOutRate: '+5%',
  voiceOutMaxChars: 120,
  voiceOutMaxPerDay: 8,
  voiceOutMinGapMin: 8,
  voiceOutTimeoutMs: 25_000,
  // ── 模型后端：dsh（完整 agent） / openai（任意兼容接口） ──
  agentBackend: 'dsh',
  openaiBaseUrl: 'https://api.deepseek.com/v1',
  openaiApiKey: '',
  openaiModel: 'deepseek-chat',
  // 在线够久才在关掉时喊一声（防止反复重启时刷屏）
  farewellMinUptimeMin: 30,
  edgeTtsBin: '.venv-tts/bin/edge-tts',
  ffmpegBin: 'ffmpeg',
  // 说话方式笔记 + emoji 上限（模型自己数不住，出站时机械兜底）
  voiceFile: 'data/voice.md',
  slangFile: 'data/slang.md',
  emojiMax: 2,
  douyinChatEnabled: false,
  douyinChatTickMs: 20_000,
  douyinChatMaxPerHour: 30,
  douyinChatMaxPerDay: 200,
  douyinChatDebug: false,
  douyinChatResident: false, // 默认不常驻：查完就关浏览器，省内存
  douyinChatHideWindow: true,
  // 无头：连窗口都不存在，最干净（UA 会自动换成真的）
  douyinChatHeadless: false,
  douyinCdpUrl: '',
  // 互动通知（谁 @ 了她 / 评论了她）：只读，便宜，默认开
  douyinNoticeEnabled: true,
  douyinNoticeMin: 10,
  // 就算没看到未读红点，也至少这么久走一次完整检查（防角标不刷新）
  douyinForceCheckMin: 5,
  douyinFeedScript: 'scripts/douyin-feed.mjs',
  // 聊天走短超时：回一句话不该让人等三分钟
  agentChatTimeoutMs: 60_000,
  ackDelayMs: 12_000,
  auditFile: 'data/qq/audit.jsonl',
};

/** @param {NodeJS.ProcessEnv} env */
export function loadQqConfig(env = process.env) {
  const allowList = readList(env, 'QQ_ALLOW_LIST');
  const groupAllowList = readList(env, 'QQ_GROUP_ALLOW_LIST');
  const wsUrl = env.QQ_WS_URL?.trim() || DEFAULTS.wsUrl;
  const dryRun = readBool(env, 'QQ_DRY_RUN', false);

  const problems = [];

  if (allowList.length === 0) {
    problems.push(
      'QQ_ALLOW_LIST 为空：私聊不会回复任何人。自用时填你自己的 QQ 号即可（可以先用 QQ_DRY_RUN=1 试跑）。',
    );
  }
  if (!/^wss?:\/\//i.test(wsUrl)) {
    problems.push(`QQ_WS_URL 必须是 ws:// 或 wss:// 开头，当前为 ${JSON.stringify(wsUrl)}`);
  } else {
    try {
      const { hostname } = new URL(wsUrl);
      const local = ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(hostname);
      if (!local) {
        problems.push(
          `QQ_WS_URL 指向非本机地址（${hostname}）：NapCat 的 OneBot 端口不应暴露到局域网/公网，请改回 127.0.0.1。`,
        );
      }
    } catch {
      problems.push(`QQ_WS_URL 无法解析：${JSON.stringify(wsUrl)}`);
    }
  }

  const dataDir = env.DATA_DIR?.trim() || DEFAULTS.dataDir;

  return Object.freeze({
    channel: 'qq',
    allowList,
    allowUnknown: false, // QQ 侧永远不自动放行陌生人
    allowListHint: 'QQ_ALLOW_LIST',
    groupAllowList,
    groupPrefix: env.QQ_GROUP_PREFIX?.trim() ?? DEFAULTS.groupPrefix,
    wsUrl,
    wsToken: env.QQ_WS_TOKEN?.trim() || '',
    selfId: env.QQ_SELF_ID?.trim() || '',
    dryRun,
    // 配置向导模式：只记录发来消息的 QQ 号/群号，不回复、不调模型。首次接入时用。
    setupMode: readBool(env, 'QQ_SETUP_MODE', false),
    replyDelayMinMs: readInt(env, 'QQ_REPLY_DELAY_MIN_MS', DEFAULTS.replyDelayMinMs),
    replyDelayMaxMs: readInt(env, 'QQ_REPLY_DELAY_MAX_MS', DEFAULTS.replyDelayMaxMs),
    ratePerGroupMin: readInt(env, 'QQ_RATE_PER_GROUP_MIN', DEFAULTS.ratePerGroupMin),
    ratePerUserHour: readInt(env, 'QQ_RATE_PER_USER_HOUR', DEFAULTS.ratePerUserHour),
    rateGlobalMin: readInt(env, 'QQ_RATE_GLOBAL_MIN', DEFAULTS.rateGlobalMin),
    rateOutMin: readInt(env, 'QQ_RATE_OUT_MIN', DEFAULTS.rateOutMin),
    sendFailBreaker: readInt(env, 'QQ_SEND_FAIL_BREAKER', DEFAULTS.sendFailBreaker),
    maxReconnect: readInt(env, 'QQ_MAX_RECONNECT', DEFAULTS.maxReconnect),
    auditFile: env.QQ_AUDIT_FILE?.trim() || `${dataDir}/qq/audit.jsonl`,
    dataDir,

    // ── 与微信通道共用的部分 ──
    agentProfile: env.AGENT_PROFILE?.trim() || BASE.agentProfile,
    agentCwd: env.AGENT_CWD?.trim() || BASE.agentCwd,
    agentTimeoutMs: readInt(env, 'AGENT_TIMEOUT_MS', BASE.agentTimeoutMs),
    agentPermissionMode: env.AGENT_PERMISSION_MODE?.trim() || BASE.agentPermissionMode,
    agentChatTimeoutMs: readInt(env, 'AGENT_CHAT_TIMEOUT_MS', DEFAULTS.agentChatTimeoutMs),
    maxReplyChars: readInt(env, 'MAX_REPLY_CHARS', DEFAULTS.maxReplyChars),
    bubbleMaxChars: readInt(env, 'QQ_BUBBLE_MAX_CHARS', DEFAULTS.bubbleMaxChars),
    bubbleMax: readInt(env, 'QQ_BUBBLE_MAX', DEFAULTS.bubbleMax),
    chatThinkMinMs: readInt(env, 'QQ_CHAT_THINK_MIN_MS', DEFAULTS.chatThinkMinMs),
    chatThinkMaxMs: readInt(env, 'QQ_CHAT_THINK_MAX_MS', DEFAULTS.chatThinkMaxMs),
    typingMsPerChar: readInt(env, 'QQ_TYPING_MS_PER_CHAR', DEFAULTS.typingMsPerChar),
    thinkCapMs: readInt(env, 'QQ_THINK_CAP_MS', DEFAULTS.thinkCapMs),
    distractedChance: Number(env.QQ_DISTRACTED_CHANCE ?? DEFAULTS.distractedChance),
    distractedMinMs: readInt(env, 'QQ_DISTRACTED_MIN_MS', DEFAULTS.distractedMinMs),
    distractedMaxMs: readInt(env, 'QQ_DISTRACTED_MAX_MS', DEFAULTS.distractedMaxMs),
    turnGraceMs: readInt(env, 'QQ_TURN_GRACE_MS', DEFAULTS.turnGraceMs),
    proactiveEnabled: readBool(env, 'QQ_PROACTIVE_ENABLED', DEFAULTS.proactiveEnabled),
    proactiveMaxPerDay: readInt(env, 'QQ_PROACTIVE_MAX_PER_DAY', DEFAULTS.proactiveMaxPerDay),
    proactiveMinGapMin: readInt(env, 'QQ_PROACTIVE_MIN_GAP_MIN', DEFAULTS.proactiveMinGapMin),
    proactiveAfterIdleMin: readInt(env, 'QQ_PROACTIVE_AFTER_IDLE_MIN', DEFAULTS.proactiveAfterIdleMin),
    proactiveQuietStart: readInt(env, 'QQ_PROACTIVE_QUIET_START', DEFAULTS.proactiveQuietStart),
    proactiveQuietEnd: readInt(env, 'QQ_PROACTIVE_QUIET_END', DEFAULTS.proactiveQuietEnd),
    proactiveChance: Number(env.QQ_PROACTIVE_CHANCE ?? DEFAULTS.proactiveChance),
    proactiveTickMs: readInt(env, 'QQ_PROACTIVE_TICK_MS', DEFAULTS.proactiveTickMs),
    proactiveDouyinChance: Number(env.QQ_PROACTIVE_DOUYIN_CHANCE ?? DEFAULTS.proactiveDouyinChance),
    proactiveCommentChance: Number(env.QQ_PROACTIVE_COMMENT_CHANCE ?? DEFAULTS.proactiveCommentChance),
    proactiveQzoneChance: Number(env.QQ_PROACTIVE_QZONE_CHANCE ?? DEFAULTS.proactiveQzoneChance),
    douyinMention: env.QQ_DOUYIN_MENTION?.trim() || DEFAULTS.douyinMention,
    douyinChatSelfName: env.QQ_DOUYIN_SELF_NAME?.trim() || DEFAULTS.douyinChatSelfName,
    lifeEnabled: readBool(env, 'QQ_LIFE_ENABLED', DEFAULTS.lifeEnabled),
    lifeTickMs: readInt(env, 'QQ_LIFE_TICK_MS', DEFAULTS.lifeTickMs),
    lifeBrowseMaxPerDay: readInt(env, 'QQ_LIFE_BROWSE_MAX_PER_DAY', DEFAULTS.lifeBrowseMaxPerDay),
    lifeBrowseMinGapMin: readInt(env, 'QQ_LIFE_BROWSE_MIN_GAP_MIN', DEFAULTS.lifeBrowseMinGapMin),
    lifeBrowseChance: Number(env.QQ_LIFE_BROWSE_CHANCE ?? DEFAULTS.lifeBrowseChance),
    lifeBrowseScroll: readInt(env, 'QQ_LIFE_BROWSE_SCROLL', DEFAULTS.lifeBrowseScroll),
    lifeBrowseTimeoutMs: readInt(env, 'QQ_LIFE_BROWSE_TIMEOUT_MS', DEFAULTS.lifeBrowseTimeoutMs),
    lifeStateFile: env.QQ_LIFE_STATE_FILE?.trim() || DEFAULTS.lifeStateFile,
    lifeLikePerBrowse: readInt(env, 'QQ_DOUYIN_LIKE_PER_BROWSE', DEFAULTS.lifeLikePerBrowse),
    lifeLikeMaxPerDay: readInt(env, 'QQ_DOUYIN_LIKE_MAX_PER_DAY', DEFAULTS.lifeLikeMaxPerDay),
    stickerChance: Number(env.QQ_STICKER_CHANCE ?? DEFAULTS.stickerChance),
    stickerDir: env.QQ_STICKER_DIR?.trim() || DEFAULTS.stickerDir,
    voiceOutEnabled: readBool(env, 'QQ_VOICE_OUT', DEFAULTS.voiceOutEnabled),
    voiceOutName: env.QQ_VOICE_NAME?.trim() || DEFAULTS.voiceOutName,
    voiceOutPitch: env.QQ_VOICE_PITCH?.trim() || DEFAULTS.voiceOutPitch,
    voiceOutRate: env.QQ_VOICE_RATE?.trim() || DEFAULTS.voiceOutRate,
    voiceOutMaxChars: readInt(env, 'QQ_VOICE_MAX_CHARS', DEFAULTS.voiceOutMaxChars),
    voiceOutMaxPerDay: readInt(env, 'QQ_VOICE_MAX_PER_DAY', DEFAULTS.voiceOutMaxPerDay),
    voiceOutMinGapMin: readInt(env, 'QQ_VOICE_MIN_GAP_MIN', DEFAULTS.voiceOutMinGapMin),
    voiceOutTimeoutMs: readInt(env, 'QQ_VOICE_TIMEOUT_MS', DEFAULTS.voiceOutTimeoutMs),
    agentBackend: (env.AGENT_BACKEND || DEFAULTS.agentBackend).trim().toLowerCase(),
    openaiBaseUrl: env.OPENAI_BASE_URL?.trim() || DEFAULTS.openaiBaseUrl,
    openaiApiKey: env.OPENAI_API_KEY?.trim() || '',
    openaiModel: env.OPENAI_MODEL?.trim() || DEFAULTS.openaiModel,
    farewellMinUptimeMin: readInt(env, 'QQ_FAREWELL_MIN_UPTIME_MIN', DEFAULTS.farewellMinUptimeMin),
    edgeTtsBin: env.QQ_EDGE_TTS_BIN?.trim() || DEFAULTS.edgeTtsBin,
    ffmpegBin: env.QQ_FFMPEG_BIN?.trim() || DEFAULTS.ffmpegBin,
    voiceFile: env.QQ_VOICE_FILE?.trim() || DEFAULTS.voiceFile,
    slangFile: env.QQ_SLANG_FILE?.trim() || DEFAULTS.slangFile,
    emojiMax: readInt(env, 'QQ_EMOJI_MAX', DEFAULTS.emojiMax),
    douyinChatEnabled: readBool(env, 'QQ_DOUYIN_CHAT_ENABLED', DEFAULTS.douyinChatEnabled),
    douyinChatTickMs: readInt(env, 'QQ_DOUYIN_CHAT_TICK_MS', DEFAULTS.douyinChatTickMs),
    douyinChatMaxPerHour: readInt(env, 'QQ_DOUYIN_CHAT_MAX_PER_HOUR', DEFAULTS.douyinChatMaxPerHour),
    douyinChatMaxPerDay: readInt(env, 'QQ_DOUYIN_CHAT_MAX_PER_DAY', DEFAULTS.douyinChatMaxPerDay),
    douyinChatAllowList: readList(env, 'QQ_DOUYIN_CHAT_ALLOW'),
    douyinChatDebug: readBool(env, 'QQ_DOUYIN_CHAT_DEBUG', DEFAULTS.douyinChatDebug),
    douyinChatResident: readBool(env, 'QQ_DOUYIN_CHAT_RESIDENT', DEFAULTS.douyinChatResident),
    douyinChatHideWindow: readBool(env, 'QQ_DOUYIN_HIDE_WINDOW', DEFAULTS.douyinChatHideWindow),
    douyinChatHeadless: readBool(env, 'QQ_DOUYIN_HEADLESS', DEFAULTS.douyinChatHeadless),
    douyinCdpUrl: env.QQ_DOUYIN_CDP_URL?.trim() || DEFAULTS.douyinCdpUrl,
    douyinNoticeEnabled: readBool(env, 'QQ_DOUYIN_NOTICE', DEFAULTS.douyinNoticeEnabled),
    douyinNoticeMin: readInt(env, 'QQ_DOUYIN_NOTICE_MIN', DEFAULTS.douyinNoticeMin),
    douyinForceCheckMin: readInt(env, 'QQ_DOUYIN_FORCE_CHECK_MIN', DEFAULTS.douyinForceCheckMin),
    // 多久强制开一次私信面板（秒）。角标读不到时，这就是最坏延迟。
    douyinRecheckSec: readInt(env, 'QQ_DOUYIN_RECHECK_SEC', 25),
    douyinFeedScript: env.QQ_DOUYIN_FEED_SCRIPT?.trim() || DEFAULTS.douyinFeedScript,
    maxInputChars: readInt(env, 'MAX_INPUT_CHARS', BASE.maxInputChars),
    maxRunsGlobal: readInt(env, 'MAX_RUNS_GLOBAL', BASE.maxRunsGlobal),
    historyTurns: readInt(env, 'HISTORY_TURNS', BASE.historyTurns),
    historyMaxChars: readInt(env, 'HISTORY_MAX_CHARS', BASE.historyMaxChars),
    logLevel: env.LOG_LEVEL?.trim() || BASE.logLevel,
    // QQ 默认少发一条消息：ack 关掉能少一次出站
    replyAck: readBool(env, 'QQ_REPLY_ACK', false),
    ackDelayMs: readInt(env, 'ACK_DELAY_MS', DEFAULTS.ackDelayMs),
    // ack 之后再等这么久还没回，就补一句「还在翻」（0 = 不补）
    progressAckGapMs: readInt(env, 'PROGRESS_ACK_GAP_MS', 60_000),
    typing: false,
    personaFile: env.PERSONA_FILE?.trim() || BASE.personaFile,
    visionEnabled: readBool(env, 'VISION_ENABLED', true),
    visionCli: env.VISION_CLI?.trim() || null,
    visionTimeoutMs: readInt(env, 'VISION_TIMEOUT_MS', BASE.visionTimeoutMs),
    maxMediaBytes: readInt(env, 'MAX_MEDIA_BYTES', BASE.maxMediaBytes),
    problems,
  });
}

export { DEFAULTS as QQ_DEFAULTS };