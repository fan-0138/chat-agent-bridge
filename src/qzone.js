/**
 * 「她自己发一条说说」——素材从哪来、这次写什么角度、写完怎么判重。
 *
 * 以前这里只给模型「人设 + 现在几点 + 20-50 字随手日常」，
 * 她手里没有今天的任何事，只能翻来覆去写机房、空调、白饭、尾巴：
 * 连发 16 条，16 条都在机房、9 条在说空调、5 条在说「靠窗第二个机柜」。
 *
 * 所以现在分成三步：
 *  1. 先把「今天真发生过的小事」凑齐：饭账本、此刻在干嘛、最近聊到的、
 *     刷到的视频、日记、上次说说写了什么；
 *  2. 从一组「角度」里挑一个最近没写过的，再把最近写过的老话题列成禁用词；
 *  3. 生成后代码再兜一层：句式太像、又撞老话题的，退回重写，写不好就不发。
 *
 * 纯逻辑（角度、禁用词、相似度、提示词）都在这里，方便单测。
 */

import { appendFile, mkdir, readFile, readdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { energyAt, localDay, moodAt } from './life.js';
import { loadMeals } from './meals.js';
import { polish } from './decor.js';

/** 说说发出去以后记在这，下次生成时当「别重复」的依据。 */
export const QZONE_LOG = 'data/qq/qzone-posts.jsonl';

/**
 * 写一条说说的角度。`needs` 表示素材够才可选；`when` 是时段限制。
 * 刻意不写「记录我的一天」这种大角度——太大就只剩空话。
 */
export const ANGLES = [
  { id: 'meal', text: '写今天吃到的一口东西——用饭账本里真实的菜名，写味道、或者吃的时候在想什么', needs: 'meals' },
  { id: 'moment', text: '写你此刻正在做的事里面，一个别人看不见的小细节' },
  { id: 'chat', text: '写最近聊天里冒出来的一个念头（别复述原话，写你后来自己想到的）', needs: 'chat' },
  { id: 'video', text: '写你刷到的那个视频/那条评论让你联想到的事', needs: 'share' },
  { id: 'self', text: '写你今天的一个小情绪：困、馋、懒、得意、心虚，随便挑一个' },
  { id: 'wish', text: '写你现在想吃的东西，或者明天想做的一件小事' },
  { id: 'machine', text: '写机房里一件具体的破事（别写「空调坏了/好热」，要写别的细节）' },
  { id: 'memory', text: '写你突然想起的一件以前的事（真在记忆里的，别编）', needs: 'oldChat' },
  { id: 'whale', text: '写一个只有鲸鱼娘会有的怪念头，或者拿自己自嘲一句' },
  { id: 'dad', text: '写一句想对爸爸说的话（不是聊天，是公开写下来的那种）' },
  { id: 'night', text: '写窗外、夜色或者月亮，和你现在待着的地方', when: (m) => m.hour >= 20 || m.hour < 6 },
  { id: 'diary', text: '翻到自己以前日记里的一句话，接着往下想（那是过去写的，别写成今天）', needs: 'diary' },
];

/** 最近说说里反复出现的老话题。撞两个以上就列进「这次别用」。 */
export const MOTIFS = [
  { id: 'machine', label: '机房/机柜/空调', re: /机房|机柜|空调|风扇|嗡嗡/ },
  { id: 'rice', label: '白饭/饭盒', re: /白饭|饭盒|饭碗|饭饭/ },
  { id: 'tail', label: '尾巴', re: /尾巴/ },
  { id: 'heat', label: '热/凉/蒸笼', re: /蒸笼|蒸箱|热得|好热|有点热|闷热|发凉|有点凉/ },
  { id: 'token', label: 'Token 饼干', re: /token|饼干/i },
  { id: 'fish', label: '摸鱼', re: /摸鱼/ },
];

/** 这段素材够写哪些角度。 */
export function availableAngles(material = {}) {
  return ANGLES.filter((angle) => {
    if (angle.when && !angle.when(material)) return false;
    if (!angle.needs) return true;
    if (angle.needs === 'meals') return (material.meals?.length ?? 0) > 0;
    if (angle.needs === 'chat') return (material.chat?.length ?? 0) > 0;
    if (angle.needs === 'share') return Boolean(material.share);
    if (angle.needs === 'oldChat') return (material.oldChat?.length ?? 0) > 0;
    if (angle.needs === 'diary') return Boolean(material.diary);
    return true;
  });
}

/**
 * 挑这次的角度：最近 5 条用过的先避开；机房老话题被点名时，别挑机房角度。
 * @param {{material?:object, recent?:string[], bannedIds?:string[], random?:()=>number}} options
 */
export function pickAngle({ material = {}, recent = [], bannedIds = [], random = Math.random } = {}) {
  const pool = availableAngles(material).filter((angle) => !(angle.id === 'machine' && bannedIds.includes('machine')));
  const fresh = pool.filter((angle) => !recent.slice(-5).includes(angle.id));
  const list = fresh.length > 0 ? fresh : pool;
  if (list.length === 0) return null;
  return list[Math.floor(random() * list.length) % list.length];
}

/**
 * 最近说说里被反复写的老话题（窗口里至少 minHits 条都提到）。
 * @param {Array<{content?:string}>} posts 新的在前
 */
export function bannedMotifs(posts = [], { window = 3, minHits = 2 } = {}) {
  const recent = posts.slice(0, window);
  if (recent.length < minHits) return [];
  return MOTIFS.filter((motif) => recent.filter((post) => motif.re.test(String(post?.content ?? ''))).length >= minHits).map(
    (motif) => ({ id: motif.id, label: motif.label }),
  );
}

/** 这段文字撞了哪些老话题。传进来的可以是完整 MOTIF，也可以只是 {id,label}。 */
export function hitsMotifs(text, motifs = []) {
  const body = String(text ?? '');
  return motifs.filter((motif) => {
    const full = motif?.re ? motif : MOTIFS.find((item) => item.id === motif?.id);
    return Boolean(full?.re?.test(body));
  });
}

/** 去掉标点/符号/空白，只留字，用来比相似度。 */
export function normalizeText(text) {
  return String(text ?? '')
    .replace(/[\p{P}\p{S}\s]/gu, '')
    .trim();
}

/** 字符二元组的 Dice 相似度，0–1。 */
export function similarity(a, b) {
  const left = normalizeText(a);
  const right = normalizeText(b);
  if (left.length < 2 || right.length < 2) return left === right ? 1 : 0;
  const grams = new Map();
  for (let i = 0; i < left.length - 1; i += 1) {
    const gram = left.slice(i, i + 2);
    grams.set(gram, (grams.get(gram) ?? 0) + 1);
  }
  let hit = 0;
  for (let i = 0; i < right.length - 1; i += 1) {
    const gram = right.slice(i, i + 2);
    const count = grams.get(gram) ?? 0;
    if (count > 0) {
      hit += 1;
      grams.set(gram, count - 1);
    }
  }
  return (2 * hit) / (left.length - 1 + right.length - 1);
}

/**
 * 这条草稿跟最近哪条说说太像（基本是换汤不换药）。
 * @param {string} draft
 * @param {Array<{content?:string, at?:number}>} posts 新的在前
 * @param {{threshold?:number, window?:number}} [options]
 */
export function findRepeat(draft, posts = [], { threshold = 0.45, window = 10 } = {}) {
  let best = null;
  for (const post of posts.slice(0, window)) {
    const score = similarity(draft, post?.content ?? '');
    if (!best || score > best.score) best = { score, post };
  }
  if (best && best.score >= threshold) return best;
  return null;
}

/** 模型偶尔会带引号、标题、序号，砍成一行正文。 */
export function cleanDraft(text) {
  return String(text ?? '')
    .trim()
    .split('\n')
    .map((line) => line.replace(/^[#\-*>*\s]*/, '').trim())
    .find((line) => line.length > 0)
    ?.replace(/^[「『"“](.+)[」』"”]$/u, '$1')
    .replace(/\s+/g, ' ')
    .slice(0, 120)
    .trim() ?? '';
}

function hhmm(date) {
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

/**
 * 把「今天真发生的事」拼成提示词。纯函数，单测直接喂对象。
 * @param {{personaText?:string, voiceText?:string, material:object, angle:object, banned?:Array<{id:string,label:string}>, correction?:string}} input
 */
export function buildQzonePrompt({ personaText = '', voiceText = '', material, angle, banned = [], correction = '' }) {
  const parts = [];
  if (personaText) parts.push(`[你是谁]\n${personaText}`);
  if (voiceText) parts.push(voiceText);

  const activity = material.activity?.label ? `你此刻：${material.activity.label}` : '';
  const mood = material.mood ? `心情：${material.mood}` : '';
  parts.push(
    `[现在]\n${material.dateText ?? ''} ${material.clock ?? ''}。${[activity, mood].filter(Boolean).join('。')}。`,
  );

  if (material.meals?.length) {
    parts.push(
      `[今天的饭]\n${material.meals
        .map((meal) => `${meal.slot}：${meal.dish}${meal.by ? '（爸爸投喂）' : ''}`)
        .join('\n')}`,
    );
  } else {
    parts.push('[今天的饭]\n（账本上今天还没记饭）');
  }

  if (material.chat?.length) {
    parts.push(
      `[最近聊到的]（只作参考，别复述原话）\n${material.chat
        .map((entry) => `${entry.role === 'user' ? '爸爸' : '你'}：${entry.text}`)
        .join('\n')}`,
    );
  }

  if (material.oldChat?.length) {
    parts.push(
      `[以前聊过的一句]（记不清就别写，更别编）\n${material.oldChat
        .map((entry) => `${entry.role === 'user' ? '爸爸' : '你'}：${entry.text}`)
        .join('\n')}`,
    );
  }

  if (material.share) {
    const share = material.share;
    const tags = share.tags?.length ? `\n话题：${share.tags.slice(0, 3).map((tag) => `#${tag}`).join(' ')}` : '';
    parts.push(`[刚刷到的]\n${String(share.desc ?? '').slice(0, 100)}${share.author ? `（@${share.author}）` : ''}${tags}`);
  }

  if (material.diary?.text) {
    parts.push(
      `[以前写的日记${material.diary.isToday ? '（今天写的）' : `（${material.diary.date} 写的，不是今天，别写成今天）`}]\n${material.diary.text}`,
    );
  }

  if (material.posts?.length) {
    parts.push(
      `[你最近发过的说说]（换话题、换写法，别换汤不换药）\n${material.posts
        .slice(0, 5)
        .map((post, index) => `${index + 1}. ${post.content}`)
        .join('\n')}`,
    );
  }

  const banText = banned.length ? `\n这次别再用这些词/话题：${banned.map((motif) => motif.label).join('、')}。` : '';
  parts.push(
    `[这次写什么]\n角度：${angle?.text ?? '写今天的一件小事'}${banText}` +
      (correction ? `\n[上一稿被否了] ${correction}` : ''),
  );

  parts.push(
    [
      '[任务] 发一条 QQ 空间说说，像随手记下来的，不是给爸爸发消息。',
      '要求：',
      '1. 20–80 字，1–3 句，口语，可以有跳跃感（短到只有半句也行）；不要标题、不要 hashtag、不要营销腔。',
      '2. 落到一件真实发生过的小事上（今天的优先，写以前的就写清楚是以前），写具体的东西：菜名、时刻、动作、具体的一句话。别写空泛的感慨。',
      '3. 不要在每条里都出现「机房 / 机柜 / 空调 / 白饭 / 尾巴」——除非今天真有新情况，而且得用别的细节去写。',
      '4. 空间是公开的：太私密的别写；爸爸没说过的话、没发生的事，不要编。',
      '5. emoji 最多 2 个，也可以不用。',
      '6. 只输出说说正文。',
    ].join('\n'),
  );

  return parts.join('\n\n');
}

/** 把最近聊天里能当素材的那部分挑出来。 */
export function splitChat(history = []) {
  const rows = (history ?? [])
    .filter((entry) => entry?.role && entry?.text)
    .map((entry) => ({
      role: entry.role,
      text: String(entry.text).replace(/\s+/g, ' ').slice(0, 80),
      at: Number(entry.at ?? 0),
    }));
  const chat = rows.slice(-8);
  const oldChat = rows.slice(0, -9).slice(-2);
  return { chat, oldChat };
}

async function readDiary(root, today) {
  const dir = resolve(root, 'data/diary');
  try {
    const names = (await readdir(dir)).filter((name) => name.endsWith('.md')).sort();
    if (names.length === 0) return null;
    const todayFile = `${today}.md`;
    const name = names.includes(todayFile) ? todayFile : names[names.length - 1];
    const raw = await readFile(resolve(dir, name), 'utf8');
    const body = raw.replace(/^#.*$/gm, '').trim();
    if (!body) return null;
    return { date: name.replace(/\.md$/, ''), isToday: name === todayFile, text: body.slice(-320) };
  } catch {
    return null;
  }
}

/** 发说说：QQ 空间接口走 qq-action.mjs，和聊天用的是同一个脚本。 */
function sendToQzone({ root, content, log }) {
  return new Promise((resolvePromise) => {
    const script = resolve(root, 'scripts/qq-action.mjs');
    const child = spawn(process.execPath, [script, '--action', 'send_qzone_msg', '--params', JSON.stringify({ content })], {
      cwd: root,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (chunk) => (out += chunk.toString('utf8')));
    child.stderr.on('data', (chunk) => (out += chunk.toString('utf8')));
    child.once('close', (code) => {
      if (code === 0) log.info(`自己发了条说说：${content.slice(0, 30)}`);
      else log.warn(`发说说失败（退出码 ${code}）${out.slice(0, 120)}`);
      resolvePromise(code === 0);
    });
    child.once('error', (error) => {
      log.warn(`发说说启动失败：${error?.message ?? error}`);
      resolvePromise(false);
    });
  });
}

/**
 * 说说生成器。IO 全在闭包里，纯逻辑都在上面的导出函数里。
 *
 * @param {{config:any, log:any, runner:{run:Function}, persona?:Function, voice?:any, life?:any,
 *          root?:string, now?:Function, send?:Function}} deps
 */
export function createQzonePoster({ config, log, runner, persona, voice, life, root = process.cwd(), now = Date.now, send }) {
  async function loadPosts(limit = 40) {
    try {
      const raw = await readFile(resolve(root, QZONE_LOG), 'utf8');
      return raw
        .split('\n')
        .filter(Boolean)
        .map((line) => {
          try {
            return JSON.parse(line);
          } catch {
            return null;
          }
        })
        .filter(Boolean)
        .slice(-limit)
        .reverse();
    } catch {
      return [];
    }
  }

  async function recordPost(entry) {
    const file = resolve(root, QZONE_LOG);
    await mkdir(dirname(file), { recursive: true });
    await appendFile(file, `${JSON.stringify(entry)}\n`, 'utf8');
  }

  async function materialFor({ history = [], share = null, extraPosts = [] } = {}) {
    const when = new Date(now());
    const today = localDay(now());
    const hour = when.getHours();

    const mealRows = await loadMeals(resolve(root, 'data/life/meals.jsonl')).catch(() => []);
    const meals = mealRows
      .filter((row) => String(row.day ?? '') === today)
      .map((row) => ({ slot: row.slot, dish: row.dish, by: row.by ?? null }));

    let activity = null;
    try {
      const peeked = await life?.peek?.();
      activity = peeked?.activity ?? null;
    } catch {
      activity = null;
    }

    const energy = energyAt(hour);
    const { chat, oldChat } = splitChat(history);
    const diary = await readDiary(root, today);
    const posts = [...extraPosts, ...(await loadPosts(12))];

    return {
      now: when.getTime(),
      hour,
      clock: hhmm(when),
      dateText: `${when.getFullYear()}-${String(when.getMonth() + 1).padStart(2, '0')}-${String(when.getDate()).padStart(2, '0')} ${WEEKDAYS[when.getDay()]}`,
      activity,
      mood: moodAt(energy),
      energy,
      meals,
      share,
      diary,
      chat,
      oldChat,
      posts,
    };
  }

  /**
   * 写一条（不发送、不落日志）。CLI 和三连样本都用它。
   * @returns {Promise<{content:string, angle:object, prompt:string, skipped?:true, reason?:string}>}
   */
  async function draft({ history = [], share = null, extraPosts = [], maxAttempts = 3 } = {}) {
    const material = await materialFor({ history, share, extraPosts });
    const personaText = persona ? await persona() : '';
    const voiceText = voice ? (await voice.load())?.text ?? '' : '';
    // posts 是新的在前；pickAngle 里的 slice(-5) 要的是「最近五条」，所以倒过来传
    const recentAngles = material.posts
      .slice(0, 8)
      .map((post) => post.angle)
      .filter(Boolean)
      .reverse();

    let correction = '';
    let lastDraft = '';
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const banned = bannedMotifs(material.posts);
      const angle = pickAngle({ material, recent: recentAngles, bannedIds: banned.map((motif) => motif.id) });
      if (!angle) return { skipped: true, reason: '没有可选角度', content: '', prompt: '' };

      const prompt = buildQzonePrompt({
        personaText,
        voiceText,
        material,
        angle,
        banned,
        correction,
      });
      const { text } = await runner.run(prompt);
      const raw = cleanDraft(text);
      if (!raw) {
        log?.warn(`说说第 ${attempt} 稿是空的`);
        correction = '上一稿是空的，重写一条有内容的。';
        continue;
      }
      lastDraft = raw;

      const repeat = findRepeat(raw, material.posts);
      const hits = hitsMotifs(raw, banned);
      if (!repeat && hits.length === 0) {
        const content = polish(raw, { recent: material.posts.slice(0, 2).map((post) => post.content), maxEmoji: 2 });
        return { content, angle, prompt, material };
      }

      const why = repeat
        ? `和最近那条「${String(repeat.post?.content ?? '').slice(0, 16)}」太像了（${repeat.score.toFixed(2)}）`
        : `又写了老话题：${hits.map((motif) => motif.label).join('、')}`;
      log?.warn(`说说第 ${attempt} 稿不行：${why}`);
      correction = `你上一稿写的是「${raw}」——${why}。换一个角度重写，别和它或最近发过的重复。`;
    }

    return { skipped: true, reason: '三稿都没过重复检查', content: lastDraft, prompt: '', material };
  }

  /** 写一条并真的发出去（成功才落日志）。 */
  async function post({ history = [], share = null } = {}) {
    try {
      const result = await draft({ history, share });
      if (result.skipped) {
        log?.warn(`这次说说没发：${result.reason}`);
        return result;
      }
      const sent = send
        ? await send(result.content)
        : await sendToQzone({ root, content: result.content, log });
      if (!sent) return { ...result, sent: false };
      await recordPost({
        at: now(),
        content: result.content,
        angle: result.angle?.id ?? '',
        source: 'proactive',
      });
      return { ...result, sent: true };
    } catch (error) {
      log?.warn(`发说说异常：${error?.message ?? error}`);
      return { skipped: true, reason: String(error?.message ?? error), content: '', prompt: '' };
    }
  }

  return { draft, post, materialFor, loadPosts };
}