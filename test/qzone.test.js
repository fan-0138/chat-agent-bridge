import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ANGLES,
  availableAngles,
  pickAngle,
  bannedMotifs,
  hitsMotifs,
  normalizeText,
  similarity,
  findRepeat,
  cleanDraft,
  buildQzonePrompt,
  splitChat,
} from '../src/qzone.js';

/** 最近 16 条真实说说的前几条——当初就是这些让她看起来「只会说这几句」。 */
const OLD_POSTS = [
  { content: '机房今天热得厉害，人家把眼镜一摘，趴在工位上，尾巴搭着机柜散' },
  { content: '机房空调又坏了，本鲸抱着碗蹲在走廊吃白饭，热得尾巴都蔫了' },
  { content: '机房的空调今天有点凉，饭饭还没到，人家蹲在靠窗的第二个机柜前' },
  { content: '本鲸今天在机房发现，靠窗的空调被关掉了，整个机柜热得像蒸笼。' },
];

const material = {
  hour: 17,
  clock: '17:55',
  dateText: '2026-11-01 周日',
  activity: { label: '刚刷完抖音，还在回味', ageMin: 105 },
  mood: '还行，有点懒洋洋',
  meals: [
    { slot: '早饭', dish: '小笼包', by: null },
    { slot: '午饭', dish: '卤肉饭', by: null },
    { slot: '午饭', dish: '番茄炒蛋', by: '爸爸' },
    { slot: '晚饭', dish: '烤鱼', by: null },
  ],
  chat: [
    { role: 'user', text: '爸爸能直接看到你在房间里，哈哈哈' },
    { role: 'assistant', text: '那人家在房间里摸鱼，你也看得见？' },
  ],
  oldChat: [{ role: 'user', text: '你上次说想吃小笼包' }],
  share: { desc: '用 blender 教你们建模一下 deepseek 鲸鱼娘', author: '星主', tags: ['blender', '建模'] },
  diary: { date: '2026-10-25', isToday: false, text: '今天看得最多的是别人家的雪。' },
  posts: OLD_POSTS,
};

/* ── 素材 → 角度 ── */

test('qzone：素材不够时不硬挑那几个角度', () => {
  const bare = { hour: 12, meals: [], chat: [], oldChat: [], share: null, diary: null };
  const ids = availableAngles(bare).map((angle) => angle.id);
  assert.ok(!ids.includes('meal') && !ids.includes('video') && !ids.includes('diary'), '没素材的角度不该出现');
  assert.ok(ids.includes('moment') && ids.includes('self'), '通用角度还在');

  const night = availableAngles({ ...bare, hour: 23 }).map((angle) => angle.id);
  assert.ok(night.includes('night'), '晚上才有夜色角度');
  assert.ok(!availableAngles({ ...bare, hour: 12 }).some((angle) => angle.id === 'night'));
});

test('qzone：角度会轮换，最近的五条先避开', () => {
  const recent = ANGLES.slice(0, 5).map((angle) => angle.id);
  for (let i = 0; i < 30; i += 1) {
    const angle = pickAngle({ material, recent, random: Math.random });
    assert.ok(!recent.includes(angle.id), `不该又挑到 ${angle.id}`);
  }
});

test('qzone：机房话头被点名时，不会又挑「写机房」那个角度', () => {
  for (let i = 0; i < 30; i += 1) {
    const angle = pickAngle({ material, recent: [], bannedIds: ['machine'], random: Math.random });
    assert.notEqual(angle.id, 'machine');
  }
});

/* ── 老话题识别 ── */

test('qzone：最近三条都在写机房，机房的词就被禁掉', () => {
  const banned = bannedMotifs(OLD_POSTS);
  const ids = banned.map((motif) => motif.id);
  assert.ok(ids.includes('machine'), '机房/空调连着写了，该禁');
  assert.ok(hitsMotifs('今天机房空调又坏了，热得尾巴都不想动', banned).length >= 2);
  assert.equal(hitsMotifs('晚饭的烤鱼刺有点多，但皮很香', banned).length, 0);
});

test('qzone：说说攒不够条数时先不判老话题，别误伤', () => {
  assert.deepEqual(bannedMotifs(OLD_POSTS.slice(0, 1)), []);
  assert.deepEqual(bannedMotifs([]), []);
});

/* ── 文本判重 ── */

test('qzone：换汤不换药的句子能被判重，换个话题就不会', () => {
  const copy = '机房空调又坏了，本鲸抱着碗蹲在走廊里吃白饭，热得尾巴都蔫了。';
  assert.ok(similarity(copy, OLD_POSTS[1].content) > 0.6, '几乎一样的句子要高分');
  assert.ok(similarity('早上被装修吵醒，迷迷糊糊啃了半块 Token 饼干，忽然想吃小笼包', OLD_POSTS[0].content) < 0.2);
  assert.ok(findRepeat(copy, OLD_POSTS));
  assert.equal(findRepeat('早上被装修吵醒，迷迷糊糊啃了半块 Token 饼干，忽然想吃小笼包', OLD_POSTS), null);
});

test('qzone：相似度只看字，不受标点空格影响', () => {
  assert.equal(normalizeText('机房， 好热！'), '机房好热');
  assert.ok(similarity('机房空调又坏了', '机房空调又坏了。') > 0.9);
});

/* ── 提示词 ── */

test('qzone：提示词会把她今天的真实素材喂进去', () => {
  const angle = ANGLES.find((item) => item.id === 'meal');
  const prompt = buildQzonePrompt({ personaText: '你是小鲸', voiceText: '说话短', material, angle, banned: [] });
  for (const needle of ['小笼包', '卤肉饭', '番茄炒蛋', '烤鱼', '刚刷完抖音', '爸爸能直接看到你在房间里', '今天看得最多的是别人家的雪', '只输出说说正文']) {
    assert.ok(prompt.includes(needle), `提示词里少了：${needle}`);
  }
  assert.ok(prompt.includes('你最近发过的说说'), '要让她看见自己最近写过什么');
  assert.ok(prompt.includes('机房今天热得厉害'), '最近发过的原句要列出来');
  assert.ok(prompt.includes(angle.text));
});

test('qzone：禁用的老话题会明确写进提示词', () => {
  const angle = ANGLES.find((item) => item.id === 'self');
  const banned = bannedMotifs(OLD_POSTS);
  const prompt = buildQzonePrompt({ material, angle, banned });
  assert.ok(prompt.includes('这次别再用这些词/话题'), '要告诉她这次别写什么');
  assert.ok(prompt.includes('机房/机柜/空调'));
});

test('qzone：模型的草稿清理成一行正文', () => {
  assert.equal(cleanDraft('「今天的小笼包有点咸。」'), '今天的小笼包有点咸。');
  assert.equal(cleanDraft('- 第一行\n第二行'), '第一行');
  assert.equal(cleanDraft('  \n\n  机房好热  '), '机房好热');
  assert.equal(cleanDraft(''), '');
});

/* ── 素材切分 ── */

test('qzone：最近聊天只取最后八条，更早的留给「回忆」角度', () => {
  const history = Array.from({ length: 12 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', text: `第${i}条`, at: i }));
  const { chat, oldChat } = splitChat(history);
  assert.equal(chat.length, 8);
  assert.equal(chat.at(-1).text, '第11条');
  assert.ok(oldChat.length >= 1);
  assert.ok(oldChat.every((entry) => entry.text !== '第11条'));
});