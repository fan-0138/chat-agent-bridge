/**
 * 她手上的事：没做完的待办。
 *
 * 为什么单独一层：她的记忆是「发生过什么」，待办是「还欠着什么」——
 * 屋顶还差三块、视频想重剪、答应了要一起看月亮。没有这一层，她每 10 分钟重新开机，
 * 手里的事一放下就再也捡不起来。
 *
 * 来源：
 *  - 聊天里她自己写【待办：…】/【做完：…】（桥接解析，和【记住：…】同一套）
 *  - 以后也可以由游戏/刷视频等事件写进来
 *
 * 存在 data/mind/agenda.json（小文件，直接重写）。
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const DAY = 86_400_000;
const MAX_ITEMS = 40;

function clean(text, max = 80) {
  return String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

export function createAgenda({ root = process.cwd(), now = Date.now, log = console } = {}) {
  const file = resolve(root, 'data/mind/agenda.json');
  /** @type {Array<{id:string,at:number,text:string,kind:string,status:string,due:number,doneAt?:number,source:string}>|null} */
  let cache = null;

  async function load() {
    if (cache) return cache;
    try {
      const raw = await readFile(file, 'utf8');
      const parsed = JSON.parse(raw);
      const items = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.items) ? parsed.items : [];
      cache = items.filter((row) => row && row.text && row.status);
    } catch {
      cache = [];
    }
    return cache;
  }

  async function save() {
    const items = (cache ?? []).slice(-MAX_ITEMS);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, `${JSON.stringify({ items }, null, 2)}\n`, 'utf8');
  }

  /** 加一件。同一句话没做完前不重复加。 */
  async function add({ text = '', kind = 'todo', due = 0, source = 'chat' } = {}) {
    const cleanText = clean(text);
    if (!cleanText) return null;
    const items = await load();
    const dup = items.find((row) => row.status === 'open' && row.text.slice(0, 12) === cleanText.slice(0, 12));
    if (dup) return { ...dup, duplicate: true };
    const row = {
      id: `a${now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
      at: now(),
      text: cleanText,
      kind: clean(kind, 12) || 'todo',
      status: 'open',
      due: Number(due) || 0,
      source: clean(source, 16) || 'chat',
    };
    items.push(row);
    await save();
    log?.info?.(`她记下一件没做完的事：${cleanText}`);
    return row;
  }

  /** 按一句话把它划掉（模糊匹配：包含就算）。 */
  async function closeByText(text = '') {
    const target = clean(text);
    if (!target) return null;
    const items = await load();
    const open = items.filter((row) => row.status === 'open');
    const hit =
      open.find((row) => row.text === target) ??
      open.find((row) => row.text.includes(target) || target.includes(row.text.slice(0, 12)));
    if (!hit) return null;
    hit.status = 'done';
    hit.doneAt = now();
    await save();
    log?.info?.(`她划掉了一件：${hit.text}`);
    return hit;
  }

  /** 没做完的：按时间倒序。 */
  async function listOpen({ limit = 8 } = {}) {
    const items = await load();
    return items
      .filter((row) => row.status === 'open')
      .sort((a, b) => (b.at || 0) - (a.at || 0))
      .slice(0, limit);
  }

  /** 拼进 prompt 的一段。 */
  async function promptSection({ limit = 5 } = {}) {
    const open = await listOpen({ limit });
    if (open.length === 0) return '';
    const lines = open.map((row) => {
      const age = Math.round((now() - (row.at || 0)) / 60_000);
      const ago = age >= 60 ? `${Math.round(age / 60)} 小时前` : `${Math.max(1, age)} 分钟前`;
      const due = row.due ? `（说要 ${new Date(row.due).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' })} 做）` : '';
      return `- ${row.text}${due}（${ago}记下的）`;
    });
    return (
      '[你手上还欠着的事]\n' +
      `${lines.join('\n')}\n` +
      '（这些是你自己记下的、还没做完的事。这一轮想接着做就挑一件做，做完了在回复里写【做完：那句话】；' +
      '不想做也可以先放着，别当任务清单念出来。）'
    );
  }

  /** 清掉很久以前做完/放弃的，别无限长。 */
  async function prune({ days = 7 } = {}) {
    const items = await load();
    const floor = now() - days * DAY;
    const kept = items.filter((row) => row.status === 'open' || Number(row.doneAt || row.at) >= floor);
    if (kept.length !== items.length) {
      cache = kept;
      await save();
    }
    return items.length - kept.length;
  }

  return { add, closeByText, listOpen, promptSection, prune, _file: file };
}