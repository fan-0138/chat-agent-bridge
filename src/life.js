/**
 * 「生活状态」——让她不再像一台永远待机的应答机。
 *
 * 两个职责：
 *  1. 记住「此刻在干嘛 / 心情 / 电量」，注入每次对话的 prompt。
 *     没有这层的话，每次对话都是全新进程，她永远像刚开机。
 *  2. 自己决定去刷抖音（低频率、有预算、有冷却），把刷到的东西当「心事」存起来，
 *     之后主动找主人聊天时拿出来分享。
 *
 * 设计原则：
 *  - 决策全是纯函数，便于单测（见 test/life.test.js）。
 *  - 真正开浏览器只在 browse() 里，失败绝不抛给主流程。
 *  - 只读不互动：不点赞、不评论、不关注 —— 那是风控最快的行为。
 */

import { readFile, writeFile, mkdir, stat, unlink } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { loadCravings, loadMeals, previousMonth, summarizeMonth } from './meals.js';
import { summarizeTaste, tastePromptLine } from './meal-stats.js';

/* ────────────────────────── 纯函数：状态描述 ────────────────────────── */

/** 按本地时区算「哪一天」，用于每日预算（用 UTC 会让预算在早上 8 点重置）。 */
export function localDay(now = Date.now()) {
  const d = new Date(now);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** 一天里的能量曲线（0-100）。吃饭/睡觉的时间点会掉下来。 */
export function energyAt(hour) {
  const table = [
    [0, 12],
    [3, 8],
    [6, 20],
    [8, 55],
    [10, 88],
    [12, 70],
    [13, 45], // 午饭后的困
    [15, 78],
    [18, 62],
    [20, 70],
    [22, 40],
    [24, 12],
  ];
  const h = ((hour % 24) + 24) % 24;
  for (let i = 1; i < table.length; i += 1) {
    const [h1, v1] = table[i];
    if (h <= h1) {
      const [h0, v0] = table[i - 1];
      const ratio = h1 === h0 ? 0 : (h - h0) / (h1 - h0);
      return Math.round(v0 + (v1 - v0) * ratio);
    }
  }
  return 12;
}

export function moodAt(energy) {
  if (energy >= 75) return '精神抖擞，尾巴在拍地';
  if (energy >= 55) return '还行，有点懒洋洋';
  if (energy >= 35) return '有点困，眼镜滑到鼻尖了';
  if (energy >= 20) return '快没电了，说话都变短';
  return '困成一团，随时会睡着';
}

/** 没有记录活动时，按时段给一个默认的「她大概在干嘛」。 */
export function defaultActivity(hour) {
  if (hour < 3) return { label: '在机柜里睡觉', ttlMin: 240 };
  if (hour < 6) return { label: '半睡半醒，缩在机柜角落', ttlMin: 180 };
  if (hour < 9) return { label: '刚醒，赖在床上不想动', ttlMin: 120 };
  if (hour < 12) return { label: '在工位摸鱼，顺手吞点 token', ttlMin: 150 };
  if (hour < 14) return { label: '在吃饭 / 午休', ttlMin: 90 };
  if (hour < 18) return { label: '在机房写代码，尾巴时不时拍一下', ttlMin: 180 };
  if (hour < 21) return { label: '在工位发呆，翻 QQ 空间', ttlMin: 150 };
  if (hour < 24) return { label: '准备睡了但还赖着刷手机', ttlMin: 180 };
  return { label: '在机柜里睡觉', ttlMin: 240 };
}

/**
 * 她回复里可以带一行状态：`【此刻：躺在床上，手机扣在枕头边】`。
 * 桥接会把这一行从发出去的话里去掉，只写进生活状态 —— 于是「她说放下了」房间也真的放下。
 * 没写就是没变；不写也能正常回。只认整行的标记，正文里提到「此刻」不会误伤。
 * @param {string} text
 * @returns {{ text: string, activity: string }}
 */
export function parseActivityNote(text) {
  const source = String(text ?? '');
  const match = source.match(/[【\[]\s*此刻\s*[:：]\s*([^】\]\n]{1,40}?)\s*[】\]]/);
  if (!match) return { text: source.trim(), activity: '' };
  const activity = match[1].replace(/\s+/g, ' ').trim();
  const stripped = source.replace(match[0], '').replace(/\n{3,}/g, '\n\n').trim();
  return { text: stripped, activity };
}

