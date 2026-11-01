"""
「睡觉特写」的建模 + 出图（在已经打开的 room_v13.blend 里跑）。

做三件事：
  1. 加一台床边相机 camSleep（机位固定，页面按这台相机算百分比坐标）
  2. 建一条有人形的被子 duvet（坐姿：膝盖在前面鼓起来，往脚踝平下去，四边垂到床外）
  2.5 床头落地灯 + 暖光（夜里那盏，别让她躺在黑里）
  3. 出两张同机位的图：
       /tmp/blroom/bed-bg.png      空床（含枕头/床架/房间）
       /tmp/blroom/bed-duvet.png   只有被子，透明底（页面叠上去做呼吸/翻身）

跑法（Blender GUI + addon 在 9876）：
    python3 ~/Documents/deepseek/blender-mcp/mcpctl.py exec tools/room/blender/build_sleep.py

之后还要两步（在外面跑）：
    # 被子压蓝一点（Blender 的白布被台灯打爆了）
    python3 tools/room/blender/tint_duvet.py
    # 从 sleep.webm 抠她的睡脸（VP9 的 alpha 要用 libvpx-vp9 解码才拿得到）
    python3 tools/room/blender/make_sleep_head.py
"""

import bpy
import math
from mathutils import Vector
from bpy_extras.object_utils import world_to_camera_view

scene = bpy.context.scene


def look_at(cam, target):
    d = (Vector(target) - cam.location).normalized()
    cam.rotation_euler = d.to_track_quat('-Z', 'Y').to_euler()


def smoothstep(e0, e1, x):
    t = max(0.0, min(1.0, (x - e0) / (e1 - e0)))
    return t * t * (3 - 2 * t)


# ── 1. 床边相机 ──
cam = bpy.data.objects.get('camSleep')
if cam is None:
    cam = bpy.data.objects.new('camSleep', bpy.data.cameras.new('camSleepData'))
    scene.collection.objects.link(cam)
cam.location = (-2.50, -3.02, 1.42)
cam.data.lens = 30
look_at(cam, (-2.56, -0.95, 0.42))
scene.camera = cam

# ── 2. 清掉这一帧里的杂物 ──
for name in ('bed_blanket', 'cube_side', 'fl_base'):
    ob = bpy.data.objects.get(name)
    if ob:
        ob.hide_render = True
# 鲸鱼玩偶挪到床尾，别压在她身上
for name in ('whale_body', 'whale_tail', 'whale_eye', 'whale_eye2', 'whale_fin'):
    ob = bpy.data.objects.get(name)
    if ob:
        ob.location.x += 0.95

# ── 2.5 床头落地灯 + 暖光 ──
for name in ('sleep_lamp_base', 'sleep_lamp_pole', 'sleep_lamp_shade'):
    ob = bpy.data.objects.get(name)
    if ob:
        bpy.data.objects.remove(ob, do_unlink=True)

LX, LY = -2.86, -0.10
bpy.ops.mesh.primitive_cylinder_add(radius=0.11, depth=0.04, location=(LX, LY, 0.02))
base = bpy.context.object
base.name = 'sleep_lamp_base'
bpy.ops.mesh.primitive_cylinder_add(radius=0.014, depth=0.86, location=(LX, LY, 0.45))
pole = bpy.context.object
pole.name = 'sleep_lamp_pole'
bpy.ops.mesh.primitive_cone_add(radius1=0.17, radius2=0.12, depth=0.20, location=(LX, LY, 0.97))
shade = bpy.context.object
shade.name = 'sleep_lamp_shade'

for ob, mat_name in ((base, 'lamp_base_mat2'), (pole, 'lamp_base_mat2'), (shade, 'lamp_shade_mat2')):
    mat = bpy.data.materials.get(mat_name) or bpy.data.materials.new(mat_name)
    mat.use_nodes = True
    bsdf = next((n for n in mat.node_tree.nodes if n.type == 'BSDF_PRINCIPLED'), None)
    if bsdf:
        if mat_name == 'lamp_shade_mat2':
            bsdf.inputs['Base Color'].default_value = (0.98, 0.88, 0.70, 1.0)
            bsdf.inputs['Roughness'].default_value = 0.65
            if 'Emission Color' in bsdf.inputs:
                bsdf.inputs['Emission Color'].default_value = (1.0, 0.78, 0.50, 1.0)
                bsdf.inputs['Emission Strength'].default_value = 2.4
        else:
            bsdf.inputs['Base Color'].default_value = (0.30, 0.32, 0.40, 1.0)
            bsdf.inputs['Roughness'].default_value = 0.5
    ob.data.materials.append(mat)
    for poly in ob.data.polygons:
        poly.use_smooth = True

lamp_light = bpy.data.objects.get('sleep_lamp_light')
if lamp_light is None:
    light_data = bpy.data.lights.new('sleep_lamp_lightData', 'POINT')
    lamp_light = bpy.data.objects.new('sleep_lamp_light', light_data)
    scene.collection.objects.link(lamp_light)
