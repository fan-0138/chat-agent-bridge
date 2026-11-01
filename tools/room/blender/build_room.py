import bpy, math, random
from mathutils import Vector

for obj in list(bpy.data.objects):
    bpy.data.objects.remove(obj, do_unlink=True)

def mat(name, color, rough=0.8, emit=None, strength=1.0, metal=0.0):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    bsdf = None
    for n in m.node_tree.nodes:
        if n.type == 'BSDF_PRINCIPLED':
            bsdf = n; break
    bsdf.inputs['Base Color'].default_value = (*color, 1)
    bsdf.inputs['Roughness'].default_value = rough
    bsdf.inputs['Metallic'].default_value = metal
    if emit is not None:
        bsdf.inputs['Emission Color'].default_value = (*emit, 1)
        bsdf.inputs['Emission Strength'].default_value = strength
    return m

def box(name, loc, dims, m, rot=(0,0,0), bevel=0.012):
    bpy.ops.mesh.primitive_cube_add(size=1, location=loc, rotation=rot)
    o = bpy.context.object; o.name = name
    o.scale = dims
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    if bevel:
        b = o.modifiers.new('bev', 'BEVEL'); b.width = bevel; b.segments = 2
    o.data.materials.append(m)
    return o

def cyl(name, loc, radius, depth, m, rot=(0,0,0), verts=48):
    bpy.ops.mesh.primitive_cylinder_add(vertices=verts, radius=radius, depth=depth, location=loc, rotation=rot)
    o = bpy.context.object; o.name = name
    o.data.materials.append(m); bpy.ops.object.shade_smooth()
    return o

def cone(name, loc, r1, r2, depth, m, rot=(0,0,0), verts=40):
    bpy.ops.mesh.primitive_cone_add(vertices=verts, radius1=r1, radius2=r2, depth=depth, location=loc, rotation=rot)
    o = bpy.context.object; o.name = name
    o.data.materials.append(m); bpy.ops.object.shade_smooth()
    return o

def sphere(name, loc, radius, m, scale=(1,1,1)):
    bpy.ops.mesh.primitive_uv_sphere_add(segments=32, ring_count=16, radius=radius, location=loc)
    o = bpy.context.object; o.name = name; o.scale = scale
    o.data.materials.append(m); bpy.ops.object.shade_smooth()
    return o

