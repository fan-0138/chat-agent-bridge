/**
 * 「一块能走的地板」——落脚点图、寻路、透视缩放、闲逛选点。
 *
 * 房间（Blender 渲的透视房间）和小区屋（dsh-in-home 的娃娃屋图）用的是同一套逻辑，
 * 只是路点、缩放系数、立绘大小不同；所以抽成工厂，两边各自配置。
 *
 * 坐标约定：x 从左往右 0–100，bottom 从下往上 0–100（脚踩的那一点）。
 * 走路不直接连直线，而是在路点图上寻路——家具摆在哪，人可以走哪，都写在 EDGES 里。
 */

/**
 * @param {{
 *   nodes: Record<string, {x:number, bottom:number}>,
 *   edges: Array<[string,string]>,
 *   wander: string[],
 *   walkSpeed: number,
 *   scale: {atBottom0:number, perBottom:number, min?:number, max?:number},
 *   baseHeight: number,
 *   feetGap: number,
 *   aspect?: number,
 * }} config
 */
export function createFloor({ nodes, edges, wander, walkSpeed, scale, baseHeight, feetGap, aspect = 16 / 9 }) {
  const NODES = nodes;
  const EDGES = edges;
  const WANDER = wander;
  const WALK_SPEED = walkSpeed;
  const SPRITE_BASE_HEIGHT = baseHeight;
  const SPRITE_FEET_GAP = feetGap;
  const ASPECT = aspect;
  const MIN_SCALE = scale.min ?? 0.42;
  const MAX_SCALE = scale.max ?? 1.05;

  /** 某个脚下位置对应的身体缩放（比例，1 = 原始大小）。 */
  function scaleAt(bottom) {
    const raw = scale.atBottom0 + scale.perBottom * bottom;
    return Math.max(MIN_SCALE, Math.min(MAX_SCALE, Number(raw.toFixed(3))));
  }

  /** 脚在画面上的真实落点（bottom 百分比）。影子画在这里，不是画在 sprite 帧底边。 */
  function feetAt(bottom) {
    return bottom + SPRITE_FEET_GAP * SPRITE_BASE_HEIGHT * scaleAt(bottom);
  }

  /** 两点之间的实际距离（横向按画面宽高比折算成纵向百分比）。 */
  function distance(a, b) {
    const dx = (a.x - b.x) * ASPECT;
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
  function route(from, to) {
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
  function pointsLength(points) {
    let total = 0;
    for (let i = 1; i < points.length; i += 1) total += distance(points[i - 1], points[i]);
    return total;
  }

  /** 走这一串点要多少毫秒。 */
  function lengthMs(points, speed = WALK_SPEED) {
    return Math.max(320, Math.round((pointsLength(points) / speed) * 1000));
  }

  /**
   * 一串点上走了 traveled 距离时，脚踩在哪、朝哪边。
   * @param {{x:number,bottom:number}[]} points
   * @param {number} traveled
   */
  function pointOnPoints(points, traveled) {
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
  function pathLength(keys) {
    let total = 0;
    for (let i = 1; i < keys.length; i += 1) total += distance(NODES[keys[i - 1]], NODES[keys[i]]);
    return total;
  }

  /** 走这条路要多少毫秒。 */
  function walkMs(keys) {
    return Math.max(320, Math.round((pathLength(keys) / WALK_SPEED) * 1000));
  }

  /**
   * 路上走了 traveled 距离时，她脚踩在哪、朝哪边。
   * @param {string[]} keys
   * @param {number} traveled
   */
  function pointAlong(keys, traveled) {
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
  function pickStroll(fromKey, random = Math.random) {
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

  return {
    NODES,
    EDGES,
    WANDER,
    WALK_SPEED,
    ASPECT,
    SPRITE_BASE_HEIGHT,
    SPRITE_FEET_GAP,
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
  };
}