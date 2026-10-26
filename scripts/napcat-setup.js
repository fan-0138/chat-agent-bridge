#!/usr/bin/env node
/**
 * 不用点 WebUI，直接通过 NapCat 自带的 HTTP API 把 OneBot11 的正向 WebSocket 配好。
 *
 *   node scripts/napcat-setup.js                 # 自动找 webui.json，建 127.0.0.1:3001
 *   node scripts/napcat-setup.js --port 3005     # 换端口
 *   node scripts/napcat-setup.js --token xxxx    # 手动指定 WebUI token
 *   node scripts/napcat-setup.js --dry-run       # 只打印将写入的配置，不提交
 *
 * 原理（NapCat WebUI 源码）：
 *   登录 hash = sha256(token + ".napcat")  → POST /api/auth/login {hash}
 *   拿到 Credential 后 POST /api/OB11Config/GetConfig / SetConfig（body: {config: JSON字符串}）
 */

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { connect } from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';

const args = process.argv.slice(2);
const argValue = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};
const flag = (name) => args.includes(name);

const WS_PORT = Number(argValue('--port', 3001));
const WS_HOST = '127.0.0.1';
const ENTRY_NAME = 'dsh';
const DRY_RUN = flag('--dry-run');

const WEBUI_CANDIDATES = [
  argValue('--webui-json', ''),
  process.env.NAPCAT_WEBUI_JSON || '',
  join(homedir(), 'Library/Containers/com.tencent.qq/Data/Documents/napcat/config/webui.json'),
  join(homedir(), 'napcat/config/webui.json'),
  '/opt/QQ/resources/app/app_launcher/napcat/config/webui.json',
  join(process.cwd(), 'config/webui.json'),
].filter(Boolean);

const sha256 = (text) => createHash('sha256').update(text).digest('hex');

function findWebuiJson() {
  for (const path of WEBUI_CANDIDATES) {
    if (existsSync(path)) return path;
  }
  return null;
}

async function login(baseUrl, token) {
  const hash = sha256(`${token}.napcat`);
  const response = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ hash }),
  });
  const payload = await response.json().catch(() => null);
  if (!payload || payload.code !== 0 || !payload.data?.Credential) {
    throw new Error(`登录失败：${JSON.stringify(payload)?.slice(0, 200)}`);
  }
  return payload.data.Credential;
}

async function api(baseUrl, credential, path, body) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${credential}`,
    },
    body: JSON.stringify(body ?? {}),
  });
  const payload = await response.json().catch(() => null);
  if (!payload || payload.code !== 0) {
    throw new Error(`${path} 失败：${JSON.stringify(payload)?.slice(0, 300)}`);
  }
  return payload.data;
}

async function main() {
  const tokenArg = argValue('--token', '');
  const webuiJson = findWebuiJson();
  let baseUrl = argValue('--webui', '');
  let token = tokenArg;

  if (webuiJson) {
    const raw = JSON.parse(await readFile(webuiJson, 'utf8'));
    const host = !raw.host || raw.host === '0.0.0.0' ? '127.0.0.1' : raw.host;
    baseUrl ||= `http://${host}:${raw.port || 6099}`;
    token ||= raw.token || '';
    console.log(`找到 WebUI 配置：${webuiJson}`);
  } else {
    console.log('没找到 webui.json，尝试用默认地址 127.0.0.1:6099');
  }

  baseUrl ||= 'http://127.0.0.1:6099';
  if (!token) {
    console.error('没有 WebUI token。用 --token 指定，或等 NapCat 启动后再跑一次。');
    process.exit(2);
  }

  console.log(`WebUI: ${baseUrl}`);
  const credential = await login(baseUrl, token);
  console.log('登录 WebUI 成功');

  const config = await api(baseUrl, credential, '/api/OB11Config/GetConfig');
  const servers = Array.isArray(config?.network?.websocketServers) ? config.network.websocketServers : [];
  const entry = {
    name: ENTRY_NAME,
    enable: true,
    host: WS_HOST,
    port: WS_PORT,
    messagePostFormat: 'array',
    reportSelfMessage: false,
    token: '',
    enableForcePushEvent: true,
    debug: false,
    heartInterval: 30000,
  };

  const existingIndex = servers.findIndex((item) => item?.name === ENTRY_NAME);
  if (existingIndex >= 0) servers[existingIndex] = { ...servers[existingIndex], ...entry };
  else servers.push(entry);

  config.network ||= {};
  config.network.websocketServers = servers;

  const payload = JSON.stringify(config, null, 2);
  if (DRY_RUN) {
    console.log('--- 将写入的 OneBot 配置（dry-run，不提交）---');
    console.log(payload);
    return;
  }

  await api(baseUrl, credential, '/api/OB11Config/SetConfig', { config: JSON.stringify(config) });
  console.log(`已写入 OneBot 配置：${WS_HOST}:${WS_PORT}（entry=${ENTRY_NAME}, 消息格式 array）`);

  // 等端口起来（NapCat 通常立即生效）
  const up = await waitPort(WS_HOST, WS_PORT, 8_000);
  console.log(up ? `端口 ${WS_PORT} 已可以连接 ✅` : `端口 ${WS_PORT} 暂未监听，重启 NapCat 后再试`);
  console.log('\n下一步：npm run probe:qq');
}

main().catch((error) => {
  console.error(`失败：${error?.message ?? error}`);
  console.error('如果提示登录失败：NapCat 首次启动后可能已经重置过 token，请到 NapCat 控制台/手机侧重新拿一次 token，或手动在 WebUI 里新建一个 WebSocket 服务端（127.0.0.1:3001）。');
  process.exit(1);
});
/** 轮询 TCP 端口是否已监听（WebSocket 端口用 HTTP 探测会误判） */
function waitPort(host, port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve) => {
    const attempt = () => {
      const socket = connect({ host, port });
      const done = (ok) => {
        socket.destroy();
        if (ok) resolve(true);
        else if (Date.now() > deadline) resolve(false);
        else setTimeout(attempt, 400);
      };
      socket.once('connect', () => done(true));
      socket.once('error', () => done(false));
    };
    attempt();
  });
}
