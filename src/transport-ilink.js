/**
 * 微信侧适配层：腾讯 iLink 机器人通道（官方接口，不是协议逆向）。
 *
 * 为什么是 iLink：个人微信的 Web 协议 2017 年后基本封死；PadLocal（iPad 协议）
 * 官方站点已下线、Wechaty 停在 2022 年的 1.20.2；Windows 注入方案（WeChatFerry
 * 等）又跑不了 macOS。iLink 是腾讯自带的机器人通道，扫码即登录，跨平台。
 *
 * 能力边界（由微信侧决定，不是桥接层的限制）：
 *  - 只能 1:1 私聊，不能进群；
 *  - 机器人主动发消息有 24 小时会话窗口，但「收到消息 → 立即回复」不受影响；
 *  - 可能需要账号在灰度范围内（微信版本不够会登录失败）。
 */

import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import qrcodeTerminal from 'qrcode-terminal';
import { MessageItemType, MessageType, WeChatClient } from 'wechat-ilink-client';

const ACCOUNT_FILE = 'account.json';
const SYNC_FILE = 'sync.json';

/**
 * @param {{
 *   config: any,
 *   log: any,
 *   onMessage: (msg: any) => Promise<void> | void,
 * }} options
 */
export async function startIlink({ config, log, onMessage }) {
  const dir = join(config.dataDir, 'ilink');
  const accountFile = join(dir, ACCOUNT_FILE);
  const syncFile = join(dir, SYNC_FILE);
  await mkdir(dir, { recursive: true });

  const client = await openClient({ accountFile, config, log });

  client.on('message', (raw) => {
    void (async () => {
      try {
        const msg = await normalize(raw, { client, config, log });
        if (msg) await onMessage(msg);
      } catch (error) {
        log.error(`消息解析异常：${error?.stack ?? error}`);
      }
    })();
  });

  client.on('error', (error) => {
    log.error(`iLink 轮询错误：${error?.message ?? error}`);
  });

  client.on('sessionExpired', () => {
    log.warn('iLink 会话过期，删除本地凭据并退出，等待重启后重新扫码');
    void rm(accountFile, { force: true }).finally(() => setTimeout(() => process.exit(1), 500));
  });

  let lastSequence = 0;
  let lastBeat = 0;
  client.on('poll', (resp) => {
    const now = Date.now();
    // 心跳：每 10 分钟一条，方便从日志判断「在线」还是「Mac 睡了」
    if (now - lastBeat > 10 * 60 * 1000) {
      lastBeat = now;
      log.info('长轮询在线（心跳）');
    }
    const count = resp?.msgs?.length ?? 0;
    if (count > 0) log.debug(`收到 ${count} 条更新`);
    lastSequence += count;
  });

  log.info('启动 iLink 长轮询');

  // start() 会一直阻塞到 stop()，所以不 await，让调用方先拿到 reply 句柄。
  void client
    .start({
      longPollTimeoutMs: config.longPollTimeoutMs,
      loadSyncBuf: async () => (await readJson(syncFile))?.buf,
      saveSyncBuf: async (buf) => {
        await writeJson(syncFile, { buf, at: new Date().toISOString() });
      },
    })
    .catch((error) => {
      log.error(`iLink 长轮询退出：${error?.stack ?? error}`);
      setTimeout(() => process.exit(1), 500);
    });

  return {
    /** @param {{senderId: string}} target @param {string} text */
    async reply({ senderId }, text) {
      await client.sendText(senderId, text);
    },
    async typing(senderId) {
      const ticket = await client.getTypingTicket(senderId);
      await client.sendTyping(senderId, ticket, 'typing');
    },
    stats() {
      return { messages: lastSequence, accountId: client.getAccountId() };
    },
    async stop() {
      log.info('停止 iLink 长轮询');
      try {
        client.stop();
      } catch {
        /* 已经停了 */
      }
    },
  };
}

async function openClient({ accountFile, config, log }) {
  const saved = await readJson(accountFile);

  if (saved?.accountId && saved?.botToken && saved?.baseUrl) {
    log.info(`复用已保存的 iLink 登录：accountId=${saved.accountId}`);
    return new WeChatClient({
      accountId: saved.accountId,
      token: saved.botToken,
      baseUrl: saved.baseUrl,
    });
  }

  const client = new WeChatClient();
  const result = await client.login({
    timeoutMs: config.qrTimeoutMs,
    onQRCode: async (url) => {
      log.info('请用微信扫下方二维码，把机器人通道绑到你的账号');
      qrcodeTerminal.generate(url, { small: true });
      log.info(`二维码内容（二维码渲染失败时可用微信打开）：${url}`);
      // 后台运行（launchd / nohup）时终端二维码看不到，落一份图片和文本更实用。
      await persistQr(url, config.dataDir, log);
    },
    onStatus: (status) => log.info(`扫码状态：${status}`),
  });

  if (!result.connected) {
    throw new Error(`iLink 登录失败：${result.message}`);
  }

  await writeJson(
    accountFile,
    {
      accountId: result.accountId,
      botToken: result.botToken,
      baseUrl: result.baseUrl,
      userId: result.userId,
      savedAt: new Date().toISOString(),
    },
    0o600,
  );
  log.info(`iLink 登录成功：accountId=${result.accountId}`);
  return client;
}