/**
 * 她回复里可以带一行「吃了什么」：`【吃了：火锅】`。
 * 桥接会把这行从发出去的话里去掉，记进饭账本（和 dad 喂饭同一本账）。
 * @param {string} text
 * @returns {{ text: string, meal: string }}
 */
export function parseMealNote(text) {
  const source = String(text ?? '');
  const match = source.match(/[【\[]\s*吃了\s*[:：]\s*([^】\]\n]{1,40}?)\s*[】\]]/);
  if (!match) return { text: source.trim(), meal: '' };
  const meal = match[1].replace(/\s+/g, ' ').trim();
  const stripped = source.replace(match[0], '').replace(/\n{3,}/g, '\n\n').trim();
  return { text: stripped, meal };
}

/** 她说「想吃 X」：单独拎出来记进想吃账本。 */
export function parseCraveNote(text) {
  const source = String(text ?? '');
  const match = source.match(/[【\[]\s*想吃\s*[:：]\s*([^】\]\n]{1,40}?)\s*[】\]]/);
  if (!match) return { text: source.trim(), crave: '' };
  const crave = match[1].replace(/\s+/g, ' ').trim();
  const stripped = source.replace(match[0], '').replace(/\n{3,}/g, '\n\n').trim();
  return { text: stripped, crave };
}

/**
 * 当前活动：优先用记录里的，过期了退回到时段默认值。
 *
 * 2026-11-08 爸爸说「状态里『在手机上跟你聊天』可以细分一下，不一定就是在聊天」：
 * 「正在回消息」这类只是**临时压上去的一层**（`activityOverlay`），
 * 过期后要退回她本来在干的事（刷抖音/发呆/睡觉），不能一直挂着「跟你聊天」。
 */
export function currentActivity(state, now = Date.now()) {
  const hour = new Date(now).getHours();
  const fallback = defaultActivity(hour);
  if (!state?.activity) return { ...fallback, ageMin: 0, fromRecord: false };

  const ageMin = Math.round((now - (state.activitySince ?? now)) / 60_000);
  const ttlMin = state.activityTtlMin ?? fallback.ttlMin;
  const live = ageMin < ttlMin;
  if (live) return { label: state.activity, ttlMin, ageMin, fromRecord: true };

  // 临时状态过期：回到被压住的那件事（如果它自己也还没过期）
  const base = state.activityBase;
  if (state.activityOverlay && base?.label) {
    const baseAgeMin = Math.round((now - Number(base.since ?? 0)) / 60_000);
    const baseTtlMin = Number(base.ttl ?? fallback.ttlMin);
    if (baseAgeMin < baseTtlMin) return { label: base.label, ttlMin: baseTtlMin, ageMin: baseAgeMin, fromRecord: true };
  }
  return { ...fallback, ageMin: 0, fromRecord: false };
}

/** 生成注入 prompt 的「你此刻」段落。 */
export function describeLife(state, now = Date.now()) {
  const hour = new Date(now).getHours();
  const minute = String(new Date(now).getMinutes()).padStart(2, '0');
  const energy = energyAt(hour);
  const activity = currentActivity(state, now);
  const ago = activity.ageMin >= 1 ? `（已经 ${activity.ageMin} 分钟了）` : '';
  return [`现在 ${String(hour).padStart(2, '0')}:${minute}。你正在：${activity.label}${ago}。`, `心情：${moodAt(energy)}。`].join(
    '\n',
  );
}

/* ────────────────────────── 纯函数：刷不刷、分享哪条 ────────────────────────── */