M = {
 'wall':   mat('wall', (0.072, 0.088, 0.155), 0.92),
 'side':   mat('side', (0.050, 0.064, 0.120), 0.92),
 'floor':  mat('floor', (0.165, 0.112, 0.115), 0.70),
 'base':   mat('base', (0.018, 0.023, 0.040), 0.75),
 'wood':   mat('wood', (0.235, 0.160, 0.170), 0.62),
 'wood2':  mat('wood2', (0.170, 0.115, 0.130), 0.68),
 'dark':   mat('dark', (0.048, 0.055, 0.082), 0.55),
 'rack':   mat('rack', (0.028, 0.033, 0.050), 0.42, metal=0.35),
 'slot':   mat('slot', (0.010, 0.012, 0.020), 0.6),
 'ledc':   mat('ledc', (0.10,0.90,1.00), 0.3, emit=(0.12, 0.85, 1.0), strength=7),
 'ledg':   mat('ledg', (0.15,1.00,0.55), 0.3, emit=(0.12, 1.0, 0.5), strength=7),
 'leda':   mat('leda', (1.00,0.65,0.15), 0.3, emit=(1.0, 0.58, 0.10), strength=6),
 'screen': mat('screen', (0.015,0.045,0.09), 0.3, emit=(0.05, 0.20, 0.42), strength=2.6),
 'code1':  mat('code1', (0.10,0.80,1.00), 0.3, emit=(0.22, 0.82, 1.0), strength=5),
 'code2':  mat('code2', (0.20,1.00,0.70), 0.3, emit=(0.18, 1.0, 0.7), strength=5),
 'code3':  mat('code3', (1.00,0.80,0.40), 0.3, emit=(1.0, 0.76, 0.32), strength=5),
 'blanket':mat('blanket', (0.155, 0.200, 0.400), 0.96),
 'pillow': mat('pillow', (0.62, 0.67, 0.82), 0.95),
 'rug':    mat('rug', (0.085, 0.115, 0.235), 1.0),
 'rug2':   mat('rug2', (0.125, 0.165, 0.310), 1.0),
 'white':  mat('white', (0.80, 0.84, 0.92), 0.5),
 'rice':   mat('rice', (0.92, 0.89, 0.76), 0.8),
 'warm':   mat('warm', (0.95, 0.72, 0.38), 0.5, emit=(1.0, 0.70, 0.34), strength=3.5),
 'book1':  mat('book1', (0.28, 0.42, 0.72), 0.8),
 'book2':  mat('book2', (0.55, 0.32, 0.52), 0.8),
 'book3':  mat('book3', (0.24, 0.56, 0.48), 0.8),
 'book4':  mat('book4', (0.70, 0.44, 0.26), 0.8),
 'plant':  mat('plant', (0.13, 0.34, 0.24), 0.85),
 'pot':    mat('pot', (0.22, 0.15, 0.13), 0.8),
 'neon':   mat('neon', (0.85, 0.25, 0.60), 0.3, emit=(1.0, 0.22, 0.60), strength=9),
 'sky':    mat('sky', (0.008,0.020,0.055), 0.9, emit=(0.012, 0.045, 0.13), strength=1.2),
 'moon':   mat('moon', (1.0,0.96,0.82), 0.5, emit=(1.0, 0.94, 0.78), strength=9),
 'star':   mat('star', (0.80,0.90,1.0), 0.5, emit=(0.72, 0.86, 1.0), strength=6),
 'city':   mat('city', (0.012,0.025,0.055), 0.95),
 'winlit': mat('winlit', (1.0,0.78,0.38), 0.4, emit=(1.0, 0.74, 0.26), strength=4),
}

# ── 房间：7.2 宽 × 4.8 深 × 2.8 高，后墙在 y=+2.4 ──
box('floor', (0, 0, -0.04), (7.4, 5.0, 0.08), M['floor'], bevel=0)
box('ceiling', (0, 0, 2.84), (7.4, 5.0, 0.08), M['base'], bevel=0)
WY = 2.42
box('wall_b', (0, WY, 0.52), (7.4, 0.08, 1.04), M['wall'], bevel=0)
box('wall_t', (0, WY, 2.53), (7.4, 0.08, 0.55), M['wall'], bevel=0)
box('wall_l', (-2.0, WY, 1.66), (3.4, 0.08, 1.14), M['wall'], bevel=0)   # x -3.7..-0.3
box('wall_r', (2.95, WY, 1.66), (1.7, 0.08, 1.14), M['wall'], bevel=0)   # x 2.1..3.8
box('wall_left', (-3.72, 0, 1.42), (0.08, 5.0, 2.84), M['side'], bevel=0)
box('wall_right', (3.72, 0, 1.42), (0.08, 5.0, 2.84), M['side'], bevel=0)
box('base_b', (0, WY-0.05, 0.06), (7.4, 0.05, 0.12), M['base'], bevel=0)
box('base_l', (-3.67, 0, 0.06), (0.05, 5.0, 0.12), M['base'], bevel=0)
box('base_r', (3.67, 0, 0.06), (0.05, 5.0, 0.12), M['base'], bevel=0)