lamp_light.data.energy = 48
lamp_light.data.color = (1.0, 0.72, 0.46)
lamp_light.data.shadow_soft_size = 0.2
lamp_light.location = (LX, LY, 0.86)

# ── 3. 被子 ──
old = bpy.data.objects.get('duvet')
if old:
    bpy.data.objects.remove(old, do_unlink=True)
mesh = bpy.data.meshes.new('duvet')
ob = bpy.data.objects.new('duvet', mesh)
scene.collection.objects.link(ob)

X0, X1 = -2.86, -1.24
Y0, Y1 = -1.64, -0.26
NX, NY = 160, 100
TOP = 0.335
verts, faces = [], []
for i in range(NX + 1):
    for j in range(NY + 1):
        u, v = i / NX, j / NY
        x = X0 + (X1 - X0) * u
        y = Y0 + (Y1 - Y0) * v
        z = TOP + 0.030

        # 坐姿：膝盖在前面鼓起来，往脚踝那边平下去
        knee = 0.20 * math.exp(-((x + 2.34) / 0.26) ** 2)
        shin = 0.10 * math.exp(-((x + 1.86) / 0.30) ** 2)
        lap = 0.07 * math.exp(-((x + 2.62) / 0.20) ** 2)
        across = math.exp(-((y + 0.98) / 0.44) ** 4)
        z += (knee + shin + lap) * across

        # 靠她腰的那一头收窄、压低（掖在被子边上，别成墙）
        z -= 0.055 * (1 - smoothstep(-2.86, -2.66, x))
        z -= 0.06 * smoothstep(-1.46, -1.24, x)

        # 褶子
        z += 0.010 * math.sin((x + 2.0) * 23.0 + (y + 1.0) * 5.0) * (1 - across)
        z += 0.007 * math.sin((y + 0.98) * 27.0 + 2.0 * math.sin(x * 3.0)) * (1 - across * 0.6)

        # 垂到床外
        if y < -1.50:
            z -= 0.22 * smoothstep(-1.50, -1.64, y) ** 1.4
        if y > -0.40:
            z -= 0.22 * smoothstep(-0.40, -0.26, y) ** 1.4
        z = max(0.08, z)
        verts.append((x, y, z))

for i in range(NX):
    for j in range(NY):
        a = i * (NY + 1) + j
        faces.append((a, a + 1, a + NY + 2, a + NY + 1))
mesh.from_pydata(verts, [], faces)
mesh.update()

mat = bpy.data.materials.get('duvet_fabric3') or bpy.data.materials.new('duvet_fabric3')
mat.use_nodes = True
bsdf = next((n for n in mat.node_tree.nodes if n.type == 'BSDF_PRINCIPLED'), None)
if bsdf:
    bsdf.inputs['Base Color'].default_value = (0.30, 0.36, 0.50, 1.0)
    bsdf.inputs['Roughness'].default_value = 1.0
    if 'Specular IOR Level' in bsdf.inputs:
        bsdf.inputs['Specular IOR Level'].default_value = 0.15
    if 'Sheen Weight' in bsdf.inputs:
        bsdf.inputs['Sheen Weight'].default_value = 0.25
ob.data.materials.append(mat)

sol = ob.modifiers.new('solid', 'SOLIDIFY')
sol.thickness = 0.035
sub = ob.modifiers.new('sub', 'SUBSURF')
sub.levels = 1
for poly in mesh.polygons:
    poly.use_smooth = True

# ── 4. 投影（页面里睡脸/被子按这些百分比摆） ──
for label, co in [
    ('pillow_center', (-2.92, -0.95, 0.46)),
    ('duvet_head_edge', (-2.78, -0.95, 0.42)),
    ('shoulder_top', (-2.52, -0.98, 0.60)),
]:
    p = world_to_camera_view(scene, cam, Vector(co))
    print(f'PROJ {label}: x={p.x * 100:.2f}% y={(1 - p.y) * 100:.2f}%')

# ── 5. 出图：空床 + 只有被子（透明） ──
scene.render.resolution_x, scene.render.resolution_y = 1920, 1080
scene.cycles.samples = 96

ob.hide_render = True
scene.render.film_transparent = False
scene.render.filepath = '/tmp/blroom/bed-bg.png'
bpy.ops.render.render(write_still=True)
print('rendered bed-bg.png')

ob.hide_render = False
for o in scene.objects:
    if o is ob:
        continue
    if o.type in {'MESH', 'CURVE', 'SURFACE', 'FONT'}:
        o.hide_render = True
scene.render.film_transparent = True
scene.render.image_settings.color_mode = 'RGBA'
scene.render.filepath = '/tmp/blroom/bed-duvet.png'
bpy.ops.render.render(write_still=True)
print('rendered bed-duvet.png')

for o in scene.objects:
    if o.type in {'MESH', 'CURVE', 'SURFACE', 'FONT'}:
        o.hide_render = False
for name in ('bed_blanket', 'cube_side', 'fl_base'):
    o = bpy.data.objects.get(name)
    if o:
        o.hide_render = True
bpy.ops.wm.save_as_mainfile(filepath='/tmp/blroom/room_v13.blend')
print('saved room_v13.blend')
