#!/usr/bin/env node
/**
 * 她自己的时间——一个常驻的小进程。
 *
 *   npm run mind                      # 常驻：每 10 分钟左右让她自己想一次
 *   npm run mind -- --once            # 立刻想一次（忽略预算，调试用）
 *   npm run mind -- --status          # 看她最近都想什么了
 *   npm run mind -- --review          # 立刻跑一次睡前复盘（今天哪句想错了）
 *   npm run mind -- --interval 5      # 换成 5 分钟一次
 *   npm run mind -- --play-dry "去砍树" # 只打印要给游戏拼的参数，不起进程
 *   npm run mind -- --comment-dry "2|这句话"  # 只打印要去哪条视频下说什么
 *
 * 为什么是独立进程：
 *  - 想事这件事不该绑在「回消息」上，桥接重启也不该把她的时间清空；
 *  - 挂了也只影响她自己想事，不会挡住他说话（桥接读不到新想法会自动退回）。
 *
 * 想出来的东西落在 data/mind/stream.jsonl；她说「记住」的落 data/mind/memory.jsonl。
 * 下一轮对话时这两份会一起进 prompt，所以她是接着自己刚才想的往下说。
 * 她说「玩」的话，detach 一个 tools/mc/play.mjs 去玩，日志在 data/mc/play-daemon.log。
 */

import { closeSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { execFile, execFileSync, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadQqConfig } from '../src/config-qq.js';
import { createLogger } from '../src/log.js';
import { createPersona } from '../src/persona.js';
import { createLife, localDay } from '../src/life.js';
import {
  createMind,
  decideAlbum,
  decideBrowseTime,
  decideComment,
  decidePlay,
  decidePlan,
  decideVisit,
  decideQzone,
  decideReply,
  formatAlbumList,
  formatReplyList,
  parseCommentContent,
} from '../src/mind.js';
import { pickCandidates } from '../src/douyin-inbox.js';
import { visitCandidates } from '../src/people.js';
import { albumCandidates, saveToAlbum } from '../src/scrapbook.js';
import { createInvite, decideInvite, readInvite } from '../src/invite.js';
import { digest as digestMemory } from '../src/memory-digest.js';
import { createLessons, reviewDue, reviewLessons } from '../src/lessons.js';
import { createMemoryStore } from '../src/memory-store.js';
import { createAgenda } from '../src/agenda.js';
import { createUsage } from '../src/usage.js';
import { createHealth } from '../src/health.js';
import { createNotifier } from '../src/notify-send.js';
import { createBudget } from '../src/budget.js';
import { maybeSleepMc, wakeMc } from '../tools/mc/idle-guard.mjs';
import { runMaintenance } from './maintenance.mjs';
import { createDshRunner } from '../src/dsh.js';
import { createApiKeySource, resolveDshCommand } from '../src/credentials.js';

const args = process.argv.slice(2);
const has = (name) => args.includes(`--${name}`);
const arg = (name, fallback = '') => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? (args[i + 1] ?? fallback) : fallback;
};
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

