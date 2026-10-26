/**
 * 评论区写操作：在抖音页面的上下文里 fetch，**不点 UI**。
 *
 * 为什么必须这样（三条路都实测过）：
 *   ① 点评论区 UI 发送  → 能发，但抖音会弹**短信验证**（要人工给验证码）
 *   ② 自己签名 POST      → 403：写接口要 bdms 的强签名，外部补不齐
 *   ③ ⭐ 在页面里 fetch  → 200，不弹验证（页面自己的签名器把 URL 补齐了）
 *
 * 回复的楼根（reply_id）有个坑：**回复顶层评论**时 reply_id = 那条评论自己；
 * **回复楼中楼**时 reply_id = 楼根、reply_to_reply_id = 具体那条。
 * 填错不会报错 —— 会变成一条悄无声息冒到顶层的评论，位置全错还「看起来成功」。
 * 所以判不出来就拒绝发送，绝不瞎猜。
 */

/** 页面里那些接口都要带上这一串基础参数，少一个就可能 status_code=5。 */
export const COMMON = {
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

/** 从视频 URL 里取 aweme_id：/video/7412345678901234567 → 19 位数字。 */
export function awemeIdFromUrl(url) {
  const match = String(url ?? '').match(/(?:video|note)\/(\d{15,20})/);
  return match ? match[1] : null;
}

/**
 * 判定这条评论到底落在哪（纯函数，方便单测）。
 * 服务端有时不给 level，所以只能靠「重读那栋楼」来核实。
 */
export function judgePlacement({ plan, res }) {
  const root = plan?.root ?? '';
  if (!root) return { state: 'top-level', ok: true };
  if (!res || res.http !== 200 || !res.cid) return { state: 'unknown', ok: null, note: '没拿到 cid，不知道发没发出去' };
  if (res.verified) {
    const level = Number(res.verified_level);
    if (level === 2) return { state: 'in-thread', ok: true, level };
    return {
      state: 'misplaced',
      ok: false,
      level,
      note: `已核实是 level=${level} 的独立顶层评论，不是楼中楼回复 —— 楼根填错了`,
    };
  }
  if (res.found_at_top) {
    return {
      state: 'misplaced',
      ok: false,
      level: 1,
      note: '已核实这条跑到了顶层评论列表 —— 楼根填错，它没进楼',
    };
  }
  return {
    state: 'unverified',
    ok: null,
    note: '重读那栋楼没读到（评论按热度排，0 赞够不着）—— 不等于失败，过几分钟再看',
  };
}

/** 在页面里跑一段 fetch，返回解析后的 JSON（拿不到就 null）。 */
export async function fetchJson(page, path, { timeoutMs = 12_000 } = {}) {
  return page
    .evaluate(
      async ({ url, timeoutMs }) => {
        // 一定要自带超时：有的接口（实测 comment/list/reply）能挂几十秒不返回，
        // 页面里的 fetch 不设超时就会把整条命令拖死。
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
          const response = await fetch(url, { credentials: 'include', headers: { accept: 'application/json' }, signal: controller.signal });
          const text = await response.text();
          try {
            return JSON.parse(text);
          } catch {
            return { __parse_error: true, __head: text.slice(0, 200) };
          }
        } catch (error) {
          return { __error: String(error?.message ?? error), __timeout: controller.signal.aborted };
        } finally {
          clearTimeout(timer);
        }
      },
      { url: path, timeoutMs },
    )
    .catch(() => null);
}

/**
 * 查「@ 谁」的人：昵称/备注名 → { nickname, user_id, sec_uid }。
 *
 * 走评论区 @ 弹层用的那个接口（category_name=aweme_at_user）。字段对应关系（实测）：
 *   words[].word                    → 弹层里显示的那个名字（可能是备注名，比如「主人」）
 *   words[].id                      → 就是 text_extra 要填的 user_id
 *   params.info.rich_sug_nickname   → 真实昵称（插进正文里的 @ 用它，比如「restart」）
 *   params.info.rich_sug_remarkname → 备注名
 *   params.info.rich_sug_sec_uid    → sec_uid（保号用的就是它）
 * 选人优先级：名字（显示名/昵称/备注名）对得上 + 是朋友 > 名字对得上 > 朋友 > 第一个。
 */