const MEDIA_TYPES = new Set([
  MessageItemType.IMAGE,
  MessageItemType.FILE,
  MessageItemType.VIDEO,
  MessageItemType.VOICE,
]);

async function normalize(raw, { client, config, log }) {
  // 只处理对方发来的消息；message_type=2 是自己（机器人）发出的回声。
  if (raw?.message_type !== MessageType.USER) return null;

  const senderId = raw.from_user_id;
  if (!senderId) return null;

  const id = String(raw.message_id ?? raw.client_id ?? raw.seq ?? '');
  const text = (WeChatClient.extractText(raw) ?? '').trim();
  const items = raw.item_list ?? [];
  const mediaItem = items.find((item) => MEDIA_TYPES.has(item?.type));

  if (!mediaItem) {
    if (!text) return null;
    return { type: 'text', id, text, senderId, senderName: senderId, isSelf: false, receivedAt: raw.create_time_ms };
  }

  const saved = await saveMedia(client, mediaItem, { config, id, log });
  if (!saved) return null;

  return {
    type: 'media',
    id,
    text,
    senderId,
    senderName: senderId,
    isSelf: false,
    receivedAt: raw.create_time_ms,
    ...saved,
  };
}

async function saveMedia(client, item, { config, id, log }) {
  let downloaded;
  try {
    downloaded = await client.downloadMedia(item);
  } catch (error) {
    log.warn(`媒体下载失败：${error?.message ?? error}`);
    return null;
  }

  if (!downloaded?.data?.length) {
    log.warn('媒体下载结果为空，已忽略');
    return null;
  }
  if (downloaded.data.length > config.maxMediaBytes) {
    log.warn(`媒体过大（${Math.round(downloaded.data.length / 1024 / 1024)}MB），已忽略`);
    return null;
  }

  const ext = sniffExt(downloaded.data) ?? extFromName(downloaded.fileName) ?? kindExt(downloaded.kind);
  const dir = join(config.dataDir, 'inbox');
  await mkdir(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0, 14);
  const tail = (id || 'media').replace(/[^A-Za-z0-9]/g, '').slice(-8) || 'media';
  const path = join(dir, `${stamp}-${tail}.${ext}`);
  await writeFile(path, downloaded.data);

  log.info(`收到${downloaded.kind === 'image' ? '图片' : downloaded.kind}：${path}（${Math.round(downloaded.data.length / 1024)}KB）`);
  return { kind: downloaded.kind, path, fileName: downloaded.fileName ?? null };
}

function sniffExt(buf) {
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8) return 'jpg';
  if (buf.length > 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (buf.length > 12 && buf.subarray(0, 4).toString() === 'RIFF' && buf.subarray(8, 12).toString() === 'WEBP') return 'webp';
  if (buf.length > 4 && buf.subarray(0, 3).toString() === 'GIF') return 'gif';
  return null;
}

function extFromName(name) {
  const match = /^.+?\.([A-Za-z0-9]{2,5})$/.exec(name ?? '');
  return match ? match[1].toLowerCase() : null;
}

function kindExt(kind) {
  if (kind === 'image') return 'jpg';
  if (kind === 'video') return 'mp4';
  if (kind === 'voice') return 'silk';
  return 'bin';
}

async function persistQr(url, dataDir, log) {
  try {
    const dir = join(dataDir, 'ilink');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'qr-url.txt'), `${url}\n`, 'utf8');
    const mod = await import('qrcode');
    const QRCode = mod.default ?? mod;
    const png = await QRCode.toBuffer(url, { type: 'png', width: 720, margin: 2, errorCorrectionLevel: 'M' });
    await writeFile(join(dataDir, 'login-qr.png'), png);
    log.info(`二维码图片：${join(dataDir, 'login-qr.png')}`);
  } catch (error) {
    log.warn(`二维码落盘失败（不影响登录）：${error?.message ?? error}`);
  }
}

async function readJson(file) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return null;
  }
}

async function writeJson(file, value, mode) {
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode });
  if (mode) await chmod(file, mode).catch(() => {});
}
