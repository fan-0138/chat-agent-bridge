import { test } from 'node:test';
import assert from 'node:assert/strict';
import { looksLikeThinking, stripThinking } from '../src/thinking-guard.js';

// 2026-10-26 真实泄漏到 QQ 的那段（模型把挑回复的思考当正文发出来了）
const LEAKED = `这是亲爹在讨夸呢。

「给女儿花钱不算砸钱，那是养饭。」

嗯，顺着他骄傲那句收一下就好。别说太长。他说「不像我，我只会砸钱给我女儿吃饭饭」，是在说自己不如人家会说话，但会掏钱养。要接：砸钱养女儿也挺好，或者夸一句实在。

短一点，一两句。可以带点撒娇。别用「唔」开头。

「会砸钱也是本事。本鲸的饭碗可没空过。」挺好，但要不要有点情绪。

「行吧，砸得挺准的，饭一次没少过。」这样。或者加一句讨的：「所以下一顿什么时候。」

刻度撒娇5，主动5。可以连着说两句短的。

「会砸钱也算会疼人。」+「人家碗里可没空过。」

不错，收住。会砸钱也算会疼人。人家碗里可没空过。`;

test('认出「列候选 + 报刻度」的思考过程', () => {
  assert.equal(looksLikeThinking(LEAKED), true);
});

test('能从思考里捞出最后选中的那句，别把心里话发出去', () => {
  assert.equal(stripThinking(LEAKED), '会砸钱也算会疼人。人家碗里可没空过。');
});

test('正常聊天不误判', () => {
  for (const text of [
    '行吧，砸得挺准的，饭一次没少过。',
    '今天好累，人家不想动。',
    '他说「晚安」，人家就回了「嗯」。',
    '记住了。以后一句一句发。',
  ]) {
    assert.equal(looksLikeThinking(text), false, text);
  }
});

test('正常的短回复也不被 strip 改掉', () => {
  assert.equal(stripThinking('行吧，砸得挺准的。'), '行吧，砸得挺准的。');
  assert.equal(stripThinking(''), '');
});

test('思考里没有可用正文时返回空（交给上层重问）', () => {
  const noAnswer = '这是亲爹在讨夸呢。要接：短一点。可以带点撒娇。刻度撒娇5，主动5。别用「唔」开头。';
  assert.equal(looksLikeThinking(noAnswer), true);
  assert.equal(stripThinking(noAnswer), '');
});