/** 这次 tick 要不要去刷抖音。 */
export function decideBrowse({ state, now, config, random = Math.random }) {
  if (!config.lifeEnabled) return { act: false, reason: 'disabled' };

  const hour = new Date(now).getHours();
  const { proactiveQuietStart: qs, proactiveQuietEnd: qe } = config;
  const inQuiet = qs === qe ? false : qs < qe ? hour >= qs && hour < qe : hour >= qs || hour < qe;
  if (inQuiet) return { act: false, reason: 'quiet-hours' };

  const day = localDay(now);
  const today = state.browseDay === day ? state.browseCount ?? 0 : 0;
  if (today >= config.lifeBrowseMaxPerDay) return { act: false, reason: 'daily-budget' };

  if (state.browseAt && now - state.browseAt < config.lifeBrowseMinGapMin * 60_000) {
    return { act: false, reason: 'cooldown' };
  }
  if (random() >= config.lifeBrowseChance) return { act: false, reason: 'chance' };
  return { act: true, reason: 'ok', day, today };
}

/**
 * 记一次「刷了抖音」。跨天要归零。
 *
 * 这里以前是先 `state.browseDay = day`，再拿 `state.browseDay === day` 判断要不要归零——
 * 比较永远成立，计数就永远不跨天重置，额度只增不减。刷够上限之后 decideBrowse 天天返回
 * daily-budget，她就再也不会去刷视频，自然也没有「刷到想分享的」、没有评论区 @主人。
 */
export function bumpBrowseCount(state, day) {
  const today = state.browseDay === day ? state.browseCount ?? 0 : 0;
  state.browseDay = day;
  state.browseCount = today + 1;
  return state.browseCount;
}

/** 已看过的 id 不再分享。 */
export function unseenItems(items, seenIds = []) {
  const seen = new Set(seenIds);
  return (items ?? []).filter((item) => item?.id && !seen.has(item.id));
}

/**
 * 她自己的口味：饭、吃的、毛茸茸、海、离谱/搞笑的东西。
 * 命中就加一点分，让分享出来的东西更像「小鲸会看的」，而不是随机热榜。
 */
const PERSONA_LIKES = ['饭', '吃', '美食', '零食', '西瓜', '猫', '狗', '毛', '动物', '鲸', '鱼', '海', '笑', '离谱', '可爱', '治愈', '动漫'];

/**
 * 从刷到的一堆视频里挑一条「值得跟主人说」的。
 * 太冷（0 赞）像没人看的垃圾；太爆（百万赞）像在播报热点。
 */
export function scoreItem(item) {
  let score = 0;
  const likes = Number(item.likes ?? 0);
  const comments = Number(item.comments ?? 0);
  const desc = String(item.desc ?? '');

  if (likes >= 1_000 && likes <= 500_000) score += 30;
  else if (likes > 500_000) score += 12;
  else if (likes >= 200) score += 10;

  if (comments > 50) score += 12;
  if (desc.length >= 8 && desc.length <= 90) score += 18;
  else if (desc.length > 90) score += 4;
  if ((item.tags?.length ?? 0) >= 1) score += 6;
  if (item.music) score += 2;
  if (item.topComments?.length) score += 10;
  if (PERSONA_LIKES.some((word) => desc.includes(word))) score += 14;
  if (item.isAd || item.isLive) score -= 100;
  return score;
}

