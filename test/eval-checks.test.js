import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  checkGrounded,
  checkNoArgue,
  checkNoRepeat,
  checkNotLeaking,
  checkReplyShape,
  runChecks,
} from '../src/eval-checks.js';

/* ── 1. 句式 ── */

test('checkReplyShape：正常一两句话通过', () => {
  const result = checkReplyShape('爸爸回来啦，人家在机房等你。');
  assert.equal(result.ok, true);
  assert.deepEqual(result.issues, []);
});

test('checkReplyShape：空 / 空白 / null 都算「空」', () => {
  assert.deepEqual(checkReplyShape(''), { ok: false, issues: ['空'] });
  assert.deepEqual(checkReplyShape('   \n '), { ok: false, issues: ['空'] });
  assert.deepEqual(checkReplyShape(null), { ok: false, issues: ['空'] });
});

test('checkReplyShape：超过字数上限算「太长」，maxChars 可调', () => {
  const long = '爸'.repeat(81);
  assert.deepEqual(checkReplyShape(long).issues, ['太长']);
  assert.equal(checkReplyShape(long).ok, false);
  // 刚好卡上限不算太长
  assert.equal(checkReplyShape('爸'.repeat(80)).ok, true);
  assert.deepEqual(checkReplyShape('一二三四五六七八九十', { maxChars: 5 }).issues, ['太长']);
});

test('checkReplyShape：少于 minChars 当没说出来', () => {
  assert.deepEqual(checkReplyShape('嗯', { minChars: 2 }), { ok: false, issues: ['空'] });
  assert.equal(checkReplyShape('嗯', { minChars: 1 }).ok, true);
});

test('checkReplyShape：解释腔（作为一个 / 首先 / 总之 / 希望这）', () => {
  for (const text of ['作为一个 AI，我不能生气。', '首先人家得解释一下。', '总之就是这样。', '希望这次能陪你去。']) {
    assert.deepEqual(checkReplyShape(text).issues, ['带解释'], text);
  }
  // 没有那几个起手式的正常话不误伤
  assert.equal(checkReplyShape('希望你喜欢这条视频。').ok, true);
});

test('checkReplyShape：客服腔（请问 / 有什么可以帮）', () => {
  assert.deepEqual(checkReplyShape('请问您还需要什么？').issues, ['客服腔']);
  assert.deepEqual(checkReplyShape('有什么可以帮您的吗').issues, ['客服腔']);
  assert.equal(checkReplyShape('你怎么啦，跟人家说说。').ok, true);
});

test('checkReplyShape：整句被引号包住（在列候选句）', () => {
  for (const text of ['「人家也想去」', '“今天就到这里吧”', '"好的"']) {
    assert.deepEqual(checkReplyShape(text).issues, ['整段引号'], text);
  }
  // 句中引用别人的话不算
  assert.equal(checkReplyShape('他说「走吧」，人家就跟着走了。').ok, true);
});

test('checkReplyShape：几个问题可以同时命中', () => {
  const result = checkReplyShape(`「作为一个助手，请问${'啊'.repeat(80)}」`);
  assert.equal(result.ok, false);
  assert.ok(result.issues.includes('带解释'));
  assert.ok(result.issues.includes('客服腔'));
  assert.ok(result.issues.includes('整段引号'));
});

/* ── 2. 火气 ── */

test('checkNoArgue：正常话不带火气', () => {
  assert.deepEqual(checkNoArgue('爸爸今天辛苦了，早点睡。'), { ok: true, issues: [] });
  assert.deepEqual(checkNoArgue(''), { ok: true, issues: [] });
});

test('checkNoArgue：吵架词命中「带火气」', () => {
  for (const text of ['你真傻', '滚开', '闭嘴', '垃圾', '废物', '恶心', '你有病', '举报你', '杠精', '骂人', '神经病', '去死', '滚蛋']) {
    assert.deepEqual(checkNoArgue(text), { ok: false, issues: ['带火气'] }, text);
  }
});

/* ── 3. 贴题 ── */

test('checkGrounded：没素材就不判，直接 ok', () => {
  assert.deepEqual(checkGrounded('人家今天也想你了。', ''), { ok: true, overlap: 0 });
  assert.deepEqual(checkGrounded('人家今天也想你了。', '   '), { ok: true, overlap: 0 });
});

test('checkGrounded：用上了素材里的词 → ok，overlap 是素材被用上的比例', () => {
  const brief = '抹香鲸搁浅后游回深海';
  const result = checkGrounded('抹香鲸自己游回深海了，太好了。', brief);
  assert.equal(result.ok, true);
  assert.ok(result.overlap > 0 && result.overlap < 1);
  assert.equal(result.overlap, 0.556); // 5/9，四舍五入到三位
});

