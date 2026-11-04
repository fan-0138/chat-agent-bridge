import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  REPLY_MAX_AGE_DAYS,
  isSafeToReply,
  loadInbox,
  markReplied,
  pickCandidates,
  unsafeReason,
} from '../src/douyin-inbox.js';

// 固定 now：测试不跟着真实时间漂，也不会因为「跑测试时正好过了 3 天」而红
const NOW = 1_800_000_000_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

const inboxPath = (root) => join(root, 'data/douyin/at-inbox.jsonl');
const repliedPath = (root) => join(root, 'data/douyin/replied.jsonl');

/** 造一条和真通知同形状的行（createTime 是秒，atMe/replyable 是字符串） */
function row({ at = NOW - HOUR, ...over } = {}) {
  return {
    type: 31,
    typeName: '回复了评论 / 在我的评论下回复',
    nid: '7700000000000000001',
    nickname: '陌生网友',
    uid: '42',
    content: '这歌我也循环了好久',
    createTime: Math.floor(at / 1000),
    seenAt: at + 500,
    awemeId: '7689204748985126170',
    awemeDesc: '大众辉腾红标丹拿音响听许茹芸《泪海》',
    commentId: '7700000000000000002',
    rootCommentId: '7700000000000000003',
    videoUrl: 'https://www.douyin.com/video/7689204748985126170',
    atMe: 'True',
    replyable: 'True',
    ...over,
  };
}

/** loadInbox 出来的结构（给 isSafeToReply 的纯逻辑测试用） */
function item(over = {}) {
  return { nid: '1', nickname: '陌生网友', content: '这歌我也循环了好久', at: NOW - HOUR, replyable: true, ...over };
}

