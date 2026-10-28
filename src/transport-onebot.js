/**
 * QQ 侧适配层：连接 NapCat（跑的是真 QQ NT 客户端）暴露的 OneBot 11 正向 WebSocket。
 *
 * 为什么是 NapCat：它把 NapCat 逻辑挂在官方 QQ NT 里跑，客户端与设备指纹是真的；
 * 纯协议实现（Lagrange / go-cqhttp）要么依赖第三方签名服务，要么协议已失效。
 *
 * 设计原则：**风控相关的行为策略全部放在传输层**，不散落在业务代码里。
 *  - 只被动响应：群里必须 @ 或前缀触发，不 @ 不说话；
 *  - 白名单：群要显式列进去，私聊要显式列进去，其余一律静默忽略；
 *  - 限流：每群/每人/全局三道滑动窗口，超限直接丢；
 *  - 拟人：每条回复前随机延迟 + 最小发送间隔 + 每分钟出站上限；
 *  - 熔断：连续发送失败或长时间连不上，停止发送/退出，绝不无限重试登录；
 *  - 审计：每条进来的触发和每条发出去的文本都落盘，出事能回看是哪句招的事；
 *  - 试运行：QQ_DRY_RUN=1 时完整跑流程但不真发，用来先观察它想回什么。
 */

import { appendFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, extname, isAbsolute, join } from 'node:path';
import WebSocket from 'ws';

const MAX_IMAGE_BASE64 = 6 * 1024 * 1024; // base64 长度上限（约 4.5MB 原图）
const ACTION_TIMEOUT_MS = 15_000;
const IMAGE_TIMEOUT_MS = 20_000;

/* ────────────────────────── 纯函数：可单测 ────────────────────────── */

/**
 * 三道滑动窗口限流。未来时间不回填，只按调用顺序裁剪。
 * @param {{perGroupMinute?: number, perUserHour?: number, globalMinute?: number, now?: () => number}} options
 */
export function createRateLimiter({
  perGroupMinute = 5,
  perUserHour = 20,
  globalMinute = 12,
  now = Date.now,
} = {}) {
  /** @type {Map<string, number[]>} */
  const groups = new Map();
  /** @type {Map<string, number[]>} */
  const users = new Map();
  /** @type {number[]} */
  const global = [];

  const prune = (hits, windowMs) => {
    const cut = now() - windowMs;
    let drop = 0;
    while (drop < hits.length && hits[drop] <= cut) drop += 1;
    if (drop > 0) hits.splice(0, drop);
    return hits;
  };

  const bucket = (map, key, windowMs) => {
    let hits = map.get(key);
    if (!hits) {
      hits = [];
      map.set(key, hits);
      // 防御内存增长：一个进程跑久了 key 会很多，简单粗暴地清空一次。
      if (map.size > 5_000) map.clear();
    }
    return prune(hits, windowMs);
  };

  return {
    /** @returns {{ok: boolean, reason?: string}} */
    check({ userId, groupId }) {
      const cutoff = now() - 60_000;
      while (global.length > 0 && global[0] <= cutoff) global.shift();

      if (globalMinute > 0 && global.length >= globalMinute) {
        return { ok: false, reason: `全局 ${globalMinute} 条/分钟 已达上限` };
      }
      if (userId && perUserHour > 0) {
        const hits = bucket(users, String(userId), 3_600_000);
        if (hits.length >= perUserHour) return { ok: false, reason: `该用户 ${perUserHour} 条/小时 已达上限` };
      }
      if (groupId && perGroupMinute > 0) {
        const hits = bucket(groups, String(groupId), 60_000);
        if (hits.length >= perGroupMinute) return { ok: false, reason: `该群 ${perGroupMinute} 条/分钟 已达上限` };
      }
      return { ok: true };
    },
    record({ userId, groupId }) {
      const at = now();
      global.push(at);
      if (userId) bucket(users, String(userId), 3_600_000).push(at);
      if (groupId) bucket(groups, String(groupId), 60_000).push(at);
    },
    stats() {
      return {
        globalLastMinute: global.length,
        groups: groups.size,
        users: users.size,
      };
    },
  };
}

/** 引用/回复段在文本里留的记号（模型看得懂，也方便测试断言）。 */
export const REPLY_MARKER = '（他引用了你上面那条）';

