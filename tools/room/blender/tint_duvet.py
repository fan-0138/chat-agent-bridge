"""被子压蓝一点点：床头灯是暖光，被子别白到发光。出图后在系统 python 里做一次色调。

    python3 tools/room/blender/tint_duvet.py
"""
from PIL import Image
from pathlib import Path

SRC = Path('/tmp/blroom/bed-duvet.png')
DST = Path(__file__).resolve().parents[1] / 'assets' / 'bed-duvet.png'

im = Image.open(SRC).convert('RGBA')
r, g, b, a = im.split()
im = Image.merge('RGBA', (
    r.point(lambda v: int(v * 0.88)),
    g.point(lambda v: int(v * 0.90)),
    b.point(lambda v: int(v * 0.97)),
    a,
))
im.save(DST)
print(f'wrote {DST}')