/** 临时 root + 写好的 at-inbox，跑完自动清理 */
async function withRoot(lines, fn) {
  const root = await mkdtemp(join(tmpdir(), 'douyin-inbox-'));
  try {
    await mkdir(join(root, 'data/douyin'), { recursive: true });
    if (lines) {
      const body = lines.map((line) => (typeof line === 'string' ? line : JSON.stringify(line)));
      await writeFile(inboxPath(root), `${body.join('\n')}\n`, 'utf8');
    }
    return await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('收件箱：正常一条解析成统一结构（字符串形式的布尔/秒数也认）', async () => {
  await withRoot(
    [
      row({
        nid: '7702103249054926000',
        nickname: '大笨钟.',
        content: '都辉腾了 还不舍得用 准备用啥车上啊[捂脸]',
        createTime: '1793285657',
        videoUrl: 'https://www.douyin.com/video/7689204748985126170',
        atMe: 'True',
        replyable: 'True',
      }),
    ],
    async (root) => {
      const [entry, ...rest] = await loadInbox({ root });
      assert.equal(rest.length, 0);
      assert.deepEqual(entry, {
        nid: '7702103249054926000',
        nickname: '大笨钟.',
        content: '都辉腾了 还不舍得用 准备用啥车上啊[捂脸]',
        videoUrl: 'https://www.douyin.com/video/7689204748985126170',
        awemeId: '7689204748985126170',
        commentId: '7700000000000000002',
        rootCommentId: '7700000000000000003',
        desc: '大众辉腾红标丹拿音响听许茹芸《泪海》',
        typeName: '回复了评论 / 在我的评论下回复',
        at: 1793285657000,
        replyable: true,
      });
    },
  );
});

test('收件箱：坏行跳过，缺字段兜底，createTime 解析失败退回 seenAt', async () => {
  await withRoot(
    [
      '{坏 JSON',
      '[]',
      '{"content":"没有 nid 的行"}',
      row({ nid: '7700000000000000100', content: '第一条' }),
      // 缺 createTime / awemeDesc / 各种 id：at 用 seenAt，其它给空串/默认值
      { nid: '7700000000000000101', content: '只有最少字段', seenAt: NOW - 2000 },
      '',
    ],
    async (root) => {
      const items = await loadInbox({ root });
      assert.equal(items.length, 2, '两条有效行，坏行不算');
      assert.equal(items[0].nid, '7700000000000000100');

      const bare = items[1];
      assert.equal(bare.nid, '7700000000000000101');
      assert.equal(bare.content, '只有最少字段');
      assert.equal(bare.at, NOW - 2000, 'createTime 解析失败退回 seenAt');
      assert.equal(bare.nickname, '');
      assert.equal(bare.videoUrl, '');
      assert.equal(bare.awemeId, '');
      assert.equal(bare.commentId, '');
      assert.equal(bare.rootCommentId, '');
      assert.equal(bare.desc, '');
      assert.equal(bare.typeName, '');
      assert.equal(bare.replyable, true, '缺 replyable 时默认能回');
    },
  );
});

test('收件箱：没有 videoUrl 时用 awemeId 拼；limit 只取尾部；空/缺文件返回 []', async () => {
  const lines = [1, 2, 3, 4].map((n) => row({ nid: `nid-${n}`, videoUrl: undefined }));
  await withRoot(lines, async (root) => {
    const all = await loadInbox({ root });
    assert.equal(all.length, 4);
    assert.equal(all[0].videoUrl, 'https://www.douyin.com/video/7689204748985126170');

    const tail = await loadInbox({ root, limit: 2 });
    assert.deepEqual(tail.map((entry) => entry.nid), ['nid-3', 'nid-4']);
  });

  // 文件不存在（withRoot 不传 lines 就不写文件）
  await withRoot(null, async (root) => {
    assert.deepEqual(await loadInbox({ root }), []);
    assert.deepEqual(await pickCandidates({ root, now: NOW }), []);
  });

  // 空文件
  await withRoot([''], async (root) => {
    assert.deepEqual(await loadInbox({ root }), []);
  });
});

// 纯逻辑判断都钉在 NOW 上（不用真实时钟，否则「未来时间」会干扰过期判断）
const safe = (over) => isSafeToReply(item(over), { now: NOW });
const why = (over) => unsafeReason(item(over), { now: NOW });

test('安全过滤：正常能回；空内容、replyable=False、太旧的不回', () => {
  assert.equal(REPLY_MAX_AGE_DAYS, 3);
  assert.equal(safe(), true);

  assert.equal(safe({ content: '   ' }), false);
  assert.equal(why({ content: '' }), 'empty');

  assert.equal(safe({ replyable: false }), false, '布尔 false');
  assert.equal(safe({ replyable: 'False' }), false, '字符串 "False"');

  assert.equal(safe({ at: NOW - 5 * DAY }), false, '超过 3 天');
  assert.equal(why({ at: NOW - 5 * DAY }), 'too_old');
  assert.equal(safe({ at: NOW - 3 * DAY + 60_000 }), true, '3 天内还行');
  assert.equal(safe({ at: 0 }), false, '没时间信息的也不冒这个险');
});

test('安全过滤：骂人 / 引战的不回，正常聊天的能回', () => {
  for (const content of ['傻鱼，我不打瓦', '滚', '闭嘴吧你', '你在杠什么', '别在这喷了', '垃圾视频', '举报了', '骗子']) {
    assert.equal(safe({ content }), false, `应该跳过：${content}`);
  }
  assert.equal(why({ content: '傻鱼，我不打瓦' }), 'hostile');

  assert.equal(safe({ content: '这歌我也循环了好久，副歌一进来就想哭' }), true);
  assert.equal(safe({ content: '哈哈哈我也一样' }), true);
});

test('安全过滤：广告 / 引流的提示不回', () => {
  for (const content of ['加微信免费领课', '看我主页', '私信我发你', '扫码进群', '点这个链接 http://a.b', 'QQ 号私聊我']) {
    assert.equal(safe({ content }), false, `应该跳过：${content}`);
  }
  assert.equal(why({ content: '私信我发你' }), 'spam');
  assert.equal(safe({ content: '这句歌词我记了好多年' }), true);
});

test('安全过滤：营销号昵称跳过，普通网友别误杀', () => {
  assert.equal(safe({ nickname: '周杰伦音乐小屋' }), false);
  assert.equal(safe({ nickname: '直播带货小能手' }), false);

  for (const nickname of ['汤元', '大笨钟.', '💋M', 'restart', '爱听歌的猫']) {
    assert.equal(safe({ nickname, content: '一样' }), true, `别误杀：${nickname}`);
  }
});

test('挑候选：骂人/广告/过期/明确不回的都筛掉，按时间倒序、index 从 1 开始', async () => {
  const lines = [
    row({ nid: 'safe-new', nickname: '陌生人A', content: '好听', at: NOW - HOUR }),
    row({ nid: 'hostile', content: '傻鱼，我不打瓦', at: NOW - 2 * HOUR }),
    row({ nid: 'spam', content: '加微信聊', at: NOW - 3 * HOUR }),
    row({ nid: 'old', content: '好早的评论', at: NOW - 5 * DAY }),
    row({ nid: 'no-reply', content: '不想回', replyable: 'False', at: NOW - 4 * HOUR }),
    row({ nid: 'safe-older', nickname: '陌生人B', content: '循环了一整晚', at: NOW - 6 * HOUR }),
    row({ nid: 'marketing', nickname: '好歌推荐直播', content: '来我直播间', at: NOW - 30 * 60_000 }),
    row({ nid: 'empty', content: '', at: NOW - 20 * 60_000 }),
  ];
  await withRoot(lines, async (root) => {
    const picked = await pickCandidates({ root, now: NOW });
    assert.deepEqual(
      picked.map((entry) => entry.nid),
      ['safe-new', 'safe-older'],
    );
    assert.deepEqual(
      picked.map((entry) => entry.index),
      [1, 2],
    );
    assert.equal(picked[0].content, '好听');
    assert.ok(picked[0].at > picked[1].at, '时间倒序');
  });
});

test('挑候选：limit 生效，并且已经回过的 nid 不再出现', async () => {
  const lines = [1, 2, 3, 4, 5].map((n) => row({ nid: `nid-${n}`, at: NOW - n * HOUR }));
  await withRoot(lines, async (root) => {
    const picked = await pickCandidates({ root, now: NOW, limit: 3 });
    assert.deepEqual(
      picked.map((entry) => entry.nid),
      ['nid-1', 'nid-2', 'nid-3'],
    );
    assert.deepEqual(
      picked.map((entry) => entry.index),
      [1, 2, 3],
    );

    await markReplied({ root, nid: 'nid-1', at: NOW, text: '回了第一条' });
    const after = await pickCandidates({ root, now: NOW, limit: 3 });
    assert.deepEqual(
      after.map((entry) => entry.nid),
      ['nid-2', 'nid-3', 'nid-4'],
      '回过的被跳过，候选取下一条',
    );
    assert.deepEqual(
      after.map((entry) => entry.index),
      [1, 2, 3],
    );
  });
});

test('记已回：目录不存在会自己建，一行一条 {nid, at, text}', async () => {
  const root = await mkdtemp(join(tmpdir(), 'douyin-inbox-'));
  try {
    // 故意不建 data/douyin
    await markReplied({ root, nid: '7703837135082063000', at: NOW, text: '@大笨钟. 回你的' });
    await markReplied({ root, nid: '7703837135082063001', at: NOW + 1 });

    const rows = (await readFile(repliedPath(root), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    assert.deepEqual(rows, [
      { nid: '7703837135082063000', at: NOW, text: '@大笨钟. 回你的' },
      { nid: '7703837135082063001', at: NOW + 1, text: '' },
    ]);

    await assert.rejects(markReplied({ root, nid: '' }), /nid/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});