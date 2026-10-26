/**
 * 配置加载：全部来自环境变量（.env 或 launchd 环境），便于开机自启。
 * 缺配置时不直接崩溃，而是返回 problems 列表，让 --check 能一次列全所有问题。
 */

const DEFAULTS = {
  agentBackend: 'dsh',
  openaiBaseUrl: 'https://api.deepseek.com/v1',
  openaiApiKey: '',
  openaiModel: 'deepseek-chat',
  botName: 'dsh-wechat-bridge',
  agentProfile: 'headless',
  agentCwd: process.cwd(),
  agentTimeoutMs: 180_000,
  agentPermissionMode: 'workspace-write',
  maxReplyChars: 1800,
  maxInputChars: 6_000,
  maxRunsGlobal: 2,
  historyTurns: 8,
  historyMaxChars: 6_000,
  logLevel: 'info',
  replyAck: true,
  ackDelayMs: 15_000,
  typing: true,
  dataDir: 'data',
  personaFile: 'persona.md',
  visionTimeoutMs: 60_000,
  maxMediaBytes: 25 * 1024 * 1024,
  longPollTimeoutMs: 60_000,
  qrTimeoutMs: 480_000,
};

function readInt(env, key, fallback) {
  const raw = env[key];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${key} 必须是 >= 0 的整数，当前为 ${JSON.stringify(raw)}`);
  }
  return value;
}

function readBool(env, key, fallback) {
  const raw = env[key];
  if (raw === undefined || raw.trim() === '') return fallback;
  return /^(1|true|yes|on)$/i.test(raw.trim());
}

function readList(env, key) {
  const raw = env[key];
  if (raw === undefined) return [];
  return raw
    .split(/[,，\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * @param {NodeJS.ProcessEnv} env
 */
export function loadConfig(env = process.env) {
  const allowList = readList(env, 'WECHAT_ALLOW_LIST');
  const allowUnknown = readBool(env, 'WECHAT_ALLOW_UNKNOWN', false);

  const problems = [];
  if (allowList.length === 0 && !allowUnknown) {
    problems.push(
      'WECHAT_ALLOW_LIST 为空：任何加到机器人上的人发消息都能在本机执行命令。请显式配置白名单；' +
        '首次运行可临时设置 WECHAT_ALLOW_UNKNOWN=1 获取自己的 wxid。',
    );
  }

  return Object.freeze({
    allowList,
    allowUnknown,
    botName: env.WECHAT_BOT_NAME?.trim() || DEFAULTS.botName,
    agentBackend: (env.AGENT_BACKEND || DEFAULTS.agentBackend || 'dsh').trim().toLowerCase(),
    openaiBaseUrl: env.OPENAI_BASE_URL?.trim() || DEFAULTS.openaiBaseUrl,
    openaiApiKey: env.OPENAI_API_KEY?.trim() || '',
    openaiModel: env.OPENAI_MODEL?.trim() || DEFAULTS.openaiModel,
    agentProfile: env.AGENT_PROFILE?.trim() || DEFAULTS.agentProfile,
    agentCwd: env.AGENT_CWD?.trim() || DEFAULTS.agentCwd,
    agentTimeoutMs: readInt(env, 'AGENT_TIMEOUT_MS', DEFAULTS.agentTimeoutMs),
    // workspace-write（默认，只能写工作区）/ danger-full-access（能读写桌面、操作 GUI）
    agentPermissionMode: env.AGENT_PERMISSION_MODE?.trim() || DEFAULTS.agentPermissionMode,
    maxReplyChars: readInt(env, 'MAX_REPLY_CHARS', DEFAULTS.maxReplyChars),
    maxInputChars: readInt(env, 'MAX_INPUT_CHARS', DEFAULTS.maxInputChars),
    maxRunsGlobal: readInt(env, 'MAX_RUNS_GLOBAL', DEFAULTS.maxRunsGlobal),
    historyTurns: readInt(env, 'HISTORY_TURNS', DEFAULTS.historyTurns),
    historyMaxChars: readInt(env, 'HISTORY_MAX_CHARS', DEFAULTS.historyMaxChars),
    logLevel: env.LOG_LEVEL?.trim() || DEFAULTS.logLevel,
    replyAck: readBool(env, 'REPLY_ACK', DEFAULTS.replyAck),
    ackDelayMs: readInt(env, 'ACK_DELAY_MS', DEFAULTS.ackDelayMs),
    typing: readBool(env, 'TYPING_INDICATOR', DEFAULTS.typing),
    dataDir: env.DATA_DIR?.trim() || DEFAULTS.dataDir,
    personaFile: env.PERSONA_FILE?.trim() || DEFAULTS.personaFile,
    visionEnabled: readBool(env, 'VISION_ENABLED', true),
    visionCli: env.VISION_CLI?.trim() || null,
    visionTimeoutMs: readInt(env, 'VISION_TIMEOUT_MS', DEFAULTS.visionTimeoutMs),
    maxMediaBytes: readInt(env, 'MAX_MEDIA_BYTES', DEFAULTS.maxMediaBytes),
    longPollTimeoutMs: readInt(env, 'LONG_POLL_TIMEOUT_MS', DEFAULTS.longPollTimeoutMs),
    qrTimeoutMs: readInt(env, 'QR_TIMEOUT_MS', DEFAULTS.qrTimeoutMs),
    problems,
  });
}

export { DEFAULTS, readInt, readBool, readList };
