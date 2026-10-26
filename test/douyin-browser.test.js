import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pagesToClose } from '../scripts/lib/douyin-browser.mjs';

test('收尾只关自己开的页面，桥接的私信页不能动', () => {
  const bridgePage1 = { name: 'bridge-dm' };
  const bridgePage2 = { name: 'bridge-flow' };
  const mine = { name: 'script' };

  const preexisting = new Set([bridgePage1, bridgePage2]);
  const current = [bridgePage1, bridgePage2, mine];

  const closing = pagesToClose(preexisting, current);
  assert.equal(closing.length, 1);
  assert.equal(closing[0], mine);
});

test('没记下之前的页面时（本机新开的浏览器）全都关', () => {
  const a = { name: 'a' };
  const b = { name: 'b' };
  assert.deepEqual(pagesToClose(new Set(), [a, b]), [a, b]);
  assert.deepEqual(pagesToClose(undefined, [a]), [a]);
});

test('页面列表为空时不会报错', () => {
  assert.deepEqual(pagesToClose(new Set(), []), []);
  assert.deepEqual(pagesToClose(new Set(), undefined), []);
});