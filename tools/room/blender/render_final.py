import bpy, json, time
from mathutils import Vector
from bpy_extras.object_utils import world_to_camera_view
bpy.ops.wm.open_mainfile(filepath='/tmp/blroom/room.blend')
sc = bpy.context.scene

def set_emit(name, strength):
    m = bpy.data.materials.get(name)
    if not m: return
    for n in m.node_tree.nodes:
        if n.type == 'BSDF_PRINCIPLED':
            n.inputs['Emission Strength'].default_value = strength

for nm, st in [('code1',2.0),('code2',2.0),('code3',2.0),('warm',1.5),('moon',4.5),('neon',5.5),('screen',1.6),('winlit',2.5)]:
    set_emit(nm, st)

# 月亮小一点
moon = bpy.data.objects.get('moon')
if moon: moon.scale = (0.85, 0.4, 0.85)

# 降一点主光，避免灯罩全白
for lname, energy in (('pendant', 85), ('desk_lamp', 30), ('floor_lamp', 45)):
    ob = bpy.data.objects.get(lname)
    if ob: ob.data.energy = energy

sc.render.resolution_x = 1920
sc.render.resolution_y = 1080
sc.render.resolution_percentage = 100
sc.cycles.samples = 64
sc.cycles.use_denoising = True
sc.render.image_settings.file_format = 'PNG'
sc.render.filepath = '/tmp/blroom/room_final.png'
sc.camera = bpy.data.objects['camB']
sc.view_settings.exposure = 0.95

SPOTS_WORLD = {
  'work':    (-0.88, 0.62), 'think':   (-0.88, 0.78), 'eat':     (1.52, -0.55),
  'phone':   (-0.55, -1.55), 'rubik':   (0.55, -1.15), 'window':  (1.72, 0.45),
  'hum':     (1.30, -0.25), 'sleep':   (-2.20, -0.92), 'yawn':    (0.20, -0.30),
  'stretch': (0.40, -0.70), 'idle':    (0.10, -0.95),
}
out = {}
for name, (x, y) in SPOTS_WORLD.items():
    u, v0, _ = world_to_camera_view(sc, sc.camera, Vector((x, y, 0.0)))
    _, v1, _ = world_to_camera_view(sc, sc.camera, Vector((x, y, 1.30)))
    out[name] = {'x': round(u*100, 1), 'bottom': round(v0*100, 1), 'visible': round(abs(v1-v0)*100, 2)}
print('SPOTS_JSON', json.dumps(out))
t0 = time.time()
bpy.ops.render.render(write_still=True)
print('RENDER2 DONE %.1fs' % (time.time()-t0))
print('SPOTS 里的 x/bottom/scale 就是用上面的 JSON 换算的：bottom = 地面点 - 脚底留白，scale = visible/0.79/62')
bpy.ops.wm.save_as_mainfile(filepath='/tmp/blroom/room.blend')
