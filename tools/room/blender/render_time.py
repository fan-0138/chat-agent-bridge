#!/usr/bin/env python3
"""按「时间」重渲房间：白天 / 黄昏。

夜间版由 render_final.py 渲（room-bg.png）。这一版加的是**有方向的光**：
  - 窗外太阳（SUN）+ 天空渐变 + 天空面光当散射；
  - 白天把墙/地/天花板提亮到暖灰，夜里那套深蓝只留给 night；
  - 黄昏太阳压低、变红，室内灯开一半，霓虹和城市灯亮起来；
  - 渲完用 post_time.py 做辉光/暗角/颗粒。

用法（在 Blender GUI 里通过 MCP 执行，见 blender-mcp/mcpctl.py）：
    echo day > /tmp/blroom/preset.txt      # 或 dusk
    python3 mcpctl.py exec tools/room/blender/render_time.py
产物：/tmp/blroom/room-<preset>-raw.png
"""

import os
import time

import bpy
from mathutils import Vector

PRESET_FILE = "/tmp/blroom/preset.txt"
PRESET = "day"
try:
    PRESET = open(PRESET_FILE, encoding="utf-8").read().strip().lower() or "day"
except OSError:
    pass
if PRESET not in ("day", "dusk"):
    raise SystemExit("preset 只支持 day / dusk")

SRC = "/tmp/blroom/room_v13.blend"
OUT = f"/tmp/blroom/room-{PRESET}-raw.png"
bpy.ops.wm.open_mainfile(filepath=SRC)
sc = bpy.context.scene


def bsdf(mat):
    return next((n for n in mat.node_tree.nodes if n.type == "BSDF_PRINCIPLED"), None)


def tint(name, rgba, rough=None):
    m = bpy.data.materials.get(name)
    if not m:
        return
    node = bsdf(m)
    if not node:
        return
    node.inputs["Base Color"].default_value = rgba
    if rough is not None:
        node.inputs["Roughness"].default_value = rough


def ensure_light(name, kind):
    light = bpy.data.lights.get(name) or bpy.data.lights.new(name, kind)
    ob = bpy.data.objects.get(name)
    if ob is None:
        ob = bpy.data.objects.new(name, light)
        sc.collection.objects.link(ob)
    return ob, light


def aim(ob, direction):
    """让灯朝 direction 方向照（sun/area 都按 -Z 发光）。"""
    ob.rotation_euler = Vector(direction).normalized().to_track_quat("-Z", "Y").to_euler()



def set_emit(name, strength):
    m = bpy.data.materials.get(name)
    if not m or not m.use_nodes:
        return
    for node in m.node_tree.nodes:
        if node.type == "BSDF_PRINCIPLED" and "Emission Strength" in node.inputs:
            node.inputs["Emission Strength"].default_value = strength


EMISSIVE = {
    "code1": 2.0,
    "code2": 2.0,
    "code3": 2.0,
    "warm": 1.5,
    "moon": 4.5,
    "neon": 5.5,
    "screen": 1.6,
    "winlit": 2.5,
}

def hide(names, hidden=True):
    for name in names:
        ob = bpy.data.objects.get(name)
        if ob:
            ob.hide_render = hidden


# ── 窗户：换成渐变天空，并且不挡光 ──
sky = bpy.data.objects.get("win_sky")
sky.visible_shadow = False
mat = bpy.data.materials.get("sky_time") or bpy.data.materials.new("sky_time")
mat.use_nodes = True
tree = mat.node_tree
for node in list(tree.nodes):
    tree.nodes.remove(node)
out = tree.nodes.new("ShaderNodeOutputMaterial")
emit = tree.nodes.new("ShaderNodeEmission")
ramp = tree.nodes.new("ShaderNodeValToRGB")
sep = tree.nodes.new("ShaderNodeSeparateXYZ")
coord = tree.nodes.new("ShaderNodeTexCoord")
tree.links.new(coord.outputs["Generated"], sep.inputs["Vector"])
tree.links.new(sep.outputs["Z"], ramp.inputs["Fac"])
tree.links.new(ramp.outputs["Color"], emit.inputs["Color"])
tree.links.new(emit.outputs["Emission"], out.inputs["Surface"])
sky.data.materials[0] = mat

# 窗外近处的楼群会挡光，白天/黄昏都先藏起来
for ob in bpy.data.objects:
    if ob.name.startswith("city") and ob.type == "MESH":
        ob.visible_shadow = False
        ob.hide_render = True

# 窗帘拉开
hide(["curtain_closed_l", "curtain_closed_r"])

# 室内灯：白天全关；黄昏开一半（原值见 build_room.py）
INTERIOR = {
    "点光.014": 170.0,
    "点光.015": 42.0,
    "点光.016": 67.5,
    "点光.017": 18.0,
    "点光.018": 16.0,
    "面光.002": 60.0,
    "面光.009": 14.0,
    "面光.010": 22.0,
    "面光.011": 70.0,
    "sleep_lamp_lightData": 48.0,
}