# ── 窗（后墙 x -0.3..2.1, z 1.0..2.3）──
WX0, WX1, WZ0, WZ1 = -0.30, 2.10, 1.00, 2.30
wcx, ww = (WX0+WX1)/2, (WX1-WX0)
wcz, wh = (WZ0+WZ1)/2, (WZ1-WZ0)
box('win_f_t', (wcx, WY-0.07, WZ1+0.04), (ww+0.20, 0.10, 0.08), M['wood2'], bevel=0.006)
box('win_f_b', (wcx, WY-0.07, WZ0-0.04), (ww+0.20, 0.10, 0.08), M['wood2'], bevel=0.006)
box('win_f_l', (WX0-0.05, WY-0.07, wcz), (0.08, 0.10, wh+0.16), M['wood2'], bevel=0.006)
box('win_f_r', (WX1+0.05, WY-0.07, wcz), (0.08, 0.10, wh+0.16), M['wood2'], bevel=0.006)
box('win_bar_v', (wcx, WY-0.07, wcz), (0.04, 0.10, wh), M['wood2'], bevel=0.003)
box('win_bar_h', (wcx, WY-0.07, wcz), (ww, 0.10, 0.04), M['wood2'], bevel=0.003)
box('win_sky', (wcx, WY+0.02, wcz), (ww, 0.02, wh), M['sky'], bevel=0)
sphere('moon', (1.45, WY-0.14, 2.02), 0.17, M['moon'], scale=(1, 0.45, 1))
random.seed(11)
for i in range(14):
    sphere('star%d' % i, (random.uniform(WX0+0.08, WX1-0.08), WY-0.14, random.uniform(WZ0+0.08, WZ1-0.22)), 0.010 + random.random()*0.006, M['star'], scale=(1,0.4,1))
for i, (bx, bw, bh) in enumerate([(-0.18,0.16,0.20),(0.02,0.12,0.28),(0.16,0.18,0.16),(0.38,0.12,0.24),(0.54,0.16,0.18),(0.74,0.12,0.26),(0.90,0.18,0.16),(1.14,0.12,0.22),(1.30,0.16,0.18),(1.52,0.14,0.24),(1.70,0.16,0.16)]):
    box('city%d' % i, (bx+bw/2, WY+0.10, WZ0+bh/2), (bw, 0.02, bh), M['city'], bevel=0)
for i, (wx, wz) in enumerate([(-0.12,1.18),(0.06,1.30),(0.30,1.10),(0.42,1.24),(0.60,1.14),(0.80,1.32),(0.98,1.12),(1.22,1.26),(1.40,1.16),(1.60,1.30),(1.78,1.14)]):
    box('winlit%d' % i, (wx, WY+0.09, wz), (0.022, 0.02, 0.024), M['winlit'], bevel=0)
box('win_sill', (wcx, WY-0.18, WZ0-0.10), (ww+0.36, 0.34, 0.06), M['wood'], bevel=0.008)
# 窗帘
for side, x0 in ((-1, WX0-0.24), (1, WX1+0.24)):
    box('curtain%d' % side, (x0, WY-0.16, 1.70), (0.26, 0.14, 1.56), M['blanket'], bevel=0.04)
# 窗台小摆设
cyl('sill_cup', (WX0+0.20, WY-0.20, WZ0+0.12), 0.05, 0.10, M['white'], verts=24)
cyl('sill_pot', (WX1-0.22, WY-0.20, WZ0+0.10), 0.05, 0.08, M['pot'], verts=24)
sphere('sill_plant', (WX1-0.22, WY-0.20, WZ0+0.18), 0.07, M['plant'])

# ── 机柜（左后） ──
RX, RY = -2.95, 1.55
box('rack_body', (RX, RY, 1.02), (1.00, 0.85, 2.04), M['rack'], bevel=0.02)
box('rack_top', (RX, RY, 2.06), (1.04, 0.89, 0.04), M['dark'], bevel=0.01)
for i in range(7):
    z = 0.28 + i*0.25
    box('rack_slot%d' % i, (RX, RY-0.44, z), (0.84, 0.02, 0.20), M['slot'], bevel=0.004)
    box('rack_seam%d' % i, (RX, RY-0.45, z-0.10), (0.84, 0.015, 0.012), M['dark'], bevel=0)
    for j in range(3):
        led = 'ledc' if (i+j) % 3 == 0 else ('ledg' if (i+j) % 3 == 1 else 'leda')
        sphere('rack_led%d_%d' % (i, j), (RX-0.30+j*0.10, RY-0.455, z+0.06), 0.014, M[led])
box('rack_nest', (RX, RY-0.42, 0.12), (0.88, 0.06, 0.22), M['blanket'], bevel=0.03)  # 最下面一格的毯子

