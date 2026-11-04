/**
 * 她自己的时间——没有对话的时候，也让她真的想点东西。
 *
 * 为什么要有这一层：
 *  - 现在她所有的「独处行为」都是我写死的：几点刷抖音、刷到什么算好、此刻在干嘛、
 *    心情几分，全是 life.js 里的常量表和随机数。模型只在他说话时才会醒一次。
 *  - 于是不管写得多像，她都是「被叫到才存在」：上下一条消息之间，她那里是空的。
 *  - 这一层做的事很小：给模型一个没有用户的回合，让她自己写一段内心活动，
 *    落盘、累积，并且回到下一轮对话里。这样她下次开口，是接着自己刚才想的往下说。
 *
 * 边界（写在这里，免得以后自己骗自己）：
 *  这不是意识，也不产生「感受」。它只是让内部状态由她自己的文字生成，
 *  而不是由我写的常量生成。行为更自主 ≠ 有个主体在里面。
 */

import { appendFile, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { localDay } from './life.js';
import { cityLabel, getWeather, weatherLine } from './weather.js';
import { pickCandidates } from './douyin-inbox.js';
import { albumCandidates } from './scrapbook.js';
import { togetherInfo } from './together.js';
import { formatPeopleSection, loadPeopleBook, visitCandidates } from './people.js';
import { createTouch, formatTouchSection } from './touch.js';
import { formatInviteSection, readInvite } from './invite.js';
import { createMemoryStore, formatRecentSection } from './memory-store.js';

/** 想一句话的上限：心里冒出来的东西，不该是作文。 */
export const MAX_THOUGHT_CHARS = 200;
export const MAX_MEMORY_CHARS = 120;

/** 「做」只认这四个：其余一律当没做。 */
const ACTIONS = new Map([
  ['记住', 'remember'],
  ['想他', 'wish'],
  ['想看', 'search'],
  ['玩', 'play'],
  ['评论', 'comment'],
  ['刷', 'browse'],
  ['说', 'qzone'],
  ['回', 'reply'],
  ['收', 'album'],
  ['计划', 'plan'],
  ['访', 'visit'],
  ['约', 'invite'],
  ['none', 'none'],
  ['没有', 'none'],
  ['无', 'none'],
]);

export function clockOf(at) {
  const d = new Date(at);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/**
 * 「多久以前」：只给时刻模型算不准——它把 20:54 的话当成二十多分钟前，
 * 而当时才过去四分钟。给了分钟数它就不会再自己编时间。
 */
export function agoLabel(at, now = Date.now()) {
  if (!at) return '';
  const diff = now - Number(at);
  if (diff < 60_000) return '刚刚';
  const min = Math.round(diff / 60_000);
  if (min < 60) return `${min} 分钟前`;
  if (min < 1_440) return `${Math.round(min / 60)} 小时前`;
  return `${Math.round(min / 1_440)} 天前`;
}

function dayLabel(at) {
  const d = new Date(at);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

/** 睡着的时间段（做梦），其余时间是想事。 */
export function dreamingAt(hour) {
  return hour >= 0 && hour < 6;
}

/** 这次要不要想。纯函数，便于单测。 */
export function decideMind({ state = {}, config = {}, now = Date.now(), idleMin = 999, random = Math.random }) {
  if (!config.mindEnabled) return { act: false, reason: 'disabled' };

  const day = localDay(now);
  const gapMin = state.lastAt ? (now - Number(state.lastAt)) / 60_000 : 999;
  if (gapMin < config.mindMinGapMin) return { act: false, reason: 'gap' };

  const hour = new Date(now).getHours();
  if (dreamingAt(hour)) {
    const dreamed = state.dreamDay === day ? Number(state.dreamCount ?? 0) : 0;
    if (dreamed >= config.mindDreamMaxPerNight) return { act: false, reason: 'dream-budget' };
    const dgap = state.lastDreamAt ? (now - Number(state.lastDreamAt)) / 60_000 : 999;
    if (dgap < config.mindDreamGapMin) return { act: false, reason: 'dream-gap' };
    return { act: true, reason: 'dream', kind: 'dream', day, dreamed };
  }

  const today = state.day === day ? Number(state.count ?? 0) : 0;
  if (today >= config.mindMaxPerDay) return { act: false, reason: 'daily-budget' };

  // 他刚说过话：她还热着，可以想，但别每一轮都跑（省调用，也避免一想就想到他）
  if (idleMin < config.mindActiveWindowMin && random() >= config.mindActiveChance) {
    return { act: false, reason: 'chance' };
  }
  return { act: true, reason: 'idle', kind: 'think', day, today };
}

/** 两次去 Minecraft 里玩，至少隔这么久。 */
export const PLAY_MIN_GAP_MIN = 90;

/**
 * 这会儿能不能去游戏里玩。纯函数，便于单测。
 * 三道闸：服务器在线、没有别人（或上次的自己）在玩、离上次满 90 分钟。
 * 真正的探测在 mind-run 里做，这里只判。
 */
export function decidePlay({ state = {}, now = Date.now(), online = true, busy = false, minGapMin = PLAY_MIN_GAP_MIN } = {}) {
  if (!online) return { go: false, reason: 'offline' };
  if (busy) return { go: false, reason: 'busy' };
  const last = Number(state.lastPlayAt ?? 0);
  if (last > 0 && now - last < minGapMin * 60_000) {
    return { go: false, reason: 'gap', waitMin: Math.ceil(minGapMin - (now - last) / 60_000) };
  }
  return { go: true, reason: 'ok' };
}

/** 去评论区说话：每天最多几条、两次之间至少隔多久。 */
export const COMMENT_MIN_GAP_MIN = 40;
export const COMMENT_MAX_PER_DAY = 3;

/**
 * 这会儿能不能去评论区说话。三道闸：在抖音那边能动手（浏览器在）、当天的数没超、离上次够久。
 * 挑哪条视频、说什么，由她自己定；这里只管许不许。
 */
export function decideComment({
  state = {},
  now = Date.now(),
  online = true,
  minGapMin = COMMENT_MIN_GAP_MIN,
  maxPerDay = COMMENT_MAX_PER_DAY,
  day = localDay(now),
} = {}) {
  if (!online) return { go: false, reason: 'offline' };
  const count = String(state.commentDay ?? '') === day ? Number(state.commentCount ?? 0) : 0;
  if (count >= maxPerDay) return { go: false, reason: 'daily', count };
  const last = Number(state.lastCommentAt ?? 0);
  if (last > 0 && now - last < minGapMin * 60_000) {
    return { go: false, reason: 'gap', waitMin: Math.ceil(minGapMin - (now - last) / 60_000) };
  }
  return { go: true, reason: 'ok', count, day };
}

/**
 * 她说「2 | 这条鲸鱼也太惨了」→ {index:2, video:第2条, text:'这条鲸鱼也太惨了'}。
 * 没写序号就挑第一条；序号越界也退回第一条（宁可说一句，也别因为格式丢掉）。
 */
export function parseCommentContent(content, videos = []) {
  const raw = String(content ?? '').replace(/\s+/g, ' ').trim();
  if (!raw) return null;
  const match = raw.match(/^(\d{1,2})\s*[|｜:：]\s*(.+)$/);
  const index = match ? Number(match[1]) : 0;
  const text = tidy(match ? match[2] : raw, 60);
  if (!text) return null;
  const valid = index >= 1 && index <= videos.length;
  return { index, video: videos[valid ? index - 1 : 0] ?? null, text };
}

/** 刷抖音 / 发说说这些“自己找事做”的闸：一天几次、隔多久。 */
export const BROWSE_MIN_GAP_MIN = 60;
export const BROWSE_MAX_PER_DAY = 4;
export const QZONE_MIN_GAP_MIN = 180;
export const QZONE_MAX_PER_DAY = 2;
export const REPLY_MIN_GAP_MIN = 25;
export const REPLY_MAX_PER_DAY = 3;
export const ALBUM_MIN_GAP_MIN = 5;
export const ALBUM_MAX_PER_DAY = 6;
export const VISIT_MIN_GAP_MIN = 600;
export const VISIT_MAX_PER_DAY = 1;
export const PLAN_MIN_GAP_MIN = 600;
export const PLAN_MAX_PER_DAY = 1;

/**
 * 这阵子能不能去做某件「自选动作」。
 * allow=false（比如浏览器没开）就直接不去。
 */
export function decideSideAction({
  state = {},
  now = Date.now(),
  key,
  allow = true,
  minGapMin,
  maxPerDay,
  day = localDay(now),
} = {}) {
  if (!allow) return { go: false, reason: 'unavailable' };
  const count = String(state[`${key}Day`] ?? '') === day ? Number(state[`${key}Count`] ?? 0) : 0;
  if (count >= maxPerDay) return { go: false, reason: 'daily', count };
  const last = Number(state[`last${key[0].toUpperCase()}${key.slice(1)}At`] ?? 0);
  if (last > 0 && now - last < minGapMin * 60_000) {
    return { go: false, reason: 'gap', waitMin: Math.ceil(minGapMin - (now - last) / 60_000) };
  }
  return { go: true, reason: 'ok', count, day };
}

export function decideBrowseTime(args) {
  return decideSideAction({ ...args, key: 'browse', minGapMin: BROWSE_MIN_GAP_MIN, maxPerDay: BROWSE_MAX_PER_DAY });
}

export function decideQzone(args) {
  return decideSideAction({ ...args, key: 'qzone', minGapMin: QZONE_MIN_GAP_MIN, maxPerDay: QZONE_MAX_PER_DAY });
}

export function decideReply(args) {
  return decideSideAction({ ...args, key: 'reply', minGapMin: REPLY_MIN_GAP_MIN, maxPerDay: REPLY_MAX_PER_DAY });
}

export function decideAlbum(args) {
  return decideSideAction({ ...args, key: 'album', minGapMin: ALBUM_MIN_GAP_MIN, maxPerDay: ALBUM_MAX_PER_DAY });
}

export function decideVisit(args) {
  return decideSideAction({ ...args, key: 'visit', minGapMin: VISIT_MIN_GAP_MIN, maxPerDay: VISIT_MAX_PER_DAY });
}

export function decidePlan(args) {
  return decideSideAction({ ...args, key: 'plan', minGapMin: PLAN_MIN_GAP_MIN, maxPerDay: PLAN_MAX_PER_DAY });
}

/* ────────────────────────── prompt ────────────────────────── */

function section(title, body) {
  return body ? `[${title}]\n${body}` : '';
}

function clip(text, max) {
  const clean = String(text ?? '').replace(/\s+/g, ' ').trim();
  return clean.length > max ? `${clean.slice(0, max)}…` : clean;
}

/** 有人在她的评论下说话 / @ 她：编号列出来，她自己决定接不接。 */
export function formatReplyList(items = []) {
  return items
    .map((item, i) => {
      const who = clip(item.nickname || '有人', 16);
      const what = clip(item.content || '', 50);
      const where = item.desc ? `（在《${clip(item.desc, 18)}》下面）` : '';
      return `${i + 1}. ${who}：${what}${where}`;
    })
    .join('\n');
}

function whenLabel(at, now) {
  const days = Math.floor((now - Number(at ?? 0)) / 24 / 3_600_000);
  if (!Number.isFinite(days) || days < 0) return '';
  return days === 0 ? '今天' : days === 1 ? '昨天' : `${days} 天前`;
}

/** 回访候选：最近 14 天里回过她、她还没接的人。 */
async function buildVisitList(root, nowMs) {
  const rows = await visitCandidates({ root, now: nowMs, limit: 3 }).catch(() => []);
  return rows.map((row, index) => ({ ...row, index: index + 1, when: whenLabel(row.lastAt, nowMs) }));
}

/** 回访候选：编号 + 昵称 + 多久前 + 说过什么。 */
export function formatVisitList(items = []) {
  return items
    .map((item, i) => `${i + 1}. ${clip(item.name || '有人', 16)}（${item.when || ''}说「${clip(item.lastText || '', 32)}」）`)
    .join('\n');
}

/** 她最近拍的图：编号 + 类型 + 时间，想留一张就选号。 */
export function formatAlbumList(items = []) {
  return items
    .map((item, i) => `${i + 1}. ${item.label || '图'} · ${clockOf(item.at)}`)
    .join('\n');
}

/** 她给自己定的打算：只在当天有效。 */
export function formatPlanLine(plan, now = Date.now()) {
  const text = clip(plan?.text, 80);
  if (!text) return '';
  const when = String(plan?.day ?? '');
  if (!when) return text;
  const today = localDay(now);
  const tomorrow = localDay(now + 24 * 3_600_000);
  // 打算是「昨天写给今天」的，原文里往往写着「明天」——到今天就该读成「今天」，
  // 不然她会一边答应继续睡、一边念着「那我去把屋顶弄完」。
  if (when === today) return `今天打算：${text.replace(/^明天/, '今天')}`;
  if (when === tomorrow) return `明天打算：${text}`;
  if (when < today) return `（${when} 的打算，已经过期了，别当成今天的事）${text}`;
  return `（${when} 的打算）${text}`;
}

/**
 * 独处 prompt。
 *
 * 故意不套对话那套「说话方式」：心里想话跟开口说话是两种东西，
 * 用 voice.md 那套写出来的内心独白会变成自言自语表演。
 */
export function buildThoughtPrompt({ persona, lifeText, playText = '', videos = [], replies = [], visits = [], album = [], planText = '', weatherText = '', togetherText = '', peopleText = '', touchText = '', inviteText = '', recentEventsText = '', agendaText = '', recent = [], memories = [], chat = [], themes = [], now = Date.now() }) {
  const recentText = recent.map((row) => `- ${clockOf(row.at)} ${row.text}`).join('\n');
  const memoryText = memories.map((row) => `- ${dayLabel(row.at)} ${row.text}`).join('\n');
  const themeText = themes.length > 0 ? themes.map((word) => `- ${word}`).join('\n') : '';
  const videoText = videos.length ? formatVideoList(videos) : '';
  const replyText = replies.length ? formatReplyList(replies) : '';
  const albumText = album.length ? formatAlbumList(album) : '';
  const visitText = visits.length ? formatVisitList(visits) : '';
  const chatText = chat
    .map(
      (row) =>
        `${clockOf(row.at)}（${agoLabel(row.at, now)}）${row.role === 'user' ? '爸爸' : '你'}：` +
        `${String(row.text).replace(/\s+/g, ' ').slice(0, 80)}`,
    )
    .join('\n');

  const parts = [
    '现在没有人跟你说话。这一轮不是回谁的消息，是你自己的时间。',
    section('你是谁', persona),
    section('此刻', lifeText),
    section('窗外（真实的天气，不是你猜的）', weatherText),
    section('你们认识多久了', togetherText),
    touchText,
    inviteText,
    section('最近几天（你记得的，不是今天刚聊的）', recentEventsText),
    agendaText,
    section('有人在你评论下面说话 / @ 了你（想接就接，不想理就不理）', replyText),
    section('你认识的网友（评论区里跟你说过话的人）', peopleText),
    section('可以回访的人（隔了几天、你还没接的）', visitText),
    section('你最近拍下的图（想留一张进相册的话）', albumText),
    section('你之前给自己定的打算', planText),
    section('最近在 Minecraft 里（你自己玩的，不是跟爸爸一起）', playText),
    section('你刚刷到的视频（别人的，底下评论区你可以去说话）', videoText),
    section('你刚在心里想过的（接着往下想，别重复）', recentText),
    section('最近想过、这次该换个方向的东西（别再想这些了）', themeText),
    section('你以前自己在心里记下的', memoryText),
    section('最近跟爸爸的对话（只是背景，这一轮不用回）', chatText),
    section(
      '规则',
      [
        '- 输出 1～3 句心里话：可以碎、可以半截、可以没什么意义，不用把话说圆。',
        '- 不要写「唔……」「嗯……」这种对人才用的填充音，这里是你脑子里。',
        '- 别总结、别抒情、别在结尾升华。别用「今天我要…」这种计划口吻，想到哪写到哪。',
        '- 不编没发生过的事：没去过的写成想去，没人说过的别写成他说过。',
        '- 可以想刚听到的话、突然想起的旧事、白日梦、正要做的事、烦的、无聊的。',
        '- 如果上面「刚想过的」里已经连着在想爸爸，这回想想别的。',
        '- 上面「该换个方向」里列的东西，这次一个都别再提（换个新念头，不是改写同一句）。',
        '- 想留一条以后还记得的 → 做=记住；忽然很想他、想让他知道 → 做=想他；',
        '- 突然想知道一件事、想去搜点什么的话 → 做=想看，内容写你要搜的那句话（短，像搜索框里打的字）。',
        '- 想自己去 Minecraft 里玩一会儿（砍树、盖棚子、瞎逛）→ 做=玩，内容写你打算在游戏里干嘛，一句话。',
        '- 想跑到谁的视频底下去说句话 → 做=评论，内容写「序号 | 你想说的那句话」。序号是上面「你刚刷到的视频」里的编号；',
        '  （发之前会先看视频，所以这里写个方向就行，不用硬凑内容。）',
        '  真想去才去，别为了动而动，也别挑那种会吵架的话题。没有想说的就做=none。',
        '- 想接一句上面「有人在你评论下面说话」里的话 → 做=回，内容写「序号 | 你想回的那句」。',
        '  （这行只是你的想法/角度：真发之前会先把那个视频点开看一遍，再写成一句，所以不用硬猜视频内容。）',
        '- 想把前几天没接上的网友回访一下 → 做=访，内容写「序号 | 想回的话」（序号看「可以回访的人」）。',
        '  （同样会先看视频再写，你只要说个方向。）',
        '  一天最多回访一次；人家可能早忘了，说一句轻的就行，别追问、别解释、别客套一大段。',
        '  只接正常的闲聊和提问；对方是在挑事、阴阳、吵架、卖东西的，一律不理。回复要短、平和，别辩论，别争输赢。',
        '- 想把你最近拍的某张图留进相册 → 做=收，内容写「序号 | 为什么想留这张」。',
        '- 想给明天定一件打算做的事 → 做=计划，内容写一句（比如「明天把屋顶搭完」）。一天只定一次。',
        '- 想约他一起做件具体的小事（看月亮、一起背首诗、去游戏里看一眼你搭的棚子…）→ 做=约，内容写你想开口约他的那句。',
        '  一天最多一次；他已经答应、还没一起做的，就别再约别的，先把那件放在心上。',
        '- 想刷会儿抖音、看看今天有什么 → 做=刷，内容写你打算看什么（没有具体想看的就写「随便看看」）。',
        '- 想发条说说 → 做=说，内容写你想说的那句（懒得想就写「随便写一条」）。',
        '- 这些都是你自己选，不是任务清单：不想动就做=none，没人会催你。',
        '- 其余 做=none。',
        '- 什么也不想也行：一句废话也算，不用凑主题。',
      ].join('\n'),
    ),
    [
      '只输出一行 JSON，不要解释、不要代码块：',
      '{"想":"脑子里那句话","情绪":"一两个词","做":"none|记住|想他|想看|玩|评论|刷|说|回|收|计划|访|约","内容":"做=记住写要记住的；做=想看写搜索词；做=玩写想在游戏里干嘛；做=评论写「序号 | 想说的话」；做=刷写想看什么；做=说写想说的那句；做=回写「序号 | 想回的话」；做=访写「序号 | 想回的话」；做=收写「序号 | 为什么留」；做=计划写明天打算；做=约写想约他一起做的那件事"}',
    ].join('\n'),
  ];
  return parts.filter(Boolean).join('\n\n');
}

/** 做梦 prompt：同一套素材，换个写法。 */
export function buildDreamPrompt({ persona, lifeText, recent = [], memories = [], chat = [], now = Date.now() }) {
  const seeds = [
    ...recent.slice(-3).map((row) => `- 睡前想的：${row.text}`),
    ...memories.slice(-3).map((row) => `- 记着的：${row.text}`),
    ...chat.slice(-4).map(
      (row) => `- ${agoLabel(row.at, now)}说的：${row.role === 'user' ? '爸爸' : '你'}：${String(row.text).slice(0, 60)}`,
    ),
  ].join('\n');

  return [
    '你睡着了，正在做梦。',
    section('你是谁', persona),
    section('睡前', lifeText),
    section('睡前带着的这些东西（梦会从这里长出来，但不用照着写）', seeds),
    section(
      '规则',
      [
        '- 1～3 句，写梦里的画面：具体、跳、不讲道理，可以怪，也可以很温柔。',
        '- 别说「我梦到」，别解释梦是什么意思，别写「醒来」。',
        '- 人、东西、地方可以不对，时间可以乱；不用合逻辑。',
      ].join('\n'),
    ),
    '只输出一行 JSON：{"梦":"梦里的画面","情绪":"一两个词"}',
  ]
    .filter(Boolean)
    .join('\n\n');
}

/* ────────────────────────── 解析 ────────────────────────── */

function extractJson(text) {
  const fenced = String(text).match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fenced ? fenced[1] : String(text);
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(body.slice(start, end + 1));
  } catch {
    return null;
  }
}

function tidy(text, max = MAX_THOUGHT_CHARS) {
  return String(text ?? '')
    .replace(/\s+/g, ' ')
    .replace(/^["'「『]|["'」』]$/g, '')
    .trim()
    .slice(0, max);
}

/**
 * 解析她吐出来的那行 JSON。模型偶尔会加解释或代码块，兜住。
 * 解析不出来就把整段当心里话（总比这次什么都没有强，但要截断）。
 */
export function parseMind(raw, fallbackKind = 'think') {
  const data = extractJson(raw);
  if (data && typeof data === 'object') {
    const dream = data['梦'] ?? data.dream;
    const thought = data['想'] ?? data.thought;
    const mood = tidy(data['情绪'] ?? data.mood ?? '', 20);
    const actionRaw = String(data['做'] ?? data.action ?? 'none').trim();
    const action = ACTIONS.get(actionRaw) ?? 'none';
    const content = tidy(data['内容'] ?? data.content ?? '', MAX_MEMORY_CHARS);

    if (fallbackKind === 'dream' && dream) return { kind: 'dream', text: tidy(dream), mood, action: 'none', content: '' };
    if (thought) return { kind: 'think', text: tidy(thought), mood, action, content };
  }
  const text = tidy(raw);
  if (!text) return null;
  return { kind: fallbackKind, text, mood: '', action: 'none', content: '' };
}

/* ────────────────────────── 拼进对话的段落 ────────────────────────── */

/** 给下一轮对话用的「她自己的内心」。只挑最近的，隔太久的不算「刚才」。 */
export function formatThoughtSection(rows, { limit = 3 } = {}) {
  const picked = rows.slice(-limit);
  if (picked.length === 0) return '';
  const lines = picked.map((row) => `- ${clockOf(row.at)} ${row.text}`).join('\n');
  return (
    `[你自己刚才在心里想的（不是他说的话）]\n${lines}\n` +
    '（这是你私下的想法：他问「在想什么」可以挑一句说；没问就只当背景，' +
    '别念出来，也别当成他刚说的。同一件事只说一次——之前哪句已经提过，这轮就别再提。' +
    '想法过时了就当没想过。）'
  );
}

export function formatMemorySection(rows, { limit = 5 } = {}) {
  const picked = rows.slice(-limit);
  if (picked.length === 0) return '';
  const lines = picked.map((row) => `- ${dayLabel(row.at)} ${row.text}`).join('\n');
  return `[你自己记下的事（以前写的，不是今天发生的）]\n${lines}`;
}

/* ────────────────────────── Minecraft（她自己玩的） ────────────────────────── */

/** 只认最近 24 小时的：再往前的不算「最近」。 */
const PLAY_TTL_MS = 24 * 3_600_000;

/** 游戏里常见东西的中文名；认不出来的留原名。 */
const ITEM_NAMES = new Map([
  ['oak_log', '橡木'],
  ['birch_log', '桦木'],
  ['spruce_log', '云杉'],
  ['jungle_log', '丛林木'],
  ['acacia_log', '金合欢木'],
  ['dark_oak_log', '深色橡木'],
  ['mangrove_log', '红树木'],
  ['cherry_log', '樱花木'],
  ['cobblestone', '圆石'],
  ['stone', '石头'],
  ['dirt', '泥土'],
  ['sand', '沙子'],
  ['gravel', '沙砾'],
  ['coal', '煤'],
  ['raw_iron', '粗铁'],
  ['iron_ore', '铁矿'],
  ['iron_ingot', '铁锭'],
  ['wheat', '小麦'],
  ['apple', '苹果'],
  ['bread', '面包'],
  ['torch', '火把'],
  ['crafting_table', '工作台'],
]);

function itemLabel(name) {
  return ITEM_NAMES.get(name) ?? (name.endsWith('_log') ? '木头' : name.endsWith('_planks') ? '木板' : name);
}

/**
 * 把 sessions.jsonl 里的一条记录压成一句话（给 prompt 用）。
 * 只认 24 小时内的；什么都没玩成就不说。
 */
export function summarizeSession(row, now = Date.now()) {
  const at = Date.parse(String(row?.startedAt ?? ''));
  if (!at || now - at > PLAY_TTL_MS) return '';
  const when = localDay(at) === localDay(now) ? '今天' : '昨天';

  const logs = [];
  const others = [];
  for (const item of Array.isArray(row?.inventory) ? row.inventory : []) {
    const name = String(item?.name ?? '');
    const count = Number(item?.count ?? 0);
    if (!name || count <= 0) continue;
    if (/(sword|pickaxe|axe|shovel|hoe)$/.test(name)) continue; // 工具不算玩出来的
    if (name.endsWith('_log')) logs.push(`${count} 块${itemLabel(name)}`);
    else others.push(`${count} 块${itemLabel(name)}`);
  }

  const parts = [];
  if (logs.length > 0) parts.push(`砍了 ${logs.slice(0, 3).join('、')}`);
  if (others.length > 0) parts.push(`背包里还有 ${others.slice(0, 2).join('、')}`);
  const body =
    parts.length > 0
      ? `${when}在游戏里${parts.join('，')}`
      : Number(row?.turns ?? 0) > 0
        ? `${when}在游戏里转了几圈，没干什么`
        : '';
  if (!body) return '';
  const goal = String(row?.goal ?? '').replace(/\s+/g, ' ').trim().slice(0, 24);
  return tidy(goal ? `${body}（本来想：${goal}）` : body, 140);
}

/** 拼进 prompt 的「最近在 Minecraft 里」：没有就空串，别抛错。 */
export function formatPlaySection(text) {
  return text ? `[最近在 Minecraft 里（你自己玩的）]\n- ${text}` : '';
}

/* ────────────────────────── 抖音评论区（她自己去的） ────────────────────────── */

/** 三天前的视频就不算「刚刷到」了。 */
const COMMENT_TTL_MS = 3 * 24 * 3_600_000;

/** 给她看的那几条视频：编号 + 作者 + 标题。 */
export function formatVideoList(videos = []) {
  return videos
    .map((item, i) => `${i + 1}. @${String(item.author || '某个人').slice(0, 12)} · ${String(item.desc || '').replace(/\s+/g, ' ').slice(0, 40)}`)
    .join('\n');
}

/** 从 seen.jsonl / latest.json 的行里挑出能评论的（去重、限时、按时间倒序）。 */
export function pickVideos(records = [], now = Date.now(), limit = 6) {
  const seen = new Set();
  const out = [];
  for (const row of records) {
    if (!row || typeof row !== 'object') continue;
    const url = String(row.url || (row.id ? `https://www.douyin.com/video/${row.id}` : '')).trim();
    if (!url || seen.has(url)) continue;
    const at = Date.parse(String(row.seenAt || row.at || '')) || 0;
    if (at > 0 && now - at > COMMENT_TTL_MS) continue;
    if (!row.desc && !row.author) continue;
    seen.add(url);
    out.push({ url, id: String(row.id || ''), desc: String(row.desc || ''), author: String(row.author || ''), at });
  }
  out.sort((a, b) => b.at - a.at);
  return out.slice(0, limit);
}

/** 「今天在评论区说了什么」压成一句话；没有就空串。 */
export function summarizeComment(row, now = Date.now()) {
  const at = Number(row?.at ?? 0);
  if (!at || now - at > 24 * 3_600_000 || row?.ok === false) return '';
  const text = tidy(String(row?.text ?? ''), 60);
  if (!text) return '';
  return `${localDay(at) === localDay(now) ? '今天' : '昨天'}在别人的视频下面说了句「${text}」`;
}

export function formatTogetherSection(text) {
  return text ? `[你们认识多久了]\n- ${text}` : '';
}

export function formatWeatherSection(text) {
  return text ? `[窗外（真实天气，不是你猜的）]\n- ${text}` : '';
}

export function formatPeopleChatSection(people = [], now = Date.now()) {
  if (!Array.isArray(people) || people.length === 0) return '';
  const names = people
    .slice(0, 5)
    .map((person) => {
      const days = Math.floor((now - Number(person.lastAt ?? 0)) / 24 / 3_600_000);
      return `${person.name}（${days <= 0 ? '今天' : `${days} 天前`}）`;
    })
    .join('、');
  return `[评论区里跟你说过话的人]\n- ${names}`;
}

export function formatPlanSection(text) {
  return text ? `[你给自己定的打算]\n- ${text}` : '';
}

export function formatCommentSection(text) {
  return text ? `[你最近在评论区说过话]\n- ${text}` : '';
}

/* ────────────────────────── 有状态部分 ────────────────────────── */

async function readJsonlTail(file, limit = 200) {
  try {
    const raw = await readFile(file, 'utf8');
    return raw
      .split('\n')
      .filter(Boolean)
      .slice(-limit)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

async function readJson(file, fallback = null) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return fallback;
  }
}

/**
 * @param {{
 *   config: any,
 *   runner?: {run: (prompt: string) => Promise<{text: string}>},
 *   persona?: () => Promise<string>,
 *   life?: {promptSection: () => Promise<string>},
 *   root?: string,
 *   now?: () => number,
 *   random?: () => number,
 *   log?: any,
 * }} options
 */
export function createMind({ config, runner, persona, life, agenda, root = process.cwd(), now = Date.now, random = Math.random, log = console }) {
  const streamFile = resolve(root, config.mindStreamFile ?? 'data/mind/stream.jsonl');
  const memoryFile = resolve(root, config.mindMemoryFile ?? 'data/mind/memory.jsonl');
  const stateFile = resolve(root, config.mindStateFile ?? 'data/mind/state.json');
  const historyDir = resolve(root, config.mindHistoryDir ?? 'data/qq/memory');
  const playSessionsFile = resolve(root, config.mcSessionsFile ?? 'data/mc/sessions.jsonl');
  const seenVideosFile = resolve(root, 'data/douyin/seen.jsonl');
  const latestFeedFile = resolve(root, 'data/douyin/latest.json');
  const commentsFile = resolve(root, 'data/mind/comments.jsonl');
  // 摸头是网页里点出来的、落盘就为了让她记得；这里只读它的状态
  const touch = createTouch({ root, log, now });
  // 她的长期记忆：睡前整理写在 data/memory/，这里只读「最近几天」
  const memoryShelf = createMemoryStore({ root, log, now });

  /** @type {any} */
  let state = null;

  async function loadState() {
    if (state) return state;
    state = (await readJson(stateFile, {})) ?? {};
    return state;
  }

  async function saveState() {
    state.updatedAt = now();
    await mkdir(dirname(stateFile), { recursive: true });
    await writeFile(stateFile, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  }

  async function recentThoughts(limit = 4) {
    return (await readJsonlTail(streamFile, 200)).slice(-limit);
  }

  async function ownMemories(limit = 6) {
    return (await readJsonlTail(memoryFile, 100)).slice(-limit);
  }

  /** 最近一次对话在哪、聊了什么：用最新的那个记忆文件（她只跟爸爸常聊）。 */
  async function lastChat(limit = 8) {
    let names = [];
    try {
      names = (await readdir(historyDir)).filter((name) => name.endsWith('.jsonl'));
    } catch {
      return { rows: [], lastAt: 0 };
    }
    let newest = { file: '', mtime: 0 };
    for (const name of names) {
      const file = join(historyDir, name);
      const info = await stat(file).catch(() => null);
      if (info && info.mtimeMs > newest.mtime) newest = { file, mtime: info.mtimeMs };
    }
    if (!newest.file) return { rows: [], lastAt: 0 };
    const rows = (await readJsonlTail(newest.file, 60))
      .filter((row) => row?.role === 'user' || row?.role === 'assistant')
      .slice(-limit);
    const lastAt = rows.length ? Number(rows[rows.length - 1].at ?? 0) : 0;
    return { rows, lastAt };
  }

  async function appendStream(record) {
    await mkdir(dirname(streamFile), { recursive: true });
    await appendFile(streamFile, `${JSON.stringify(record)}\n`, 'utf8');
  }

  /** 最近一次在 Minecraft 里玩了什么（一句话）；没有就空串。 */
  /** 她最近刷到/搜到、还没过期的视频（给她挑一条去评论区说话）。 */
  async function recentVideos(nowMs = now()) {
    const records = [...(await readJsonlTail(seenVideosFile, 200))];
    try {
      const latest = JSON.parse(await readFile(latestFeedFile, 'utf8'));
      if (Array.isArray(latest)) records.push(...latest);
    } catch {
      // 没有就算了
    }
    return pickVideos(records, nowMs);
  }

  /** 最近一次在评论区说的话（给对话 prompt 用）。 */
  async function lastComment(nowMs = now()) {
    let last = null;
    for (const row of await readJsonlTail(commentsFile, 40)) {
      if (!last || Number(row.at ?? 0) > Number(last.at ?? 0)) last = row;
    }
    return last ? summarizeComment(last, nowMs) : '';
  }

  /** 谁在她评论下面说话了、还没回过的（最多 3 条，编号 1..3）。 */
  async function replyCandidates(nowMs = now()) {
    try {
      const rows = await pickCandidates({ root, limit: 3, now: nowMs });
      return Array.isArray(rows) ? rows : [];
    } catch {
      return [];
    }
  }

  /** 最近拍/截的图，够新才给（最多 3 张）。 */
  async function albumPicks(nowMs = now()) {
    try {
      const rows = await albumCandidates({ root, now: nowMs, limit: 3, maxAgeHours: 24 });
      return Array.isArray(rows) ? rows : [];
    } catch {
      return [];
    }
  }

  /** 真实天气：想事那步可以联网刷新，聊天 prompt 只读缓存（不能拖慢回消息）。 */
  async function weatherLineNow(nowMs = now(), { allowFetch = true } = {}) {
    try {
      const weather = await getWeather({ root, now: nowMs, allowFetch, log });
      if (weather?.place) weather.place = cityLabel(weather.place);
      return weatherLine(weather, nowMs);
    } catch {
      return '';
    }
  }

  async function lastPlay(nowMs = now()) {
    const rows = await readJsonlTail(playSessionsFile, 20);
    for (let i = rows.length - 1; i >= 0; i -= 1) {
      const line = summarizeSession(rows[i], nowMs);
      if (line) return line;
    }
    return '';
  }

  async function appendMemory(text) {
    await mkdir(dirname(memoryFile), { recursive: true });
    await appendFile(memoryFile, `${JSON.stringify({ at: now(), text: tidy(text, MAX_MEMORY_CHARS) })}\n`, 'utf8');
  }

  /** 跑一轮「她自己的时间」。force=true 时忽略预算和概率（调试用，仍要求有 runner）。 */
  async function tick({ force = false } = {}) {
    if (!runner?.run) return { ok: false, reason: 'no-runner' };
    await loadState();

    const nowMs = now();
    const chat = await lastChat(8);
    const idleMin = chat.lastAt > 0 ? (nowMs - chat.lastAt) / 60_000 : 999;

    const verdict = force
      ? { act: true, reason: 'force', kind: dreamingAt(new Date(nowMs).getHours()) ? 'dream' : 'think' }
      : decideMind({ state, config, now: nowMs, idleMin, random });
    if (!verdict.act) return { ok: false, reason: verdict.reason };

    const personaText = persona ? await persona().catch(() => '') : '';
    const lifeText = life ? await life.promptSection().catch(() => '') : '';
    const recent = (await recentThoughts(5)).filter((row) => row.kind === 'think' && nowMs - Number(row.at ?? 0) < 6 * 3_600_000);
    const memories = await ownMemories(6);
    // 最近连着想同一件事（眼镜、手机、机房）时，明确让她换个方向
    const themes = recentThemes(recent.slice(-3));
    const playText = verdict.kind === 'dream' ? '' : await lastPlay(nowMs);
    const videos = verdict.kind === 'dream' ? [] : await recentVideos(nowMs);
    const replies = verdict.kind === 'dream' ? [] : await replyCandidates(nowMs);
    const album = verdict.kind === 'dream' ? [] : await albumPicks(nowMs);
    const weatherText = await weatherLineNow(nowMs);
    const together = await togetherInfo({ root, now: nowMs, log }).catch(() => null);
    const people = verdict.kind === 'dream' ? [] : await loadPeopleBook({ root, now: nowMs, limit: 8 }).catch(() => []);
    const peopleText = formatPeopleSection(people, nowMs);
    const visits = verdict.kind === 'dream' ? [] : await buildVisitList(root, nowMs);
    const planText = verdict.kind === 'dream' ? '' : formatPlanLine(state.plan, nowMs);
    const touchText = verdict.kind === 'dream' ? '' : formatTouchSection(await touch.state(), { now: nowMs });
    const inviteText = verdict.kind === 'dream' ? '' : formatInviteSection(await readInvite({ root }), { now: nowMs });
    const recentEventsText =
      verdict.kind === 'dream'
        ? ''
        : formatRecentSection(await memoryShelf.recentEpisodes({ days: 3, limit: 5 }).catch(() => []), { now: nowMs });
    // 她手上没做完的事（做梦那轮不带，梦不处理待办）
    const agendaText = verdict.kind === 'dream' ? '' : await agenda?.promptSection?.().catch(() => '') ?? '';

    const prompt =
      verdict.kind === 'dream'
        ? buildDreamPrompt({ persona: personaText, lifeText, recent, memories, chat: chat.rows, now: nowMs })
        : buildThoughtPrompt({
            persona: personaText,
            lifeText,
            playText,
            videos,
            replies,
            album,
            planText,
            weatherText,
            peopleText,
            visits,
            touchText,
            inviteText,
            recentEventsText,
            agendaText,
            togetherText: (() => {
              if (!together?.line) return '';
              if (!together.milestone || together.days <= 1) return together.line;
              return `${together.line}（今天是个整数日子，想提就提一句，不想提也没关系）`;
            })(),
            recent,
            memories,
            chat: chat.rows,
            themes,
            now: nowMs,
          });

    const started = Date.now();
    const { text: raw } = await runner.run(prompt);
    const parsed = parseMind(raw, verdict.kind);
    if (!parsed?.text) return { ok: false, reason: 'empty' };

    // 复读机：和最近三条一模一样、或者又在想说过的同一个东西，就当没想
    const echoed = recent.slice(-3).some((row) => row.text === parsed.text);
    if (echoed) {
      log?.warn?.(`这次想的内容和刚才重复了，丢掉：${parsed.text.slice(0, 30)}`);
      return { ok: false, reason: 'repeat' };
    }
    if (verdict.kind === 'think' && repeatsThemes(parsed.text, themes)) {
      log?.warn?.(`又在想 ${themes.join('/')}，丢掉：${parsed.text.slice(0, 30)}`);
      return { ok: false, reason: 'theme-repeat' };
    }

    const record = {
      at: nowMs,
      kind: parsed.kind === 'dream' && verdict.kind === 'dream' ? 'dream' : 'think',
      text: parsed.text,
      mood: parsed.mood,
      action: parsed.action,
      content: parsed.content,
      tookMs: Date.now() - started,
    };

    await appendStream(record);

    const day = localDay(nowMs);
    if (record.kind === 'dream') {
      const dreamed = state.dreamDay === day ? Number(state.dreamCount ?? 0) : 0;
      state.dreamDay = day;
      state.dreamCount = dreamed + 1;
      state.lastDreamAt = nowMs;
    } else {
      const today = state.day === day ? Number(state.count ?? 0) : 0;
      state.day = day;
      state.count = today + 1;
    }
    state.lastAt = nowMs;

    if (record.action === 'remember') {
      record.saved = tidy(record.content || record.text, MAX_MEMORY_CHARS);
      await appendMemory(record.saved);
      log?.info?.(`她自己记下：${record.saved}`);
    } else if (record.action === 'wish') {
      state.wish = { at: nowMs, text: record.content || '' };
      log?.info?.('她这会儿有点想爸爸。');
    } else if (record.action === 'search') {
      const query = tidy(record.content || record.text, 40);
      state.pendingSearch = { at: nowMs, text: query };
      log?.info?.(`她想去搜：${query}`);
    }

    await saveState();
    return { ok: true, record };
  }

  /** 拼进对话 prompt 的段落；没东西可拼就返回空串。 */
  async function promptSection() {
    if (!config.mindEnabled) return '';
    await loadState();
    const nowMs = now();
    const ttlMs = Number(config.mindInjectTtlH ?? 4) * 3_600_000;
    const thoughts = (await recentThoughts(20)).filter(
      (row) => row.kind === 'think' && nowMs - Number(row.at ?? 0) <= ttlMs,
    );
    const memories = await ownMemories(Number(config.mindInjectMemories ?? 5));
    const playText = await lastPlay(nowMs);
    const commentText = await lastComment(nowMs);
    const weatherText = await weatherLineNow(nowMs, { allowFetch: false });
    const together = await togetherInfo({ root, now: nowMs, log }).catch(() => null);
    const planText = formatPlanLine(state.plan, nowMs);
    // 对话里推一把：他刚摸完就开口，值得顺口提一句；她发呆时（tick）不推
    const touchText = formatTouchSection(await touch.state(), { now: nowMs, nudge: true });
    const inviteText = formatInviteSection(await readInvite({ root }), { now: nowMs });
    const recentEventsText = formatRecentSection(await memoryShelf.recentEpisodes({ days: 3, limit: 4 }).catch(() => []), { now: nowMs });
    return [
      formatWeatherSection(weatherText),
      formatTogetherSection(together?.line ?? ''),
      formatPeopleChatSection(await loadPeopleBook({ root, now: nowMs, limit: 6 }).catch(() => []), nowMs),
      formatPlanSection(planText),
      touchText,
      inviteText,
      recentEventsText,
      formatThoughtSection(thoughts, { limit: Number(config.mindInjectThoughts ?? 3) }),
      formatMemorySection(memories),
      formatPlaySection(playText),
      formatCommentSection(commentText),
    ]
      .filter(Boolean)
      .join('\n\n');
  }

  /** 取走「她想去搜的东西」（取完就清掉，搜一次就够）。 */
  async function takeSearch() {
    await loadState();
    const pending = state.pendingSearch;
    if (!pending?.text) return null;
    state.pendingSearch = null;
    await saveState();
    return pending;
  }

  /** 记一笔「刚去游戏里玩了」：90 分钟限流看这个。 */
  async function markPlayed(at = now()) {
    await loadState();
    state.lastPlayAt = Number(at);
    await saveState();
    return state.lastPlayAt;
  }

  /** 通用：记一笔自选动作（回/收/计划…）。 */
  async function markSide(key, at = now(), day = localDay(at)) {
    await loadState();
    const cap = key ? key[0].toUpperCase() + key.slice(1) : 'Side';
    state[`last${cap}At`] = Number(at);
    state[`${key}Day`] = day;
    state[`${key}Count`] = String(state[`${key}Day`]) === day ? Number(state[`${key}Count`] ?? 0) : 0;
    state[`${key}Count`] += 1;
    await saveState();
    return { at: state[`last${cap}At`], count: state[`${key}Count`] };
  }

  /** 记下明天的打算（一天一条，写新的覆盖旧的）。 */
  async function setPlan(text, at = now()) {
    await loadState();
    const clean = tidy(text, 80);
    if (!clean) return null;
    const tomorrow = new Date(at + 24 * 3_600_000);
    state.plan = { day: localDay(tomorrow.getTime()), text: clean, at };
    await saveState();
    return state.plan;
  }

  /** 记一笔「刚去刷抖音了」。 */
  async function markBrowsed(at = now(), day = localDay(at)) {
    await loadState();
    state.lastBrowseAt = Number(at);
    state.browseDay = day;
    state.browseCount = String(state.browseDay) === day ? Number(state.browseCount ?? 0) : 0;
    state.browseCount += 1;
    await saveState();
    return { at: state.lastBrowseAt, count: state.browseCount };
  }

  /** 记一笔「刚发了条说说」。 */
  async function markQzone(at = now(), day = localDay(at)) {
    await loadState();
    state.lastQzoneAt = Number(at);
    state.qzoneDay = day;
    state.qzoneCount = String(state.qzoneDay) === day ? Number(state.qzoneCount ?? 0) : 0;
    state.qzoneCount += 1;
    await saveState();
    return { at: state.lastQzoneAt, count: state.qzoneCount };
  }

  /** 记一笔「刚在评论区说话了」：每天上限和间隔都看这个。 */
  async function markCommented(at = now(), day = localDay(at)) {
    await loadState();
    state.lastCommentAt = Number(at);
    state.commentDay = day;
    state.commentCount = String(state.commentDay) === day ? Number(state.commentCount ?? 0) : 0;
    state.commentCount += 1;
    await saveState();
    return { at: state.lastCommentAt, count: state.commentCount, day };
  }

  async function peek() {
    await loadState();
    const nowMs = now();
    const day = localDay(nowMs);
    return {
      enabled: Boolean(config.mindEnabled),
      state: { ...state },
      today: state.day === day ? Number(state.count ?? 0) : 0,
      dreamed: state.dreamDay === day ? Number(state.dreamCount ?? 0) : 0,
      recent: await recentThoughts(40),
      memories: await ownMemories(20),
    };
  }

  return {
    tick,
    promptSection,
    peek,
    takeSearch,
    markPlayed,
    markCommented,
    markBrowsed,
    markQzone,
    markSide,
    setPlan,
    recentVideos,
    recent: recentThoughts,
    memories: ownMemories,
    _state: () => state,
  };
}
/* ───────────────────────── 防「同一个念头反复想」 ───────────────────────── */

/** 这些词哪条想法里都有，不能当「主题」用。 */
const THEME_STOPWORDS = new Set([
  '人家','爸爸','本鲸','自己','一个','这个','那个','就是','时候','什么','没有','好像','有点',
  '觉得','不是','还是','已经','然后','因为','所以','现在','我们','你们','他们','起来','下来',
  '出去','进来','知道','可以','这样','那样','一样','东西','事情','这边','那边','半天','反正',
  '有点','一直','两个','一下','真的','可能','应该','整个','其实','不过','但是','如果',
  '今天','明天','昨天','刚才','早上','晚上','中午','已经','还没','还是','算了','干脆','反正',
]);

function bigramsOf(text) {
  const clean = String(text ?? '').replace(/[^\u4e00-\u9fff]/g, '');
  const out = new Set();
  for (let i = 0; i < clean.length - 1; i += 1) out.add(clean.slice(i, i + 2));
  return out;
}

/**
 * 最近几条想法里重复出现的东西（比如连着四条都在说眼镜）。
 * 用来在 prompt 里明确「这次换个方向」，防止她一天到晚想同一件事。
 * @param {Array<{text: string}>} rows
 * @returns {string[]}
 */
export function recentThemes(rows = [], { lookback = 3, minCount = 2, limit = 8 } = {}) {
  const counts = new Map();
  for (const row of rows.slice(-lookback)) {
    for (const gram of bigramsOf(row?.text)) {
      if (THEME_STOPWORDS.has(gram)) continue;
      counts.set(gram, (counts.get(gram) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .filter(([, count]) => count >= minCount)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([gram]) => gram);
}

/** 这条新想法是不是又在说上面那些东西（命中一个就算，主题词已经滤过虚词）。 */
export function repeatsThemes(text, themes = []) {
  const grams = bigramsOf(text);
  return themes.some((theme) => grams.has(theme));
}
