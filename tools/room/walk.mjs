/**
 * 「Blender 房间」这块地板——落脚点、可走的路、透视缩放。
 *
 * 房间背景是 Blender 用 camB 渲染的透视图，所以这里的坐标都是画面百分比：
 *   x      = 从左往右 0–100
 *   bottom = 从下往上 0–100（她脚踩的那一点）
 *
 * 为什么不用「直接连直线」：
 *  房间里摆着床、机柜、书桌、书架、圆桌，直线走过去会从家具中间穿过去。
 *  所以把能站的地方列成节点，把能走的路列成边，走之前先寻路——像导航一样绕开家具。
 *
 * 透视缩放：同样的身高，站得越靠下（离镜头越近）画面上越大。
 * 相机固定，scale 和 bottom 是线性关系（pinhole 投影里 scale ∝ 1/深度），
 * 系数由场景站位反算拟合出来；走路时 size 跟着脚下位置自动变，不用手调。
 *
 * 想换另一块地板（比如 dsh-in-home 的小屋），看 house.mjs；两边共用 floor.mjs 的走法。
 */

import { createFloor } from './floor.mjs';

/** 场景里的落脚点（前 11 个来自相机投影反算；后面是专供闲逛的中间点）。 */
export const NODES = {
  // ── 有事做的站位 ──
  work: { x: 37.0, bottom: 20.5 }, // 书桌前
  think: { x: 37.3, bottom: 21.8 },
  eat: { x: 71.5, bottom: 11.7 }, // 圆桌边
  phone: { x: 43.2, bottom: 3.9 }, // 地毯前侧
  rubik: { x: 56.0, bottom: 6.8 },
  window: { x: 65.2, bottom: 20.1 }, // 窗下
  hum: { x: 63.3, bottom: 16.0 },
  sleep: { x: 19.5, bottom: 17.5, onBed: true }, // 床上（坐着打盹；脚踩在床垫前半边）
  yawn: { x: 51.4, bottom: 14.4 },
  stretch: { x: 53.9, bottom: 10.9 },
  idle: { x: 50.1, bottom: 9.2 },

  // ── 闲逛用的落脚点 ──
  rugL: { x: 35.0, bottom: 14.0 }, // 地毯左
  rugC: { x: 47.0, bottom: 8.0 }, // 地毯中间
  rugR: { x: 59.0, bottom: 12.0 }, // 地毯右
  frontC: { x: 52.0, bottom: 3.0 }, // 地毯最前
  rightF: { x: 71.0, bottom: 6.0 }, // 地毯右边的地板
  shelfF: { x: 76.0, bottom: 16.0 }, // 书架前
  bedF: { x: 31.5, bottom: 8.0 }, // 床沿（上床/下床的唯一踏板）
};

/**
 * 能走的连线。没列出来的两点之间不会直着穿过去。
 * 床沿 bedF 是进出床铺的唯一通道，所以只让 bedF 连 sleep 和地毯。
 */
export const EDGES = [
  // 床
  ['sleep', 'bedF'],
  ['bedF', 'rugL'],
  // 地毯一圈
  ['rugL', 'rugC'],
  ['rugL', 'work'],
  ['rugL', 'think'],
  ['rugC', 'idle'],
  ['rugC', 'frontC'],
  ['rugC', 'rubik'],
  ['rugC', 'phone'],
  ['rugC', 'stretch'],
  ['rugC', 'yawn'],
  ['rugC', 'rugR'],
  // 右边
  ['rugR', 'hum'],
  ['rugR', 'window'],
  ['rugR', 'rightF'],
  ['rightF', 'eat'],
  ['rightF', 'shelfF'],
  ['shelfF', 'window'],
  ['window', 'hum'],
  ['work', 'think'],
];

/** 闲逛去得最多的几个点（床不在里面：床只用来睡觉）。 */
export const WANDER = ['rugL', 'rugC', 'rugR', 'frontC', 'rightF', 'shelfF', 'bedF'];

/** 走路速度：单位是「舞台高度的百分比每秒」（横向按 16:9 折算成实际距离）。 */
export const WALK_SPEED = 12;

/** 站得越靠下越大：scale = SCALE.atBottom0 + SCALE.perBottom * bottom。 */
export const SCALE = { atBottom0: 0.8794, perBottom: -0.01368, min: 0.42, max: 1.05 };

/** 她脚底在 sprite 帧里离底边还有一点透明留白（实测约 8.4% 帧高）。 */
export const SPRITE_FEET_GAP = 0.084;

/** #her 的基础高度占舞台的百分比。 */
export const SPRITE_BASE_HEIGHT = 62;

const floor = createFloor({
  nodes: NODES,
  edges: EDGES,
  wander: WANDER,
  walkSpeed: WALK_SPEED,
  scale: SCALE,
  baseHeight: SPRITE_BASE_HEIGHT,
  feetGap: SPRITE_FEET_GAP,
  aspect: 16 / 9,
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