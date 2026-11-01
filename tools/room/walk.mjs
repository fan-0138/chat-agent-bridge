/**
 * 「她在房间里怎么走」——落脚点、可走的路、透视缩放。
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
 */

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
export const WALK_SPEED = 15;

/** 站得越靠下越大：scale = SCALE.atBottom0 + SCALE.perBottom * bottom。 */
export const SCALE = { atBottom0: 0.8794, perBottom: -0.01368 };

/** 她脚底在 sprite 帧里离底边还有一点透明留白（实测约 8.4% 帧高）。 */
export const SPRITE_FEET_GAP = 0.084;

/** #her 的基础高度占舞台的百分比（和 index.html 的 CSS 保持一致）。 */
export const SPRITE_BASE_HEIGHT = 62;

/** 某个脚下位置对应的身体缩放（比例，1 = 原始大小）。 */
export function scaleAt(bottom) {
  const scale = SCALE.atBottom0 + SCALE.perBottom * bottom;
  return Math.max(0.42, Math.min(1.05, Number(scale.toFixed(3))));
}

/** 脚在画面上的真实落点（bottom 百分比）。影子画在这里，不是画在 sprite 帧底边。 */
export function feetAt(bottom) {
  return bottom + SPRITE_FEET_GAP * SPRITE_BASE_HEIGHT * scaleAt(bottom);
}

/** 两点之间的实际距离（按 16:9 把横向百分比折算成纵向百分比）。 */
export function distance(a, b) {
  const dx = (a.x - b.x) * (16 / 9);
  const dy = a.bottom - b.bottom;
  return Math.hypot(dx, dy);
}

function edgeMap() {
  const map = new Map();
  const add = (a, b) => {
    if (!NODES[a] || !NODES[b] || a === b) return;
    if (!map.has(a)) map.set(a, []);
    map.get(a).push(b);
  };
  for (const [a, b] of EDGES) {
    add(a, b);
    add(b, a);
  }
  return map;
}

/**
 * 从 from 走到 to 要经过哪些点（含首尾）。找不到路就返回直接连线。
 * @param {string} from
 * @param {string} to
 * @returns {string[]}
 */
export function route(from, to) {
  if (!NODES[from] || !NODES[to]) throw new Error(`没有这个落脚点：${from} / ${to}`);
  if (from === to) return [from];

  const map = edgeMap();
  const dist = new Map([[from, 0]]);
  const prev = new Map();
  const open = new Set([...map.keys(), from, to]);

  while (open.size > 0) {
    let best = null;
    for (const key of open) {
      const d = dist.get(key);
      if (d === undefined) continue;
      if (best === null || d < dist.get(best)) best = key;
    }
    if (best === null || best === to) break;
    open.delete(best);
    for (const next of map.get(best) ?? []) {
      if (!open.has(next)) continue;
      const d = dist.get(best) + distance(NODES[best], NODES[next]);
      if (d < (dist.get(next) ?? Infinity)) {
        dist.set(next, d);
        prev.set(next, best);
      }
    }
  }

  if (!dist.has(to)) return [from, to];
  const path = [to];
  while (path[0] !== from) {
    const p = prev.get(path[0]);
    if (!p) return [from, to];
    path.unshift(p);
  }
  return path;
}

/** 一串点（不一定是路点）总长，和 distance 同一套单位。 */
export function pointsLength(points) {
  let total = 0;
  for (let i = 1; i < points.length; i += 1) total += distance(points[i - 1], points[i]);
  return total;
}

/** 走这一串点要多少毫秒。 */
export function lengthMs(points, speed = WALK_SPEED) {
  return Math.max(320, Math.round((pointsLength(points) / speed) * 1000));
}

/**
 * 一串点上走了 traveled 距离时，脚踩在哪、朝哪边。
 * @param {{x:number,bottom:number}[]} points
 * @param {number} traveled
 */
export function pointOnPoints(points, traveled) {
  let left = Math.max(0, traveled);
  for (let i = 1; i < points.length; i += 1) {
    const a = points[i - 1];
    const b = points[i];
    const len = distance(a, b);
    if (left <= len || i === points.length - 1) {
      const t = len === 0 ? 1 : Math.min(1, left / len);
      return {
        x: a.x + (b.x - a.x) * t,
        bottom: a.bottom + (b.bottom - a.bottom) * t,
        dirX: b.x - a.x,
        index: i,
      };
    }
    left -= len;
  }
  const only = points[0];
  return { x: only.x, bottom: only.bottom, dirX: 0, index: 0 };
}

/** 一整条路有多长（和 distance 同一套单位）。 */
export function pathLength(keys) {
  let total = 0;
  for (let i = 1; i < keys.length; i += 1) total += distance(NODES[keys[i - 1]], NODES[keys[i]]);
  return total;
}

/** 走这条路要多少毫秒。 */
export function walkMs(keys) {
  return Math.max(320, Math.round((pathLength(keys) / WALK_SPEED) * 1000));
}

/**
 * 路上走了 traveled 距离时，她脚踩在哪、朝哪边。
 * @param {string[]} keys
 * @param {number} traveled
 * @returns {{x:number,bottom:number,dirX:number,index:number}}
 */
export function pointAlong(keys, traveled) {
  let left = Math.max(0, traveled);
  for (let i = 1; i < keys.length; i += 1) {
    const a = NODES[keys[i - 1]];
    const b = NODES[keys[i]];
    const len = distance(a, b);
    if (left <= len || i === keys.length - 1) {
      const t = len === 0 ? 1 : Math.min(1, left / len);
      return {
        x: a.x + (b.x - a.x) * t,
        bottom: a.bottom + (b.bottom - a.bottom) * t,
        dirX: b.x - a.x,
        index: i,
      };
    }
    left -= len;
  }
  const only = NODES[keys[0]];
  return { x: only.x, bottom: only.bottom, dirX: 0, index: 0 };
}

/**
 * 闲逛去哪儿：从当前站位挑 1–2 个点，顺路走一圈再回来。
 * @param {string} fromKey
 * @param {() => number} random
 * @returns {string[]} 依次要去的地名
 */
export function pickStroll(fromKey, random = Math.random) {
  const pool = WANDER.filter((key) => key !== fromKey);
  if (pool.length === 0) return [];
  const count = random() < 0.4 ? 2 : 1;
  const picks = [];
  let last = fromKey;
  for (let i = 0; i < count; i += 1) {
    const candidates = pool.filter((key) => key !== last && !picks.includes(key));
    if (candidates.length === 0) break;
    const key = candidates[Math.floor(random() * candidates.length) % candidates.length];
    picks.push(key);
    last = key;
  }
  return picks;
}