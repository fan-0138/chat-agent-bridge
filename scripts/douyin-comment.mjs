#!/usr/bin/env node
/**
 * 让她去抖音评论区说一句话。
 *
 *   node scripts/douyin-comment.mjs --url https://www.douyin.com/video/xxx --text "这句我喜欢"
 *   node scripts/douyin-comment.mjs --url ... --text "回复你" --reply-text "那条评论里的一句话"
 *   node scripts/douyin-comment.mjs --url ... --text "听见了" --mention 主人
 *   node scripts/douyin-comment.mjs --from-inbox --text "听见了" --mention 主人   # 回最新 @ 她的那条
 *
 * 以前走「请求文件 + 常驻浏览器代跑」：桥接要把私信面板那一轮跑完才轮到评论，
 * 面板一卡评论就永远不执行（实测等 3 分钟超时）。现在自己连 9223 上那个浏览器做，
 * 几秒就有结果，私信页也不会被碰（只关自己开的标签页）。
 */

import { mkdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { openBrowser, closeBrowser, stealth } from './lib/douyin-browser.mjs';
import { postComment } from './lib/douyin-comments.js';

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const option = (name, fallback) => {
  const index = argv.indexOf(name);
  return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback;
};

const root = resolve(import.meta.dirname, '..');
const inboxFile = resolve(root, 'data/douyin/at-inbox.jsonl');

let url = option('--url', '');
let replyCid = option('--reply-cid', '');
let rootCid = option('--root-cid', '');
const text = option('--text', '');
const mention = option('--mention', '');
let replyText = option('--reply-text', '');

// --from-inbox：直接回最新那条 @ 她的评论，靠 commentId 精确定位，不用在评论区大海捞针
if (flag('--from-inbox')) {
  try {
    const lines = (await readFile(inboxFile, 'utf8')).trim().split('\n').filter(Boolean);
    const latest = JSON.parse(lines[lines.length - 1]);
    url = url || latest.videoUrl || `https://www.douyin.com/video/${latest.awemeId}`;
    replyCid = replyCid || latest.commentId || '';
    // 通知里没带 rootText ⇒ 那条本身就是顶层评论，它自己就是楼根，不用去翻楼
    if (!rootCid && !latest.rootText && latest.commentId) rootCid = String(latest.commentId);
  } catch {
    console.error('at-inbox 是空的：还没人 @ 过她（或通知还没落到文件里）');
    process.exit(1);
  }
}

if (!url || !text) {
  console.error(
    '用法：node scripts/douyin-comment.mjs --url <视频链接> --text "评论内容" [--mention 昵称] [--reply-text 片段 | --reply-cid cid] [--from-inbox]',
  );
  process.exit(1);
}

await mkdir(resolve(root, 'data/douyin'), { recursive: true });

const { context, remote, preexisting } = await openBrowser({ offscreen: true });
try {
  // 远程模式（连桥接的浏览器）必须自己开页：拿别人那页会互相踩
  const page = remote ? await context.newPage() : (context.pages()[0] ?? (await context.newPage()));
  await stealth(page);
  const result = await postComment(page, url, text, { mention, replyText, replyCid, rootCid });
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.ok ? 0 : 2);
} finally {
  await closeBrowser(context, remote, preexisting);
}