export async function lookupMention(page, name) {
  const needle = String(name ?? '').trim().replace(/^@/, '');
  if (!needle) return null;
  const query = new URLSearchParams({
    ...COMMON,
    count: '20',
    query: needle,
    business_id: '30101',
    category_name: 'aweme_at_user',
    words_source: 'aweme_at_user',
    pd: 'aweme_at_user',
  }).toString();
  const json = await fetchJson(page, `/aweme/v1/web/api/suggest_words/?${query}`);
  const words = (json?.data ?? []).flatMap((item) => item?.words ?? []);
  const candidates = [];
  for (const word of words) {
    let info = {};
    try {
      info = JSON.parse(word?.params?.info ?? '{}');
    } catch {
      info = {};
    }
    const nickname = String(info.rich_sug_nickname ?? word?.word ?? '').trim();
    const remark = String(info.rich_sug_remarkname ?? '').trim();
    const display = String(word?.word ?? '').trim();
    const secUid = String(info.rich_sug_sec_uid ?? '');
    const userId = String(word?.id ?? info.rich_sug_uid ?? '');
    if (!nickname || !secUid || !userId) continue;
    const names = [display, nickname, remark].filter(Boolean);
    candidates.push({
      nickname,
      remark,
      display,
      names,
      user_id: userId,
      sec_uid: secUid,
      relation: String(info.rich_sug_relation_type ?? ''),
      follow: String(info.rich_sug_follow_status ?? ''),
    });
  }
  if (candidates.length === 0) return null;
  const isFriend = (item) => item.follow === 'friends' || item.relation === '朋友';
  const named = (item) => item.names.includes(needle);
  return (
    candidates.find((item) => named(item) && isFriend(item)) ??
    candidates.find(named) ??
    candidates.find(isFriend) ??
    candidates[0]
  );
}

/**
 * 拼「带 @ 的评论」正文 + text_extra（纯函数，方便单测）。
 *
 * - 正文里自己写的开头 @xxx 要剥掉：@ 由 text_extra 表达，重复写会出现「@a @b」；
 * - start/end 是 `@真实昵称` 在正文里的区间，必须跟正文完全对得上。
 */
export function buildMentionPayload(text, mentionTag) {
  if (!mentionTag?.nickname || !mentionTag?.user_id || !mentionTag?.sec_uid) return null;
  const body = String(text ?? '').trim().replace(/^@\S+\s*/, '').trim();
  const prefix = `@${mentionTag.nickname}`;
  return {
    text: body ? `${prefix} ${body}` : prefix,
    textExtra: [{ user_id: String(mentionTag.user_id), sec_uid: String(mentionTag.sec_uid), type: 0, start: 0, end: prefix.length }],
  };
}

/** 顶层评论（按热度/时间倒序，游标翻页）。 */
export async function listComments(page, awemeId, { cursor = 0, count = 20 } = {}) {
  const query = new URLSearchParams({ ...COMMON, aweme_id: String(awemeId), count: String(count), cursor: String(cursor), item_type: '0' });
  const json = await fetchJson(page, `/aweme/v1/web/comment/list/?${query}`);
  return { comments: json?.comments ?? [], hasMore: Boolean(json?.has_more), cursor: Number(json?.cursor ?? 0), statusCode: json?.status_code ?? null };
}

/**
 * 某一栋楼里的回复。
 *
 * ⚠️ 2026-10-25 实测：这个接口（comment/list/reply）会让页面卡死 ——
 * fetch 既不 resolve 也不 abort（连页面里的 setTimeout 都不触发），
 * 调用它的命令会一直挂着。所以代码里**不要主动调用**，只在人工排查时用。
 */
