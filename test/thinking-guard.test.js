import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  looksLikeThinking,
  stripThinking,
  looksLikeSelfTalk,
  stripSelfTalk,
  looksLikeNoteTalk,
  stripNoteTalk,
  trimRepeatedTail,
} from '../src/thinking-guard.js';

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

/* ───────── 第二种漏：把「我怎么看他这句话」的独白当正文（2026-10-28） ───────── */

const SELFTALK = `我去找过你——这话有点不一样。是在说去哪里找的？

这句听着不太像平常的聊天，里面带了点别的意思。我先问一句：找哪儿去了？`;

test('认出「复述他的话 + 点评他这句话」的独白', () => {
  assert.equal(looksLikeSelfTalk(SELFTALK, '我去找过你'), true);
});

test('独白里一句人话都捞不出来时返回空（交给上层重问）', () => {
  assert.equal(stripSelfTalk(SELFTALK), '');
});

test('独白和正文混在一起时只留正文', () => {
  assert.equal(stripSelfTalk('这句听着不太像平常聊天。\n行吧，那就当你在夸人家。'), '行吧，那就当你在夸人家。');
});

test('正常聊天不误判成「判断独白」', () => {
  for (const text of [
    '你这话说得好难听。',
    '我先问一句，你吃饭了没？',
    '人家在说正经的。',
    '行吧，砸得挺准的，饭一次没少过。',
    '找什么给人家呀？',
  ]) {
    assert.equal(looksLikeSelfTalk(text, '我去找过你'), false, text);
  }
});

test('没有他原话时，单看一句「我先问一句」不算独白', () => {
  assert.equal(looksLikeSelfTalk('我先问一句：你吃饭没？'), false);
});

// 2026-11-07 换模型之后真实漏到 QQ 的那条：她在正文里纠结要不要加标记，还把改稿念了出来
const NOTE_LEAK = `米店抱大米那条，刚剪好的
玻璃柜那条留明天，一天一条别挤着发
八点我准时传
实际没吃，别写。删掉。改成不加标记或者只写此刻？没换状态。就不加。八点我准时传`;

test('认出「纠结标记」的正文泄漏', () => {
  assert.equal(looksLikeNoteTalk(NOTE_LEAK), true);
});

test('剥掉纠结，只留真的要说的', () => {
  const cleaned = stripNoteTalk(NOTE_LEAK);
  assert.doesNotMatch(cleaned, /别写|删掉|没换状态|不加标记/);
  assert.match(cleaned, /米店抱大米那条/);
  assert.match(cleaned, /八点我准时传/);
});

test('正常说话里出现一个「删掉」不算纠结', () => {
  assert.equal(looksLikeNoteTalk('那条评论我删掉了，别理他。'), false);
  assert.equal(looksLikeNoteTalk('八点我准时传，你记得看。'), false);
});

test('改稿留下的重复尾巴会被截断', () => {
  const trimmed = trimRepeatedTail('米店抱大米那条。\n八点我准时传\n实际没吃。\n八点我准时传');
  // 换行会保留（切句时不 trim），所以按去空白后的文本比较，并确认只留前面那两句
  assert.equal(trimmed.replace(/\s+/g, ''), '米店抱大米那条。八点我准时传');
  assert.equal((trimmed.match(/八点我准时传/g) ?? []).length, 1, '重复的那句应该只剩一次');
  // 没有重复就一个字都不动
  const normal = '今天发米店那条，八点整。你记得看。';
  assert.equal(trimRepeatedTail(normal), normal);
});

test('MaaS 线路那种英文推理 + Final 收尾，能剥出正文', () => {
  const leak = `Answer in Chinese, one sentence. Maybe add nothing else. The instruction — strictly one sentence. I will give exactly one sentence.
Should I mention 今天还没发? Not necessary.
Final: "今天发两条：19:30 先发米店抱大米，21:30 再发玻璃柜大鲸鱼。"`;
  assert.equal(looksLikeThinking(leak), true);
  assert.equal(stripThinking(leak), '今天发两条：19:30 先发米店抱大米，21:30 再发玻璃柜大鲸鱼。');
});
