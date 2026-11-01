"""从 sleep.webm 里抠她的睡脸（闭眼那几帧）。

VP9 的 alpha 通道要显式用 libvpx-vp9 解码才拿得到，默认解码器会把它丢掉。
FFmpeg 只用来抽帧；裁剪/清 alpha 噪声交给 Pillow。

    python3 tools/room/blender/make_sleep_head.py
"""
import subprocess
from pathlib import Path
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
CLIP = ROOT / 'assets' / 'sleep.webm'
TMP = Path('/tmp/sleep-frame.png')
DST = ROOT / 'assets' / 'sleep-head.png'

subprocess.run([
    'ffmpeg', '-y', '-v', 'error', '-c:v', 'libvpx-vp9', '-i', str(CLIP),
    '-vf', 'select=eq(n\\,48),format=rgba', '-frames:v', '1', '-pix_fmt', 'rgba', str(TMP),
], check=True)

im = Image.open(TMP).convert('RGBA')
alpha = im.getchannel('A').point(lambda v: 0 if v < 10 else v)
im.putalpha(alpha)
head = im.crop((196, 78, 430, 242))
head = head.crop(head.getchannel('A').getbbox())
head.save(DST)
print(f'wrote {DST} {head.size}')
