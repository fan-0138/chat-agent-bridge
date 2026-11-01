import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SCENES } from '../tools/room/scene.mjs';
import {
  NODES,
  EDGES,
  WANDER,
  SCALE,
  WALK_SPEED,
  SPRITE_BASE_HEIGHT,
  route,
  scaleAt,
  feetAt,
  distance,
  pathLength,
  pointsLength,
  pickStroll,
  pointOnPoints,
} from '../tools/room/house.mjs';

const canWalk = (a, b) => EDGES.some(([x, y]) => (x === a && y === b) || (x === b && y === a));

/* ── 小屋这块地板 ── */

test('house：每个场景都有落脚点，坐标都在画里', () => {
  for (const scene of SCENES) assert.ok(NODES[scene], `小屋缺 ${scene} 的落脚点`);
  for (const [key, node] of Object.entries(NODES)) {
    assert.ok(node.x > 8 && node.x < 92, `${key} 的 x 跑到屋子外了`);
    assert.ok(node.bottom > 5 && node.bottom < 55, `${key} 的 bottom 跑到墙上了`);
  }
});

test('house：任意两点都连得上，每一步都是能走的路', () => {
  for (const from of Object.keys(NODES)) {
    for (const to of Object.keys(NODES)) {
      const path = route(from, to);
      assert.equal(path[0], from);
      assert.equal(path.at(-1), to);
      for (let i = 1; i < path.length; i += 1) {
        assert.ok(canWalk(path[i - 1], path[i]), `${from}→${to} 里 ${path[i - 1]}→${path[i]} 不是一条能走的路`);
      }
    }
  }
});

test('house：床只从床前上下，不会从屋子中间直接横穿', () => {
  const path = route('idle', 'sleep');
  assert.ok(path.includes('bedSide'), '上床要先走到床前');
  assert.ok(!canWalk('sleep', 'idle'), 'sleep 不能直接连屋子中间');
});

test('house：缩放对上插件自己的深度系数（y430→0.78，y665→1.0）', () => {
  const bottomOf = (y) => 100 - (y / 768) * 100;
  assert.ok(Math.abs(scaleAt(bottomOf(430)) - 0.78) < 0.01, '远处 0.78');
  assert.ok(Math.abs(scaleAt(bottomOf(665)) - 1.0) < 0.012, '近处 1.0');
  assert.ok(scaleAt(bottomOf(665)) > scaleAt(bottomOf(430)), '越靠前越大');
});

test('house：立绘大小落在合理范围（屋高的 1/5 到 1/3 之间）', () => {
  // sprite 帧里人物约占 0.72 高；最小/最大缩放各看一遍
  const minVisible = SPRITE_BASE_HEIGHT * 0.72 * scaleAt(44);
  const maxVisible = SPRITE_BASE_HEIGHT * 0.72 * scaleAt(13.4);
  assert.ok(minVisible > 20 && minVisible < 30, `最小可见高度 ${minVisible.toFixed(1)}%`);
  assert.ok(maxVisible > 24 && maxVisible < 36, `最大可见高度 ${maxVisible.toFixed(1)}%`);
  assert.ok(SPRITE_BASE_HEIGHT < 62, '小屋版立绘要比 Blender 房间小一号，不然像巨人进屋');
});

test('house：脚底和影子的落点算得对', () => {
  for (const node of Object.values(NODES)) {
    const feet = feetAt(node.bottom);
    assert.ok(feet > node.bottom);
    assert.ok(feet - node.bottom < 5);
  }
});

test('house：距离按娃娃屋图的宽高比折算，不是按 16:9', () => {
  const a = { x: 0, bottom: 0 };
  const b = { x: 100, bottom: 0 };
  assert.ok(Math.abs(distance(a, b) - 100 * (1376 / 768)) < 1e-9);
});

test('house：路长和毫秒数一致，走路不会瞬移', () => {
  const keys = route('sleep', 'eat');
  const ms = Math.max(320, Math.round((pathLength(keys) / WALK_SPEED) * 1000));
  assert.ok(pathLength(keys) > 0);
  assert.ok(ms >= 320);
  const total = pointsLength(keys.map((key) => NODES[key]));
  assert.ok(Math.abs(total - pathLength(keys)) < 1e-9);
  const mid = pointOnPoints(keys.map((key) => NODES[key]), total / 2);
  assert.ok(mid.x > 0 && mid.x < 100 && mid.bottom > 0 && mid.bottom < 100);
});

test('house：闲逛不会挑床', () => {
  for (let i = 0; i < 100; i += 1) {
    const picks = pickStroll('center');
    assert.ok(picks.length >= 1);
    for (const key of picks) {
      assert.notEqual(key, 'sleep');
      assert.notEqual(key, 'center');
      assert.ok(WANDER.includes(key));
    }
  }
});

test('house：走路速度和缩放表是合理值', () => {
  assert.ok(WALK_SPEED > 5 && WALK_SPEED < 30);
  assert.ok(SCALE.min < 1 && SCALE.max > 0.9 && SCALE.max <= 1.05);
});