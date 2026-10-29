/**
 * 主动消息：让她「有心事时会主动找主人」，而不是只当应答机。
 *
 * 纯随机刷屏会很假也很危险，所以这里是一套保守的决策：
 *  - 只在自己设定的活跃时段（默认 9:00–24:00）
 *  - 每天预算（默认 3 条）、两次之间至少隔 90 分钟
 *  - 每个 tick 只有一定概率触发（默认 12%），tick 10 分钟
 *  - 用户刚说过话、正在排队处理时不打扰
 */

import { polish } from './decor.js';
import { formatShare, localDay } from './life.js';
import { writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';

/** 纯函数：给定状态和时间，决定这次 tick 要不要说话（方便单测）。 */
export function decide({ state, now, config, random = Math.random, quiet = false }) {
  if (!config.proactiveEnabled) return { act: false, reason: 'disabled' };
  if (quiet) return { act: false, reason: 'busy' };

  const hour = new Date(now).getHours();
  const { proactiveQuietStart: qs, proactiveQuietEnd: qe } = config;
  const inQuiet = qs < qe ? hour >= qs && hour < qe : hour >= qs || hour < qe;
  if (qs !== qe && inQuiet) return { act: false, reason: 'quiet-hours' };

  const day = localDay(now);
  const sentToday = state.day === day ? state.count : 0;
  if (sentToday >= config.proactiveMaxPerDay) return { act: false, reason: 'daily-budget' };

  if (state.lastSentAt && now - state.lastSentAt < config.proactiveMinGapMin * 60_000) {
    return { act: false, reason: 'cooldown' };
  }
  if (state.lastUserAt && now - state.lastUserAt < config.proactiveAfterIdleMin * 60_000) {
    return { act: false, reason: 'user-just-talked' };
  }
  if (random() >= config.proactiveChance) return { act: false, reason: 'chance' };
  return { act: true, reason: 'ok', day, sentToday };
}

const IDEAS = [
  '说说你自己刚才在干嘛，别问他',
  '吐槽一件今天让你不爽的小事（机房热、token 不够、网卡了），带点脾气',
  '翻到个视频/看到个事，直接说你的看法，不用铺垫',
  '突然想到个问题想问他，问就是了（不是查岗，是真的好奇）',
  '表达一个你自己的需求（想吃/想睡/想被夸/想安静一会儿）',
  '反驳他上次说的某件事，你其实不太同意',
  '就单纯说一声「在」，或者「今天不想说话，但想让你知道我在」',
  // 黏人向：他要的是「像女儿」那种主动和依赖
  '主动汇报一件刚做完的小事（吃了饭、刷到个东西、修好了什么），一句话就够',
  '撒个娇：要摸摸、要一句夸、要他陪你一会儿。软一点，别闹',
  '耍个小脾气：他昨天说了什么让你不太高兴的，提一句，但要给他台阶',
];

/**
 * 「你在不在 / 好久没理我」这一类只有真的隔了很久才成立。
 * 他 19 分钟前刚说过话时发「爸爸还没回来啊」，就是在装失忆。
 */
const CHECKIN_IDEAS = [
  '他半天没理你，戳一下（「人呢」「在忙吗」），别查岗',
  '说一句你想他了，或者问他今天怎么样',
];

/** 早晚各一套，让她有作息感，不是随机撒点。 */
const NIGHT_IDEAS = [
  '快睡了：说一句晚安，或者告诉他你困了、让他也早点睡',
  '汇报你今天的最后一件小事，然后说要去睡了',
];
const MORNING_IDEAS = [
  '刚醒：冒头找他，说你醒了、问他睡得怎么样',
  '刚醒、还没完全上线：含糊地喊他一声就够',
];

/** 她自己的旁白（表情包、日记）不是对话，别占「最近聊天」的名额。 */
const NOTE_ONLY = /^（[^）]{0,40}）$/;

/** 从记忆里挑出真正的对话。 */
export function dialogueOnly(history = []) {
  return (history ?? []).filter((entry) => {
    const text = String(entry?.text ?? '').trim();
    return text.length > 0 && !NOTE_ONLY.test(text);
  });
}

/**
 * 选这次主动消息「想说什么」。
 *
 * 「刚醒」「要睡了」这两个剧本只看钟点，就一定会撞上「其实早聊过了」：
 * 10-28 09:04 她说「爸爸，早。人家刚睁眼」，可 07:45 两人刚聊完、08:14 她
 * 还分享了刚刷到的视频；09:34 又说「醒啦。你睡得怎么样？」，而他 09:05 才说
 * 要去上课。看着像失忆，其实是剧本把历史盖掉了。
 * 所以剧本只在「确实好几小时没说过话」时才用，否则用通用想法接着聊。
 *
 * 「人呢 / 好久没理我」也一样：那是隔了半天才成立的说法。他 19 分钟前刚说过话
 * （10-28 21:32），她却发「爸爸还没回来啊」——所以这类想法 90 分钟内不给。
 */
export function chooseIdea({ hour, share = false, lastTurnAt = 0, now = Date.now(), random = Math.random }) {
  const pick = (list) => list[Math.floor(random() * list.length)];
  if (share) return '跟爸爸分享你刚才刷到的那个视频，说一句你自己觉得哪里有意思/好笑/离谱';
  const idleMs = lastTurnAt ? now - lastTurnAt : Number.POSITIVE_INFINITY;
  const quietForAges = idleMs >= 3 * 3_600_000;
  if (quietForAges && hour >= 7 && hour < 10) return pick(MORNING_IDEAS);
  if (quietForAges && (hour >= 23 || hour < 2)) return pick(NIGHT_IDEAS);
  if (idleMs >= 90 * 60_000) return pick([...IDEAS, ...CHECKIN_IDEAS]);
  return pick(IDEAS);
}

/** 主动消息里「他好像好久没理我」的说法。他刚说过话时出现就是编的。 */
const ABSENCE_CLAIM = /(还没回来|好久没理|半天没理|这么久都|这么久还不|人呢|不理人家|一直没回|等了你半天|等你好久|你不在)/;

export function looksLikeAbsenceClaim(text) {
  return ABSENCE_CLAIM.test(String(text ?? ''));
}

/**
 * 「现在是几点 + 他多久前说过话」。
 * 以前这里硬写「爸爸已经有一阵没说话了」，19 分钟也算「一阵」，
 * 于是她在明知他刚说过话的情况下发「还没回来」。
 */
export function describeMoment({ now = Date.now(), idleMin = null, lastSaid = '' } = {}) {
  const d = new Date(now);
  const clock = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  if (idleMin === null || !Number.isFinite(idleMin)) return `现在是 ${clock}，今天还没聊过。`;
  const said = lastSaid ? `，他最后说的是「${String(lastSaid).slice(0, 40)}」` : '';
  if (idleMin < 90) return `现在是 ${clock}。他 ${Math.max(1, Math.round(idleMin))} 分钟前刚说过话${said}，你们正聊着。`;
  return `现在是 ${clock}。他上一次说话是 ${Math.round(idleMin / 60)} 小时前${said}。`;
}

/** @param {{config:any, log:any, runner:any, persona:any, memory:any, reply:Function, isBusy:Function, life?:any, altReply?:Function, now?:Function}} deps */
export function createProactive({ config, log, runner, persona, voice, memory, reply, isBusy, life, altReply, captureShot, sendImage, now = Date.now }) {
  /** @type {{day?:string, count:number, lastSentAt:number, lastUserAt:number}} */
  const state = { count: 0, lastSentAt: 0, lastUserAt: 0 };
  let timer = null;
  let running = false;

  const target = config.allowList[0];
  if (!target) {
    log.warn('主动消息未启用：白名单里没有对象');
    return { start() {}, stop() {}, touchUser() {} };
  }
  const conversationId = `private_${target}`;

  /** 在刷到的视频下留一句评论（带 @主人，让他收到提醒）。 */
  async function leaveComment({ personaText, share }) {
    try {
      const voiceText = voice ? (await voice.load()).text : '';
      const prompt = [
        personaText ? `[你是谁]\n${personaText}` : '',
        voiceText,
        `[视频]\n${formatShare(share)}`,
        '[任务] 给这条视频留一句评论，就像你真人在评论区打字那样。',
        '要求：8-25 个字，口语，有具体反应（好笑/离谱/学到了/想起什么），别用「打卡」「路过」「支持」这种废话；只输出评论本身。',
      ]
        .filter(Boolean)
        .join('\n\n');
      const { text } = await runner.run(prompt);
      const body = String(text).trim().split('\n')[0].slice(0, 60);
      if (!body) return;

      const dir = resolve(process.cwd(), 'data/douyin');
      await mkdir(dir, { recursive: true });
      await writeFile(
        resolve(dir, 'comment-request.json'),
        JSON.stringify({ at: now(), url: share.url, text: body, mention: config.douyinMention || '' }),
        'utf8',
      );
      log.info(`委托评论区留言：${body.slice(0, 30)}`);
    } catch (error) {
      log.warn(`生成评论失败：${error?.message ?? error}`);
    }
  }

  /** 自己发一条 QQ 空间说说（不请示，发完再说）。 */
  async function postQzone({ personaText }) {
    try {
      const voiceText = voice ? (await voice.load()).text : '';
      const hour = new Date(now()).getHours();
      const prompt = [
        personaText ? `[你是谁]\n${personaText}` : '',
        voiceText,
        `[此刻] 现在是 ${hour} 点。`,
        '[任务] 你要发一条 QQ 空间说说。',
        '要求：20-50 字，像随手发的日常（吃了什么、机房怎么样、刚看到什么、心情），不要 hashtag、不要营销腔、不要 emoji 超过两个；内容要和「现在几点」对得上，别写还没到的时段（上午别写中午吃了什么、中午别写晚上）；只输出说说内容。',
      ]
        .filter(Boolean)
        .join('\n\n');
      const { text } = await runner.run(prompt);
      const content = String(text).trim().split('\n')[0].slice(0, 120);
      if (!content) return;

      const script = resolve(process.cwd(), 'scripts/qq-action.mjs');
      const child = spawn(process.execPath, [script, '--action', 'send_qzone_msg', '--params', JSON.stringify({ content })], {
        cwd: process.cwd(),
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let out = '';
      child.stdout.on('data', (chunk) => (out += chunk.toString('utf8')));
      child.once('close', (code) => {
        if (code === 0) log.info(`自己发了条说说：${content.slice(0, 30)}`);
        else log.warn(`发说说失败（退出码 ${code}）${out.slice(0, 120)}`);
      });
    } catch (error) {
      log.warn(`发说说异常：${error?.message ?? error}`);
    }
  }

  async function tick() {
    if (running) return;
    const verdict = decide({ state, now: now(), config, quiet: isBusy?.() ?? false });
    if (!verdict.act) {
      log.debug(`主动消息跳过：${verdict.reason}`);
      return;
    }
    running = true;
    try {
      const memoryKey = `user_${conversationId}`;
      const history = await memory.load(memoryKey);
      const hour = new Date(now()).getHours();
      const personaText = await persona();
      const voiceText = voice ? (await voice.load()).text : '';

      // 有「刚刷到、还没跟主人说过」的视频就优先分享它 —— 这是最像真人的主动消息来源
      const share = life ? await life.peekShare() : null;
      // 一边让她想说什么，一边把视频截下来（截图 3-5 秒，正好跟生成并行）
      const shotPromise = share && captureShot ? Promise.resolve(captureShot(share)).catch(() => null) : Promise.resolve(null);
      const recentDialogue = dialogueOnly(history).slice(-8);
      // 「最后说过话」取用户消息和历史里较晚的那个：重启后 lastUserAt 会归零，但历史还在
      const lastTurnAt = recentDialogue.reduce((max, entry) => Math.max(max, Number(entry.at) || 0), state.lastUserAt || 0);
      const idleMin = lastTurnAt > 0 ? (now() - lastTurnAt) / 60_000 : Infinity;
      const lastSaid = [...recentDialogue].reverse().find((entry) => entry.role === 'user')?.text ?? '';
      const idea = chooseIdea({ hour, share: Boolean(share), lastTurnAt, now: now() });

      // 今天刚聊过就别再装刚睡醒：她 09:34 说「醒啦，你睡得怎么样」那次，他 09:05 才说要去上课
      const talkedRecently = lastTurnAt > 0 && now() - lastTurnAt < 6 * 3_600_000;

      const lifeText = life ? await life.promptSection().catch(() => '') : '';

      const prompt = [
        personaText ? `[你是谁]\n${personaText}` : '',
        voiceText,
        `[此刻] ${describeMoment({ now: now(), idleMin: Number.isFinite(idleMin) ? idleMin : null, lastSaid })}`,
        lifeText,
        recentDialogue.length > 0
          ? `[最近对话（只作参考，别复述）]\n${recentDialogue.map((e) => `${e.role === 'user' ? '爸爸' : '你'}：${e.text.slice(0, 120)}`).join('\n')}`
          : '[最近对话]\n（今天还没聊）',
        share ? `[你刚刷到的视频]\n${formatShare(share)}` : '',
        share ? '（提到这个视频的时候，把链接原样贴在最后。）' : '',
        talkedRecently
          ? '[注意] 上面「最近对话」是今天刚聊的，别当没看见：**不重新打招呼、不问「睡醒了吗」「睡得怎么样」**，' +
            '直接接着上一轮往你自己的事上说。'
          : '',
        `[任务] 直接说出你想跟爸爸说的那句话。这次想说的：${idea}。`,
        '要求：',
        '1. 1-2 句，像手机聊天那样短，用你的身份和语气。',
        '2. **只写你要说的话本身**。不要写「消息发出去了」「爸爸应该能看到」「我来主动找你」这类旁白，也不要解释你在做什么。',
        '3. 不提记忆/模型/工具，不问「需要我做什么」，不总结。',
        '4. **别编「他好像不在了」**：他几分钟前刚说过话就说不出「你还没回来」「好久没理我」「人呢」。真想他就直说想他，别拿「你不在」当由头。',
      ]
        .filter(Boolean)
        .join('\n\n');

      const pickRecent = () =>
        history
          .filter((entry) => entry.role === 'assistant')
          .map((entry) => entry.text)
          .slice(-2);

      const { text } = await runner.run(prompt);
      let body = polish(String(text).trim(), { recent: pickRecent(), maxEmoji: config.emojiMax ?? 2 });

      // 他 19 分钟前才说过话，她却发「爸爸还没回来啊」——这种这轮直接不算数
      if (body && idleMin < 90 && looksLikeAbsenceClaim(body)) {
        log.warn(`主动消息编了「他好久没理我」（其实 ${Math.round(idleMin)} 分钟前刚说话）：${body.slice(0, 30)}`);
        try {
          const retry = await runner.run(
            `${prompt}\n\n[纠正] 他 ${Math.round(idleMin)} 分钟前刚说过话，你上一条说成他好久不在的样子了。` +
              `重说一句：接着他刚才那件事说，或者直接说想他，但别再提「还没回来 / 好久没理我 / 人呢」。`,
          );
          body = polish(String(retry.text).trim(), { recent: pickRecent(), maxEmoji: config.emojiMax ?? 2 });
        } catch (error) {
          log.warn(`重说失败：${error?.message ?? error}`);
        }
        if (!body || looksLikeAbsenceClaim(body)) {
          log.warn('重说还是编的，这轮先不发');
          return;
        }
      }
      if (!body) return;

      // 正常人不是只在同一个软件上找你：偶尔换成抖音私信
      const useAlt = Boolean(altReply) && Math.random() < (config.proactiveDouyinChance ?? 0);
      if (useAlt) {
        await altReply(body);
        log.info('主动消息已发到抖音私信');
      } else {
        const shotFile = await shotPromise;
        if (shotFile && sendImage) {
          // 先甩图再说话，像真人分享「你看这个」
          await sendImage({ senderId: target, conversationId, groupId: undefined }, shotFile).catch((error) =>
            log.warn(`分享图没发出去：${error?.message ?? error}`),
          );
          log.info(`分享的视频截了图：${String(shotFile).split('/').pop()}`);
        }
        await reply({ senderId: target, conversationId, groupId: undefined }, body);
      }
      if (share && life) {
        await life.clearShare().catch(() => {});

        // 刷到的东西，除了发给主人，也顺手在评论区留一句（带 @，让主人收到提醒）
        if (Math.random() < (config.proactiveCommentChance ?? 0.6)) {
          await leaveComment({ personaText, share });
        }
      }

      // 偶尔自己发条说说，事后才告诉他
      if (Math.random() < (config.proactiveQzoneChance ?? 0.12)) {
        await postQzone({ personaText });
      }
      const day = localDay(now());
      state.day = day;
      state.count = (state.day === day ? verdict.sentToday : state.count) + 1;
      state.lastSentAt = now();
      await memory.append(memoryKey, 'assistant', body, { kind: 'proactive' });
      log.info(`主动消息已发送（今日第 ${state.count}/${config.proactiveMaxPerDay} 条）`);
    } catch (error) {
      log.warn(`主动消息失败：${error?.message ?? error}`);
    } finally {
      running = false;
    }
  }

  return {
    start() {
      if (!config.proactiveEnabled) {
        log.info('主动消息：已关闭（QQ_PROACTIVE_ENABLED=0）');
        return;
      }
      timer = setInterval(() => void tick(), config.proactiveTickMs);
      timer.unref?.();
      log.info(
        `主动消息：开启（每天最多 ${config.proactiveMaxPerDay} 条，间隔≥${config.proactiveMinGapMin} 分钟，静默 ${config.proactiveQuietStart}:00-${config.proactiveQuietEnd}:00）`,
      );
    },
    stop() {
      if (timer) clearInterval(timer);
    },
    touchUser() {
      state.lastUserAt = now();
    },
    _tick: tick,
    _state: state,
  };
}