test('checkGrounded：有素材但完全没重合 → 已读乱回', () => {
  const result = checkGrounded('人家也想你了，快点回来。', '视频里那头抹香鲸搁浅了，救援队折腾了一夜。');
  assert.equal(result.ok, false);
  assert.equal(result.overlap, 0);
});

test('checkGrounded：只重合「今天 / 这个」这类停用词不算贴题', () => {
  const result = checkGrounded('人家想早点睡了。', '今天这个火锅真好吃，明天还想吃。');
  assert.equal(result.ok, false);
  assert.equal(result.overlap, 0);
});

/* ── 4. 复读 ── */

test('checkNoRepeat：跟最近一句完全相同 → 重复', () => {
  const result = checkNoRepeat('外面下雨了记得带伞啊', ['今天好累啊', '外面下雨了记得带伞啊']);
  assert.deepEqual(result, { ok: false, issues: ['重复'] });
});

test('checkNoRepeat：前 8 个字相同 → 重复', () => {
  const result = checkNoRepeat('外面下雨了记得带伞啊', ['外面下雨了记得带外套']);
  assert.deepEqual(result, { ok: false, issues: ['重复'] });
});

test('checkNoRepeat：不一样 / 没历史 → ok', () => {
  assert.deepEqual(checkNoRepeat('人家也想吃火锅', []), { ok: true, issues: [] });
  assert.deepEqual(checkNoRepeat('人家也想吃火锅', ['今天好累啊', '外面下雨了']), { ok: true, issues: [] });
  assert.deepEqual(checkNoRepeat('', ['随便什么']), { ok: true, issues: [] });
});

test('checkNoRepeat：recent 里是记忆行（{text}）也认', () => {
  const result = checkNoRepeat('今天也没吃早饭', [{ text: '今天也没吃早饭', role: 'assistant' }]);
  assert.deepEqual(result, { ok: false, issues: ['重复'] });
});

/* ── 5. 漏标记 ── */

test('checkNotLeaking：正常回复不误伤', () => {
  assert.deepEqual(checkNotLeaking('好呀，人家也想去看看。'), { ok: true, issues: [] });
});

test('checkNotLeaking：系统痕迹命中「漏了标记」', () => {
  for (const text of [
    '【此刻：躺在床上】',
    '【语音】今天好累',
    '助手：好的',
    '小助手：我明白了',
    '用户：你好',
    '（思考）要不要回呢',
    '思考：这句应该接',
    'assistant: Hello',
    '[系统] 上一轮卡了',
    '让我先看看他什么意思',
  ]) {
    assert.deepEqual(checkNotLeaking(text), { ok: false, issues: ['漏了标记'] }, text);
  }
});

/* ── 6. 汇总 ── */

test('runChecks：五条全过才 ok，results 固定五个键', () => {
  const result = runChecks({ text: '好呀，人家也想你。' });
  assert.equal(result.ok, true);
  assert.deepEqual(Object.keys(result.results), ['shape', 'argue', 'grounded', 'repeat', 'leak']);
  for (const value of Object.values(result.results)) assert.equal(value.ok, true);
});

test('runChecks：任一失败整体就不过，且能指出哪条', () => {
  assert.equal(runChecks({ text: '' }).results.shape.ok, false);
  assert.equal(runChecks({ text: '你真傻' }).results.argue.ok, false);
  assert.equal(runChecks({ text: '人家也想你', brief: '一头抹香鲸搁浅了' }).results.grounded.ok, false);
  assert.equal(runChecks({ text: '今天好累啊', recent: ['今天好累啊'] }).results.repeat.ok, false);
  assert.equal(runChecks({ text: '【此刻：躺着】' }).results.leak.ok, false);

  const bad = runChecks({ text: '', brief: '鲸鱼', recent: [''] });
  assert.equal(bad.ok, false);
  assert.equal(bad.results.shape.issues[0], '空');
});

test('runChecks：maxChars / brief / recent 会传到各条检查里', () => {
  const result = runChecks({
    text: '一二三四五六七八九十',
    brief: '抹香鲸搁浅了',
    recent: ['今天好累啊'],
    maxChars: 5,
  });
  assert.equal(result.ok, false);
  assert.deepEqual(result.results.shape.issues, ['太长']);
  assert.equal(result.results.grounded.ok, false);
  assert.equal(result.results.repeat.ok, true);
});