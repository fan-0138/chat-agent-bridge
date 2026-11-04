/**
 * 她的「网友簿」：评论区里跟她说过话的人。
 *
 * 数据来自 data/douyin/at-inbox.jsonl（别人 @ 她 / 回她评论的通知）和
 * data/douyin/replied.jsonl（她回过的 nid）。
 * 用途：
 *  - 想事时知道「这些人是谁、上次说了什么」，接话不至于像第一次见；
 *  - 房间里能看到她认识的网友；
 *  - 「回访」：隔了几天、上次没接上的那种，她可以自己决定回去接一句。
 */

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const DAY_MS = 24 * 3_600_000;

async function readJsonl(file) {
  try {
    const raw = await readFile(file, 'utf8');
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
      .filter(Boolean);
  } catch {
    return [];
  }
}

function timeOf(item) {
  const seconds = Number(item?.createTime);
  if (Number.isFinite(seconds) && seconds > 1_000_000_000) return seconds * 1000;
  const seen = Date.parse(String(item?.seenAt ?? ''));
  return Number.isFinite(seen) ? seen : 0;
}

/**
 * 把通知和「已回过」的记录合成一本按人来分的簿子。
 * @param {{root?: string, now?: number, limit?: number}} options
 * @returns {Promise<Array<{key:string,name:string,uid:string,count:number,lastAt:number,lastText:string,lastVideoUrl:string,lastCommentId:string,lastRootCommentId:string,lastNid:string,replied:boolean}>>}
 */
export async function loadPeopleBook({ root = process.cwd(), now = Date.now(), limit = 20 } = {}) {
  const [inbox, repliedRows] = await Promise.all([
    readJsonl(resolve(root, 'data/douyin/at-inbox.jsonl')),
    readJsonl(resolve(root, 'data/douyin/replied.jsonl')),
  ]);
  const repliedNids = new Set(repliedRows.map((row) => String(row?.nid ?? '')).filter(Boolean));

  /** @type {Map<string, any>} */
  const people = new Map();
  for (const item of inbox) {
    const nickname = String(item?.nickname ?? '').trim();
    if (!nickname) continue;
    const uid = String(item?.uid ?? '').trim();
    const key = uid || nickname;
    const at = timeOf(item);
    const text = String(item?.content ?? '').trim();
    const record = people.get(key) ?? {
      key,
      name: nickname,
      uid,
      count: 0,
      lastAt: 0,
      lastText: '',
      lastVideoUrl: '',
      lastCommentId: '',
      lastRootCommentId: '',
      lastNid: '',
      replied: false,
    };
    record.count += 1;
    if (at >= record.lastAt) {
      record.lastAt = at;
      record.lastText = text;
      record.lastVideoUrl = String(item?.videoUrl ?? '');
      record.lastCommentId = String(item?.commentId ?? '');
      record.lastRootCommentId = String(item?.rootCommentId ?? '');
      record.lastNid = String(item?.nid ?? '');
    }
    people.set(key, record);
  }

  const list = [...people.values()]
    .map((person) => ({
      ...person,
      // 三天内的才算「最近认识」，更久的只当背景
      fresh: now - person.lastAt <= 3 * DAY_MS,
      replied: person.lastNid ? repliedNids.has(person.lastNid) : false,
    }))
    .sort((a, b) => b.lastAt - a.lastAt);
  return list.slice(0, limit);
}

/** 给想事 prompt 用的一段：谁、什么时候、说过什么。 */
export async function formatPeopleSection(people = [], now = Date.now()) {
  if (!Array.isArray(people) || people.length === 0) return '';
  const lines = people.slice(0, 6).map((person) => {
    const days = Math.max(0, Math.floor((now - person.lastAt) / DAY_MS));
    const when = days === 0 ? '今天' : days === 1 ? '昨天' : `${days} 天前`;
    const said = String(person.lastText ?? '').replace(/\s+/g, ' ').slice(0, 40);
    const state = person.replied ? '你已经接过话' : '你还没接';
    return `- ${person.name}（${when}说「${said}」；${state}）`;
  });
  return lines.join('\n');
}

/**
 * 回访候选：隔了几天、上次没接上的网友（不超过 14 天）。
 * @param {{root?: string, now?: number, limit?: number, maxAgeDays?: number}} options
 */
export async function visitCandidates({ root = process.cwd(), now = Date.now(), limit = 3, maxAgeDays = 14 } = {}) {
  const people = await loadPeopleBook({ root, now, limit: 40 });
  return people
    .filter((person) => !person.replied)
    .filter((person) => person.lastVideoUrl && person.lastCommentId)
    .filter((person) => Number.isFinite(person.lastAt) && person.lastAt > 0)
    .filter((person) => now - person.lastAt <= maxAgeDays * DAY_MS)
    .sort((a, b) => b.lastAt - a.lastAt)
    .slice(0, limit)
    .map((person, index) => ({ ...person, index: index + 1 }));
}