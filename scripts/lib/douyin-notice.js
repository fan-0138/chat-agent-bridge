/**
 * 读抖音的互动通知：谁 @ 了我、谁评论了我的作品、谁回复了我的评论。
 *
 * 网页端**没有**通知页面（/notice /notification /message 全 404），只能走接口。
 * 踩过的坑：
 *  - 列表在响应的 `notice_list_v2` 里，不是 `notice_list`；
 *  - 必须**同时**给 `group` 和 `notice_group`，缺一个就 status_code=5；
 *  - `min_time=0` 才会把历史拉出来；
 *  - 路径是 `/aweme/v1/web/notice/`（不是 notice/list，那个会说 url doesn't match）。
 *
 * 只读：is_mark_read=0，不把消息标成已读。
 *
 * 好消息：这个接口**不需要签名器**（在页面里 fetch 就 200）—— 之前以为要 bdms，
 * 实测用页面自己的 cookie + 同源请求就够。
 */

const COMMON = {
  device_platform: 'webapp',
  aid: '6383',
  channel: 'channel_pc_web',
  pc_client_type: '1',
  version_code: '190500',
  version_name: '19.5.0',
  cookie_enabled: 'true',
  screen_width: '1920',
  screen_height: '1080',
  browser_language: 'zh-CN',
  browser_platform: 'Win32',
  browser_name: 'Chrome',
  browser_version: '141.0.0.0',
  engine_name: 'Blink',
  engine_version: '141.0.0.0',
  os_name: 'Windows',
  os_version: '10',
  platform: 'PC',
};

export const TYPE_NAME = {
  31: '回复了评论 / 在我的评论下回复',
  32: '回复了你的评论',
  33: '关注了你',
  34: '点赞了你的作品',
  35: '评论了你的作品',
  41: '点赞了你的评论',
  45: '@了你（评论区）',
  46: '@了你（作品）',
};

/** 这几个 group 覆盖了评论区/作品互动/关注/粉丝 */
export const GROUPS = [700, 960, 401, 601];

/** 只有这些类型值得她回一句 */
export const REPLYABLE_TYPES = new Set([31, 32, 35, 45, 46]);

const BLOCKS = ['at', 'comment', 'digg', 'follow', 'fans', 'im', 'system'];

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

/**
 * 把一条原始通知压成能直接用的形状（纯函数）。
 * @returns {null | object}
 */
export function normalizeNotice(item) {
  if (!item || typeof item !== 'object') return null;
  const type = Number(item.type ?? 0);
  const record = {
    type,
    typeName: TYPE_NAME[type] ?? `type_${type}`,
    nid: item.nid ? String(item.nid) : '',
    createTime: Number(item.create_time ?? 0),
    nickname: '',
    uid: '',
    content: '',
  };

  for (const key of BLOCKS) {
    const block = asObject(item[key]);
    if (!block) continue;
    let user = asObject(block.user_info) ?? asObject(block.from_user) ?? {};

    // 评论类通知里，真正说话的人在 block.comment.user，不在 user_info
    const inner = asObject(block.comment);
    if (inner) {
      const commentUser = asObject(inner.user);
      if (commentUser?.nickname) user = commentUser;
      if (inner.cid) record.commentId = String(inner.cid);
      if (inner.text) record.content = String(inner.text).trim();
    }
    record.nickname = user.nickname ?? record.nickname;
    record.uid = user.uid ?? record.uid;
    record.content = String(record.content || block.content || '').trim();

    const schema = String(block.schema_url ?? '');
    if (schema.includes('aweme/detail/')) {
      record.awemeId = schema.split('aweme/detail/')[1].split('?')[0].split('&')[0];
      if (schema.includes('cid=')) record.commentId ??= schema.split('cid=')[1].split('&')[0];
    }
    if (block.aweme_id) record.awemeId ??= String(block.aweme_id);
    const aweme = asObject(block.aweme);
    if (aweme?.aweme_id) {
      record.awemeId ??= String(aweme.aweme_id);
      if (aweme.desc) record.awemeDesc = String(aweme.desc).slice(0, 80);
    }

    // 回楼中楼时 reply_id 必须填「楼根」，这个字段是关键
    if (block.parent_id) record.rootCommentId = String(block.parent_id);
    const level1 = asObject(block.level1_comment);
    if (level1) {
      if (level1.cid) record.rootCommentId ??= String(level1.cid);
      record.rootAuthor = level1.user?.nickname ?? '';
      record.rootText = String(level1.text ?? '').slice(0, 60);
    }
    const reply = asObject(block.reply_comment);
    if (reply) {
      record.replyToNickname = reply.user?.nickname ?? '';
      record.replyToText = String(reply.text ?? '').slice(0, 60);
      if (reply.cid) record.replyToCommentId = String(reply.cid);
    }
    break;
  }

  if (record.awemeId) {
    record.videoUrl = `https://www.douyin.com/video/${record.awemeId}`;
    if (record.commentId) record.commentUrl = `${record.videoUrl}?comment_id=${record.commentId}`;
  }
  record.atMe = type === 45 || type === 46;
  record.replyable = REPLYABLE_TYPES.has(type);
  return record;
}

/** 页面里 fetch 一次通知列表。 */
async function fetchGroup(page, group, { count = 20, minTime = 0 } = {}) {
  const query = new URLSearchParams({
    is_new_notice: '1',
    is_mark_read: '0',
    count: String(count),
    min_time: String(minTime),
    group: String(group),
    notice_group: String(group),
    ...COMMON,
  });
  return page
    .evaluate(async (url) => {
      try {
        const response = await fetch(url, { credentials: 'include', headers: { accept: 'application/json' } });
        const text = await response.text();
        try {
          return JSON.parse(text);
        } catch {
          return { __parse_error: String(text).slice(0, 200) };
        }
      } catch (error) {
        return { __error: String(error?.message ?? error) };
      }
    }, `/aweme/v1/web/notice/?${query}`)
    .catch(() => null);
}

/**
 * 读全部通知（去重、按时间倒序）。
 * @returns {{ok: boolean, items: object[], counts: object, warnings: string[]}}
 */
export async function readNotices(page, { groups = GROUPS, count = 20, minTime = 0, pauseMs = 1_000 } = {}) {
  const items = [];
  const warnings = [];
  const counts = {};
  const seen = new Set();

  for (const group of groups) {
    const json = await fetchGroup(page, group, { count, minTime });
    if (!json) {
      warnings.push(`group=${group} 没返回`);
    } else {
      if (json.__error) warnings.push(`group=${group} ${json.__error}`);
      if (json.__parse_error) warnings.push(`group=${group} 响应不是 JSON`);
      if (json.status_code && json.status_code !== 0) warnings.push(`group=${group} status_code=${json.status_code}`);
      for (const raw of json.notice_list_v2 ?? []) {
        const record = normalizeNotice(raw);
        if (!record || !record.nid || seen.has(record.nid)) continue;
        seen.add(record.nid);
        record.group = group;
        items.push(record);
      }
    }
    if (pauseMs > 0) await new Promise((done) => setTimeout(done, pauseMs));
  }

  items.sort((a, b) => b.createTime - a.createTime);
  return { ok: items.length > 0 || warnings.length === 0, items, counts, warnings };
}

/** 只挑「该回一句」的：@我 / 评论我 / 回复我。 */
export function pickReplyable(items) {
  return (items ?? []).filter((item) => item.replyable && (item.content || item.rootText || item.replyToText));
}