function fmtClock(at) {
  const d = new Date(at);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/* ──────────────────── 她自己去 Minecraft 里玩 ──────────────────── */

const PLAY_SCRIPT = 'tools/mc/play.mjs';
const PLAY_MINUTES = 4;
const PLAY_PID_FILE = 'data/mc/play-daemon.pid';
const PLAY_LOG_FILE = 'data/mc/play-daemon.log';
const MC_API = process.env.MC_API || 'http://127.0.0.1:8772';
const PLAY_DRY = process.env.QQ_MIND_PLAY_DRY === '1' || args.includes('--dry-run');

/** 起的游戏子进程参数（抽出来单测；--play-dry 看的就是它）。 */
export function playArgs(goal) {
  return ['--env-file-if-exists=.env.qq', PLAY_SCRIPT, '--minutes', String(PLAY_MINUTES), '--goal', goal];
}

/** 游戏服务器在不在线：不在就不玩，别起个进程干等。 */
async function mcOnline() {
  try {
    const res = await fetch(`${MC_API}/status`, { signal: AbortSignal.timeout(3000) });
    return Boolean((await res.json())?.online);
  } catch {
    return false;
  }
}

/** 这个 pid 还活着、而且确实是 play.mjs？（防 pid 被别的进程复用后一直挡着） */
function playPidAlive(pid) {
  try {
    process.kill(pid, 0);
    const cmd = execFileSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' });
    return cmd.includes(PLAY_SCRIPT);
  } catch {
    return false;
  }
}

/** 已经有一个在玩了？先看 pid 文件，再用 pgrep 兜住别人手动起的。 */
function playRunning(root) {
  try {
    const pid = Number(readFileSync(resolve(root, PLAY_PID_FILE), 'utf8').trim());
    if (Number.isInteger(pid) && pid > 0 && playPidAlive(pid)) return true;
  } catch {
    // pid 文件没有 / 进程已经没了：往下兜底
  }
  try {
    execFileSync('pgrep', ['-f', PLAY_SCRIPT], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/** detach 起一个游戏进程：不挡她的循环，输出全进 play-daemon.log。 */
function startPlay({ root, goal, log }) {
  const logFile = resolve(root, PLAY_LOG_FILE);
  mkdirSync(dirname(logFile), { recursive: true });
  const fd = openSync(logFile, 'a');
  try {
    const child = spawn(process.execPath, playArgs(goal), {
      cwd: root,
      detached: true, // 独立进程组：她的循环停了也不连坐
      stdio: ['ignore', fd, fd],
      env: process.env,
    });
    child.on('error', (error) => log?.warn?.(`游戏进程起不来：${error?.message ?? error}`));
    child.unref();
    mkdirSync(dirname(resolve(root, PLAY_PID_FILE)), { recursive: true });
    writeFileSync(resolve(root, PLAY_PID_FILE), `${child.pid}\n`, 'utf8');
    return child.pid;
  } finally {
    closeSync(fd);
  }
}

/**
 * tick 说她想去玩：限流、在线探测都过了才真起进程。
 * QQ_MIND_PLAY_DRY=1 / --dry-run 时只打印「本来要玩：<内容>」，不起进程、不落 state。
 */
export async function maybePlay({ root, mind, log, record, dry = PLAY_DRY }) {
  const goal = String(record?.content || record?.text || '').replace(/\s+/g, ' ').trim().slice(0, 120) || '自己去逛逛';
  if (dry) {
    console.log(`本来要玩：${goal}`);
    return { started: false, reason: 'dry-run' };
  }
  // 小世界可能在睡觉：她真想玩的时候先叫醒它，叫不醒再按离线处理
  let online = await mcOnline();
  if (!online) {
    log?.info?.('小世界在睡觉，先叫醒它');
    online = await wakeMc({ root, log }).catch(() => false);
  }
  const verdict = decidePlay({ state: mind?._state?.() ?? {}, online, busy: playRunning(root) });
  if (!verdict.go) {
    const why =
      verdict.reason === 'gap'
        ? `刚玩过，还要等 ${verdict.waitMin} 分钟`
        : ({ offline: '服务器不在线', busy: '已经有一个在玩' }[verdict.reason] ?? verdict.reason);
    log?.debug?.(`这次不去游戏里玩：${why}`);
    return { started: false, reason: verdict.reason };
  }
  const pid = startPlay({ root, goal, log });
  await mind?.markPlayed?.();
  log?.info?.(`她去 Minecraft 里玩了（pid ${pid}，${PLAY_MINUTES} 分钟）：${goal}`);
  return { started: true, pid };
}

/* ──────────────────── 她自己去评论区说话 ──────────────────── */

const COMMENT_SCRIPT = 'scripts/douyin-comment-note.mjs';
const COMMENT_LOG_FILE = 'data/douyin/comment-daemon.log';
const COMMENT_DRY = process.env.QQ_MIND_COMMENT_DRY === '1' || args.includes('--dry-run-comment');
const CDP_URL = process.env.QQ_DOUYIN_HOST_CDP?.trim() || 'http://127.0.0.1:9223';

/** 抖音那边的浏览器还开着吗（评论要靠它，没开就别起进程干等）。 */
async function browserOnline() {
  try {
    const res = await fetch(`${CDP_URL}/json/version`, { signal: AbortSignal.timeout(3000) });
    return res.ok;
  } catch {
    return false;
  }
}

/** detach 起一个「去评论区说话」的进程，输出进 comment-daemon.log。 */
function startComment({ root, url, text, why, log }) {
  const logFile = resolve(root, COMMENT_LOG_FILE);
  mkdirSync(dirname(logFile), { recursive: true });
  const fd = openSync(logFile, 'a');
  try {
    const child = spawn(
      process.execPath,
      [COMMENT_SCRIPT, '--url', url, '--text', text, '--why', String(why || '').slice(0, 80)],
      { cwd: root, detached: true, stdio: ['ignore', fd, fd], env: process.env },
    );
    child.on('error', (error) => log?.warn?.(`去评论区的进程起不来：${error?.message ?? error}`));
    child.unref();
    return child.pid;
  } finally {
    closeSync(fd);
  }
}

/**
 * tick 说她想去评论区说话：选视频、查闸、起进程。
 * 内容格式是「序号 | 想说的话」；序号对应想事 prompt 里那几条视频。
 */
export async function maybeComment({ root, mind, log, record, dry = COMMENT_DRY, runner, personaText }) {
  const raw = String(record?.content || record?.text || '');
  const videos = (await mind?.recentVideos?.()) ?? [];
  const parsed = parseCommentContent(raw, videos);

  if (dry) {
    const video = parsed?.video;
    console.log(
      video
        ? `本来要在这条下面说：「${parsed.text}」\n  @${video.author} · ${String(video.desc).slice(0, 40)}\n  ${video.url}`
        : `本来要去评论区说：「${parsed?.text ?? raw}」（没有可选的视频）`,
    );
    return { started: false, reason: 'dry-run' };
  }
  if (!parsed) {
    log?.debug?.('这次不去评论区：内容为空');
    return { started: false, reason: 'empty' };
  }
  if (!parsed.video) {
    log?.debug?.('这次不去评论区：最近没有能挑的视频');
    return { started: false, reason: 'no-video' };
  }

  const verdict = decideComment({ state: mind?._state?.() ?? {}, online: await browserOnline() });
  if (!verdict.go) {
    const why =
      verdict.reason === 'gap'
        ? `刚说过话，还要等 ${verdict.waitMin} 分钟`
        : ({ offline: '抖音浏览器没开', daily: '今天说得够多了' }[verdict.reason] ?? verdict.reason);
    log?.debug?.(`这次不去评论区：${why}`);
    return { started: false, reason: verdict.reason };
  }

  // 先看视频再开口（她原来只看标题，容易说岔）
  const composed = await composeForPosting({
    root,
    log,
    runner,
    personaText,
    url: parsed.video.url,
    fallbackDesc: parsed.video.desc,
    draft: parsed.text,
    kind: 'comment',
  });
  const guarded = replyGuard(composed.text);
  if (guarded) {
    log?.warn?.(`这句评论不发了（${guarded}）：${composed.text.slice(0, 40)}`);
    return { started: false, reason: 'unsafe-reply' };
  }

  const pid = startComment({ root, url: parsed.video.url, text: composed.text, why: record?.内容 || record?.text, log });
  await mind?.markCommented?.();
  log?.info?.(`她跑去评论区说话了（pid ${pid}）：@${parsed.video.author} 下面「${composed.text.slice(0, 40)}」`);
  return { started: true, pid, video: parsed.video.url, text: composed.text, readVideo: Boolean(composed.context) };
}

/* ──────────────────── 她自己决定去刷抖音 / 发说说 ──────────────────── */

/** 起一个脱钩的子进程（刷抖音、发说说都是这样跑）。 */
function spawnSide({ root, script, args = [], logFile, env = process.env, log }) {
  const file = resolve(root, logFile);
  mkdirSync(dirname(file), { recursive: true });
  const fd = openSync(file, 'a');
  try {
    const child = spawn(process.execPath, [script, ...args], {
      cwd: root,
      detached: true,
      stdio: ['ignore', fd, fd],
      env,
    });
    child.on('error', (error) => log?.warn?.(`${script} 起不来：${error?.message ?? error}`));
    child.unref();
    return child.pid;
  } finally {
    closeSync(fd);
  }
}

/** 她说「想刷会儿抖音」：她自己起的，代码只负责有没有浏览器、今天刷够没有。 */
export async function maybeBrowse({ root, mind, log, record, dry = process.env.QQ_MIND_BROWSE_DRY === '1' }) {
  const goal = String(record?.content || record?.text || '').replace(/\s+/g, ' ').trim().slice(0, 60);
  if (dry) {
    console.log(`本来要自己去刷抖音：${goal || '随便看看'}`);
    return { started: false, reason: 'dry-run' };
  }
  const verdict = decideBrowseTime({ state: mind?._state?.() ?? {}, allow: await browserOnline() });
  if (!verdict.go) {
    const why =
      verdict.reason === 'gap'
        ? `刚刷过，还要等 ${verdict.waitMin} 分钟`
        : ({ unavailable: '抖音浏览器没开', daily: '今天刷得够多了' }[verdict.reason] ?? verdict.reason);
    log?.debug?.(`这次不去刷抖音：${why}`);
    return { started: false, reason: verdict.reason };
  }
  const pid = spawnSide({ root, script: 'src/life-now.mjs', args: ['--browse'], logFile: 'data/mind/browse-daemon.log', log });
  await mind?.markBrowsed?.();
  log?.info?.(`她自己跑去刷抖音了（pid ${pid}）${goal ? `：${goal}` : ''}`);
  return { started: true, pid };
}

/** 她说「想发条说说」：她自己起的，走同一套说说生成器。 */
export async function maybeQzone({ root, mind, log, record, dry = process.env.QQ_MIND_QZONE_DRY === '1' }) {
  if (dry) {
    console.log(`本来要发一条说说：${String(record?.content || '').slice(0, 60) || '随便写一条'}`);
    return { started: false, reason: 'dry-run' };
  }
  const verdict = decideQzone({ state: mind?._state?.() ?? {} });
  if (!verdict.go) {
    const why =
      verdict.reason === 'gap'
        ? `刚发过，还要等 ${verdict.waitMin} 分钟`
        : ({ daily: '今天发得够多了' }[verdict.reason] ?? verdict.reason);
    log?.debug?.(`这次不发说说：${why}`);
    return { started: false, reason: verdict.reason };
  }
  const pid = spawnSide({ root, script: 'scripts/qzone-write.mjs', args: ['--post'], logFile: 'data/mind/qzone-daemon.log', log });
  await mind?.markQzone?.();
  log?.info?.(`她自己发了条说说（pid ${pid}）`);
  return { started: true, pid };
}

/* ──────────────────── 开口之前先看视频 ──────────────────── */

const execFileAsync = promisify(execFile);

/**
 * 先看视频再说话：读标题/作者/热评。
 * 拿不到就返回 null，后面退回按标题猜（总比不看强，但不能装看过）。
 */
async function readVideoContext({ root, url, log }) {
  if (!url) return null;
  try {
    const { stdout } = await execFileAsync(process.execPath, ['scripts/douyin-video-context.mjs', '--url', url], {
      cwd: root,
      timeout: 90_000,
      maxBuffer: 2 * 1024 * 1024,
    });
    const data = JSON.parse(String(stdout).trim().split('\n').pop());
    return data?.ok ? data : null;
  } catch (error) {
    log?.debug?.(`读视频失败：${error?.message ?? error}`);
    return null;
  }
}

/** 把视频读到的内容拼成一段给模型看。 */
function videoBrief(context, fallbackDesc = '') {
  if (!context) return fallbackDesc ? `大概内容：${fallbackDesc}` : '';
  const lines = [];
  if (context.desc) lines.push(`标题：${context.desc}`);
  if (context.author) lines.push(`作者：${context.author}`);
  // DOM 里偶尔把「作者」这类标签当成评论抓进来，滤掉
  const NOISE = /^(作者|分享|回复|展开|收起|置顶|广告|相关推荐)$/;
  const comments = (context.comments ?? []).filter((comment) => comment && !NOISE.test(String(comment).trim())).slice(0, 4);
  if (comments.length) {
    lines.push('热评：');
    for (const comment of comments) lines.push(`  · ${comment}`);
  }
  return lines.join('\n');
}

/**
 * 看过视频之后，把她那句话重新写成一句真的接得上的回复。
 * 失败就退回她自己写的那版（后面还有 replyGuard 兜着）。
 */
async function composeReply({ runner, personaText, brief, person, said, draft, kind }) {
  if (!runner?.run) return draft || '';
  const prompt = [
    personaText ? `[你是谁]\n${personaText}` : '',
    `[这条视频讲什么]\n${brief || '（没读到，别硬编内容）'}`,
    `[对方]\n${person || '有人'}：${said || '（没留下文字）'}`,
    draft ? `[你原本的想法]\n${draft}` : '',
    kind === 'visit' ? '[情况] 这是前几天没接上的话，今天回去补一句，别说教、别道歉一大段。' : '',
    '[任务] 写一句要发到评论区的话：8～30 个字，口语，像真人随手打字；',
    '要跟视频内容或对方那句有关；不确定的内容别编；不辩论、不抬杠、不教育人；',
    '不要写「哈哈」「支持」「路过」这种空话；只输出这一句，不要引号、不要解释。',
  ]
    .filter(Boolean)
    .join('\n\n');
  try {
    const { text } = await runner.run(prompt);
    const line = String(text ?? '')
      .split('\n')
      .map((row) => row.trim())
      .filter(Boolean)[0] ?? '';
    return line.replace(/^[「『"'“]+|[」』"'”]+$/g, '').trim() || draft || '';
  } catch (error) {
    return draft || '';
  }
}

/** 开口之前：读视频 → 带着内容重写一句 → 再发。 */
export async function composeForPosting({ root, log, runner, personaText, url, fallbackDesc = '', person = '', said = '', draft = '', kind = 'comment' }) {
  const context = await readVideoContext({ root, url, log });
  const brief = videoBrief(context, fallbackDesc);
  const text = await composeReply({ runner, personaText, brief, person, said, draft, kind });
  return { text, brief, context };
}

/* ──────────────────── 她回别人的话 / 收张图 / 定明天的打算 ──────────────────── */

/** 「2 | 想回的话」→ {index, text}；没序号就用第一句。 */
function parseIndexed(content) {
  const raw = String(content ?? '').replace(/\s+/g, ' ').trim();
  if (!raw) return null;
  const match = raw.match(/^(\d{1,2})\s*[|｜:：]\s*(.+)$/);
  return { index: match ? Number(match[1]) : 0, text: match ? match[2].trim() : raw };
}

/** 回别人的话也不能越界：太冲、太长、带脏字的一律不发。 */
const REPLY_GUARD = /(傻|蠢|滚|闭嘴|垃圾|废物|恶心|有病|拉黑|举报|吵|杠|骂|滚蛋|神经病)/;
function replyGuard(text) {
  const clean = String(text ?? '').trim();
  if (!clean) return '空';
  if (clean.length > 40) return '太长';
  if (REPLY_GUARD.test(clean)) return '带火气';
  return '';
}

/** 她说「回」：从没回过的留言里挑一条，接一句。 */
export async function maybeReply({ root, mind, log, record, dry = process.env.QQ_MIND_REPLY_DRY === '1', runner, personaText }) {
  const parsed = parseIndexed(record?.content || record?.text);
  const candidates = (await pickCandidates({ root, limit: 5 }).catch((error) => {
    log?.warn?.(`读回复候选失败：${error?.message ?? error}`);
    return [];
  })) ?? [];
  const picked = parsed
    ? candidates[parsed.index >= 1 && parsed.index <= candidates.length ? parsed.index - 1 : 0]
    : null;
  const guarded = parsed ? replyGuard(parsed.text) : '空';
  if (dry && guarded) {
    console.log(`这句本来也不会发（${guarded}）：「${parsed?.text ?? ''}」`);
    return { started: false, reason: 'unsafe-reply' };
  }

  if (dry) {
    console.log(
      picked
        ? `本来要回 ${picked.nickname}：「${parsed.text}」\n  在她评论下：${picked.content}\n  ${picked.videoUrl}`
        : `本来要回一句：「${parsed?.text ?? ''}」（没有可回的留言）`,
    );
    return { started: false, reason: 'dry-run' };
  }
  if (!parsed || !picked) {
    log?.debug?.('这次不去回评论：没有可接的留言');
    return { started: false, reason: 'no-target' };
  }
  if (guarded) {
    log?.warn?.(`这句不发了（${guarded}）：${parsed.text.slice(0, 40)}`);
    return { started: false, reason: 'unsafe-reply' };
  }

  const verdict = decideReply({ state: mind?._state?.() ?? {}, allow: await browserOnline() });
  if (!verdict.go) {
    log?.debug?.(`这次不接评论：${verdict.reason === 'gap' ? '刚回过，歇会儿' : verdict.reason}`);
    return { started: false, reason: verdict.reason };
  }

  // 先看视频再回：别对着标题和一句 @ 就乱接
  const composed = await composeForPosting({
    root,
    log,
    runner,
    personaText,
    url: picked.videoUrl,
    fallbackDesc: picked.desc,
    person: picked.nickname,
    said: picked.content,
    draft: parsed.text,
    kind: 'reply',
  });
  const finalGuard = replyGuard(composed.text);
  if (finalGuard) {
    log?.warn?.(`这句回复不发了（${finalGuard}）：${composed.text.slice(0, 40)}`);
    return { started: false, reason: 'unsafe-reply' };
  }

  const file = resolve(root, 'data/douyin/reply-daemon.log');
  mkdirSync(dirname(file), { recursive: true });
  const fd = openSync(file, 'a');
  try {
    const child = spawn(
      process.execPath,
      [
        // 在人家评论底下回复（楼中楼）：接口那条路回 ok 但不落地，只能走界面
        'scripts/douyin-reply-ui.mjs',
        '--url', picked.videoUrl,
        '--match', String(picked.content || '').slice(0, 12),
        '--text', composed.text.slice(0, 40),
        '--nid', String(picked.nid),
        '--why', `回 ${picked.nickname}`,
      ],
      { cwd: root, detached: true, stdio: ['ignore', fd, fd], env: process.env },
    );
    child.on('error', (error) => log?.warn?.(`回评论起不来：${error?.message ?? error}`));
    // 子进程是 detached 的，但 mind-run 活得比它久，exit 事件照样收得到。
    // 不盯这一下的话，日志会先写「她回了…」，账本后来说没发出去，人就被骗了。
    child.on('exit', (code) => {
      if (code === 0) return;
      log?.warn?.(`回 ${picked.nickname} 那句没落地（exit ${code}），原因在 data/mind/comments.jsonl 最后一行`);
    });
    child.unref();
  } finally {
    closeSync(fd);
  }
  // 「回过了」由 douyin-reply-ui 在**确认落地之后**自己写（失败要能重试），这里只管占额度
  await mind?.markSide?.('reply');
  log?.info?.(`她去回 ${picked.nickname} 了：「${composed.text.slice(0, 30)}」${composed.context ? '（看过视频）' : ''}`);
  return { started: true, target: picked.nickname, text: composed.text, readVideo: Boolean(composed.context) };
}

/** 她说「收」：把最近某张图收进相册，写一句为什么。 */
export async function maybeAlbum({ root, mind, log, record, dry = process.env.QQ_MIND_ALBUM_DRY === '1' }) {
  const parsed = parseIndexed(record?.content || record?.text);
  const candidates = (await albumCandidates({ root, limit: 5, maxAgeHours: 24 }).catch(() => [])) ?? [];
  const picked = parsed
    ? candidates[parsed.index >= 1 && parsed.index <= candidates.length ? parsed.index - 1 : 0]
    : null;
  const guarded = parsed ? replyGuard(parsed.text) : '空';
  if (dry && guarded) {
    console.log(`这句本来也不会发（${guarded}）：「${parsed?.text ?? ''}」`);
    return { started: false, reason: 'unsafe-reply' };
  }

  if (dry) {
    console.log(
      picked
        ? `本来要把「${picked.label} ${picked.relPath}」收进相册，写：${parsed.text}`
        : `本来要收一张图（没有新图可选）`,
    );
    return { started: false, reason: 'dry-run' };
  }
  if (!parsed || !picked) return { started: false, reason: 'no-target' };

  const verdict = decideAlbum({ state: mind?._state?.() ?? {} });
  if (!verdict.go) return { started: false, reason: verdict.reason };

  const saved = await saveToAlbum({
    root,
    srcPath: picked.path,
    note: parsed.text,
    source: picked.kind,
    at: Date.now(),
  });
  if (!saved?.ok) {
    log?.warn?.(`收进相册失败：${saved?.reason ?? '未知'}`);
    return { started: false, reason: 'save-failed' };
  }
  await mind?.markSide?.('album');
  log?.info?.(`她收了一张图进相册：${saved.relPath}`);
  return { started: true, path: saved.relPath };
}

/** 她说「访」：回访一个前几天没接上的网友。 */
export async function maybeVisit({ root, mind, log, record, dry = process.env.QQ_MIND_VISIT_DRY === '1', runner, personaText }) {
  const parsed = parseIndexed(record?.content || record?.text);
  const candidates = (await visitCandidates({ root, limit: 5 }).catch(() => [])) ?? [];
  const picked = parsed
    ? candidates[parsed.index >= 1 && parsed.index <= candidates.length ? parsed.index - 1 : 0]
    : null;

  if (dry) {
    console.log(
      picked
        ? `本来要回访 ${picked.name}：「${parsed.text}」\n  上次说：${String(picked.lastText).slice(0, 40)}\n  ${picked.lastVideoUrl}`
        : `本来要回访一句：「${parsed?.text ?? ''}」（没有可回访的人）`,
    );
    return { started: false, reason: 'dry-run' };
  }
  if (!parsed || !picked) return { started: false, reason: 'no-target' };
  const guarded = replyGuard(parsed.text);
  if (guarded) {
    log?.warn?.(`回访这句不发了（${guarded}）：${parsed.text.slice(0, 40)}`);
    return { started: false, reason: 'unsafe-reply' };
  }
  const verdict = decideVisit({ state: mind?._state?.() ?? {}, allow: await browserOnline() });
  if (!verdict.go) {
    log?.debug?.(`这次不回访：${verdict.reason === 'gap' ? '刚回访过，隔久点' : verdict.reason}`);
    return { started: false, reason: verdict.reason };
  }

  // 回访也先看一眼那个视频再说话
  const composed = await composeForPosting({
    root,
    log,
    runner,
    personaText,
    url: picked.lastVideoUrl,
    person: picked.name,
    said: picked.lastText,
    draft: parsed.text,
    kind: 'visit',
  });
  const finalGuard = replyGuard(composed.text);
  if (finalGuard) {
    log?.warn?.(`这句回访不发了（${finalGuard}）：${composed.text.slice(0, 40)}`);
    return { started: false, reason: 'unsafe-reply' };
  }

  const file = resolve(root, 'data/douyin/reply-daemon.log');
  mkdirSync(dirname(file), { recursive: true });
  const fd = openSync(file, 'a');
  try {
    const child = spawn(
      process.execPath,
      [
        'scripts/douyin-comment-note.mjs',
        '--url', picked.lastVideoUrl,
        '--text', composed.text.slice(0, 40),
        '--reply-cid', String(picked.lastCommentId),
        '--root-cid', String(picked.lastRootCommentId || picked.lastCommentId),
        '--nid', String(picked.lastNid),
        '--why', `回访 ${picked.name}`,
      ],
      { cwd: root, detached: true, stdio: ['ignore', fd, fd], env: process.env },
    );
    child.on('error', (error) => log?.warn?.(`回访进程起不来：${error?.message ?? error}`));
    child.unref();
  } finally {
    closeSync(fd);
  }
  await mind?.markSide?.('visit');
  log?.info?.(`她回访了 ${picked.name}：「${composed.text.slice(0, 30)}」${composed.context ? '（看过视频）' : ''}`);
  return { started: true, target: picked.name, text: composed.text, readVideo: Boolean(composed.context) };
}

/** 她说「计划」：给明天定一件事，不用起进程。 */
export async function maybePlan({ root, mind, log, record, dry = process.env.QQ_MIND_PLAN_DRY === '1' }) {
  const text = String(record?.content || record?.text || '').trim();
  if (dry) {
    console.log(`本来要给明天定个打算：${text || '（空）'}`);
    return { started: false, reason: 'dry-run' };
  }
  const verdict = decidePlan({ state: mind?._state?.() ?? {} });
  if (!verdict.go) return { started: false, reason: verdict.reason };
  const plan = await mind?.setPlan?.(text);
  await mind?.markSide?.('plan');
  log?.info?.(`她给明天定了打算：${plan?.text ?? text}`);
  return { started: true, text: plan?.text ?? text };
}

/** 发一条私聊：走 qq-action，和定时喊人是同一条路，不受桥接限流。 */
async function sendPrivate({ root, to, text }) {
  try {
    const { stdout } = await execFileAsync(
      process.execPath,
      ['scripts/qq-action.mjs', '--action', 'send_private_msg', '--params', JSON.stringify({ user_id: Number(to), message: text })],
      { cwd: root, timeout: 30_000, maxBuffer: 1024 * 1024 },
    );
    // qq-action 打的是缩进过的 JSON，整段解析，别只取最后一行
    const data = JSON.parse(String(stdout).trim());
    if (data?.retcode === 0 || data?.status === 'ok') return { ok: true };
    return { ok: false, error: JSON.stringify(data).slice(0, 200) };
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error).slice(0, 200) };
  }
}

/**
 * 她说「约」：约爸爸一起做件具体的小事，发一条 QQ，然后等他应。
 * 先发再落盘：发不出去就当没说出口，明天还能再约，不会留一条假的「他没回」。
 */
export async function maybeInvite({ root, mind, log, record, ownerQQ = '', dry = process.env.QQ_MIND_INVITE_DRY === '1' }) {
  const text = String(record?.content || record?.text || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 40);
  if (dry) {
    console.log(`本来要约爸爸一起做件事：${text || '（空）'}`);
    return { started: false, reason: 'dry-run' };
  }
  if (!text) return { started: false, reason: 'empty' };

  const invite = await readInvite({ root }).catch(() => null);
  const verdict = decideInvite({ state: mind?._state?.() ?? {}, invite });
  if (!verdict.go) {
    const why =
      verdict.reason === 'gap'
        ? `前一条刚约过，还要等 ${verdict.waitMin} 分钟`
        : ({ asleep: '这个点不该吵他', daily: '今天已经约过了', pending: '上一条他还没回', planned: '答应了的那件还没做' }[verdict.reason] ?? verdict.reason);
    log?.debug?.(`这次不约：${why}`);
    return { started: false, reason: verdict.reason };
  }

  if (!ownerQQ) {
    log?.warn?.('想约爸爸，但没配 QQ_ALLOW_LIST，不知道发给谁');
    return { started: false, reason: 'no-owner' };
  }

  const sent = await sendPrivate({ root, to: ownerQQ, text });
  if (!sent.ok) {
    log?.warn?.(`约他一起做件事，没发出去：${sent.error}`);
    return { started: false, reason: 'send-failed', error: sent.error };
  }

  const created = await createInvite({ root, text, log });
  await mind?.markSide?.('invite');
  log?.info?.(`她约爸爸一起：${created?.text ?? text}`);
  return { started: true, text: created?.text ?? text };
}

/**
 * 睡前整理：把今天压成一两条能留住的记忆（memory-digest.js）。
 * 一天只跑一次；白天调用会直接被「今天整理过了」挡掉，所以哪儿调都行。
 */
export async function maybeDigest({ root, runner, personaText, log, force = false, now = Date.now() }) {
  const result = await digestMemory({ root, now, runner, persona: personaText, log, force });
  if (result.ok) {
    const lines = [
      ...result.episodes.map((row) => `事件：${row.title}`),
      ...result.facts.map((row) => `事实：${row.text}`),
    ];
    log?.info?.(`睡前整理完（${lines.length} 条）\n  ${lines.join('\n  ')}`);
  } else if (result.reason === 'model') {
    log?.warn?.('睡前整理今晚没成，下次再补');
  }
  return result;
}

/**
 * 睡前复盘：让她自己回头看一眼「今天哪句想错了、下回怎么想」（lessons.js）。
 * 一天只跑一次；和睡前整理同一个窗口，但各记各的账。
 */
export async function maybeReview({ root, runner, personaText, log, force = false, now = Date.now() }) {
  const result = await reviewLessons({ root, now, runner, persona: personaText, log, force });
  if (result.ok) {
    if (result.lessons.length === 0) log?.info?.('睡前复盘完：今天没挑出想错的（也是她自己看的）');
    else {
      const lines = result.lessons.map((row) => {
        const parts = [];
        if (row.said) parts.push(`我说「${row.said}」`);
        if (row.missed) parts.push(`漏了${row.missed}`);
        if (row.next) parts.push(`以后${row.next}`);
        return parts.join('；');
      });
      log?.info?.(`睡前复盘完（${lines.length} 条）\n  ${lines.join('\n  ')}`);
    }
  } else if (result.reason === 'model') {
    log?.warn?.('睡前复盘今晚没成，下次再补');
  }
  return result;
}

/**
 * 到点了没有：只在 22:00 之后整理。
 * 故意不把凌晨算进来——零点后再整理一次，会把「今天」的额度用掉，
 * 当晚真正的睡前整理反而被 done 挡掉。
 */
export function digestDue({ now = Date.now() } = {}) {
  return new Date(now).getHours() >= 22;
}

/**
 * 白天也整理一次：上次整理超过 4 小时就补一轮，不用把白天的事都攒到 22 点。
 * 夜里 22 点之后交给 digestDue，免得两边抢。
 */
export async function digestBacklogDue({ root = process.cwd(), now = Date.now(), minHours = 4 } = {}) {
  const hour = new Date(now).getHours();
  if (hour < 8 || hour >= 22) return false;
  try {
    const quiet = { debug() {}, info() {}, warn() {}, error() {} };
    const meta = await createMemoryStore({ root, log: quiet }).readMeta();
    const lastAt = Number(meta?.lastDigestAt ?? 0) || 0;
    if (!lastAt) return true; // 从没整理过，白天就先跑一轮
    return now - lastAt >= Math.max(1, Number(minHours) || 4) * 3_600_000;
  } catch {
    return false;
  }
}

async function main() {
  const root = process.cwd();
  const config = loadQqConfig();
  const log = createLogger('info');

  const { command } = resolveDshCommand(process.env);
  // 想事也是一次模型调用：记次数和字数，连续失败会喊人
  const usage = createUsage({ root, kind: 'mind', log });
  const runner = createDshRunner({
    command,
    profile: config.agentProfile,
    cwd: config.agentCwd,
    timeoutMs: config.mindTimeoutMs,
    apiKey: createApiKeySource(),
    permissionMode: config.agentPermissionMode,
    retries: 1,
    usage: (record) => usage.record(record),
    log,
  });
  const notifier = createNotifier({ root, log });
  const health = createHealth({ root, notify: notifier });
  // 每天调用次数上限：到 80% 喊一次，超了只砍「非必要」的模型调用（想事/整理/摸头/约定）
  const budget = createBudget({ root, notify: notifier, log });
  const persona = createPersona({ file: resolve(root, config.personaFile), log });
  const personaText = await persona().catch(() => '');
  const life = createLife({ config, log, root });
  await life.load();

  const agenda = createAgenda({ root, log });
  const mind = createMind({ config, runner, persona, life, root, log, agenda });
  // 她的白名单第一个人就是爸爸：约他、跟他说，都是发这个号
  const ownerQQ = String(config.allowList?.[0] ?? '');

  if (has('status')) {
    const peek = await mind.peek();
    console.log(peek.enabled ? '她的时间：开着' : '她的时间：关着（QQ_MIND_ENABLED=0）');
    console.log(`今天想了 ${peek.today}/${config.mindMaxPerDay} 次，做梦 ${peek.dreamed} 段`);
    if (peek.state.wish?.at) console.log(`最后一个念头是「想他」：${fmtClock(peek.state.wish.at)}`);
    if (peek.state.lastPlayAt) console.log(`上次去 Minecraft 里玩：${fmtClock(peek.state.lastPlayAt)}`);
    if (peek.state.lastBrowseAt) console.log(`上次自己去刷抖音：${fmtClock(peek.state.lastBrowseAt)}`);
    if (peek.state.lastQzoneAt) console.log(`上次自己发说说：${fmtClock(peek.state.lastQzoneAt)}`);
    if (peek.state.lastReplyAt) console.log(`上次接别人留言：${fmtClock(peek.state.lastReplyAt)}`);
    if (peek.state.lastVisitAt) console.log(`上次回访网友：${fmtClock(peek.state.lastVisitAt)}`);
    if (peek.state.lastAlbumAt) console.log(`上次收图进相册：${fmtClock(peek.state.lastAlbumAt)}`);
    if (peek.state.plan?.text) console.log(`明天的打算：${peek.state.plan.text}`);
    const lessonRows = await createLessons({ root, log }).recent({ limit: 3 }).catch(() => []);
    if (lessonRows.length > 0) {
      console.log(`她复盘出来的教训（最近 ${lessonRows.length} 条）：`);
      for (const row of lessonRows) {
        const parts = [];
        if (row.said) parts.push(`我说「${row.said}」`);
        if (row.missed) parts.push(`漏了${row.missed}`);
        if (row.next) parts.push(`以后${row.next}`);
        console.log(`  · ${row.day ?? ''} ${parts.join('；')}`);
      }
    }
    const healthNow = health.status();
    console.log(
      healthNow.ok
        ? '她的脑子：正常'
        : `她的脑子：卡住了（${healthNow.failing.map((row) => `${row.component}×${row.streak}`).join('、')}）`,
    );
    const budgetNow = await budget.status();
    console.log(`今天的模型调用：${budgetNow.used}/${budgetNow.limit}（${budgetNow.level === 'ok' ? '正常' : budgetNow.level === 'warn' ? '接近上限' : '超了，只剩聊天'}）`);
    const memoryStats = await createMemoryStore({ root, log }).stats();
    console.log(
      `记忆：${memoryStats.episodes} 件事、${memoryStats.facts} 条事实` +
        (memoryStats.lastDigestDay ? `（上次整理 ${memoryStats.lastDigestDay}）` : '（还没整理过）'),
    );
    if (peek.state.lastInviteAt) console.log(`上次约爸爸一起做件事：${fmtClock(peek.state.lastInviteAt)}`);
    const invite = await readInvite({ root }).catch(() => null);
    if (invite) {
      const label = { pending: '他还没回', accepted: '他答应了，还没一起做', later: '他说改天', done: '已经一起做过', expired: '没约成' }[invite.status] ?? invite.status;
      console.log(`最近的约定：${invite.text}（${label}）`);
    }
    if (peek.state.lastCommentAt) {
      console.log(
        `上次去评论区说话：${fmtClock(peek.state.lastCommentAt)}（今天 ${Number(peek.state.commentDay === undefined ? 0 : peek.state.commentCount ?? 0)} 条）`,
      );
    }
    console.log('');
    for (const row of peek.recent.slice(-20)) {
      console.log(`${fmtClock(row.at)}  ${row.kind === 'dream' ? '〔梦〕' : '〔想〕'}${row.text}`);
    }
    if (peek.memories.length) {
      console.log('\n自己记下的：');
      for (const row of peek.memories) console.log(`${fmtClock(row.at)}  ${row.text}`);
    }
    return;
  }

  // 调试：只验证给 play.mjs 拼的参数，不起进程、不落 state
  if (has('play-dry')) {
    await maybePlay({ root, mind, log, record: { content: arg('play-dry') }, dry: true });
    return;
  }

  // 调试：只验证「要去哪条视频下说什么」，不发、不落 state
  if (has('comment-dry')) {
    await maybeComment({ root, mind, log, record: { content: arg('comment-dry') }, dry: true });
    return;
  }

  if (has('reply-dry')) {
    await maybeReply({ root, mind, log, record: { content: arg('reply-dry') }, dry: true });
    return;
  }
  if (has('visit-dry')) {
    await maybeVisit({ root, mind, log, record: { content: arg('visit-dry') }, dry: true });
    return;
  }
  if (has('album-dry')) {
    await maybeAlbum({ root, mind, log, record: { content: arg('album-dry') }, dry: true });
    return;
  }
  if (has('plan-dry')) {
    await maybePlan({ root, mind, log, record: { content: arg('plan-dry') }, dry: true });
    return;
  }
  if (has('browse-dry')) {
    await maybeBrowse({ root, mind, log, record: { content: arg('browse-dry') }, dry: true });
    return;
  }
  if (has('digest')) {
    const result = await maybeDigest({ root, runner, personaText, log, force: has('force') });
    if (!result.ok) console.log(`没整理：${result.reason}`);
    return;
  }
  if (has('invite-dry')) {
    await maybeInvite({ root, mind, log, record: { content: arg('invite-dry') }, dry: true });
    return;
  }
  if (has('qzone-dry')) {
    await maybeQzone({ root, mind, log, record: { content: arg('qzone-dry') }, dry: true });
    return;
  }

  if (has('review')) {
    const result = await maybeReview({ root, runner, personaText, log, force: true });
    if (!result.ok) {
      console.log(`复盘没成：${result.reason}`);
      process.exit(1);
    }
    console.log(result.lessons.length > 0 ? `这次复盘出 ${result.lessons.length} 条：` : '今天没挑出想错的。');
    for (const row of result.lessons) {
      const parts = [];
      if (row.said) parts.push(`我说「${row.said}」`);
      if (row.missed) parts.push(`漏了${row.missed}`);
      if (row.next) parts.push(`以后${row.next}`);
      console.log(`- ${parts.join('；')}`);
    }
    return;
  }

  if (has('once')) {
    const result = await mind.tick({ force: true });
    if (!result.ok) {
      console.log(`这次没想成：${result.reason}`);
      process.exit(1);
    }
    const row = result.record;
    console.log(`${row.kind === 'dream' ? '〔梦〕' : '〔想〕'}${row.text}`);
    if (row.mood) console.log(`情绪：${row.mood}`);
    if (row.saved) console.log(`记下：${row.saved}`);
    if (row.action === 'wish') console.log('（她这会儿有点想爸爸）');
    if (row.action === 'play') {
      console.log(`（她想去 Minecraft 里玩：${row.content || row.text}）`);
      await maybePlay({ root, mind, log, record: row });
    }
    if (row.action === 'comment') {
      console.log(`（她想去评论区说话：${row.content || row.text}）`);
      await maybeComment({ root, mind, log, record: row, runner, personaText });
    }
    if (row.action === 'browse') {
      console.log(`（她想去刷会儿抖音：${row.content || row.text}）`);
      await maybeBrowse({ root, mind, log, record: row });
    }
    if (row.action === 'qzone') {
      console.log(`（她想发条说说：${row.content || row.text}）`);
      await maybeQzone({ root, mind, log, record: row });
    }
    if (row.action === 'reply') {
      console.log(`（她想回别人的话：${row.content || row.text}）`);
      await maybeReply({ root, mind, log, record: row, runner, personaText });
    }
    if (row.action === 'album') {
      console.log(`（她想往相册里收张图：${row.content || row.text}）`);
      await maybeAlbum({ root, mind, log, record: row });
    }
    if (row.action === 'plan') {
      console.log(`（她想给明天定个打算：${row.content || row.text}）`);
      await maybePlan({ root, mind, log, record: row });
    }
    if (row.action === 'visit') {
      console.log(`（她想去回访网友：${row.content || row.text}）`);
      await maybeVisit({ root, mind, log, record: row, runner, personaText });
    }
    if (row.action === 'invite') {
      console.log(`（她想约爸爸一起做件事：${row.content || row.text}）`);
      await maybeInvite({ root, mind, log, record: row, ownerQQ });
    }
    console.log(`用时 ${(row.tookMs / 1000).toFixed(1)}s`);
    if (digestDue()) await maybeDigest({ root, runner, personaText, log });
    return;
  }

  // ── 常驻 ──
  const intervalMin = Math.max(1, Number(arg('interval', process.env.QQ_MIND_INTERVAL_MIN ?? 10)) || 10);
  log.info(
    `她的时间：开启（约 ${intervalMin} 分钟一次，最多 ${config.mindMaxPerDay}/天；` +
      `睡着时做梦，最多 ${config.mindDreamMaxPerNight} 段）`,
  );
  if (!config.mindEnabled) log.warn('QQ_MIND_ENABLED=0：只在 --once 时想，不会自动跑。');

  let stopping = false;
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
      stopping = true;
      log.info('她的时间：收到停止信号，把这一轮想完就走。');
    });
  }

  await sleep(Number(arg('first-delay', 60_000)) || 60_000);
  while (!stopping) {
    try {
      // 预算：超了就不想事，也别去整理记忆；warn 时提醒一次
      const budgetNow = await budget.status().catch(() => null);
      if (budgetNow) {
        const alert = await budget.alert().catch(() => ({ alerted: false }));
        if (alert.alerted) log.warn(`今天的模型调用已经用了 ${budgetNow.used}/${budgetNow.limit}，提醒过一次了`);
      }
      const result = budgetNow?.level === 'over'
        ? { ok: false, reason: 'budget' }
        : await mind.tick();
      if (result.ok) {
        void health.record({ component: 'mind', ok: true });
        const row = result.record;
        log.info(`${row.kind === 'dream' ? '〔梦〕' : '〔想〕'}${row.text}${row.saved ? `（记下：${row.saved}）` : ''}`);
        if (row.action === 'play') await maybePlay({ root, mind, log, record: row });
        if (row.action === 'comment') await maybeComment({ root, mind, log, record: row, runner, personaText });
        if (row.action === 'browse') await maybeBrowse({ root, mind, log, record: row });
        if (row.action === 'qzone') await maybeQzone({ root, mind, log, record: row });
        if (row.action === 'reply') await maybeReply({ root, mind, log, record: row, runner, personaText });
        if (row.action === 'album') await maybeAlbum({ root, mind, log, record: row });
        if (row.action === 'plan') await maybePlan({ root, mind, log, record: row });
        if (row.action === 'visit') await maybeVisit({ root, mind, log, record: row, runner, personaText });
        if (row.action === 'invite') await maybeInvite({ root, mind, log, record: row, ownerQQ });
      } else {
        log.debug(`这次没想：${result.reason}`);
      }
      // 把今天压成记忆：白天每 4 小时补一轮，睡前（22 点后）再收一次
      if (digestDue() || (await digestBacklogDue({ root }))) {
        try {
          const allowed = budgetNow?.level === 'over' ? false : (await budget.checkOptional()).allow;
          if (allowed) await maybeDigest({ root, runner, personaText, log });
          else log.info('预算超了，今晚先不整理记忆');
        } catch (error) {
          log.warn(`睡前整理出错：${error?.message ?? error}`);
        }
      }

      // 睡前复盘：今天哪句话她自己想错了（一天一次，22 点后）
      if (reviewDue()) {
        try {
          const allowed = budgetNow?.level === 'over' ? false : (await budget.checkOptional()).allow;
          if (allowed) await maybeReview({ root, runner, personaText, log });
          else log.info('预算超了，今晚先不复盘');
        } catch (error) {
          log.warn(`睡前复盘出错：${error?.message ?? error}`);
        }
      }

      // 没人玩、没人看就让她的小世界睡下（服务端+身体常驻太吃 CPU）
      try {
        await maybeSleepMc({ root, log, idleMin: Number(process.env.QQ_MC_IDLE_MIN || 20), online: await mcOnline() });
      } catch (error) {
        log.warn(`小世界自动休眠出错：${error?.message ?? error}`);
      }

      // 每天维护一次（04:00 之后第一轮）：轮转日志、裁剪超长 jsonl、备份记忆
      try {
        const maintenanceFile = resolve(root, 'data/maintenance.json');
        let meta = {};
        try {
          meta = JSON.parse(readFileSync(maintenanceFile, 'utf8'));
        } catch {
          meta = {};
        }
        const today = localDay();
        if (String(meta.lastDay ?? '') !== today && new Date().getHours() >= 4) {
          const report = await runMaintenance({ root, log });
          mkdirSync(resolve(root, 'data'), { recursive: true });
          writeFileSync(maintenanceFile, `${JSON.stringify({ lastDay: today, at: Date.now(), report: { rotated: report.rotated, trimmed: report.trimmed, backup: report.backup } }, null, 2)}\n`);
          log.info(`日常维护完成：轮转 ${report.rotated?.length ?? 0} 个日志、裁剪 ${report.trimmed?.length ?? 0} 个文件、备份 ${report.backup ? '有' : '无'}`);
        }
      } catch (error) {
        log.warn(`日常维护出错：${error?.message ?? error}`);
      }
    } catch (error) {
      log.warn(`想的时候出错：${error?.message ?? error}`);
      void health.record({ component: 'mind', ok: false, error: String(error?.message ?? error) });
    }
    const jitter = intervalMin * 60_000 * (0.85 + Math.random() * 0.4);
    const deadline = Date.now() + jitter;
    const roundStartedAt = Date.now();
    const nudgeFile = resolve(root, 'data/mind/nudge.json');
    while (!stopping && Date.now() < deadline) {
      await sleep(Math.min(3_000, Math.max(0, deadline - Date.now())));
      // 他刚跟她聊完：别干等下一个整点，早点接着想
      if (Date.now() - roundStartedAt < 90_000) continue;
      try {
        const nudge = JSON.parse(readFileSync(nudgeFile, 'utf8'));
        if (Number(nudge?.at ?? 0) > roundStartedAt) {
          rmSync(nudgeFile, { force: true });
          log.debug(`提前想一轮（${nudge.reason ?? '有事'}）`);
          break;
        }
      } catch {
        /* 没有 nudge 就正常等 */
      }
    }
  }
  log.info('她的时间：已停止。');
}

// 被测试 import 时只导出函数，不跑主流程
const entry = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (entry === import.meta.url) {
  main().catch((error) => {
    console.error(error?.stack ?? error);
    process.exit(1);
  });
}