# ── 小窝（左前） ──
box('bed_base', (-2.25, -0.95, 0.12), (2.00, 1.30, 0.24), M['wood2'], bevel=0.05)
box('bed_mat', (-2.25, -0.95, 0.28), (1.86, 1.18, 0.10), M['pillow'], bevel=0.05)
box('bed_blanket', (-2.00, -0.88, 0.36), (1.30, 1.10, 0.08), M['blanket'], bevel=0.06)
box('bed_pillow', (-2.92, -0.95, 0.40), (0.46, 0.70, 0.12), M['pillow'], bevel=0.06, rot=(0,0.20,0))
sphere('whale_body', (-1.95, -0.60, 0.42), 0.18, M['book1'], scale=(1.6, 1.0, 0.8))
sphere('whale_tail', (-1.65, -0.60, 0.44), 0.08, M['book1'], scale=(1.0,1.0,0.9))
sphere('whale_eye', (-2.07, -0.63, 0.46), 0.022, M['dark'])
# 床边的魔方
box('cube_side', (-1.30, -1.35, 0.09), (0.16, 0.16, 0.16), M['book4'], bevel=0.012, rot=(0.15,0.25,0.1))

# ── 地毯 + 坐垫 ──
cyl('rug', (0.00, -0.70, 0.012), 1.75, 0.02, M['rug'], verts=72)
cyl('rug2', (0.00, -0.70, 0.022), 1.30, 0.02, M['rug2'], verts=72)
cyl('rug3', (0.00, -0.70, 0.030), 0.88, 0.02, M['rug'], verts=72)
cyl('cushion1', (-0.55, -1.70, 0.07), 0.44, 0.12, M['rug2'], verts=48)
cyl('cushion2', (1.00, -1.60, 0.07), 0.40, 0.12, M['rug2'], verts=48)

# 地毯细环
for r in (1.50, 1.05, 0.55):
    bpy.ops.mesh.primitive_torus_add(location=(0.00, -0.70, 0.040), major_radius=r, minor_radius=0.018, major_segments=64, minor_segments=8)
    tr = bpy.context.object; tr.name='rug_ring_%s' % r
    tr.data.materials.append(M['rug2'])

# 床头板
box('headboard', (-3.25, -0.95, 0.60), (0.10, 1.30, 0.95), M['wood2'], bevel=0.02)

# 串灯（后墙上沿）
for i in range(9):
    x = -3.0 + i * 0.75
    z = 2.42 - 0.10 * math.sin(i / 8 * math.pi)
    sphere('garland%d' % i, (x, WY-0.10, z), 0.022, M['warm'])

# ── 书桌（中） ──
DX, DY = 0.45, 0.95
box('desk_top', (DX, DY, 0.76), (2.05, 0.85, 0.06), M['wood'], bevel=0.015)
for sx in (-0.92, 0.92):
    for sy in (-0.34, 0.34):
        box('desk_leg', (DX+sx, DY+sy, 0.38), (0.07, 0.07, 0.76), M['dark'], bevel=0.006)
box('desk_bar', (DX, DY+0.32, 0.22), (1.84, 0.05, 0.05), M['dark'], bevel=0.006)
box('monitor_stand', (DX-0.12, DY+0.26, 0.88), (0.07, 0.07, 0.24), M['dark'], bevel=0.006)
box('monitor_base', (DX-0.12, DY+0.26, 0.79), (0.34, 0.22, 0.02), M['dark'], bevel=0.006)
box('monitor', (DX-0.12, DY+0.12, 1.30), (0.94, 0.05, 0.54), M['dark'], bevel=0.012)
box('monitor_screen', (DX-0.12, DY+0.088, 1.30), (0.86, 0.005, 0.46), M['screen'], bevel=0)
for i, cm in enumerate(('code1','code2','code3','code1','code2','code3','code1','code2')):
    w = 0.52 - 0.05*(i % 4)
    box('code%d' % i, (DX-0.42, DY+0.082, 1.45-i*0.05), (w, 0.004, 0.020), M[cm], bevel=0)