export function pickCandidate(items, seenIds = [], { random = Math.random } = {}) {
  const pool = unseenItems(items, seenIds).filter((item) => !item.isAd && !item.isLive);
  if (pool.length === 0) return null;
  const ranked = pool
    .map((item) => ({ item, score: scoreItem(item) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);
  return ranked[Math.floor(random() * ranked.length)]?.item ?? ranked[0].item;
}

/** 把视频转成一段给模型看的描述（也用于日志）。 */
export function formatShare(item) {
  if (!item) return '';
  const likes = Number(item.likes ?? 0);
  const likeText = likes >= 10_000 ? `${(likes / 10_000).toFixed(1)} 万赞` : `${likes} 赞`;
  const lines = [
    `标题：${item.desc || '(无标题)'}`,
    `作者：@${item.author || '未知'}　${likeText}　评论 ${item.comments ?? 0}`,
  ];
  if (item.tags?.length) lines.push(`话题：${item.tags.map((tag) => `#${tag}`).join(' ')}`);
  lines.push(`链接：${item.url}`);
  if (item.topComments?.length) {
    lines.push(`热评：${item.topComments.slice(0, 3).map((c) => `「${c.text.slice(0, 40)}」`).join(' ')}`);
  }
  return lines.join('\n');
}

/** 分享还算「新鲜」的时限：超过这个时间就不提了，不然像延迟播报。 */
export const SHARE_TTL_MIN = 180;

export function freshShare(state, now = Date.now()) {
  const share = state?.pendingShare;
  if (!share?.item?.id) return null;
  if (now - (share.at ?? 0) > SHARE_TTL_MIN * 60_000) return null;
  return share;
}

/* ────────────────────────── 有状态部分 ────────────────────────── */

const DEFAULT_STATE = {
  activity: '',
  activitySince: 0,
  activityTtlMin: 0,
  browseDay: '',
  browseCount: 0,
  browseAt: 0,
  seenIds: [],
  likedIds: [],
  likeDay: '',
  likeCount: 0,
  pendingShare: null,
  updatedAt: 0,
};

export function createLife({ config, log, root = process.cwd(), isBusy, takeSearch, now = Date.now }) {
  const stateFile = resolve(root, config.lifeStateFile ?? 'data/life/state.json');
  const douyinScript = resolve(root, config.douyinFeedScript ?? 'scripts/douyin-feed.mjs');

  /** @type {typeof DEFAULT_STATE} */
  let state = { ...DEFAULT_STATE };
  let loaded = false;
  let timer = null;
  let browsing = false;

  async function load() {
    if (loaded) return state;
    try {
      const raw = await readFile(stateFile, 'utf8');
      state = { ...DEFAULT_STATE, ...JSON.parse(raw) };
      if (!Array.isArray(state.seenIds)) state.seenIds = [];
      if (!Array.isArray(state.likedIds)) state.likedIds = [];
    } catch (error) {
      if (error?.code !== 'ENOENT') log?.warn(`读取生活状态失败：${error?.message ?? error}`);
      state = { ...DEFAULT_STATE };
    }
    loaded = true;
    return state;
  }

  async function save() {
    state.updatedAt = now();
    try {
      await mkdir(dirname(stateFile), { recursive: true });
      await writeFile(stateFile, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
    } catch (error) {
      log?.warn(`写入生活状态失败：${error?.message ?? error}`);
    }
  }

  function setActivity(label, ttlMin) {
    state.activity = label;
    state.activitySince = now();
    state.activityTtlMin = ttlMin;
    // 真的换了件事做：临时那层（在回消息）作废
    state.activityOverlay = false;
    state.activityBase = null;
  }

  /** 临时压一层（比如「在手机上回你消息」）：把她本来在干的事记下来，过期自己退回去。 */
  function startOverlay(label, ttlMin) {
    if (!state.activityOverlay && state.activity) {
      state.activityBase = {
        label: state.activity,
        since: state.activitySince,
        ttl: state.activityTtlMin,
      };
    }
    state.activity = label;
    state.activitySince = now();
    state.activityTtlMin = ttlMin;
    state.activityOverlay = true;
  }

  /**
   * 抖音私信通道常驻时会占着浏览器 profile（同一个 profile 只能有一个进程），
   * 这时候刷视频改走「请求/响应文件」，由通道在它的浏览器里代刷。
   */
  async function browseViaChannel({ scroll, limit, likeCount = 0, query = '' }) {
    const lockFile = resolve(root, 'data/douyin/browser.lock');
    const requestFile = resolve(root, 'data/douyin/browse-request.json');
    const resultFile = resolve(root, 'data/douyin/browse-result.json');

    try {
      await unlink(resultFile);
    } catch {
      /* 没有旧结果正好 */
    }
    await writeFile(requestFile, JSON.stringify({ at: now(), scroll, limit, like: likeCount, query }), 'utf8');

    const deadline = now() + 150_000;
    while (now() < deadline) {
      await new Promise((done) => setTimeout(done, 2_000));
      try {
        await stat(lockFile);
      } catch {
        return { list: [], liked: [], delegated: true, reason: 'channel-gone' };
      }
      try {
        const raw = JSON.parse(await readFile(resultFile, 'utf8'));
        if (raw?.items) {
          await unlink(resultFile).catch(() => {});
          log?.info(`代刷返回 ${raw.items.length} 条${raw.liked?.length ? `，点赞 ${raw.liked.filter((l) => l.ok).length}` : ''}`);
          return { list: raw.items, liked: raw.liked ?? [], delegated: true };
        }
      } catch {
        /* 还没写好 */
      }
    }
    log?.warn('代刷超时（私信通道没响应）');
    return { list: [], liked: [], delegated: true, reason: 'timeout' };
  }

  /** 真的开浏览器刷一遍。失败返回空数组，不抛。 */
  async function browse({ scroll = config.lifeBrowseScroll, limit = 25 } = {}) {
    if (browsing) {
      log?.debug('上一次刷抖音还没结束，跳过');
      return { list: [], liked: [], query: '' };
    }
    browsing = true;
    const started = Date.now();
    try {
      // 点赞额度：私信通道常驻和独立开浏览器都要用
      const todayKey = localDay(now());
      const usedToday = state.likeDay === todayKey ? state.likeCount ?? 0 : 0;
      const quota = Math.max(0, Math.min(config.lifeLikePerBrowse, config.lifeLikeMaxPerDay - usedToday));

      // 她自己想搜的东西（心智那一层留下的）：这次刷就搜这个，而不是看推荐
      const curiosity = await takeSearch?.().catch(() => null);
      const query = curiosity?.text ? String(curiosity.text).slice(0, 40) : '';

      const locked = await stat(resolve(root, 'data/douyin/browser.lock'))
        .then(() => true)
        .catch(() => false);
      if (locked) {
        log?.debug('抖音私信通道占着浏览器，改走代刷');
        return await browseViaChannel({ scroll, limit, likeCount: quota, query });
      }

      const result = await new Promise((resolvePromise) => {
        const args = [douyinScript, '--json', '--scroll', String(scroll), '--limit', String(limit)];
        if (query) args.push('--query', query);
        if (quota > 0) {
          args.push('--like', String(quota), '--skip', state.likedIds.slice(-200).join(','));
        }

        const child = spawn(process.execPath, args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], env: process.env });

        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (chunk) => {
          if (stdout.length < 4 * 1024 * 1024) stdout += chunk.toString('utf8');
        });
        child.stderr.on('data', (chunk) => {
          if (stderr.length < 8_000) stderr += chunk.toString('utf8');
        });

        const timerKill = setTimeout(() => {
          log?.warn(`刷抖音超时（${Math.round(config.lifeBrowseTimeoutMs / 1000)}s），已终止`);
          child.kill('SIGKILL');
        }, config.lifeBrowseTimeoutMs);
        timerKill.unref?.();

        child.once('error', (error) => {
          clearTimeout(timerKill);
          log?.warn(`刷抖音启动失败：${error?.message ?? error}`);
          resolvePromise({ list: [], liked: [] });
        });
        child.once('close', (code) => {
          clearTimeout(timerKill);
          if (code !== 0) {
            log?.warn(`刷抖音退出码 ${code}${stderr ? `：${stderr.trim().split('\n').slice(-2).join(' / ')}` : ''}`);
          }
          try {
            const parsed = JSON.parse(stdout);
            const list = Array.isArray(parsed) ? parsed : parsed?.items ?? [];
            const liked = Array.isArray(parsed?.liked) ? parsed.liked : [];
            resolvePromise({ list, liked });
          } catch {
            if (stdout.trim()) log?.warn('刷抖音返回的不是 JSON');
            resolvePromise({ list: [], liked: [] });
          }
        });
      });

      log?.info(
        `刷抖音：拿到 ${result.list.length} 条（${Math.round((Date.now() - started) / 1000)}s）` +
          (query ? `，搜的是「${query}」` : ''),
      );
      return { ...result, query };
    } catch (error) {
      log?.warn(`刷抖音异常：${error?.message ?? error}`);
      return { list: [], liked: [], query: '' };
    } finally {
      browsing = false;
    }
  }

  /** 刷一遍并挑一条存成「待分享」。 */
  async function browseAndPick() {
    setActivity('在刷抖音', 60);
    await save();

    const { list: items, liked, query } = await browse();
    if (liked.length > 0) {
      const day = localDay(now());
      const ok = liked.filter((entry) => entry.ok);
      state.likedIds = [...new Set([...state.likedIds, ...ok.map((entry) => entry.id)])].slice(-300);
      state.likeCount = (state.likeDay === day ? state.likeCount ?? 0 : 0) + ok.length;
      state.likeDay = day;
      log?.info(`点了 ${ok.length} 个赞（今天第 ${state.likeCount}/${config.lifeLikeMaxPerDay} 个）`);
    }
    if (items.length === 0) {
      setActivity('刚合上手机，什么都没刷到', 20);
      await save();
      return null;
    }

    const item = pickCandidate(items, state.seenIds);
    const ids = items.map((entry) => entry.id).filter(Boolean);
    state.seenIds = [...new Set([...state.seenIds, ...ids])].slice(-600);

    bumpBrowseCount(state, localDay(now()));
    state.browseAt = now();
    setActivity('刚刷完抖音，还在回味', 45);

    if (item) {
      state.pendingShare = { item: query ? { ...item, query } : item, at: now() };
      log?.info(query ? `自己搜「${query}」搜到一条：${String(item.desc).slice(0, 30)}` : `刷到一条想分享的：${String(item.desc).slice(0, 40)}`);
    }
    await save();
    return item;
  }

  async function tick() {
    await load();
    if (isBusy?.()) {
      log?.debug('正在回主人消息，这次不去刷抖音');
      return;
    }
    if (config.lifeAutoBrowse === false) {
      // 由她自己决定要不要刷（mind 的「刷」），这里不再定时掷骰子
      log?.debug('自动刷抖音已关：等她自己想刷');
      return;
    }
    const verdict = decideBrowse({ state, now: now(), config });
    if (!verdict.act) {
      log?.debug(`这次不刷抖音：${verdict.reason}`);
      return;
    }
    log?.info('决定去刷一会儿抖音');
    await browseAndPick();
  }

  return {
    load,
    save,
    browse,
    browseAndPick,
    tick,

    start() {
      if (!config.lifeEnabled) {
        log?.info('生活状态：未启用（QQ_LIFE_ENABLED=0）');
        return;
      }
      void load().then(save);
      timer = setInterval(() => void tick(), config.lifeTickMs);
      timer.unref?.();
      log?.info(
        `生活状态：开启（刷抖音最多 ${config.lifeBrowseMaxPerDay} 次/天，间隔≥${config.lifeBrowseMinGapMin} 分钟）`,
      );
    },
    stop() {
      if (timer) clearInterval(timer);
    },

    /** 给对话 prompt 用的状态段落。 */
    async promptSection() {
      await load();
      const parts = [`[你此刻的状态]\n${describeLife(state, now())}`];

      // 饭饭账本：他总问「记了几顿 / 你喂过我几顿」，不给她数字她就只能编
      try {
        const rows = await loadMeals(resolve(root, 'data/life/meals.jsonl'));
        const month = localDay(now()).slice(0, 7);
        const prev = previousMonth(new Date(now()));
        const mine = summarizeMonth(rows, month);
        const last = summarizeMonth(rows, prev);
        parts.push(
          `[饭饭账本] 这个月（${month}）记了 ${mine.count} 顿，其中爸爸投喂 ${mine.fed} 顿；` +
            `上个月（${prev}）${last.count} 顿。` +
            '（他问「记了几顿 / 喂饭记录」就以这里为准，别说错月份、也别编。）',
        );
        // 这阵子的口味：吃得最多的、嘴里常念叨的。她记得住这个才像有人过的日子
        try {
          const cravings = await loadCravings(resolve(root, 'data/life/cravings.jsonl'));
          const taste = tastePromptLine(summarizeTaste({ meals: rows, cravings, now: now(), days: 30 }));
          if (taste) {
            parts.push(
              `${taste}\n（这是你最近的口味。他问「你喜欢吃什么」就照这个说，别编没吃过的。）`,
            );
          }
        } catch {
          /* 统计坏了就当没有 */
        }
        // 今天具体吃了什么：饭账里有自动记的、也有她自己说的。
        // 不给她看，她就会否认自己吃过的饭（空间/房间显示的和她嘴上说的对不上）。
        const today = localDay(now());
        const todays = rows.filter((row) => String(row.day ?? '') === today);
        if (todays.length) {
          const list = todays.map((row) => `${row.slot}${row.dish}`).join('、');
          parts.push(
            `[今天吃了] ${list}\n` +
              '（这是今天的饭账。他问「晚饭吃的什么」「今天吃了啥」就照这个说；' +
              '别否认、也别编账本里没有的。）',
          );
        }
      } catch {
        /* 账本读不到就不提，别让一句话拖垮整轮 */
      }
      const share = freshShare(state, now());
      if (share) {
        const viaSearch = share.item?.query ? `（这条是你自己搜「${share.item.query}」搜出来的）\n` : '';
        parts.push(
          `[你刚刷到的视频]\n${viaSearch}${formatShare(share.item)}\n` +
            '（这是你自己刚刷到的。主人问到你在干嘛、或者话题挨得上，可以自然提一嘴；' +
            '**同一个视频只说一次**，说过的别再提；' +
            '完全不相关就别硬塞。）',
        );
      }
      return parts.join('\n\n');
    },

    /** 主动消息时取一条待分享的视频（取完就清掉，避免重复提）。 */
    async takeShare() {
      await load();
      const share = freshShare(state, now());
      if (!share) return null;
      state.pendingShare = null;
      await save();
      return share.item;
    },

    /** 只看不清：消息发成功后再 clearShare()。 */
    async peekShare() {
      await load();
      return freshShare(state, now())?.item ?? null;
    },

    async clearShare() {
      await load();
      if (!state.pendingShare) return;
      state.pendingShare = null;
      await save();
    },

    /** 她自己说此刻在干嘛（聊天里的【此刻：…】）——写进生活状态，房间和下一轮都会变。 */
    async noteActivity(label, ttlMin = 90) {
      await load();
      const clean = String(label ?? '').replace(/\s+/g, ' ').trim().slice(0, 40);
      if (!clean) return null;
      const ttl = Math.min(240, Math.max(5, Number(ttlMin) || 90));
      setActivity(clean, ttl);
      await save();
      return currentActivity(state, now());
    },

    /**
     * 临时状态：比如「在手机上回你消息」——只是这一刻在做的事，压在她本来在干的事上面，
     * TTL 一到自动退回（刷抖音/发呆/睡觉）。真换了件事做（noteActivity/browse）会直接把它作废。
     */
    async overlayActivity(label, ttlMin = 6) {
      await load();
      const clean = String(label ?? '').replace(/\s+/g, ' ').trim().slice(0, 40);
      if (!clean) return null;
      const ttl = Math.min(60, Math.max(2, Number(ttlMin) || 6));
      startOverlay(clean, ttl);
      await save();
      return currentActivity(state, now());
    },

    /** 只看不用，用于日志/测试。 */
    async peek() {
      await load();
      return { state: { ...state }, activity: currentActivity(state, now()) };
    },

    _state: () => state,
  };
}