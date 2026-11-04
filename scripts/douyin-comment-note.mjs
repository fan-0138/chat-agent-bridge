#!/usr/bin/env node
/**
 * 她自己跑去评论区说话：一条龙。
 *
 *   node scripts/douyin-comment-note.mjs --url https://www.douyin.com/video/xxx --text "这句话" [--why 为什么想说]
 *   node ... --url ... --text "回你一句" --reply-cid 123 --root-cid 100 --nid 456 --why "回 restart"
 *
 * 回复别人留言时（at-inbox 那条通知带来的参数）：
 *   --reply-cid  要回的那条评论的 commentId；
 *   --root-cid   它所在的楼根。type=45（@你）的 commentId 本身就是楼根，
 *                 type=31（回复你的评论）用通知里的 rootCommentId；
 *   --nid        这条通知的 nid：真发成功之后才记进 data/douyin/replied.jsonl，
 *                失败/试跑都不记，下次还能重试。
 *
 * 和 scripts/douyin-comment.mjs 的区别：这个是她「自己时间」里用的，
 * 发完把结果记一笔到 data/mind/comments.jsonl —— 之后她会记得自己说过什么，
 * 跟爸爸聊天时也能提一嘴；每日上限/间隔也看这份记录。
 */
import { appendFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { openBrowser, closeBrowser, stealth } from './lib/douyin-browser.mjs';
import { markReplied } from '../src/douyin-inbox.js';
import { postComment } from './lib/douyin-comments.js';

const argv = process.argv.slice(2);
const option = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};

const root = resolve(import.meta.dirname, '..');
const url = option('--url', '');
const text = option('--text', '');
const why = option('--why', '');
const replyCid = option('--reply-cid', '');
const rootCid = option('--root-cid', '');
const nid = option('--nid', '');
const replyNickname = option('--reply-nickname', '');
const dry = argv.includes('--dry-run');
const recordFile = resolve(root, 'data/mind/comments.jsonl');

// 回复某条评论时，why 里带上对方昵称更好回忆；没传昵称就完全按原来的写法记
const recordWhy = replyNickname ? (why ? `${why}（回复 @${replyNickname}）` : `回复 @${replyNickname}`) : why;

async function note(row) {
  await mkdir(dirname(recordFile), { recursive: true });
  await appendFile(recordFile, `${JSON.stringify(row)}\n`, 'utf8');
}

if (!url || !text) {
  console.error(
    '用法：douyin-comment-note.mjs --url <视频链接> --text "评论内容" [--why 为什么] [--reply-cid 评论id] [--root-cid 楼根id] [--nid 通知id] [--reply-nickname 对方昵称]',
  );
  process.exit(1);
}

const started = Date.now();
let browser = null;
try {
  browser = await openBrowser({ offscreen: true });
  const { context, remote } = browser;
  const page = remote ? await context.newPage() : (context.pages()[0] ?? (await context.newPage()));
  await stealth(page);
  // replyCid/rootCid：回复某条评论（at-inbox 里带的 commentId / rootCommentId）；不传就还是普通发评论
  const result = await postComment(page, url, text, { dryRun: dry, replyCid, rootCid });
  await note({
    at: started,
    url,
    text,
    why: recordWhy,
    replyCid: result.replyCid ?? (replyCid || null),
    rootCid: rootCid || null,
    nid: nid || null,
    ok: Boolean(result.ok) && !result.dryRun,
    cid: result.cid ?? null,
    reason: result.reason ?? result.error ?? null,
    ms: Date.now() - started,
  });
  console.log(JSON.stringify(result, null, 2));
  // 真回复成功了才记「这条已回」，失败下次还能再试；--dry-run 不算
  if (result.ok && nid && !result.dryRun) {
    await markReplied({ root, nid, text: result.comment || text, at: started }).catch((error) => {
      console.error(`已回记录没写成（不影响这次发送）：${error?.message ?? error}`);
    });
  }
  process.exitCode = result.ok ? 0 : 2;
} catch (error) {
  const message = String(error?.message ?? error);
  await note({
    at: started,
    url,
    text,
    why: recordWhy,
    replyCid: replyCid || null,
    rootCid: rootCid || null,
    nid: nid || null,
    ok: false,
    reason: message,
    ms: Date.now() - started,
  }).catch(() => {});
  console.error(`说话没成：${message}`);
  process.exitCode = 2;
} finally {
  if (browser) await closeBrowser(browser.context, browser.remote, browser.preexisting).catch(() => {});
}