box('keyboard', (DX-0.12, DY-0.12, 0.80), (0.68, 0.22, 0.02), M['dark'], bevel=0.008)
box('keyboard_keys', (DX-0.12, DY-0.12, 0.812), (0.62, 0.17, 0.01), M['slot'], bevel=0.004)
box('mouse', (DX+0.34, DY-0.10, 0.79), (0.10, 0.14, 0.03), M['dark'], bevel=0.012)
cyl('mug', (DX+0.70, DY-0.08, 0.86), 0.06, 0.12, M['white'], verts=32)
bpy.ops.mesh.primitive_torus_add(location=(DX+0.79, DY-0.08, 0.87), major_radius=0.048, minor_radius=0.013)
mh = bpy.context.object; mh.name='mug_handle'; mh.rotation_euler=(math.pi/2,0,0); mh.data.materials.append(M['white'])
# 台灯
box('lamp_base', (DX-0.86, DY+0.20, 0.80), (0.18, 0.18, 0.02), M['dark'], bevel=0.006)
cyl('lamp_arm', (DX-0.86, DY+0.20, 0.94), 0.013, 0.28, M['dark'], verts=16)
cone('lamp_shade', (DX-0.86, DY+0.20, 1.10), 0.15, 0.08, 0.16, M['warm'], verts=32)

# ── 饭桌 + 大碗白饭（右前） ──
TX, TY = 2.20, -0.60
cyl('table_top', (TX, TY, 0.68), 0.52, 0.05, M['wood'], verts=56)
cyl('table_leg', (TX, TY, 0.34), 0.055, 0.68, M['dark'], verts=24)
cyl('table_base', (TX, TY, 0.04), 0.26, 0.05, M['dark'], verts=32)
sphere('bowl', (TX, TY, 0.72), 0.21, M['white'], scale=(1,1,0.55))
sphere('rice', (TX, TY, 0.80), 0.15, M['rice'], scale=(1,1,0.45))
box('chop1', (TX+0.32, TY+0.12, 0.71), (0.32, 0.013, 0.013), M['wood2'], bevel=0.002, rot=(0,0.22,0))
box('chop2', (TX+0.33, TY+0.16, 0.71), (0.32, 0.013, 0.013), M['wood2'], bevel=0.002, rot=(0,0.22,0.12))

# ── 矮柜 + 饭锅（右后） ──
CX, CY = 2.85, 1.40
box('cab_body', (CX, CY, 0.38), (1.30, 0.60, 0.72), M['wood2'], bevel=0.02)
box('cab_door_l', (CX-0.33, CY-0.31, 0.38), (0.54, 0.02, 0.60), M['wood'], bevel=0.008)
box('cab_door_r', (CX+0.33, CY-0.31, 0.38), (0.54, 0.02, 0.60), M['wood'], bevel=0.008)
box('cab_k1', (CX-0.09, CY-0.33, 0.42), (0.03, 0.02, 0.12), M['dark'], bevel=0.004)
box('cab_k2', (CX+0.09, CY-0.33, 0.42), (0.03, 0.02, 0.12), M['dark'], bevel=0.004)
cyl('cooker', (CX-0.34, CY-0.02, 0.82), 0.16, 0.20, M['white'], verts=32)
cyl('cooker_lid', (CX-0.34, CY-0.02, 0.93), 0.14, 0.03, M['white'], verts=32)
cyl('bowls', (CX+0.22, CY-0.02, 0.79), 0.14, 0.08, M['white'], verts=32)
cyl('bowls2', (CX+0.22, CY-0.02, 0.85), 0.12, 0.04, M['white'], verts=32)
box('snack', (CX+0.46, CY-0.02, 0.84), (0.15, 0.11, 0.17), M['book2'], bevel=0.01)
cyl('pot2', (CX+0.02, CY-0.06, 1.02), 0.07, 0.12, M['pot'], verts=24)
sphere('plant2', (CX+0.02, CY-0.06, 1.14), 0.10, M['plant'], scale=(1,1,0.8))

