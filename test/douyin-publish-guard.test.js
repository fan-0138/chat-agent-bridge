import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_PER_DAY,
  REQUIRED_TAGS,
  checkDailyCap,
  countPublishedToday,
  dayOf,
  ensureTags,
  findNewWork,
  judgePublishState,
  judgeUploadState,
  normalizeTitle,
  titleSimilarity,
  sameFootage,
  hammingHex,
  findDuplicateWork,
  findDuplicatePublish,
  DUP_TITLE_SIM,
} from '../src/douyin-publish-guard.js';

const at = (month, day, hour, minute = 0) => new Date(2026, month - 1, day, hour, minute, 0).getTime();

test('文案补标签：缺哪个补哪个，三个都齐了就不动', () => {
  assert.equal(ensureTags('去米店把自己抱起来'), `去米店把自己抱起来 ${REQUIRED_TAGS.join('')}`);
  assert.equal(ensureTags('去米店 #机器人账号'), `去米店 #机器人账号 #DeepSeek#ai动画`);
  const full = '去米店 #机器人账号#DeepSeek#ai动画';
  assert.equal(ensureTags(full), full);
  assert.equal(ensureTags(''), REQUIRED_TAGS.join(''));
});

test('今天发了几条：按本地自然日算', () => {
  const now = at(11, 8, 20, 0);
  assert.equal(dayOf(now), '2026-11-08');
  const works = [
    { id: 'a', at: at(11, 8, 19, 10) },
    { id: 'b', at: at(11, 8, 0, 5) },
    { id: 'c', at: at(11, 7, 23, 59) },
    { id: 'd', at: 0 },
  ];
  assert.equal(countPublishedToday(works, now), 2, '只数今天两条');
});

test('一天最多两条：到上限就拒', () => {
  assert.equal(MAX_PER_DAY, 2);
  const now = at(11, 8, 20, 0);
  const one = checkDailyCap({ works: [{ id: 'a', at: at(11, 8, 19, 10) }], now });
  assert.equal(one.allow, true);
  assert.equal(one.today, 1);

  const two = checkDailyCap({
    works: [
      { id: 'a', at: at(11, 8, 9, 0) },
      { id: 'b', at: at(11, 8, 19, 10) },
    ],
    now,
  });
  assert.equal(two.allow, false);
  assert.match(two.reason, /今天已经发了 2 条/);
});

test('上传没走完就不算成功（11-07 那个坑）', () => {
  assert.equal(judgeUploadState({ text: '作品上传中 41%，请勿关闭页面' }), 'uploading');
  assert.equal(judgeUploadState({ text: '正在上传 6.6MB / 16.1MB' }), 'uploading');
  // 预览转码/封面检测不挡发布（页面自己写着「转码过程也可以发布作品」）
  assert.equal(judgeUploadState({ text: '预览转码中，请稍后' }), 'ready');
  assert.equal(judgeUploadState({ text: '封面检测中' }), 'ready');
  assert.equal(judgeUploadState({ text: '上传失败，请重试' }), 'failed');
  assert.equal(judgeUploadState({ text: '发布' }), 'ready');
});

test('点了发布也不算成功：地址跳到内容管理但还在上传，仍然不算', () => {
  // 关键回归：11-07 就是「url 已经是 manage、但视频还在上传」被当成成功
  assert.equal(
    judgePublishState({ url: 'https://creator.douyin.com/creator-micro/content/manage', text: '作品上传中 41%' }),
    'uploading',
  );
  assert.equal(
    judgePublishState({ url: 'https://creator.douyin.com/creator-micro/content/upload', text: '预览转码中，请稍后' }),
    'pending',
  );
  assert.equal(judgePublishState({ url: 'https://creator.douyin.com/creator-micro/content/manage', text: '作品管理' }), 'done');
  assert.equal(judgePublishState({ url: 'https://creator.douyin.com/creator-micro/content/upload', text: '发布成功' }), 'done');
  assert.equal(judgePublishState({ url: 'https://creator.douyin.com/x', text: '发布失败：内容不合规' }), 'failed');
  assert.equal(judgePublishState({ url: 'https://creator.douyin.com/x', text: '正在处理' }), 'pending');
});

test('真发没发出去，以作品列表多没多出一条为准', () => {
  const before = [
    { id: '1', desc: '橡木' },
    { id: '2', desc: '碗' },
  ];
  // 没多出来 → null
  assert.equal(findNewWork({ before, after: before, title: '玻璃柜 #机器人账号' }), null);
  // 多了一条，且文案对得上
  const fresh = findNewWork({
    before,
    after: [{ id: '3', desc: '玻璃柜里的大鲸鱼 #机器人账号#DeepSeek#ai动画' }, ...before],
    title: '玻璃柜里的大鲸鱼 #机器人账号#DeepSeek#ai动画',
  });
  assert.equal(fresh.id, '3');
  // 多出来但文案完全对不上（别的情况）：也得认出来有多一条
  const other = findNewWork({ before, after: [{ id: '9', desc: '完全不一样的东西' }, ...before], title: '玻璃柜' });
  assert.equal(other.id, '9');
});
// ── 去重（2026-11-08 下午，爸爸说她重复发了昨天的） ────────────────────────

