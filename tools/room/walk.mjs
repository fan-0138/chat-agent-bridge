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
  wardrobe: { x: 35.4, bottom: 28.3 }, // 衣柜前（相机投影算出来的）
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
  // 衣柜
  ['wardrobe', 'work'],
  ['wardrobe', 'think'],
  ['wardrobe', 'rugL'],
];

/**
 * 可点的家具热区（百分比，相对舞台：left/top/width/height）。
 * 点一下她会走过去、做对应动作、冒一句话——就是「和家具互动」。
 */
export const HOTSPOTS = [
  { id: 'bed', label: '床', node: 'sleep', clip: 'sleep', left: 0, top: 64, w: 31, h: 36,
    lines: ['床…人家先躺一会儿', '被子是凉的，正好'] },
  { id: 'desk', label: '书桌', node: 'work', clip: 'work', left: 38, top: 55, w: 30, h: 16,
    lines: ['改两个 bug 就回来', '键盘声比机房好听'] },
  { id: 'shelf', label: '书架', node: 'shelfF', clip: 'think', left: 69, top: 28, w: 17, h: 44,
    lines: ['这本书上回夹了张书签', '翻两页就走神了'] },
  { id: 'window', label: '窗', node: 'window', clip: 'window', left: 40, top: 22, w: 32, h: 28,
    lines: ['外面月亮好亮，不看白不看'] },
  { id: 'table', label: '饭桌', node: 'eat', clip: 'eat', left: 74, top: 60, w: 16, h: 10,
    lines: ['饭饭！', '这碗饭看着就香'] },
  { id: 'rug', label: '地毯', node: 'rugC', clip: 'idle', left: 25, top: 66, w: 43, h: 29,
    lines: ['坐一会儿，摸个鱼'] },
  { id: 'lamp', label: '灯', lamp: true, left: 55, top: 2, w: 12, h: 14,
    lines: [] },
  { id: 'wardrobe', label: '衣柜', node: 'wardrobe', clip: 'outfit', left: 29.3, top: 28.1, w: 13.7, h: 41.2,
    lines: ['换一身…这件还是那件', '衣柜里全是深蓝色，挑不出来'] },
  { id: 'monitor', label: '显示器', node: 'work', clip: 'work', left: 44, top: 39, w: 14, h: 13,
    lines: ['先把这个报错改掉', '屏幕亮着，人就得坐下'] },
  { id: 'rack', label: '机柜', stay: true, clip: 'rack', left: 6.6, top: 30.3, w: 16.6, h: 42.9,
    lines: ['机柜的风扇声，听着就安心', 'LED 闪得挺齐，没掉线'] },
  { id: 'cooker', label: '饭锅', node: 'eat', clip: 'cook', left: 76, top: 60, w: 10, h: 9,
    lines: ['饭还在焖，等两分钟', '今天的米放多了半杯'] },
  { id: 'curtain', label: '窗帘', curtain: true, left: 37.5, top: 19, w: 4.5, h: 30,
    lines: ['拉上窗帘，机房的光就照不进来了'] },
];

/** 只在交互里用的动作（不是生活场景，所以不在 scene.mjs 里）。 */
export const EXTRA_CLIPS = ['outfit', 'rack', 'cook'];

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

/**
 * 走路素材原生朝哪边。
 *
 * 走路片段是万相图生视频从 idle 那一帧长出来的，她是**朝左看**的（11-01 反馈：
 * 「从左往右走脸是朝左看」）。所以往右走要水平镜像过去，脸才朝着走的方向。
 * 换成别的素材（例如正面或朝右的）就把这里改掉。
 */
export const NATIVE_FACING = 'left';

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