export async function listReplies(page, awemeId, rootCid, { cursor = 0, count = 20 } = {}) {
  const query = new URLSearchParams({
    ...COMMON,
    item_id: String(awemeId),
    comment_id: String(rootCid),
    cursor: String(cursor),
    count: String(count),
    item_type: '0',
  });
  const json = await fetchJson(page, `/aweme/v1/web/comment/list/reply/?${query}`, { timeoutMs: 8_000 });
  return { comments: json?.comments ?? [], total: Number(json?.total ?? 0), statusCode: json?.status_code ?? null };
}

/**
 * 判「这条 cid 是顶楼还是楼中楼」，决定 reply_id 该怎么填。
 * 判不出来就返回 { ok:false, needRoot:true }，调用方必须中止，不许猜。
 */
export async function resolveReplyPlan(page, { awemeId, replyCid, rootCid = '' }) {
  if (!replyCid) return { ok: true, root: '', replyTo: '', how: 'top-level' };
  if (rootCid) {
    return { ok: true, root: String(rootCid), replyTo: replyCid === rootCid ? '' : String(replyCid), how: 'explicit' };
  }

  let cursor = 0;
  for (let pageIndex = 0; pageIndex < 8; pageIndex += 1) {
    const { comments, hasMore, cursor: next } = await listComments(page, awemeId, { cursor, count: 20 });
    for (const comment of comments) {
      if (String(comment.cid) === String(replyCid)) {
        return { ok: true, root: String(comment.cid), replyTo: '', how: 'found-level1' };
      }
      for (const reply of comment.reply_comment ?? []) {
        if (String(reply.cid) === String(replyCid)) {
          return { ok: true, root: String(comment.cid), replyTo: String(replyCid), how: 'found-in-thread' };
        }
      }
    }
    if (!hasMore) break;
    if (!next || next === cursor) break;
    cursor = next;
  }

  // 注意：这里**不能**再去调 comment/list/reply 探「有没有楼中楼」。
  // 实测那个接口会让页面卡死（fetch 既不 resolve 也不 abort，连定时器都不触发）。
  // 所以顶层翻不到就老实认输，让调用方传 rootCid（at-inbox 里就有 commentId）。
  return {
    ok: false,
    needRoot: true,
    hint: '判不出这条 cid 的楼根。请传 rootCid（= 这栋楼的第一条评论），或用 --from-inbox',
  };
}

/** 在评论列表里按正文片段找那条评论的 cid（最多翻 8 页）。 */
export async function findCommentCidByText(page, awemeId, needle) {
  const target = String(needle ?? '').trim();
  if (!target) return null;
  let cursor = 0;
  for (let pageIndex = 0; pageIndex < 8; pageIndex += 1) {
    const { comments, hasMore, cursor: next } = await listComments(page, awemeId, { cursor, count: 20 });
    for (const comment of comments) {
      if (String(comment.text ?? '').includes(target)) return String(comment.cid);
      for (const reply of comment.reply_comment ?? []) {
        if (String(reply.text ?? '').includes(target)) return String(reply.cid);
      }
    }
    if (!hasMore) break;
    if (!next || next === cursor) break;
    cursor = next;
  }
  return null;
}

/**
 * 发评论。一条 fetch，不点 UI。
 * @returns {{ok: boolean, http: number, cid: string, statusCode: number|null, placement: object, head?: string, error?: string}}
 */
