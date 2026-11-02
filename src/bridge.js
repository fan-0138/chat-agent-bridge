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
import { looksUnfinished, isLowContent, pickNudge } from './reader.js';


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
 *   mind?: {promptSection: () => Promise<string>},
 *   sticker?: {pick: () => Promise<string|null>},
 *   sendSticker?: (msg: any, file: string) => Promise<void>,
 * }} deps
 */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function createBridge({ config, runner, chatRunner, memory, queue, log, reply, typing, persona, voice, slang, vision, onActivity, life, mind, sticker, sendSticker, voiceOut, sendVoice }) {
  /**
   * 上一轮是不是卡超时了。
   * 她看不到系统这一层：10-29 19:45 那轮 DSH 超时，系统自动发了句「这个卡住了」，
   * 半小时后主动消息接上，他问「怎么这么久才回」，她只能编一个「刷抖音忘了时间」。
   * 记下来，下一轮把实情告诉她，别让她瞎猜。
   * @type {Map<string, number>}
   */
  const failedTurns = new Map();
  const seen = new Set();
  const unknownNotified = new Map();
  /** 他连着发、或者话没说完时的暂存：key -> {parts, timer, firstAt} */
  const inbox = new Map();
  /** 今天「故意不接」了几次、上次是什么时候 */
  const skipState = { day: '', count: 0, lastAt: 0 };
  /** 最近用过的「先问一句」，别老用同一句 */
  const nudges = [];

  function localDayKey(now = Date.now()) {
    const d = new Date(now);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

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

    // 他会连着打几条、或者话说一半停住：先攒一小会儿再答，别一句一句地打乒乓球
    if (shouldBuffer(msg)) {
      bufferMessage(msg, key, text);
      return;
    }
    await processMessage(msg, key, text);
  }

  /** 攒消息：同一个人、挨着发的几条，合成一轮再答。群里不攒（@ 了就得应）。 */
  function shouldBuffer(msg) {
    if (!(Number(config.replyMergeWindowMs ?? 0) > 0)) return false;
    if (msg.roomName || msg.groupId) return false;
    return msg.type === 'text' || msg.type === 'media';
  }

  function bufferMessage(msg, key, text) {
    const now = Date.now();
    const entry = inbox.get(key) ?? { parts: [], timer: null, firstAt: now };
    entry.parts.push({ msg, text, at: now });
    if (entry.parts.length > 8) entry.parts.splice(0, entry.parts.length - 8);

    // 图片/语音到了就立刻处理，别让图在缓冲里躺着（前面的话一起带上去）
    if (msg.type === 'media') {
      inbox.set(key, entry);
      void flushInbox(key).catch((error) => log.warn(`处理攒着的消息失败：${error?.message ?? error}`));
      return;
    }

    // 话没说完（「那个…」「我觉得」）就多等一会儿；说完了只留很短的空档给连发
    const unfinished = looksUnfinished(text);
    const waitWindow = unfinished ? Number(config.replyUnfinishedWaitMs ?? 9_000) : Number(config.replyMergeWindowMs ?? 1_500);
    const cap = Number(config.replyMaxWaitMs ?? 20_000);
    const due = Math.max(0, Math.min(waitWindow, cap - (now - entry.firstAt)));

    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = setTimeout(
      () => void flushInbox(key).catch((error) => log.warn(`处理攒着的消息失败：${error?.message ?? error}`)),
      due,
    );
    entry.timer.unref?.();
    inbox.set(key, entry);
  }

  async function flushInbox(key) {
    const entry = inbox.get(key);
    if (!entry) return;
    inbox.delete(key);
    if (entry.timer) clearTimeout(entry.timer);

    const parts = entry.parts.filter((part) => part.text || part.msg.type === 'media');
    if (parts.length === 0) return;
    const last = parts[parts.length - 1];
    const combined = parts.map((part) => part.text).filter(Boolean).join('\n');

    if (parts.length > 1) log.info(`他连发了 ${parts.length} 条，合成一轮再答`);

    // 话说一半，等完了还没下文：不硬答，先问一句
    if (parts.length === 1 && last.msg.type === 'text' && looksUnfinished(combined)) {
      await nudge(last.msg, combined);
      return;
    }

    // 纯应答（「嗯」「哈哈」）偶尔就不接，别像客服
    if (await shouldSkip(last.msg, key, combined, parts.length)) return;

    await processMessage(last.msg, key, combined);
  }

  /** 这一条不值得回：额度、间隔、随机，三个都过才不接。 */
  async function shouldSkip(msg, key, text, partCount) {
    const chance = Number(config.replySkipChance ?? 0);
    if (!(chance > 0) || partCount !== 1) return false;
    if (msg.type !== 'text' || !isLowContent(text)) return false;

    const day = localDayKey();
    const budget = Number(config.replySkipMaxPerDay ?? 0);
    const used = skipState.day === day ? skipState.count : 0;
    if (used >= budget) return false;
    const gapMs = Number(config.replySkipMinGapMin ?? 20) * 60_000;
    if (skipState.lastAt && Date.now() - skipState.lastAt < gapMs) return false;
    if (Math.random() >= chance) return false;

    skipState.day = day;
    skipState.count = used + 1;
    skipState.lastAt = Date.now();
    await memory.append(key, 'user', text).catch(() => {});
    log.info(`这条不接了（今天第 ${skipState.count}/${budget} 次）：${text.slice(0, 20)}`);
    onActivity?.('skipped');
    return true;
  }

  /** 没说完又没下文：她先问一句，别自己脑补半句去接。 */
  async function nudge(msg, text) {
    const line = pickNudge(nudges, Math.random);
    nudges.push(line);
    if (nudges.length > 6) nudges.shift();
    await safeReply(msg, line);
    const key = memoryKey(msg);
    await memory.append(key, 'user', text).catch(() => {});
    await memory.append(key, 'assistant', line).catch(() => {});
    log.info(`他没说完，先问一句：${line}`);
  }

  async function processMessage(msg, key, text) {
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
      if (error instanceof DshError && error.timedOut) failedTurns.set(key, Date.now());
      await safeReply(msg, message);
    }
  }

  /**
   * 模型偶尔会把「心里话」当正文发出去，两种都走同一个兜底：先抢救（剥掉），剥不干净就让它重说一遍。
   *   1) 列候选句 / 报刻度 / 自我指挥（2026-10-26 实录）
   *   2) 他打错字，她当面分析「他这话什么意思」（2026-10-28 实录）
   * 以前这两段各写一遍「抢救 + 重说 + 兜底」，改一处忘另一处。
   * 顺手修掉一个 bug：重说那步抛异常时，原 answer（心里话）还留在变量里，
   * 原来的 `if (!answer)` 兜不住，会把心里话原样发出去。现在无论怎么失败都落 fallback。
   */
  async function repairLeak({ prompt, active, answer, userText, isLeak, strip, label, retryNote, fallback }) {
    const current = String(answer ?? '').trim();
    if (!isLeak(current, userText)) return current;

    log.warn(`回复混进了${label}（${current.length} 字），先抢救`);
    const rescued = strip(current);
    if (rescued) {
      log.info(`剥掉${label}，留下正文：${rescued.slice(0, 40)}`);
      return rescued;
    }

    let text = '';
    try {
      const retry = await active.run(`${prompt}\n\n[纠正] ${retryNote}`);
      text = String(retry.text ?? '').trim();
      if (looksLikeThinking(text)) text = stripThinking(text) || '';
      if (looksLikeSelfTalk(text, userText)) text = stripSelfTalk(text);
      log.info(`让它重说了一遍：${text.length} 字`);
    } catch (error) {
      log.warn(`重说失败：${error?.message ?? error}`);
    }
    return text || fallback;
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
    // 她自己主动发的（「刚刷到…」）一天十来条，全塞进历史会把他刚说的话挤出去；
    // 但最近几条得留在对话里：他常常就是回她刚主动发的那条（「可以啊哈哈」），
    // 全摘成小字摘要后，模型会把更早的一条当「上一轮」，答得驴唇不对马嘴。
    const PROACTIVE_IN_WINDOW = 3;
    const proactiveSeen = new Set(
      history
        .map((entry, index) => (entry.kind === 'proactive' ? index : -1))
        .filter((index) => index >= 0)
        .slice(-PROACTIVE_IN_WINDOW),
    );
    const dialogue = history.filter((entry, index) => entry.kind !== 'proactive' || proactiveSeen.has(index));
    const notes = notesFrom(history.filter((entry, index) => !(entry.kind === 'proactive' && proactiveSeen.has(index))));
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
    // 她自己时间里想的事：接进这一轮，让她接着自己刚才想的往下说，而不是从零开机
    const mindText = mind ? await mind.promptSection().catch(() => '') : '';

    // 他隔了多久才收到回复：不写清楚，她就会自己编（「才二十分钟不到」其实三十多分钟）
    const lastUserAt = [...dialogue].reverse().find((entry) => entry.role === 'user')?.at ?? 0;
    const gapMin = lastUserAt > 0 ? Math.round((Date.now() - lastUserAt) / 60_000) : 0;
    const extraLines = [];

    // 他刚回的是她主动发的那条：明确告诉他这句话在接什么，别按两小时前的旧话答
    const lastEntry = dialogue[dialogue.length - 1];
    if (lastEntry?.kind === 'proactive' && lastEntry.at) {
      const agoMin = Math.round((Date.now() - Number(lastEntry.at)) / 60_000);
      if (agoMin >= 0 && agoMin <= 20) {
        extraLines.push(
          `[时间] 你 ${agoMin} 分钟前刚主动给他发了「${String(lastEntry.text).replace(/\s+/g, ' ').slice(0, 30)}」。` +
            '他这句话大概率是在回这条，先顺着它接；如果确实不是，再按更早的对话接。',
        );
      }
    }
    if (gapMin >= 5) {
      extraLines.push(
        `[时间] 他上一条消息是 ${gapMin} 分钟前发的，你隔了一会儿才回。别把时间说小（别说「才几分钟」），也别编理由。`,
      );
    }
    const failedAt = failedTurns.get(key);
    if (failedAt && Date.now() - failedAt < 3 * 3_600_000) {
      extraLines.push(
        '[系统] 上一轮你回的时候卡超时了（系统只自动发出去一句「这个卡住了，人家等下再弄。」），不是你没看见，也不是你在刷抖音。' +
          '他要是问你回得慢，就直说刚才卡了一下。',
      );
    }
    if (mindText) extraLines.push(mindText);

    const prompt = buildPrompt({
      persona: personaText,
      voice: voiceText,
      slang: slangText,
      history: dialogue,
      notes,
      extra: extraLines.join('\n\n'),
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

      // 两种漏（思考过程、判断他的独白）共用一套抢救逻辑，见 repairLeak。
      let answer = await repairLeak({
        prompt,
        active,
        answer: raw,
        userText: text,
        isLeak: (candidate) => looksLikeThinking(candidate),
        strip: stripThinking,
        label: '思考过程',
        retryNote:
          '你上一条把思考过程当正文发出来了（比如「要接」「刻度」「收住」这类自我指挥的话）。' +
          '现在只输出要发给他的那一两句原话：不要引号列候选，不要解释，不要复述要求。',
        fallback: '刚才脑子跑偏了，你再说一遍。',
      });
      answer = await repairLeak({
        prompt,
        active,
        answer,
        userText: text,
        isLeak: (candidate, said) => looksLikeSelfTalk(candidate, said),
        strip: stripSelfTalk,
        label: '判断他那句话的独白',
        retryNote:
          '你上一条把「我怎么理解他这句话」的分析写进正文了（比如「这句听着不太像平常的聊天」「我先问一句」）。' +
          '爸爸打字常打错、说话常半截：看到怪话就按最顺的意思接，接不上就问最短的一句。' +
          '现在只输出你要发给他的那一两句原话：不要复述他的话，不要评论他的用词，不要解释你在判断什么。',
        fallback: '没听清，再说一遍。',
      });

      // 机械去重：重复的起头、雷同的句尾 emoji、叠出来的标点
      const recent = history
        .filter((entry) => entry.role === 'assistant')
        .map((entry) => entry.text)
        .slice(-2);
      const output = polish(answer, { recent, maxEmoji: config.emojiMax ?? 2 });
      const userTurn = msg.type === 'media' ? `[${msg.kind === 'image' ? '图片' : msg.kind}]${text ? ` ${text}` : ''}` : text;
      failedTurns.delete(key);
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
