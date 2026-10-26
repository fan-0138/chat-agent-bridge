/**
 * 选后端：同一套桥接逻辑，底下可以换模型。
 *
 *   AGENT_BACKEND=dsh      DeepSeek Harness 的 headless CLI（完整 agent，推荐）
 *   AGENT_BACKEND=openai   任意 OpenAI 兼容 API（只会聊天，没有工具）
 */

import { createDshRunner } from './dsh.js';
import { createOpenAiRunner } from './openai-runner.js';

export function createAgentRunners({ config, log, dshCommand, apiKey }) {
  const backend = String(config.agentBackend ?? 'dsh').toLowerCase();

  if (backend === 'openai') {
    const runner = createOpenAiRunner({
      baseUrl: config.openaiBaseUrl,
      apiKey: config.openaiApiKey || apiKey,
      model: config.openaiModel,
      timeoutMs: config.agentTimeoutMs,
      log,
    });
    log.info(`模型后端：openai（${config.openaiBaseUrl} · ${config.openaiModel}）`);
    return { backend, runner, chatRunner: runner };
  }

  const runner = createDshRunner({
    command: dshCommand,
    apiKey,
    profile: config.agentProfile,
    cwd: config.agentCwd,
    timeoutMs: config.agentTimeoutMs,
    permissionMode: config.agentPermissionMode,
    log,
  });
  // 聊天用短超时：真人不会让你等三分钟
  const chatRunner = createDshRunner({
    command: dshCommand,
    apiKey,
    profile: config.agentProfile,
    cwd: config.agentCwd,
    timeoutMs: config.agentChatTimeoutMs ?? config.agentTimeoutMs,
    permissionMode: config.agentPermissionMode,
    log,
  });
  log.info(`模型后端：dsh（profile=${config.agentProfile}）`);
  return { backend, runner, chatRunner };
}