export async function publishComment(page, { awemeId, text, rootCid = '', replyToCid = '', textExtra = null, verify = true }) {
  const body = {
    awemeId: String(awemeId),
    text: String(text),
    rootCid: String(rootCid || ''),
    replyToCid: String(replyToCid || ''),
    textExtra: textExtra ? JSON.stringify(textExtra) : '[]',
    verify: verify !== false,
  };
  const raw = await page
    .evaluate(async ({ common, payload }) => {
      // 统一带超时：页面里的 fetch 不设超时，碰上不返回的接口会把整条命令拖死
      const fetchT = async (url, options = {}, timeoutMs = 10_000) => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
          return await fetch(url, { ...options, signal: controller.signal });
        } finally {
          clearTimeout(timer);
        }
      };
      const query = new URLSearchParams({ ...common, app_name: 'aweme' }).toString();
      const form = new URLSearchParams({
        ...common,
        aweme_id: payload.awemeId,
        text: payload.text,
        text_extra: payload.textExtra,
        aweme_type: '0',
        channel_id: '0',
        city: '',
        sticker_id: '',
        is_fold: '0',
      });
      // reply_id = 楼根；reply_to_reply_id = 具体回哪条（楼中楼才需要）
      if (payload.rootCid) {
        form.set('reply_id', payload.rootCid);
        if (payload.replyToCid) form.set('reply_to_reply_id', payload.replyToCid);
      }

      const out = { http: 0, cid: '', statusCode: null, head: '' };
      try {
        const response = await fetchT(`/aweme/v1/web/comment/publish/?${query}`, {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded', Referer: 'https://www.douyin.com/' },
          body: form.toString(),
        }, 15_000);
        const text = await response.text();
        out.http = response.status;
        out.head = text.slice(0, 240);
        try {
          const json = JSON.parse(text);
          out.statusCode = json.status_code ?? null;
          out.cid = json.comment?.cid ? String(json.comment.cid) : '';
          out.serverLevel = json.comment?.level ?? null;
          out.status = json.comment?.status ?? null;
          out.serverTextExtra = json.comment?.text_extra ?? null;
        } catch (error) {
          out.parseError = String(error?.message ?? error);
        }
      } catch (error) {
        out.error = String(error?.message ?? error);
      }

      // 发完核实落位：只查顶层列表（reply 那个接口会卡死页面，绝不能用）
      if (out.cid && payload.rootCid && payload.verify) {
        await new Promise((done) => setTimeout(done, 1_500));
        if (!out.verified) {
          const q = new URLSearchParams({ ...common, aweme_id: payload.awemeId, count: '20', cursor: '0', item_type: '0' }).toString();
          const json = await fetchT(`/aweme/v1/web/comment/list/?${q}`, {
            credentials: 'include',
            headers: { accept: 'application/json' },
          }, 8_000)
            .then((response) => response.text())
            .then((text) => {
              try {
                return JSON.parse(text);
              } catch {
                return null;
              }
            })
            .catch(() => null);
          out.foundAtTop = Boolean((json?.comments ?? []).some((comment) => String(comment.cid) === out.cid));
        }
      }
      return out;
    }, { common: COMMON, payload: body })
    .catch((error) => ({ http: 0, cid: '', error: String(error?.message ?? error) }));

  const res = {
    http: raw.http,
    cid: raw.cid ?? '',
    statusCode: raw.statusCode ?? null,
    verified: Boolean(raw.verified),
    verified_level: raw.verifiedLevel,
    found_at_top: Boolean(raw.foundAtTop),
  };
  const ok = res.http === 200 && Boolean(res.cid);
  const placement = judgePlacement({ plan: { root: rootCid }, res });
  return {
    ok,
    http: res.http,
    cid: res.cid,
    statusCode: res.statusCode,
    // status=1 正常可见；status=7 是「审核中」（新号/未实名常见，过审后才对外可见）
    status: raw.status ?? null,
    // 服务端保留的 text_extra：里面有 sec_uid 才算真 @ 住了
    textExtra: raw.serverTextExtra ?? null,
    placement,
    ...(ok ? {} : { head: String(raw.head ?? '').slice(0, 300), error: raw.error ?? raw.parseError }),
  };
}