/** 把 OneBot 的 message（数组或 CQ 字符串）拍平成纯文本，并记下 @ 情况。 */
export function extractText(message, selfId) {
  if (typeof message === 'string') {
    const atSelf = /\[CQ:at,qq=([^,\]]+)/.exec(message)?.[1] === String(selfId);
    const atAll = /\[CQ:at,qq=all/.test(message);
    const text = message.replace(/\[CQ:[^\]]+\]/g, '').replace(/\s+/g, ' ').trim();
    return { text, atSelf, atAll };
  }
  if (!Array.isArray(message)) return { text: '', atSelf: false, atAll: false };

  const parts = [];
  let atSelf = false;
  let atAll = false;

  for (const segment of message) {
    if (!segment || typeof segment !== 'object') continue;
    const data = segment.data ?? {};
    switch (segment.type) {
      case 'text':
        if (typeof data.text === 'string') parts.push(data.text);
        break;
      case 'at': {
        const qq = String(data.qq ?? '');
        if (qq === String(selfId)) atSelf = true;
        else if (qq === 'all') atAll = true;
        else if (qq) parts.push(`@${data.name || qq} `);
        break;
      }
      // 引用/回复：以前直接丢掉，结果他「引用她的表情包说"这个呀"」，她只看到三个字，
      // 以为图没发出去。留个记号，她至少知道对方是在接她上面那句。
      case 'reply':
        parts.push(REPLY_MARKER);
        break;
      // 表情、回复引用、文件、语音之类不参与文本，避免把控制字符喂给模型。
      default:
        break;
    }
  }

  const text = parts.join('').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  return { text, atSelf, atAll };
}

/** 找到第一条图片，返回可下载的地址（NapCat 通常给 http 链接）。 */
export function findImage(message) {
  if (!Array.isArray(message)) return null;
  for (const segment of message) {
    if (segment?.type !== 'image') continue;
    const data = segment.data ?? {};
    const url = typeof data.url === 'string' && data.url ? data.url : null;
    const file = typeof data.file === 'string' && data.file ? data.file : null;
    if (url || file) return { url, file };
  }
  return null;
}

/**
 * OneBot 事件 -> bridge 认识的规范消息。返回 null 表示这条不该处理。
 * @param {any} event
 * @param {{selfId?: string, groupAllowList?: string[], groupPrefix?: string, groupNames?: Map<string,string>}} options
 */
export function normalizeEvent(
  event,
  { selfId, groupAllowList = [], groupPrefix = '', groupNames, setupMode = false } = {},
) {
  if (!event || typeof event !== 'object') return null;
  // 只认真实用户消息；message_sent 是机器人自己发的回声。
  if (event.post_type !== 'message') return null;

  const self = String(event.self_id ?? selfId ?? '');
  const userId = String(event.user_id ?? event.sender?.user_id ?? '');
  if (!userId) return null;
  if (self && userId === self) return null; // 防御：自己发的消息不回环

  const id = String(event.message_id ?? '');
  const senderName = event.sender?.card || event.sender?.nickname || userId;

  if (event.message_type === 'private') {
    // 群临时会话（sub_type=group）是陌生人通道，直接忽略。
    if (event.sub_type === 'group') return null;
    const { text } = extractText(event.message, self);
    const image = findImage(event.message);
    if (!text && !image) return null;
    return {
      type: image ? 'media' : 'text',
      id,
      text,
      senderId: userId,
      senderName,
      isSelf: false,
      conversationId: `private_${userId}`,
      image,
      receivedAt: event.time ? event.time * 1000 : Date.now(),
    };
  }

  if (event.message_type === 'group') {
    const groupId = String(event.group_id ?? '');
    if (!groupId) return null;
    // 配置向导模式下放行所有群，只为把群号记下来；正常模式严格按白名单。
    if (!setupMode && (groupAllowList.length === 0 || !groupAllowList.includes(groupId))) return null;

    const { text: flat, atSelf, atAll } = extractText(event.message, self);
    const prefix = (groupPrefix || '').trim();
    // 引用记号会排在正文前面，判断触发前缀时要先剔掉
    const flatForPrefix = flat.split(REPLY_MARKER).join('').trim();
    const hasPrefix = Boolean(prefix) && flatForPrefix.toLowerCase().startsWith(prefix.toLowerCase());
    // 配置向导模式不要求触发，只要能记下群号；正常模式必须 @ 或前缀。
    if (!atSelf && !hasPrefix && !setupMode) return null;

    const text = hasPrefix ? flat.slice(prefix.length).trim() : flat;
    const image = findImage(event.message);
    if (!text && !image) return null;

    return {
      type: image ? 'media' : 'text',
      id,
      text,
      senderId: userId,
      senderName,
      isSelf: false,
      groupId,
      roomName: groupNames?.get(groupId) ?? null,
      conversationId: `group_${groupId}`,
      image,
      receivedAt: event.time ? event.time * 1000 : Date.now(),
    };
  }

  return null;
}

