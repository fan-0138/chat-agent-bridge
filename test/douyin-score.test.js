import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dropReason, normalize, score, rank, walkAwemes, DEFAULTS } from '../src/douyin-score.js';

const NOW = new Date('2026-10-25T02:00:00+08:00').getTime();
const aweme = (over = {}) => ({
  aweme_id: '7600000000000000001',
  desc: '一条正常的视频文案，长度够',
  duration: 30_000,
  create_time: Math.floor((NOW - 3 * 3_600_000) / 1000), // 3 小时前
  statistics: { digg_count: 50_000, comment_count: 2_000, collect_count: 5_000, share_count: 3_000 },
  author: { nickname: '某人', sec_uid: 'SEC' },
  text_extra: [{ hashtag_name: '猫' }],
  ...over,
});

test('硬筛：没文案直接丢', () => {
  assert.equal(dropReason(aweme({ desc: '   ' })), 'no_desc');
});

test('硬筛：短于 12 秒的丢', () => {
  assert.equal(dropReason(aweme({ duration: 8_000 })), 'too_short_video');
  assert.equal(dropReason(aweme({ duration: 20_000 })), null);
});

test('硬筛：文案短且评论少才丢（只缺一个不丢）', () => {
  const shortQuiet = aweme({ desc: '嗯', statistics: { digg_count: 100, comment_count: 1 } });
  assert.equal(dropReason(shortQuiet), 'short_and_quiet');

  const shortLively = aweme({ desc: '嗯', statistics: { digg_count: 100, comment_count: 50 } });
  assert.equal(dropReason(shortLively), null);
});

test('归一化：字段齐全，分享链接优先用官方给的', () => {
  const item = normalize(aweme({ share_info: { share_url: 'https://v.douyin.com/abc/' } }), NOW);
  assert.equal(item.id, '7600000000000000001');
  assert.equal(item.author, '某人');
  assert.equal(item.likes, 50_000);
  assert.equal(item.collects, 5_000);
  assert.equal(item.shareUrl, 'https://v.douyin.com/abc/');
  assert.equal(item.webUrl, 'https://www.douyin.com/video/7600000000000000001');
  assert.equal(item.ageHours, 3);
  assert.deepEqual(item.tags, ['猫']);
});

test('归一化：没有官方分享链接时退回 iesdouyin 分享页', () => {
  const item = normalize(aweme(), NOW);
  assert.match(item.shareUrl, /iesdouyin\.com\/share\/video\//);
});

test('打分：权重是 赞1 · 评2 · 藏3 · 转2', () => {
  // 用 200 小时前的发布时间，避开「新鲜度 ×1.15」，只验证权重本身
  const old = Math.floor((NOW - 200 * 3_600_000) / 1000);
  const mk = (stats) => normalize(aweme({ statistics: stats, create_time: old }), NOW);
  const digg = mk({ digg_count: 1000, comment_count: 0, collect_count: 0, share_count: 0 });
  const collect = mk({ digg_count: 0, comment_count: 0, collect_count: 1000, share_count: 0 });
  const share = mk({ digg_count: 0, comment_count: 0, collect_count: 0, share_count: 1000 });
  assert.equal(score(digg, NOW), 1000);
  assert.equal(score(collect, NOW), 3000, '收藏权重 3 倍');
  assert.equal(score(share, NOW), 2000, '转发权重 2 倍');
});

test('打分：评论比落在 2%–25% 之间会加分', () => {
  const good = normalize(aweme({ statistics: { digg_count: 10_000, comment_count: 1_000 } }), NOW);
  const silent = normalize(aweme({ statistics: { digg_count: 10_000, comment_count: 10 } }), NOW);
  assert.ok(score(good, NOW) > score(silent, NOW));
});

test('打分：广告和直播归零', () => {
  const ad = normalize(aweme({ ad_brand_info: {} }), NOW);
  const live = normalize(aweme({ live_info: {} }), NOW);
  assert.equal(score(ad, NOW), 0);
  assert.equal(score(live, NOW), 0);
});

test('排序：去重、跳过看过的、太老太爆的过滤掉', () => {
  const items = [
    aweme({ aweme_id: '1' }),
    aweme({ aweme_id: '2', statistics: { digg_count: 9_000_000, comment_count: 10 } }), // 太爆
    aweme({ aweme_id: '3', create_time: Math.floor((NOW - 60 * 24 * 3_600_000) / 1000) }), // 太老
    aweme({ aweme_id: '4' }),
  ];
  const result = rank(items, { now: NOW, limit: 10, maxLikes: 2_000_000, maxAgeHours: 24 * 7 });
  assert.deepEqual(result.items.map((i) => i.id).sort(), ['1', '4']);
  assert.equal(result.dropped.too_viral, 1);
  assert.equal(result.dropped.too_old, 1);

  const seen = rank(items, { now: NOW, limit: 10, seenIds: ['1'] });
  assert.ok(!seen.items.some((i) => i.id === '1'));
});

test('排序：结果按分数从高到低', () => {
  const items = [
    aweme({ aweme_id: 'a', statistics: { digg_count: 1_000, comment_count: 0, collect_count: 0, share_count: 0 } }),
    aweme({ aweme_id: 'b', statistics: { digg_count: 500_000, comment_count: 0, collect_count: 0, share_count: 0 } }),
  ];
  const { items: ranked } = rank(items, { now: NOW });
  assert.equal(ranked[0].id, 'b');
});

test('递归收集：任意层级的 aweme 都能捞出来', () => {
  const payload = { data: [{ aweme_list: [aweme({ aweme_id: 'x' }), { nested: { aweme_id: 'y', desc: '嵌套的' } }] }] };
  const bag = walkAwemes(payload);
  assert.deepEqual([...bag.keys()].sort(), ['x', 'y']);
});

test('默认阈值跟原版一致', () => {
  assert.equal(DEFAULTS.minDurationMs, 12_000);
  assert.equal(DEFAULTS.minDescLen, 12);
  assert.equal(DEFAULTS.minComments, 3);
});
