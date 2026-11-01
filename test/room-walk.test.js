import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SCENES } from '../tools/room/scene.mjs';
import {
  HOTSPOTS,
  EXTRA_CLIPS,
  NODES,
  EDGES,
  WANDER,
  WALK_SPEED,
  route,
  pathLength,
  walkMs,
  pointAlong,
  scaleAt,
  feetAt,
  pickStroll,
  pointsLength,
  pointOnPoints,
  lengthMs,
} from '../tools/room/walk.mjs';

const canWalk = (a, b) => EDGES.some(([x, y]) => (x === a && y === b) || (x === b && y === a));

/* ── 路点图 ── */

test('walk：每个场景都有落脚点，每个点坐标都在画面里', () => {
  for (const scene of SCENES) assert.ok(NODES[scene], `缺 ${scene} 的落脚点`);
  for (const [key, node] of Object.entries(NODES)) {
    assert.ok(node.x > 0 && node.x < 100, `${key} 的 x 跑到画面外了`);
    assert.ok(node.bottom > 0 && node.bottom < 100, `${key} 的 bottom 跑到画面外了`);
  }
});

test('walk：任意两个落脚点之间都连得上，而且每一步都是能走的路', () => {
  const keys = Object.keys(NODES);
  for (const from of keys) {
    for (const to of keys) {
      const path = route(from, to);
      assert.equal(path[0], from, `${from}→${to} 起点不对`);
      assert.equal(path.at(-1), to, `${from}→${to} 终点不对`);
      for (let i = 1; i < path.length; i += 1) {
        assert.ok(canWalk(path[i - 1], path[i]), `${from}→${to} 里 ${path[i - 1]}→${path[i]} 不是一条能走的路`);
      }
    }
  }
});

test('walk：床只能从床沿上下，不会从地毯穿床过去', () => {
  const path = route('idle', 'sleep');
  assert.ok(path.includes('bedF'), '上床要先走到床沿');
  assert.ok(path.indexOf('sleep') === path.length - 1, 'sleep 是终点');
  assert.ok(!canWalk('sleep', 'rugL'), 'sleep 不能直接连地毯');
  assert.ok(!canWalk('sleep', 'idle'), 'sleep 不能直接连地毯中间');
});

test('walk：原地不动就是原地', () => {
  assert.deepEqual(route('idle', 'idle'), ['idle']);
});

/* ── 透视缩放 ── */

test('walk：scale 跟着脚下高度走，和相机投影反算出来的站位对得上', () => {
  const expect = { work: 0.599, eat: 0.72, window: 0.605, idle: 0.755, sleep: 0.64 };
  for (const [key, scale] of Object.entries(expect)) {
    assert.ok(Math.abs(scaleAt(NODES[key].bottom) - scale) < 0.012, `${key} 的缩放偏了`);
  }
  // 越靠前（bottom 越小）越大
  assert.ok(scaleAt(3) > scaleAt(10));
  assert.ok(scaleAt(20) < scaleAt(10));
});

test('walk：影子落在脚底，不是 sprite 帧的底边', () => {
  for (const node of Object.values(NODES)) {
    const feet = feetAt(node.bottom);
    assert.ok(feet > node.bottom, '脚底应该比帧底边高一点');
    assert.ok(feet - node.bottom < 5, '脚底留白不该超过 5%');
  }
});

/* ── 走一段路 ── */

test('walk：路越长走得越久，但再短也不会瞬移', () => {
  const short = route('idle', 'rugC');
  const long = route('work', 'sleep');
  assert.ok(walkMs(long) > walkMs(short));
  assert.ok(walkMs(['idle', 'idle']) >= 320);
  assert.ok(Math.abs(pathLength(short) - pointsLength(short.map((key) => NODES[key]))) < 1e-9);
});

test('walk：走的途中位置连续、起点终点准确', () => {
  const keys = route('work', 'eat');
  const total = pathLength(keys);
  const start = pointAlong(keys, 0);
  const end = pointAlong(keys, total);
  assert.ok(Math.abs(start.x - NODES.work.x) < 1e-6);
  assert.ok(Math.abs(start.bottom - NODES.work.bottom) < 1e-6);
  assert.ok(Math.abs(end.x - NODES.eat.x) < 1e-6);
  assert.ok(Math.abs(end.bottom - NODES.eat.bottom) < 1e-6);

  let prev = pointAlong(keys, 0);
  for (let d = 0; d <= total; d += total / 20) {
    const p = pointAlong(keys, d);
    assert.ok(Math.hypot(p.x - prev.x, p.bottom - prev.bottom) < total / 20 + 1e-6, '位置跳了');
    prev = p;
  }
});

test('walk：行走到一半的位置落在路上（不会飞出房间）', () => {
  const keys = route('sleep', 'shelfF');
  const total = pathLength(keys);
  const mid = pointAlong(keys, total / 2);
  assert.ok(mid.x > 15 && mid.x < 90);
  assert.ok(mid.bottom > 0 && mid.bottom < 40);
});

test('walk：一串临时点的长度/插值和路点版本一致', () => {
  const points = [NODES.idle, NODES.rugR, NODES.window];
  const total = pointsLength(points);
  assert.ok(total > 0);
  assert.ok(Math.abs(total - pathLength(['idle', 'rugR', 'window'])) < 1e-9, '同一串点两条算法应一致');
  const mid = pointOnPoints(points, total / 2);
  assert.ok(mid.index >= 1 && mid.index <= 2, '半路应该在某一段上');
  assert.ok(Math.abs(mid.x - NODES.rugR.x) < 20, '不会飞到别的角落');
  const end = pointOnPoints(points, total);
  assert.ok(Math.abs(end.x - NODES.window.x) < 1e-6);
  assert.ok(lengthMs(points) >= 320);
  assert.ok(lengthMs(points) === Math.max(320, Math.round((total / WALK_SPEED) * 1000)));
});

/* ── 闲逛 ── */

test('walk：闲逛不会挑睡觉的地方，也不会原地打转', () => {
  for (let i = 0; i < 200; i += 1) {
    const picks = pickStroll('rugC');
    assert.ok(picks.length >= 1 && picks.length <= 2);
    for (const key of picks) {
      assert.notEqual(key, 'rugC', '不该选自己站的地方');
      assert.notEqual(key, 'sleep', '床不是闲逛的地方');
      assert.ok(WANDER.includes(key));
    }
    assert.notEqual(picks[0], picks[1], '一次闲逛不去同一个点两次');
  }
});

test('walk：家具热区都在画面里，节点和动作都存在', () => {
  assert.ok(HOTSPOTS.length >= 5, '至少要有几个能点的家具');
  for (const spot of HOTSPOTS) {
    assert.ok(spot.label, '热区要有名字');
    assert.ok(spot.left >= 0 && spot.top >= 0 && spot.left + spot.w <= 100 && spot.top + spot.h <= 100, `${spot.label} 热区出画面了`);
    if (!spot.lamp && !spot.stay && !spot.curtain) {
      assert.ok(NODES[spot.node], `${spot.label} 没有落脚点`);
      assert.ok(
        SCENES.includes(spot.clip) || EXTRA_CLIPS.includes(spot.clip),
        `${spot.label} 的动作不存在`,
      );
    }
  }
});

test('walk：闲逛挑的点也都能走回场景里', () => {
  for (const key of WANDER) {
    assert.ok(route(key, 'idle').length >= 2);
    assert.ok(route('window', key).length >= 2);
  }
});