# ── 书架（右，开放式：能看见书） ──
SX, SY = 2.30, 0.55
box('shelf_back', (SX, SY+0.17, 0.98), (0.86, 0.03, 1.96), M['wood2'], bevel=0.01)
box('shelf_side_l', (SX-0.42, SY, 0.98), (0.04, 0.36, 1.96), M['wood'], bevel=0.008)
box('shelf_side_r', (SX+0.42, SY, 0.98), (0.04, 0.36, 1.96), M['wood'], bevel=0.008)
box('shelf_top', (SX, SY, 1.95), (0.88, 0.38, 0.05), M['wood'], bevel=0.008)
box('shelf_bottom', (SX, SY, 0.03), (0.88, 0.38, 0.05), M['wood'], bevel=0.008)
for i, z in enumerate((0.30, 0.78, 1.26, 1.70)):
    box('shelf_board%d' % i, (SX, SY-0.01, z), (0.80, 0.34, 0.035), M['wood'], bevel=0.006)
books = [('book1',0.16,0.34),('book2',0.12,0.30),('book3',0.15,0.32),('book4',0.10,0.27),('book1',0.13,0.30),('book3',0.11,0.33)]
for row, z0 in ((0, 0.32), (1, 0.80), (2, 1.28)):
    for i, (bm, bw, bh) in enumerate(books):
        box('bk%d_%d' % (row, i), (SX-0.33+i*0.125, SY-0.05, z0+bh/2), (bw, 0.22, bh), M[bm], bevel=0.004)
box('box_shelf', (SX+0.22, SY-0.05, 1.90), (0.24, 0.22, 0.20), M['book2'], bevel=0.008)
sphere('shelf_whale', (SX-0.22, SY-0.05, 1.80), 0.09, M['book1'], scale=(1.7, 0.9, 0.7))

# ── 落地灯（左前） ──
box('fl_base', (-3.30, -1.30, 0.03), (0.34, 0.34, 0.05), M['dark'], bevel=0.01)
cyl('fl_pole', (-3.30, -1.30, 0.88), 0.022, 1.66, M['dark'], verts=16)
cone('fl_shade', (-3.30, -1.30, 1.80), 0.24, 0.14, 0.28, M['warm'], verts=32)

# ── 吊灯（中间） ──
cyl('pendant_cord', (0.0, -0.25, 2.52), 0.012, 0.55, M['dark'], verts=12)
cone('pendant_shade', (0.0, -0.25, 2.14), 0.34, 0.10, 0.26, M['warm'], verts=32)

# ── 墙饰 ──
box('poster', (-1.55, WY-0.04, 1.85), (0.70, 0.02, 0.86), M['book1'], bevel=0)
box('poster_in', (-1.55, WY-0.05, 1.85), (0.60, 0.01, 0.76), M['screen'], bevel=0)
sphere('poster_whale', (-1.55, WY-0.07, 1.90), 0.11, M['neon'], scale=(1.9, 0.25, 0.85))
box('frame1', (-0.70, WY-0.04, 1.80), (0.38, 0.02, 0.48), M['wood2'], bevel=0)
box('frame1_in', (-0.70, WY-0.05, 1.80), (0.30, 0.01, 0.40), M['screen'], bevel=0)
cyl('clock', (2.55, WY-0.04, 1.95), 0.17, 0.02, M['wood2'], verts=40, rot=(math.pi/2,0,0))
cyl('clock_face', (2.55, WY-0.06, 1.95), 0.14, 0.01, M['screen'], verts=40, rot=(math.pi/2,0,0))
box('clock_h', (2.55, WY-0.07, 1.99), (0.012, 0.01, 0.09), M['white'], bevel=0)
box('clock_m', (2.58, WY-0.07, 1.95), (0.07, 0.01, 0.012), M['white'], bevel=0)
box('neon_strip', (0, WY-0.06, 2.52), (6.4, 0.02, 0.03), M['neon'], bevel=0)