sun_ob, sun = ensure_light("sun_window", "SUN")
sun_ob.hide_render = False
sun.use_shadow = True

fill_ob, fill = ensure_light("sky_fill", "AREA")
fill.shape = "RECTANGLE"
fill.size, fill.size_y = 4.0, 2.6
fill_ob.location = (0.9, 3.7, 2.0)
aim(fill_ob, (0, -1, 0.1))

bounce_ob, bounce = ensure_light("room_bounce", "AREA")
bounce.shape = "RECTANGLE"
bounce.size, bounce.size_y = 3.2, 3.2
bounce_ob.location = (0.3, -0.6, 2.35)
aim(bounce_ob, (0, 0, -1))

if PRESET == "day":
    # 下午：暖灰墙 + 亮天光 + 高一点的太阳
    tint("wall.005", (0.66, 0.62, 0.55, 1.0), 0.9)
    tint("side.005", (0.60, 0.57, 0.52, 1.0), 0.9)
    tint("base.005", (0.50, 0.47, 0.43, 1.0), 0.85)
    tint("rug.005", (0.34, 0.37, 0.46, 1.0), 1.0)
    ramp.color_ramp.elements[0].color = (0.72, 0.80, 0.92, 1.0)
    ramp.color_ramp.elements[1].color = (0.22, 0.42, 0.85, 1.0)
    emit.inputs["Strength"].default_value = 1.05
    sun.energy = 30.0
    sun.color = (1.0, 0.85, 0.66)
    sun.angle = 0.045
    aim(sun_ob, (0.06, -0.955, -0.29))
    fill.energy = 120.0
    fill.color = (0.72, 0.82, 0.98)
    bounce.energy = 40.0
    bounce.color = (1.0, 0.9, 0.78)
    for name, energy in INTERIOR.items():
        ob = bpy.data.objects.get(name)
        if ob and ob.type == "LIGHT":
            ob.data.energy = 0.0
    # 白天：夜景那套自发光全关（灯罩、霓虹、月亮、窗灯），只留屏幕
    for name, strength in EMISSIVE.items():
        set_emit(name, 0.0 if name in ("warm", "moon", "neon", "winlit") else strength * 0.6)
    hide(["star%d" % i for i in range(14)] + ["moon", "neon_strip"] + ["winlit%d" % i for i in range(11)])
    bg = next(n for n in sc.world.node_tree.nodes if n.type == "BACKGROUND")
    bg.inputs["Color"].default_value = (0.48, 0.58, 0.78, 1.0)
    bg.inputs["Strength"].default_value = 0.5
    sc.view_settings.exposure = 0.85
else:
    # 黄昏：墙面压暗偏暖，太阳贴地平线，室内灯开一半
    tint("wall.005", (0.45, 0.37, 0.34, 1.0), 0.9)
    tint("side.005", (0.42, 0.34, 0.32, 1.0), 0.9)
    tint("base.005", (0.30, 0.25, 0.24, 1.0), 0.85)
    tint("rug.005", (0.24, 0.25, 0.33, 1.0), 1.0)
    ramp.color_ramp.elements[0].color = (1.0, 0.62, 0.36, 1.0)
    ramp.color_ramp.elements[1].color = (0.28, 0.28, 0.55, 1.0)
    emit.inputs["Strength"].default_value = 2.2
    sun.energy = 16.0
    sun.color = (1.0, 0.48, 0.22)
    sun.angle = 0.09
    aim(sun_ob, (0.55, -0.78, -0.12))
    fill.energy = 35.0
    fill.color = (0.72, 0.82, 0.98)
    bounce.energy = 40.0
    bounce.color = (1.0, 0.9, 0.78)
    for name, energy in INTERIOR.items():
        ob = bpy.data.objects.get(name)
        if ob and ob.type == "LIGHT":
            ob.data.energy = energy * 0.55
    for name, strength in EMISSIVE.items():
        set_emit(name, strength)
    for ob in bpy.data.objects:
        if ob.type == "MESH" and (
            ob.name.startswith("star") or ob.name == "moon" or ob.name.startswith("winlit") or ob.name == "neon_strip"
        ):
            ob.hide_render = False
    bg = next(n for n in sc.world.node_tree.nodes if n.type == "BACKGROUND")
    bg.inputs["Color"].default_value = (0.30, 0.24, 0.30, 1.0)
    bg.inputs["Strength"].default_value = 0.32
    sc.view_settings.exposure = 0.55

# ── 渲染 ──
sc.render.engine = "CYCLES"
sc.cycles.device = "CPU"
sc.cycles.samples = 96
sc.cycles.use_denoising = True
sc.render.resolution_x, sc.render.resolution_y = 1600, 900
sc.render.resolution_percentage = 100
sc.render.film_transparent = False
sc.render.image_settings.file_format = "PNG"
sc.camera = bpy.data.objects["camB"]
sc.render.filepath = OUT

started = time.time()
bpy.ops.render.render(write_still=True)
print(f"RENDER {PRESET} DONE {time.time() - started:.1f}s -> {OUT}")