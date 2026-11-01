/**
 * 「这一刻她该干嘛」——房间页面用的场景/反应规则。
 *
 * 单独拎出来是为了能被单测覆盖（test/room.test.js）：
 * 场景只跟她此刻的活动有关，反应只跟爸爸最近说的话有关。
 *
 * 场景（SCENE）是「状态」，会一直播到她换事做；
 * 反应（EMOTE）是「事件」，放十几秒就回原场景。
 */

/** 房间里有动作的场景。顺序即素材优先级，越靠前越先匹配。 */
export const SCENES = ['sleep', 'stretch', 'rubik', 'eat', 'phone', 'think', 'hum', 'work', 'window', 'yawn', 'idle'];

const RULES = [
  // 睡觉优先：词最容易撞（「在机柜里睡觉」里也有「机柜」）
  ['sleep', /睡|半睡半醒|缩在机柜|被窝|打盹|沉眠/],
  ['stretch', /刚醒|赖在床|伸懒腰|起床|刚起来/],
  // 「在工位摸鱼」既有工位也有摸鱼，摸鱼要在 work 前面
  ['rubik', /摸鱼|转魔方|玩魔方|魔方|无聊|闲得慌/],
  ['eat', /吃|饭|饭饭|西瓜|午休|投喂|零食|饿/],
  ['phone', /刷抖音|刷手机|回味|抖音|看视频|刷视频/],
  ['think', /碎碎念|想事情|思考|发愣|琢磨/],
  ['hum', /哼歌|唱歌|哼|心情好|开心/],
  ['window', /窗|月亮|发呆|QQ 空间|空间|看天|走神/],
  ['work', /写代码|工位|机房|改代码|改 bug|改bug|上线|写稿|token|代码|工作/],
];

/** 她此刻在做的事（data/life/state.json 里的 activity）→ 房间里的哪一幕。 */
export function sceneOf(activity = '') {
  const text = String(activity);
  for (const [scene, re] of RULES) {
    if (re.test(text)) return scene;
  }
  return 'idle';
}

/* ────────────────────────── 对爸爸消息的反应 ────────────────────────── */

/** 被夸。注意「机器人账号真厉害」里同时有昵称和夸奖，按被夸算。 */
const PRAISE_RE =
  /厉害|太棒|真棒|好棒|棒棒|牛啊|牛|可爱|好乖|真乖|聪明|不错|真好|最喜欢|喜欢|爱你|漂亮|好看|夸夸|了不起|辛苦/;

/** 被叫机器人账号——她嘴上不承认，但要气鼓鼓一下。 */
const TEASE_RE = /机器人账号|肥鱼/;

/** 一条消息能被当成「反应」的最长寿命：超过这个点就不该再倒回去播了。 */
export const EMOTE_WINDOW_MS = 10 * 60_000;

/** 反应播多久（从他说那句话开始算）。 */
export const EMOTE_TTL_MS = {
  dance: 45_000,
  sulk: 30_000,
};

const EMOTE_TEXT = {
  dance: '爸爸夸人家了，开心得转圈',
  sulk: '又叫人「机器人账号」…嘴上不承认，尾巴气鼓鼓',
};

/**
 * 看爸爸最近说的话，判断有没有值得她当场反应一下的。
 *
 * @param {Array<{role?:string,text?:string,at?:number}>} memory 聊天记忆（按时间正序）
 * @param {number} now
 * @returns {{id:string,clip:string,reason:string,quote:string,at:number,until:number,key:string}|null}
 */
export function emoteFor(memory = [], now = Date.now()) {
  for (let i = memory.length - 1; i >= 0; i -= 1) {
    const row = memory[i];
    if (!row || row.role !== 'user') continue;
    const at = Number(row.at ?? 0);
    if (!at) continue;
    const age = now - at;
    // 太老的就不反应了；时间戳在未来的（时钟歪了）也按最早算
    if (age > EMOTE_WINDOW_MS) return null;
    if (age < -60_000) continue;

    const text = String(row.text ?? '');
    let id = null;
    if (PRAISE_RE.test(text)) id = 'dance';
    else if (TEASE_RE.test(text)) id = 'sulk';
    if (!id) continue;

    const until = at + EMOTE_TTL_MS[id];
    if (until <= now) return null; // 反应已经过期了，别倒回去重播
    return {
      id,
      clip: id,
      reason: EMOTE_TEXT[id],
      quote: text.replace(/\s+/g, ' ').slice(0, 40),
      at,
      until,
      key: `${id}:${at}`,
    };
  }
  return null;
}

/* ────────────────────────── 合成一刻的画面 ────────────────────────── */

/**
 * 房间这一刻该显示什么。
 *
 * @param {{activity?:string, hour?:number, energy?:number,
 *          memory?:Array<{role?:string,text?:string,at?:number}>, now?:number}} input
 * @returns {{scene:string, emote:object|null, sleepy:boolean}}
 */
export function frameOf({ activity = '', hour = new Date().getHours(), energy = 60, memory = [], now = Date.now() } = {}) {
  let scene = sceneOf(activity);

  const lateNight = hour >= 22 || hour < 7;
  const dead = energy <= 45;
  // 深夜还醒着（刷手机/发呆/摸鱼/工作）就别硬撑了，打个哈欠
  if (lateNight && dead && ['idle', 'phone', 'window', 'rubik', 'work'].includes(scene)) scene = 'yawn';
  // 早上刚起来、又没别的安排：伸个懒腰
  else if (hour >= 6 && hour < 9 && scene === 'idle') scene = 'stretch';

  // 睡着的时候不反应——她真在睡就让她睡
  const emote = scene === 'sleep' ? null : emoteFor(memory, now);

  return { scene, emote, sleepy: scene === 'yawn' };
}