/* ────────────────────────── 侧效工具 ────────────────────────── */

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randInt(min, max) {
  const lo = Math.max(0, Math.min(min, max));
  const hi = Math.max(lo, max);
  return lo + Math.floor(Math.random() * (hi - lo + 1));
}

function createAudit({ file, log }) {
  let chain = Promise.resolve();
  const write = (entry) => {
    chain = chain
      .then(async () => {
        await mkdir(dirname(file), { recursive: true });
        await appendFile(file, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`, 'utf8');
      })
      .catch((error) => log.warn(`审计日志写入失败：${error?.message ?? error}`));
    return chain;
  };
  const preview = (text) => String(text ?? '').replace(/\s+/g, ' ').slice(0, 120);
  return {
    inbound: (msg) =>
      write({
        dir: 'in',
        type: msg.type,
        conversationId: msg.conversationId,
        senderId: msg.senderId,
        senderName: msg.senderName,
        preview: preview(msg.text),
        chars: (msg.text || '').length,
      }),
    outbound: (msg, text, extra = {}) =>
      write({
        dir: 'out',
        conversationId: msg.conversationId,
        senderId: msg.senderId,
        preview: preview(text),
        chars: text.length,
        ...extra,
      }),
    drop: (msg, reason) =>
      write({ dir: 'drop', conversationId: msg.conversationId, senderId: msg.senderId, reason }),
  };
}

/* ────────────────────────── 主流程 ────────────────────────── */

/**
 * @param {{
 *   config: any,
 *   log: any,
 *   onMessage: (msg: any) => Promise<void> | void,
 * }} options
 */
export async function startOneBot({ config, log, onMessage }) {
  const audit = createAudit({ file: config.auditFile, log });
  const limiter = createRateLimiter({
    perGroupMinute: config.ratePerGroupMin,
    perUserHour: config.ratePerUserHour,
    globalMinute: config.rateGlobalMin,
  });

  const groupNames = new Map();
  /** @type {WebSocket | null} */
  let socket = null;
  let closed = false;
  let reconnectAttempts = 0;
  let reconnectTimer = null;
  /** @type {Map<string, {resolve: Function, reject: Function, timer: any, action: string}>} */
  const pending = new Map();
  let seq = 0;

  const state = {
    connected: false,
    selfId: null,
    selfName: '',
    inbound: 0,
    outbound: 0,
    dropped: 0,
    lastBeatAt: 0,
  };

  const breaker = { open: false, fails: 0 };

  /** 出站节流：保底间隔 + 每分钟硬上限 */
  const outHits = [];
  let lastSendAt = 0;

  let resolveReady;
  const ready = new Promise((resolve) => {
    resolveReady = resolve;
  });

  function failAllPending(error) {
    for (const [, entry] of pending) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    pending.clear();
  }

  /** 调用 OneBot 动作，等 echo 回包。 */
  function call(action, params = {}) {
    return new Promise((resolve, reject) => {
      if (!socket || socket.readyState !== WebSocket.OPEN) {
        reject(new Error('未连接到 OneBot 网关'));
        return;
      }
      const echo = `dsh-${++seq}`;
      const timer = setTimeout(() => {
        pending.delete(echo);
        reject(new Error(`OneBot 动作超时：${action}`));
      }, ACTION_TIMEOUT_MS);
      timer.unref?.();
      pending.set(echo, { resolve, reject, timer, action });
      socket.send(JSON.stringify({ action, params, echo }), (error) => {
        if (!error) return;
        pending.delete(echo);
        clearTimeout(timer);
        reject(error);
      });
    });
  }

  async function downloadImage(msg) {
    const image = msg.image;
    if (!image) return null;
    const dir = join(config.dataDir, 'inbox');
    const stamp = new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0, 14);
    const tail = (msg.id || 'img').replace(/[^A-Za-z0-9]/g, '').slice(-8) || 'img';

    try {
      let data = null;
      let ext = null;

      if (image.file && isAbsolute(image.file)) {
        // NapCat 开了本地文件直链时会直接给绝对路径。
        const info = await stat(image.file).catch(() => null);
        if (info && info.size > 0 && info.size <= config.maxMediaBytes) {
          data = await readFile(image.file);
          ext = extname(image.file).replace('.', '') || 'jpg';
        }
      }

      if (!data && image.url && /^https?:\/\//i.test(image.url)) {
        const response = await fetch(image.url, { signal: AbortSignal.timeout(IMAGE_TIMEOUT_MS) });
        if (response.ok) {
          const buffer = Buffer.from(await response.arrayBuffer());
          if (buffer.length > 0 && buffer.length <= config.maxMediaBytes) data = buffer;
          ext = sniffExt(buffer) ?? 'jpg';
        }
      }

      if (!data) {
        log.warn('图片下载失败，按纯文本处理');
        return null;
      }

      await mkdir(dir, { recursive: true });
      const path = join(dir, `${stamp}-${tail}.${ext}`);
      await writeFile(path, data);
      log.info(`收到 QQ 图片：${path}（${Math.round(data.length / 1024)}KB）`);
      return { kind: 'image', path, fileName: null };
    } catch (error) {
      log.warn(`图片处理失败：${error?.message ?? error}`);
      return null;
    }
  }

  function sniffExt(buffer) {
    if (!buffer || buffer.length < 4) return null;
    if (buffer[0] === 0xff && buffer[1] === 0xd8) return 'jpg';
    if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
    if (buffer.subarray(0, 4).toString() === 'RIFF' && buffer.subarray(8, 12).toString() === 'WEBP') return 'webp';
    if (buffer.subarray(0, 3).toString() === 'GIF') return 'gif';
    return null;
  }

  /** 出站节流：保证「不像机器」的发送节奏，并在超频时等待而不是丢弃。 */
  async function throttleOutbound() {
    const minGap = Math.max(250, config.replyDelayMinMs);
    const wait = Math.max(0, lastSendAt + minGap - Date.now());
    if (wait > 0) await sleep(wait);

    const now = Date.now();
    while (outHits.length > 0 && outHits[0] <= now - 60_000) outHits.shift();
    if (config.rateOutMin > 0 && outHits.length >= config.rateOutMin) {
      const waitMs = outHits[0] + 60_000 - now + 50;
      log.warn(`出站频率达上限（${config.rateOutMin}/分钟），等待 ${Math.round(waitMs / 1000)}s`);
      await sleep(waitMs);
      while (outHits.length > 0 && outHits[0] <= Date.now() - 60_000) outHits.shift();
    }

    // 拟人延迟：机器人不会 0.1 秒就回一屏字。
    await sleep(randInt(config.replyDelayMinMs, config.replyDelayMaxMs));
    lastSendAt = Date.now();
    outHits.push(lastSendAt);
  }

  async function reply(msg, text) {
    const body = String(text ?? '').trim();
    if (!body) return;

    if (breaker.open) {
      log.warn('熔断中，放弃发送（检查 NapCat 是否被风控/掉线）');
      return;
    }

    await throttleOutbound();

    if (config.dryRun) {
      log.info(`[DRY-RUN] 本应发送到 ${msg.conversationId}：${body.slice(0, 80).replace(/\n/g, ' ')}`);
      await audit.outbound(msg, body, { dryRun: true });
      return;
    }

    const params = msg.groupId
      ? { group_id: Number(msg.groupId), message: body, auto_escape: false }
      : { user_id: Number(msg.senderId), message: body, auto_escape: false };
    const action = msg.groupId ? 'send_group_msg' : 'send_private_msg';

    try {
      const response = await call(action, params);
      const retcode = response?.retcode;
      if (retcode !== 0 && retcode !== undefined) {
        throw new Error(`retcode=${retcode} ${response?.message ?? response?.wording ?? ''}`);
      }
      state.outbound += 1;
      breaker.fails = 0;
      await audit.outbound(msg, body);
      log.info(`已回复 ${msg.conversationId}（${body.length} 字）`);
    } catch (error) {
      breaker.fails += 1;
      log.error(`发送失败（连续第 ${breaker.fails} 次）：${error?.message ?? error}`);
      await audit.outbound(msg, body, { error: String(error?.message ?? error) });
      if (breaker.fails >= config.sendFailBreaker) {
        breaker.open = true;
        log.error(
          `【熔断】连续 ${breaker.fails} 次发送失败，已停止发送。` +
            '通常是掉线、被禁言或账号被限制；请人工检查 NapCat 面板，不要盲目重启登录。',
        );
      }
      throw error;
    }
  }

  /**
   * 发一张本地图片（表情包）。
   * 走和 reply 同一套节流/熔断/审计，避免表情包绕过风控保护。
   */
  async function sendImage(msg, filePath) {
    if (!filePath) return;
    if (breaker.open) {
      log.warn('熔断中，放弃发表情包');
      return;
    }

    await throttleOutbound();

    if (config.dryRun) {
      log.info(`[DRY-RUN] 本应发图到 ${msg.conversationId}：${filePath}`);
      return;
    }

    // SnowLuma 跑在 Docker 里，看不到宿主机路径，只能用 base64 塞进去
    let base64;
    try {
      base64 = (await readFile(filePath)).toString('base64');
    } catch (error) {
      log.warn(`读取表情包失败 ${filePath}：${error?.message ?? error}`);
      return;
    }
    if (base64.length > MAX_IMAGE_BASE64) {
      log.warn(`表情包太大（${Math.round(base64.length / 1024)}KB），跳过`);
      return;
    }
    const content = [{ type: 'image', data: { file: `base64://${base64}` } }];
    const params = msg.groupId
      ? { group_id: Number(msg.groupId), message: content }
      : { user_id: Number(msg.senderId), message: content };
    const action = msg.groupId ? 'send_group_msg' : 'send_private_msg';

    try {
      const response = await call(action, params);
      const retcode = response?.retcode;
      if (retcode !== 0 && retcode !== undefined) {
        throw new Error(`retcode=${retcode} ${response?.message ?? response?.wording ?? ''}`);
      }
      state.outbound += 1;
      breaker.fails = 0;
      await audit.outbound(msg, `[表情包] ${filePath}`, { kind: 'sticker' });
      log.info(`已发表情包 ${msg.conversationId}`);
    } catch (error) {
      breaker.fails += 1;
      log.warn(`表情包发送失败：${error?.message ?? error}`);
    }
  }

  /**
   * 发一条语音。buffer 必须是 SILK（由 src/voice-out.js 合成）。
   * 走和文字同一套节流/熔断/审计 —— 语音更显眼，更不能绕过风控保护。
   */
  async function sendVoice(msg, buffer, meta = {}) {
    if (!buffer || buffer.length === 0) return;
    if (breaker.open) {
      log.warn('熔断中，放弃发语音');
      return;
    }

    await throttleOutbound();

    if (config.dryRun) {
      log.info(`[DRY-RUN] 本应发语音到 ${msg.conversationId}：${(meta.text ?? '').slice(0, 40)}`);
      return;
    }

    const content = [{ type: 'record', data: { file: `base64://${buffer.toString('base64')}` } }];
    const params = msg.groupId
      ? { group_id: Number(msg.groupId), message: content }
      : { user_id: Number(msg.senderId), message: content };
    const action = msg.groupId ? 'send_group_msg' : 'send_private_msg';

    try {
      const response = await call(action, params);
      const retcode = response?.retcode;
      if (retcode !== 0 && retcode !== undefined) {
        throw new Error(`retcode=${retcode} ${response?.message ?? response?.wording ?? ''}`);
      }
      state.outbound += 1;
      breaker.fails = 0;
      await audit.outbound(msg, `[语音] ${meta.text ?? ''}`, {
        kind: 'voice',
        durationMs: meta.durationMs ?? null,
      });
      log.info(`已发语音 ${msg.conversationId}（${Math.round((meta.durationMs ?? 0) / 1000)}s）`);
    } catch (error) {
      breaker.fails += 1;
      log.error(`语音发送失败（连续第 ${breaker.fails} 次）：${error?.message ?? error}`);
      await audit.outbound(msg, `[语音] ${meta.text ?? ''}`, { kind: 'voice', error: String(error?.message ?? error) });
      if (breaker.fails >= config.sendFailBreaker) {
        breaker.open = true;
        log.error(`【熔断】连续 ${breaker.fails} 次发送失败，已停止发送。请人工检查账号状态。`);
      }
      throw error;
    }
  }

  async function handleEvent(event) {
    if (event.post_type === 'meta_event') {
      if (event.meta_event_type === 'heartbeat') state.lastBeatAt = Date.now();
      return;
    }
    if (event.post_type === 'notice') {
      log.info(`通知：${event.notice_type ?? '?'}${event.sub_type ? `/${event.sub_type}` : ''}`);
      return;
    }

    const msg = normalizeEvent(event, {
      selfId: state.selfId,
      groupAllowList: config.groupAllowList,
      groupPrefix: config.groupPrefix,
      groupNames,
      setupMode: config.setupMode,
    });
    if (!msg) return; // 非触发消息：静默忽略，绝不回「请 @我」这类话

    // 配置向导：只打印需要的 ID，不回复、不消耗模型。填好 .env.qq 后关掉这个模式。
    if (config.setupMode) {
      if (msg.groupId) {
        log.warn(`[配置向导] 看到群消息：group=${msg.groupId}（未在白名单，不回复）`);
      } else {
        log.warn(
          `[配置向导] 收到私聊：SETUP_DETECTED=${msg.senderId} ` +
            `把他填进 .env.qq 的 QQ_ALLOW_LIST 即可（这条不回复）`,
        );
      }
      return;
    }

    // 双重防御：私聊白名单在传输层也拦一次，陌生人的消息连审计都不留正文。
    if (!msg.groupId && !config.allowList.includes(msg.senderId)) {
      state.dropped += 1;
      log.debug(`忽略白名单外的私聊 ${msg.senderId}`);
      return;
    }

    const verdict = limiter.check({ userId: msg.senderId, groupId: msg.groupId });
    if (!verdict.ok) {
      state.dropped += 1;
      log.warn(`限流丢弃 ${msg.conversationId}：${verdict.reason}`);
      void audit.drop(msg, verdict.reason);
      return;
    }
    limiter.record({ userId: msg.senderId, groupId: msg.groupId });

    state.inbound += 1;
    void audit.inbound(msg);

    if (msg.type === 'media') {
      const saved = await downloadImage(msg);
      if (!saved) {
        if (!msg.text) return;
        msg.type = 'text';
      } else {
        Object.assign(msg, saved);
      }
    }

    log.info(`收到 ${msg.conversationId} ${msg.senderName}：${(msg.text || `[${msg.kind}]`).slice(0, 40)}`);
    await onMessage(msg);
  }

  function scheduleReconnect(reason) {
    if (closed) return;
    if (reconnectTimer) return;

    if (reconnectAttempts >= config.maxReconnect) {
      log.error(
        `【停止重试】NapCat 连续 ${reconnectAttempts} 次连接失败（${reason}）。` +
          '多半是 QQ 掉线或账号被限制：请到 NapCat 面板人工检查，确认没问题后再启动桥接。',
      );
      // 退出让守护脚本/用户看到，而不是无限重试一个可能已被风控的号。
      setTimeout(() => process.exit(1), 300);
      return;
    }

    reconnectAttempts += 1;
    const delay = Math.min(60_000, 3_000 * 2 ** (reconnectAttempts - 1));
    log.warn(`连接断开（${reason}），${Math.round(delay / 1000)}s 后第 ${reconnectAttempts} 次重连`);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      void connect();
    }, delay);
    reconnectTimer.unref?.();
  }

  async function connect() {
    if (closed) return;

    const headers = config.wsToken ? { Authorization: `Bearer ${config.wsToken}` } : {};
    log.info(`连接 OneBot 网关：${config.wsUrl}${config.wsToken ? '（已带 token）' : '（无 token，仅限本机）'}`);

    const ws = new WebSocket(config.wsUrl, { headers, handshakeTimeout: 10_000 });
    socket = ws;

    ws.on('open', () => {
      void (async () => {
        try {
          state.connected = true;
          reconnectAttempts = 0;
          log.info('已连上网关');

          const info = await call('get_login_info');
          state.selfId = String(info?.data?.user_id ?? '');
          state.selfName = info?.data?.nickname ?? '';
          log.info(`当前登录：${state.selfName}（${state.selfId}）`);

          if (config.selfId && String(config.selfId) !== state.selfId) {
            log.error(
              `【注意】NapCat 登录的是 ${state.selfId}，但配置里写的是 ${config.selfId}。` +
                '确认不是主号再继续。',
            );
          }

          try {
            const groups = await call('get_group_list');
            for (const group of groups?.data ?? []) {
              groupNames.set(String(group.group_id), group.group_name ?? '');
            }
            const allowed = config.groupAllowList.filter((id) => groupNames.has(id));
            log.info(`群列表：${groupNames.size} 个；白名单命中 ${allowed.length}/${config.groupAllowList.length}`);
            const missing = config.groupAllowList.filter((id) => !groupNames.has(id));
            if (missing.length > 0) log.warn(`白名单里这些群号不在该账号的群列表里：${missing.join(', ')}`);
          } catch (error) {
            log.warn(`读取群列表失败（不影响收发）：${error?.message ?? error}`);
          }

          resolveReady?.();
        } catch (error) {
          log.error(`握手失败：${error?.message ?? error}`);
        }
      })();
    });

    ws.on('message', (raw) => {
      let data;
      try {
        data = JSON.parse(raw.toString('utf8'));
      } catch {
        log.warn('收到无法解析的 NapCat 数据帧，已忽略');
        return;
      }

      if (data?.echo) {
        const entry = pending.get(data.echo);
        if (!entry) return;
        pending.delete(data.echo);
        clearTimeout(entry.timer);
        // OneBot 11：status=ok 或 retcode=0 都算成功；失败时 reject 让调用方熔断。
        if (data.status === 'failed' || (typeof data.retcode === 'number' && data.retcode !== 0)) {
          entry.reject(new Error(`${entry.action} 失败：retcode=${data.retcode} ${data.message ?? data.wording ?? ''}`));
        } else {
          entry.resolve(data);
        }
        return;
      }

      void (async () => {
        try {
          await handleEvent(data);
        } catch (error) {
          log.error(`处理事件异常：${error?.stack ?? error}`);
        }
      })();
    });

    ws.on('close', (code, reasonBuf) => {
      state.connected = false;
      if (socket === ws) socket = null;
      const reason = `close ${code} ${reasonBuf?.toString?.() ?? ''}`.trim();
      failAllPending(new Error('连接已断开'));
      scheduleReconnect(reason);
    });

    ws.on('error', (error) => {
      log.warn(`NapCat 连接错误：${error?.message ?? error}`);
    });
  }

  await connect();

  return {
    ready,
    reply,
    sendImage,
    sendVoice,
    async typing() {
      /* OneBot 11 没有「正在输入」这类接口，留空即可 */
    },
    stats() {
      return {
        ...state,
        breakerOpen: breaker.open,
        breakerFails: breaker.fails,
        rate: limiter.stats(),
        pending: pending.size,
      };
    },
    /** 探针：连上并读出登录号/群列表，然后断开。 */
    async probe() {
      const info = await call('get_login_info').catch(() => null);
      const groups = await call('get_group_list').catch(() => null);
      return {
        selfId: String(info?.data?.user_id ?? ''),
        nickname: info?.data?.nickname ?? '',
        groups: (groups?.data ?? []).map((g) => ({ id: String(g.group_id), name: g.group_name ?? '' })),
      };
    },
    async stop() {
      closed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      failAllPending(new Error('桥接已停止'));
      try {
        socket?.close();
      } catch {
        /* 已经关了 */
      }
      log.info('已停止 QQ 连接');
    },
  };
}

/** 供测试/诊断复用：把一段文本按 QQ 的单条上限切开（沿用 bridge 的切分器即可）。 */
export { ACTION_TIMEOUT_MS };