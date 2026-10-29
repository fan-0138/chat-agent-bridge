/**
 * 桥接核心：与微信 SDK 解耦，方便单测。
 * 输入是规范化后的消息对象，输出通过注入的 reply(s) 发回微信。
 */

import { DshError } from './dsh.js';
import { isTaskMessage } from './classify.js';
import { polish } from './decor.js';
import { buildPrompt, notesFrom } from './prompt.js';
import { splitBubbles, splitReply } from './split.js';
import { parseVoiceSegments } from './voice-out.js';
import { looksLikeThinking, stripThinking, looksLikeSelfTalk, stripSelfTalk } from './thinking-guard.js';


/**
 * @param {{
 *   config: any,
 *   runner: {run: (prompt: string, opts?: any) => Promise<{text: string, durationMs: number}>},
 *   memory: {load: Function, append: Function, clear: Function},
 *   queue: import('./queue.js').KeyedQueue,
 *   log: any,
 *   reply: (msg: any, text: string) => Promise<void>,
 *   typing?: (senderId: string) => Promise<void>,
 *   onActivity?: (state: string) => void,
 *   life?: {promptSection: () => Promise<string>},
 *   sticker?: {pick: () => Promise<string|null>},
 *   sendSticker?: (msg: any, file: string) => Promise<void>,
 * }} deps
 */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function createBridge({ config, runner, chatRunner, memory, queue, log, reply, typing, persona, voice, slang, vision, onActivity, life, sticker, sendSticker, voiceOut, sendVoice }) {
  const seen = new Set();
  const unknownNotified = new Map();

  const isAllowed = (msg) => {
    if (config.allowUnknown) return true;
    return config.allowList.some((entry) => entry === msg.senderId || entry === msg.senderName);
  };

  const memoryKey = (msg) => `user_${msg.conversationId || msg.senderId}`;

  async function handle(msg) {
    if (!msg || (msg.type !== 'text' && msg.type !== 'media')) return;
    if (msg.isSelf) return; // 防御：传输层已过滤机器人自己的消息
    if (msg.id && seen.has(msg.id)) return;
    if (msg.id) remember(msg.id);

    if (!isAllowed(msg)) {
      log.warn(`忽略未授权消息 sender=${msg.senderName}(${msg.senderId})`);
      onActivity?.('ignored-unknown');
      if (config.allowUnknown) {
        const now = Date.now();
        const last = unknownNotified.get(msg.senderId) ?? 0;
        if (now - last > 30_000) {
          unknownNotified.set(msg.senderId, now);
          await safeReply(
            msg,
            `你的标识：${msg.senderId}\n把它加进 .env 的 ${config.allowListHint || 'WECHAT_ALLOW_LIST'} 后重启桥接即可正常对话。`,
          );
        }
      }
      return;
    }

    const raw = (msg.text || '').trim();
    if (!raw && msg.type === 'text') return;
    const limit = config.maxInputChars;
    const text =
      limit > 0 && raw.length > limit
        ? `${raw.slice(0, limit)}\n\n…（消息过长，已截断到 ${limit} 字）`
        : raw;
    if (text !== raw) log.warn(`输入过长已截断 sender=${msg.senderId} ${raw.length} -> ${limit}`);

    const key = memoryKey(msg);
    const stats = queue.stats();
    const queuedAhead = stats.waiting > 0 || stats.active > 0;

    try {
      const result = await queue.push(key, () => runTurn(msg, key, text, queuedAhead));
      if (result?.output) await deliver(msg, result.output, { turnMs: result.turnMs });
    } catch (error) {
      const detail = error?.stderr ? `\n${error.stderr}` : '';
      log.error(`处理失败 ${key}: ${error?.message ?? error}${detail}`);
      onActivity?.('error');
      const message =
        error instanceof DshError && error.timedOut
          ? '这个卡住了，人家等下再弄。'
          : '没弄成，等会儿再试试。';
      await safeReply(msg, message);
    }
  }

  async function runTurn(msg, key, text, queuedAhead) {
    // 主人这句话要是在纠正她怎么说话，先记进她自己的笔记本 —— 这一条回复就得照做
    if (voice && msg.type === 'text' && !msg.roomName && isAllowed(msg)) {
      const learned = await voice.capture(text).catch((error) => {
        log.warn(`记说话方式失败：${error?.message ?? error}`);
        return null;
      });
      if (learned?.added) log.info(`学到说话方式（${learned.kind}）：${learned.value}`);
    }

    const history = await memory.load(key);
    // 她自己主动发的（「刚刷到…」）单独摘出来：一天十来条，全塞进历史会把他刚说的话挤出去
    const notes = notesFrom(history);
    const dialogue = history.filter((entry) => entry.kind !== 'proactive');
    const personaText = persona ? await persona() : '';
    const voiceText = voice ? (await voice.load()).text : '';
    const slangText = slang ? (await slang.load()).text : '';

    let attachment;
    if (msg.type === 'media') {
      const canSee = Boolean(vision?.available) && (msg.kind === 'image' || msg.kind === 'video');
      const evidence = canSee ? await vision.analyze(msg.path) : null;
      attachment = {
        kind: msg.kind,
        path: msg.path,
        evidence,
        reason: canSee ? null : (vision?.reason ?? '该类型暂不支持视觉识别'),
      };
    }

    const lifeText = life ? await life.promptSection().catch(() => '') : '';

    const prompt = buildPrompt({
      persona: personaText,
      voice: voiceText,
      slang: slangText,
      history: dialogue,
      notes,
      text,
      senderName: msg.senderName || '用户',
      roomName: msg.roomName,
      channel: config.channel || 'wechat',
      attachment,
      life: lifeText,
    });

    // 只有「真要动手」的消息才先说一句，纯聊天别多这一句（模型本来 3-20 秒就回）
    const ack = createAck(msg, queuedAhead, isTaskMessage(text) || msg.type === 'media');
    if (config.typing && typing) {
      void typing(msg.senderId).catch(() => {});
    }

    try {
      // 聊天给短超时，明确让干活才用长超时
      const active = isTaskMessage(text) || msg.type === 'media' ? runner : (chatRunner ?? runner);
      const { text: raw, durationMs } = await active.run(prompt);
      await ack.cancel();

      // 偶发：模型把「心里话」当正文发出来（列候选、报刻度、自我指挥）。
      // 这种绝不能发给人看，先抢救，救不回来就让它重说一遍。
      let answer = raw;
      if (looksLikeThinking(answer)) {
        log.warn(`回复混进了思考过程（${answer.length} 字），先抢救`);
        const rescued = stripThinking(answer);
        if (rescued) {
          answer = rescued;
          log.info(`从思考里捞出正文：${rescued.slice(0, 40)}`);
        } else {
          try {
            const retry = await active.run(
              `${prompt}\n\n[纠正] 你上一条把思考过程当正文发出来了（比如「要接」「刻度」「收住」这类自我指挥的话）。` +
                '现在只输出要发给他的那一两句原话：不要引号列候选，不要解释，不要复述要求。',
            );
            answer = looksLikeThinking(retry.text) ? stripThinking(retry.text) || '' : retry.text;
            log.info(`让它重说了一遍：${answer.length} 字`);
          } catch (error) {
            log.warn(`重说失败：${error?.message ?? error}`);
          }
          if (!answer) answer = '刚才脑子跑偏了，你再说一遍。';
        }
      }

      // 另一种漏：他手滑打错字/话说半截，模型把「我在判断他这话什么意思」的独白当正文。
      // 2026-10-28 实录：他打成「我去找过你」，她回「我去找过你——这话有点不一样…我先问一句：找哪儿去了？」
      if (looksLikeSelfTalk(answer, text)) {
        log.warn(`回复混进了判断他那句话的独白：${answer.slice(0, 40)}`);
        const cleaned = stripSelfTalk(answer);
        if (cleaned) {
          answer = cleaned;
          log.info(`剥掉独白，留下正文：${cleaned.slice(0, 40)}`);
        } else {
          try {
            const retry = await active.run(
              `${prompt}\n\n[纠正] 你上一条把「我怎么理解他这句话」的分析写进正文了（比如「这句听着不太像平常的聊天」「我先问一句」）。` +
                '爸爸打字常打错、说话常半截：看到怪话就按最顺的意思接，接不上就问最短的一句。' +
                '现在只输出你要发给他的那一两句原话：不要复述他的话，不要评论他的用词，不要解释你在判断什么。',
            );
            answer = String(retry.text ?? '').trim();
            if (looksLikeThinking(answer)) answer = stripThinking(answer) || '';
            if (looksLikeSelfTalk(answer, text)) answer = stripSelfTalk(answer);
            log.info(`让它重说了一遍：${answer.length} 字`);
          } catch (error) {
            log.warn(`重说失败：${error?.message ?? error}`);
          }
          if (!answer) answer = '没听清，再说一遍。';
        }
      }

      // 机械去重：重复的起头、雷同的句尾 emoji、叠出来的标点
      const recent = history
        .filter((entry) => entry.role === 'assistant')
        .map((entry) => entry.text)
        .slice(-2);
      const output = polish(answer, { recent, maxEmoji: config.emojiMax ?? 2 });
      const userTurn = msg.type === 'media' ? `[${msg.kind === 'image' ? '图片' : msg.kind}]${text ? ` ${text}` : ''}` : text;
      await memory.append(key, 'user', userTurn);
      await memory.append(key, 'assistant', output);
      log.info(`完成 ${key} ${Math.round(durationMs / 1000)}s ${output.length}chars${output === raw.trim() ? '' : '（已去重）'}`);
      onActivity?.('done');
      return { output, turnMs: durationMs };
    } catch (error) {
      await ack.cancel();
      // 历史里保留用户这句话，但不写入失败回复，避免污染上下文。
      await memory.append(key, 'user', msg.type === 'media' ? `[${msg.kind}]` : text);
      throw error;
    }
  }

  /** 干活干久了补一句话，别让人干等（就一两句，别念经） */
  const PROGRESS_LINES = [
    '还在翻呢，图有点多。',
    '找着呢，等会儿。',
    '唔，快好了。',
    '在挑，别催。',
    '翻到几张了，再看看。',
  ];

  function createAck(msg, queuedAhead, isTask = false) {
    if (!config.replyAck || !isTask) return { cancel: async () => {} };
    let done = false;
    const timers = [
      setTimeout(() => {
        if (done) return;
        void safeReply(msg, queuedAhead ? '等下，前面还有一条没弄完。' : '等下，人家看看。');
      }, config.ackDelayMs),
    ];
    // 活干得比预想久时补一句，不然对面只看到「等下」然后三分钟没动静
    const progressGap = config.progressAckGapMs ?? 0;
    if (progressGap > 0) {
      timers.push(
        setTimeout(() => {
          if (done) return;
          const line = PROGRESS_LINES[Math.floor(Math.random() * PROGRESS_LINES.length)];
          void safeReply(msg, line);
        }, config.ackDelayMs + progressGap),
      );
    }
    for (const timer of timers) timer.unref?.();
    return {
      cancel: async () => {
        done = true;
        for (const timer of timers) clearTimeout(timer);
      },
    };
  }

  async function deliver(msg, answer, meta = {}) {
    const limit = Math.max(200, config.maxReplyChars);
    const maxTotal = limit * 6;
    const text =
      answer.length > maxTotal
        ? `${answer.slice(0, maxTotal)}\n\n…（太长了，人家先说到这）`
        : answer;

    // 她可以在回复里用【语音】标记「这句我想说出口」，拆成语音段和文字段
    const segments = parseVoiceSegments(text);

    const thinkMin = Math.max(0, config.chatThinkMinMs ?? 400);
    const thinkMax = Math.max(thinkMin, config.chatThinkMaxMs ?? 1_200);
    let delay = thinkMin + Math.floor(Math.random() * (thinkMax - thinkMin + 1));

    // 字数越多打得越久，但封顶（默认 12ms/字，上限 1.8 秒）
    const perChar = Math.max(0, config.typingMsPerChar ?? 12);
    const cap = Math.max(0, config.thinkCapMs ?? 1_800);
    delay += Math.min(cap, text.length * perChar);

    // 偶尔走神：过一会儿才回
    if (Math.random() < (config.distractedChance ?? 0.03)) {
      const distractMin = Math.max(0, config.distractedMinMs ?? 3_000);
      const distractMax = Math.max(distractMin, config.distractedMaxMs ?? 8_000);
      delay += distractMin + Math.floor(Math.random() * (distractMax - distractMin));
    }

    // 模型自己已经折腾了很久的话，把这段等待抵扣掉 —— 真人不会让你等两遍
    const grace = Math.max(0, config.turnGraceMs ?? 2_500);
    const overrun = Math.max(0, (meta.turnMs ?? 0) - grace);
    delay = Math.max(0, delay - overrun);
    if (delay > 0) await sleep(delay);

    let voiceUsed = 0;
    for (const segment of segments) {
      if (segment.kind === 'voice') {
        const allow = voiceUsed === 0;
        if (allow) voiceUsed += 1;
        await speakSegment(msg, segment.text, allow);
        continue;
      }
      const bubbles = splitBubbles(segment.text, {
        maxLen: config.bubbleMaxChars ?? 90,
        maxBubbles: config.bubbleMax ?? 3,
      });
      for (const bubble of bubbles) {
        for (const chunk of splitReply(bubble, limit)) {
          await safeReply(msg, chunk);
        }
      }
    }

    // 偶尔丢一张表情包：真人聊天不会永远只有文字
    if (sticker && sendSticker && Math.random() < (config.stickerChance ?? 0.18)) {
      const file = await sticker.pick().catch(() => null);
      if (file) {
        try {
          await sendSticker(msg, file);
          // 记进她自己的历史：不然他说「这个表情包真可爱」时，她压根不知道自己发过图
          await memory.append(memoryKey(msg), 'assistant', '（顺手丢了一张表情包）').catch(() => {});
        } catch (error) {
          log.warn(`表情包发送失败：${error?.message ?? error}`);
        }
      }
    }
  }

  /**
   * 发一条语音。任何一步不行（没开 / 今天说太多了 / 合成失败 / 在群里）都安静降级成文字，
   * 绝不因为一句「想跟你说句话」把整轮回复卡住。
   */
  async function speakSegment(msg, text, allow = true) {
    const line = String(text ?? '').trim();
    if (!line) return;
    if (!allow || msg.groupId || !voiceOut || !sendVoice) {
      return safeReply(msg, line);
    }
    const verdict =
      typeof voiceOut.canSpeak === 'function' ? voiceOut.canSpeak() : { ok: false, reason: '不可用' };
    if (!verdict.ok) {
      log.info(`不发语音（${verdict.reason}），改发文字`);
      return safeReply(msg, line);
    }
    try {
      const result = await voiceOut.speak(line);
      await sendVoice(msg, result.silk, { text: line, durationMs: result.durationMs });
    } catch (error) {
      log.warn(`语音合成失败，改发文字：${error?.message ?? error}`);
      await safeReply(msg, line);
    }
  }

  async function safeReply(msg, text) {
    try {
      // 传整条消息而不是只传 senderId：QQ 群聊回复需要 group_id，
      // 微信侧只读取 msg.senderId，所以两边都能用。
      await reply(msg, text);
    } catch (error) {
      log.error(`发送失败: ${error?.message ?? error}`);
    }
  }

  function remember(id) {
    seen.add(id);
    if (seen.size > 2_000) {
      let drop = 500;
      for (const key of seen) {
        seen.delete(key);
        if (--drop <= 0) break;
      }
    }
  }

  async function resetConversation(msg) {
    const key = memoryKey(msg);
    await memory.clear(key);
    log.info(`已清空记忆 ${key}`);
  }

  return { handle, resetConversation, memoryKey };
}
