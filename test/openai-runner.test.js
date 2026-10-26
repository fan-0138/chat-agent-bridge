import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createOpenAiRunner } from '../src/openai-runner.js';

const silent = { warn() {}, info() {}, debug() {} };

function fakeResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

test('正常返回时取 content，忽略 reasoning_content', async () => {
  let seen;
  const runner = createOpenAiRunner({
    baseUrl: 'https://api.example.com/v1/',
    apiKey: 'sk-test',
    model: 'm1',
    log: silent,
    fetchImpl: async (url, init) => {
      seen = { url, init };
      return fakeResponse({
        choices: [{ message: { content: '  在呢。 ', reasoning_content: '一堆思考' } }],
      });
    },
  });

  const result = await runner.run('你好');
  assert.equal(result.text, '在呢。');
  // baseUrl 末尾斜杠要被吃掉
  assert.equal(seen.url, 'https://api.example.com/v1/chat/completions');
  assert.equal(seen.init.headers.authorization, 'Bearer sk-test');
  assert.equal(JSON.parse(seen.init.body).model, 'm1');
});

test('429 会退避重试一次再成功', async () => {
  let calls = 0;
  const runner = createOpenAiRunner({
    baseUrl: 'https://api.example.com/v1',
    apiKey: 'k',
    model: 'm',
    retries: 2,
    log: silent,
    fetchImpl: async () => {
      calls += 1;
      if (calls === 1) return fakeResponse({ error: 'rate limited' }, 429);
      return fakeResponse({ choices: [{ message: { content: '好了' } }] });
    },
  });
  const result = await runner.run('嗨');
  assert.equal(result.text, '好了');
  assert.equal(calls, 2);
});

test('401 这种不该重试，直接报错', async () => {
  let calls = 0;
  const runner = createOpenAiRunner({
    baseUrl: 'https://api.example.com/v1',
    apiKey: 'bad',
    model: 'm',
    retries: 3,
    log: silent,
    fetchImpl: async () => {
      calls += 1;
      return fakeResponse({ error: 'invalid key' }, 401);
    },
  });
  await assert.rejects(() => runner.run('嗨'), /HTTP 401/);
  assert.equal(calls, 1);
});

test('空内容算失败，不会发出空消息', async () => {
  const runner = createOpenAiRunner({
    baseUrl: 'https://api.example.com/v1',
    apiKey: 'k',
    model: 'm',
    retries: 1,
    log: silent,
    fetchImpl: async () => fakeResponse({ choices: [{ message: { content: '   ' } }] }),
  });
  await assert.rejects(() => runner.run('嗨'), /空内容/);
});