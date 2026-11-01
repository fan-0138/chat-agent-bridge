/**
 * 「主星上的机器人账号 · 小屋」这块地板——dsh-in-home 的娃娃屋图（MIT，作者：星主）。
 *
 * 图是 1376×768 的 2.5D 娃娃屋：地板大、视角接近等距，所以走路不用像 Blender 房间
 * 那样算透视——直接把图上的像素位置换成百分比。
 *
 *   x%      = px / 1376 × 100
 *   bottom% = (768 - py) / 768 × 100   （py 是图片里竖直方向的像素，从顶往下）
 *
 * 缩放沿用插件自己的深度系数：图里 y 从 430（远）到 665（近），立体感靠
 * scale 0.78 → 1.0 还原（见 dsh-in-home client.js 的 SCENE_DEPTH）。
 *
 * 素材来自 dsh-in-home（MIT, © 星主 xingzhu）；角色动作仍来自 dsh-pet（MIT）。
 */

import { createFloor } from './floor.mjs';

const W = 1376;
const H = 768;

/** 图上像素 → 百分比。 */
function at(px, py) {
  return {
    x: Number(((px / W) * 100).toFixed(1)),
    bottom: Number((((H - py) / H) * 100).toFixed(1)),
  };
}

/** 场景里的落脚点：站在屋子空地上，语义对应床/桌/窗/地毯。 */
export const NODES = {
  // ── 有事做的站位 ──
  work: at(860, 505), // 梳妆台/书桌前
  think: at(830, 525),
  eat: at(1005, 600), // 粉地毯上
  phone: at(700, 560), // 屋子中间
  rubik: at(620, 610), // 左前方地板
  window: at(1010, 490), // 窗下、柜子前
  hum: at(950, 585), // 地毯边上
  sleep: { ...at(560, 440), onBed: true }, // 床沿（坐着打盹）
  yawn: at(600, 545),
  stretch: at(760, 580),
  idle: at(720, 600),

  // ── 闲逛用的落脚点 ──
  bedSide: at(620, 470), // 床前（上床/下床的踏板）
  leftF: at(520, 600), // 左前地板
  frontL: at(620, 660), // 最前偏左
  center: at(820, 620), // 中间
  rugF: at(980, 650), // 粉地毯前
  rugR: at(1090, 630), // 粉地毯右
  rightF: at(1080, 560), // 右边地板
};

/**
 * 能走的连线。小屋是一整片地板，家具靠边，所以连得比 Blender 房间自由；
 * 床仍然只能从床前的 bedSide 上下。
 */
export const EDGES = [
  // 床
  ['sleep', 'bedSide'],
  ['bedSide', 'yawn'],
  ['bedSide', 'leftF'],
  ['bedSide', 'stretch'],
  // 左前
  ['leftF', 'frontL'],
  ['leftF', 'rubik'],
  ['leftF', 'yawn'],
  ['frontL', 'rubik'],
  ['frontL', 'center'],
  // 中间
  ['rubik', 'center'],
  ['rubik', 'idle'],
  ['center', 'idle'],
  ['center', 'phone'],
  ['center', 'stretch'],
  ['phone', 'idle'],
  ['phone', 'yawn'],
  ['yawn', 'rubik'],
  ['yawn', 'idle'],
  ['idle', 'stretch'],
  ['stretch', 'work'],
  ['stretch', 'think'],
  ['work', 'think'],
  ['work', 'idle'],
  // 右边
  ['work', 'window'],
  ['window', 'rightF'],
  ['window', 'eat'],
  ['rightF', 'rugR'],
  ['rightF', 'hum'],
  ['rugR', 'rugF'],
  ['rugF', 'eat'],
  ['eat', 'hum'],
  ['hum', 'center'],
];

/** 闲逛去得最多的几个点（床不在里面）。 */
export const WANDER = ['leftF', 'frontL', 'center', 'rugF', 'rugR', 'rightF', 'bedSide'];

/** 走路速度：娃娃屋地板大、视角平，比 Blender 房间慢一点更像在屋里晃。 */
export const WALK_SPEED = 12.5;

/** 深度缩放：y=430 时 0.78，y=665 时 1.0（与 dsh-in-home 的 SCENE_DEPTH 对齐）。 */
export const SCALE = { atBottom0: 1.0964, perBottom: -0.00719, min: 0.74, max: 1.03 };

/** 她脚底在 sprite 帧里离底边还有一点透明留白（实测约 8.4% 帧高）。 */
export const SPRITE_FEET_GAP = 0.084;

/** #her 的基础高度占舞台的百分比（娃娃屋里的比例参考插件：可见高度约占屋高 26%–33%）。 */
export const SPRITE_BASE_HEIGHT = 42;

const floor = createFloor({
  nodes: NODES,
  edges: EDGES,
  wander: WANDER,
  walkSpeed: WALK_SPEED,
  scale: SCALE,
  baseHeight: SPRITE_BASE_HEIGHT,
  feetGap: SPRITE_FEET_GAP,
  aspect: W / H,
});

export const {
  scaleAt,
  feetAt,
  distance,
  route,
  pointsLength,
  lengthMs,
  pointOnPoints,
  pathLength,
  walkMs,
  pointAlong,
  pickStroll,
} = floor;