/**
 * OpenAI 兼容后端：只想聊天的话，这一层就够。
 *
 * 和 dsh 后端的区别（很重要）：
 *  - dsh 后端是**完整 agent**：能跑命令、读写文件、看图、用工具；
 *  - 这个后端只是**一次 HTTP 请求**：模型只能回文字，没有工具能力。
 *    人设、记忆、节奏、表情包、语音这些桥接层的能力都还在。
 *
 * 兼容所有 OpenAI Chat Completions 风格的服务：
 *   OpenAI / DeepSeek / Moonshot / 通义 / 智谱 / Ollama / vLLM / one-api …
 */

const RETRY_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504]);

function sleep(ms) {
  return new Promise((done) => setTimeout(done, ms));
}

/**
 * @param {{
 *   baseUrl: string,
 *   apiKey: string,
 *   model: string,
 *   timeoutMs?: number,
 *   retries?: number,
 *   temperature?: number,
 *   log?: any,
 *   fetchImpl?: typeof fetch,
 * }} options
 */
export function createOpenAiRunner(options) {
  const {
    baseUrl,
    apiKey,
    model,
    timeoutMs = 120_000,
    retries = 2,
    temperature = 0.9,
    log = console,
    fetchImpl = fetch,
  } = options;

  const url = `${String(baseUrl ?? '').replace(/\/+$/, '')}/chat/completions`;

  async function once(prompt) {
    const started = Date.now();
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify({
        model,
        temperature,
        messages: [{ role: 'user', content: prompt }],
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      const error = new Error(`模型接口 HTTP ${response.status}：${body.slice(0, 300)}`);
      error.status = response.status;
      throw error;
    }

    const data = await response.json();
    const message = data?.choices?.[0]?.message ?? {};
    // 思考模型的 reasoning_content 不进正文，只用 content
    const text = String(message.content ?? '').trim();
    if (!text) throw new Error('模型返回了空内容');
    return { text, durationMs: Date.now() - started };
  }

  return {
    backend: 'openai',
    async run(prompt) {
      let lastError;
      for (let attempt = 1; attempt <= retries; attempt += 1) {
        try {
          return await once(prompt);
        } catch (error) {
          lastError = error;
          const retryable = RETRY_STATUS.has(error?.status) || /ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket hang up/i.test(String(error?.message));
          if (attempt >= retries || !retryable) throw error;
          log.warn?.(`模型接口偶发失败（${error.message}），重试第 ${attempt} 次`);
          await sleep(1_200 * attempt);
        }
      }
      throw lastError;
    },
  };
}