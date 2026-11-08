import { test } from 'node:test';
import assert from 'node:assert/strict';
import { polish, openerOf, looksLikeLooping, similarity } from '../src/decor.js';

test('去重：连续用「唔」开头时，这条的起头被删掉', () => {
  assert.equal(polish('唔……我看看', { recent: ['唔，在呢'] }), '我看看');
  assert.equal(polish('唔，我看看', { recent: ['在呢'] }), '唔，我看看');
  // 没撞车就保留起头，只是重复标点被压掉
  assert.equal(polish('唔……我看看', { recent: ['在呢', '刚睡醒'] }), '唔…我看看');
});

test('去重：删完只剩标点就保留原样', () => {
  // 删完是空的就整体保留（标点仍然会被压成单个「…」）
  assert.equal(polish('唔……', { recent: ['唔…'] }), '唔…');
  assert.equal(openerOf('嗯，行'), '嗯');
  assert.equal(openerOf('行吧'), null);
});

test('去重：上一条挂同一个 emoji，这条句尾的删掉', () => {
  assert.equal(polish('好🍚', { recent: ['知道了🍚'] }), '好');
  assert.equal(polish('好🍚', { recent: ['知道了'] }), '好🍚');
  assert.equal(polish('好🐳', { recent: ['知道了🍚'] }), '好🐳');
});

test('去重：emoji 超过两个只留前两个', () => {
  assert.equal(polish('好😤😤😤', { maxEmoji: 2 }), '好😤😤');
  assert.equal(polish('好🍚', { maxEmoji: 0 }), '好');
});

test('去重：重复标点压成一个，普通句子不受影响', () => {
  assert.equal(polish('等一下……马上好。。。'), '等一下…马上好。');
  assert.equal(polish('行，那就这样。'), '行，那就这样。');
  assert.equal(polish(''), '');
  assert.equal(polish('嗯'), '嗯');
});

test('去重：不改动内容的语义（去掉的都是重复的开头/句尾符号）', () => {
  const text = '唔……本来想夸你的，算了。哼，也不看看谁在养你🍚';
  const out = polish(text, { recent: ['唔…又晚了'] });
  assert.equal(out, '本来想夸你的，算了。哼，也不看看谁在养你🍚');
});

/* ── 又绕回同一件事：只提醒她回头看，不拦她 ── */

test('连着要同一件事会被认出来', () => {
  const prev = ['让你叫啊 拍头不算数\n叫一声我听听', '哎哟 这一下是真使劲啊'];
  assert.equal(looksLikeLooping('就让你叫一声 哪里傻了', prev), true);
});

test('正常接话、换话题都不算绕回去', () => {
  const prev = ['让你叫啊 拍头不算数\n叫一声我听听', '哎哟 这一下是真使劲啊'];
  assert.equal(looksLikeLooping('行 不闹了 我玩去了', prev), false);
  assert.equal(looksLikeLooping('西瓜切好了，你吃不吃', prev), false);
});

test('相似度：同义改写不高，重复原句很高', () => {
  assert.ok(similarity('叫一声我听听', '叫一声我听听') > 0.9);
  assert.ok(similarity('行 不闹了 我玩去了', '哎哟 这一下是真使劲啊') < 0.2);
});