test('比文案之前先把话题标签、标点、表情去掉', () => {
  assert.equal(normalizeTitle('玻璃柜里的大鲸鱼，想抱一下就抱一下 #机器人账号#DeepSeek#ai动画'), '玻璃柜里的大鲸鱼想抱一下就抱一下');
  assert.equal(normalizeTitle('#机器人账号 #DeepSeek #ai动画'), '');
  assert.equal(normalizeTitle('三十七块橡木，铺出一块歪地板🍚 #机器人账号 #我的世界'), '三十七块橡木铺出一块歪地板');
  assert.equal(normalizeTitle(''), '');
});

test('文案像不像：只差标签算 1，不同的事算 0', () => {
  // 同一句话，只是标签写法不同
  assert.equal(titleSimilarity('碗端那么高还以为没我的份 #机器人账号#DeepSeek#ai动画', '碗端那么高还以为没我的份 #DeepSeek #机器人账号'), 1);
  // 换了个说法，还是同一件事 → 超过 0.62 的线
  assert.ok(titleSimilarity('玻璃柜里的大鲸鱼，想抱一下就抱一下', '大鲸鱼在玻璃柜里，想抱就抱一下') >= DUP_TITLE_SIM);
  // 两码事 → 0
  assert.equal(titleSimilarity('玻璃柜里的大鲸鱼，想抱一下就抱一下', '碗端那么高还以为没我的份 结果放地上还喂到嘴边'), 0);
  assert.equal(titleSimilarity('', '碗端那么高'), 0);
});

test('抽样帧指纹：同一段片子认得出，不同的认不出', () => {
  const a = ['c8cc94ab0de83f2f', '1a2b3c4d5e6f7080'];
  assert.equal(sameFootage(a, [...a]), true, '完全一样');
  assert.equal(sameFootage(a, ['c8cc94ab0de83f2e', '1a2b3c4d5e6f7081']), true, '差一两位还算同一段');
  assert.equal(sameFootage(a, ['0000000000000000', 'ffffffffffffffff']), false, '差太多');
  assert.equal(sameFootage(a, []), false, '没指纹就不认');
  assert.equal(hammingHex('ffffffffffffffff', '0000000000000000'), 64);
});

test('主页上已经有差不多的，就不能再发', () => {
  const works = [
    { id: 'old', desc: '玻璃柜里的大鲸鱼，想抱一下就抱一下 #机器人账号#DeepSeek#ai动画', at: 1, durationMs: 30125 },
    { id: 'bowl', desc: '碗端那么高还以为没我的份 结果放地上还喂到嘴边', at: 2, durationMs: 30125 },
  ];
  // 文案换了个说法：算重复
  const byTitle = findDuplicateWork({ works, title: '大鲸鱼在玻璃柜里，想抱就抱一下 还要再加一句长的让它更像', durationMs: 12000 });
  assert.equal(byTitle.dup.id, 'old');
  // 文案完全不像、长度也不一样：不算重复
  const unrelated = findDuplicateWork({ works, title: '今天天气不错，出去晒晒太阳', durationMs: 12000 });
  assert.equal(unrelated.dup, null);
  // 长度一样、文案也有点像：算重复（同一件事换个说法重发）
  const weak = findDuplicateWork({
    works: [{ id: 'bean', desc: '豆包姐姐捏的小鲸鱼，哭着蹭手', at: 3, durationMs: 10101 }],
    title: '豆包姐姐捏的，哭完了还得蹭一下手才算完事',
    durationMs: 10101,
  });
  assert.equal(weak.dup.id, 'bean');
  assert.match(weak.dup.why, /长度一样/);
  // 光长度一样、文案一点也不像：不能误伤（她好几条片子都是 30.125 秒）
  const durationOnly = findDuplicateWork({ works, title: '今天天气不错，出去晒晒太阳', durationMs: 30125 });
  assert.equal(durationOnly.dup, null);
  assert.equal(durationOnly.weak.length, 2);
});

test('本地账本：同一个片子重命名、重新编码过也认得出', () => {
  const registry = [
    {
      id: '7705385225223736626',
      title: '去米店把自己抱起来，一袋大米都没我沉。#机器人账号#DeepSeek#ai动画',
      at: 1794049811000,
      sha256: 'aaa',
      durationMs: 30125,
      frames: ['c8cc94ab0de83f2f', '1a2b3c4d5e6f7080'],
    },
  ];
  // 字节一样
  const sameFile = findDuplicatePublish({ print: { sha256: 'aaa', durationMs: 30125, frames: [] }, registry });
  assert.equal(sameFile.dup.id, '7705385225223736626');
  assert.match(sameFile.dup.why, /文件一模一样/);
  // 换了个文件（重编码），但画面一样
  const reencoded = findDuplicatePublish({
    print: { sha256: 'bbb', durationMs: 30125, frames: ['c8cc94ab0de83f2e', '1a2b3c4d5e6f7081'] },
    registry,
  });
  assert.equal(reencoded.dup.id, '7705385225223736626');
  assert.match(reencoded.dup.why, /格子|片子内容一样/);
  // 只有长度一样：不算铁证
  const durationOnly = findDuplicatePublish({ print: { sha256: 'ccc', durationMs: 30125, frames: [] }, registry });
  assert.equal(durationOnly.dup, null);
  assert.equal(durationOnly.weak.length, 1);
  // 空账本
  assert.equal(findDuplicatePublish({ print: {}, registry: [] }).dup, null);
});