# ── 植物（右前） ──
cyl('plantpot', (3.15, -1.85, 0.18), 0.20, 0.36, M['pot'], verts=32)
for i in range(9):
    a = i/9*math.pi*2
    sphere('leaf%d' % i, (3.15+0.17*math.cos(a), -1.85+0.17*math.sin(a), 0.52+0.07*((i%3)*0.5)), 0.14, M['plant'], scale=(1.0,0.55,1.15))

# ── 灯光 ──
def light(name, kind, loc, energy, color=(1,1,1), size=0.5, rot=(0,0,0)):
    if kind == 'AREA':
        bpy.ops.object.light_add(type='AREA', location=loc, rotation=rot)
        l = bpy.context.object; l.data.shape='DISK'; l.data.size=size
    elif kind == 'POINT':
        bpy.ops.object.light_add(type='POINT', location=loc)
        l = bpy.context.object; l.data.shadow_soft_size = size
    else:
        bpy.ops.object.light_add(type='SUN', location=loc, rotation=rot)
        l = bpy.context.object
    l.name = name; l.data.energy = energy; l.data.color = color
    return l

light('pendant', 'POINT', (0.0, -0.25, 2.02), 120, (1.0, 0.82, 0.66), size=0.10)
light('desk_lamp', 'POINT', (0.45-0.86, 0.95+0.20, 1.00), 40, (1.0, 0.68, 0.36), size=0.07)
light('floor_lamp', 'POINT', (-3.30, -1.30, 1.62), 60, (1.0, 0.64, 0.32), size=0.12)
light('screen_glow', 'AREA', (0.33, 1.02, 1.30), 14, (0.40, 0.66, 1.0), size=0.34)
light('moon', 'AREA', (0.90, 2.75, 2.00), 260, (0.55, 0.72, 1.0), size=1.1, rot=(math.radians(-58), 0, math.radians(-6)))
light('rack_glow', 'POINT', (-2.95, 1.02, 1.05), 18, (0.22, 0.70, 1.0), size=0.30)
light('fill', 'AREA', (0.0, -3.1, 2.60), 70, (0.72, 0.80, 1.0), size=2.6, rot=(math.radians(16), 0, 0))
light('shelf_lamp', 'POINT', (2.45, -0.10, 1.55), 16, (1.0, 0.70, 0.42), size=0.12)

world = bpy.data.worlds[0] if bpy.data.worlds else bpy.data.worlds.new('W')
bpy.context.scene.world = world
world.use_nodes = True
bg = world.node_tree.nodes.get('Background')
bg.inputs['Color'].default_value = (0.012, 0.018, 0.038, 1)
bg.inputs['Strength'].default_value = 0.30

# ── 渲染基础设置 ──
sc = bpy.context.scene
sc.render.engine = 'CYCLES'
sc.cycles.samples = 40
sc.cycles.use_denoising = True
sc.cycles.max_bounces = 8
sc.render.resolution_x = 1920
sc.render.resolution_y = 1080
sc.render.resolution_percentage = 30
sc.render.image_settings.file_format = 'PNG'
sc.view_settings.view_transform = 'AgX'
try: sc.view_settings.look = 'AgX - Medium High Contrast'
except Exception as e: print('look:', e)
sc.view_settings.exposure = 0.90

# ── 相机 A/B/C 三选 ──
def make_cam(name, loc, tgt, lens):
    bpy.ops.object.camera_add(location=loc)
    cam = bpy.context.object; cam.name = name
    cam.rotation_euler = (Vector(tgt) - Vector(loc)).to_track_quat('-Z','Y').to_euler()
    cam.data.lens = lens; cam.data.sensor_width = 36
    return cam

cams = [
 ('B', (0.0, -5.2, 1.78), (0.15, 2.0, 1.02), 27),
]
for nm, loc, tgt, lens in cams:
    cam = make_cam('cam'+nm, loc, tgt, lens)
    sc.camera = cam
    sc.render.filepath = '/tmp/blroom/frame_%s.png' % nm
    bpy.ops.render.render(write_still=True)
    print('RENDERED', nm)

bpy.ops.wm.save_as_mainfile(filepath='/tmp/blroom/room.blend')
print('SAVED /tmp/blroom/room.blend')
