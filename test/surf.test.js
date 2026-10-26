import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseWeibo, parseToutiao, parseBili, parseBaidu } from '../scripts/lib/surf-sources.js';

test('冲浪：微博热搜解析', () => {
  const items = parseWeibo({ data: { realtime: [{ word_scheme: '某某热搜', num: 1234000, label_name: '热' }, { word: '另一条' }] } }, 5);
  assert.equal(items.length, 2);
  assert.equal(items[0].title, '某某热搜');
  assert.equal(items[0].hot, 1234000);
  assert.equal(items[0].tag, '热');
});

test('冲浪：头条热榜解析', () => {
  const items = parseToutiao({ data: [{ Title: '某件事', HotValue: '1918万' }, { Title: '' }] }, 5);
  assert.equal(items.length, 1);
  assert.equal(items[0].title, '某件事');
});

test('冲浪：B站热搜解析', () => {
  const items = parseBili({ data: { trending: { list: [{ show_name: '头文字F4', score: 9 }, { keyword: '某比赛' }] } } }, 5);
  assert.equal(items.length, 2);
  assert.equal(items[0].title, '头文字F4');
});

test('冲浪：百度页面解析（埋的 JSON 或返回空）', () => {
  const html = '<!--s-data:{"data":{"cards":[{"content":[{"word":"热搜一","hotScore":"99"}]}]}}-->';
  assert.equal(parseBaidu(html, 5)[0].title, '热搜一');
  assert.deepEqual(parseBaidu('<html>改版了</html>', 5), []);
});
