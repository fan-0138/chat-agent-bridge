"""从 sleep.webm 里抠她的上半身（闭眼、坐在床头那个姿势）。

为什么不用「只有一颗头」：一颗头摆在枕头上，床底下没有身体，看着像被切开的。
上半身（头+肩+手）放进被子沿，才像人坐在床上。

VP9 的 alpha 通道要显式用 libvpx-vp9 解码才拿得到，默认解码器会把它丢掉。
FFmpeg 只用来抽帧；裁剪/清 alpha 噪声交给 Pillow。

    python3 tools/room/blender/make_sleep_body.py
"""
import subprocess
from pathlib import Path
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
CLIP = ROOT / 'assets' / 'sleep.webm'
TMP = Path('/tmp/sleep-frame.png')
DST = ROOT / 'assets' / 'sleep-body.png'

subprocess.run([
    'ffmpeg', '-y', '-v', 'error', '-c:v', 'libvpx-vp9', '-i', str(CLIP),
    '-vf', 'select=eq(n\\,48),format=rgba', '-frames:v', '1', '-pix_fmt', 'rgba', str(TMP),
], check=True)

im = Image.open(TMP).convert('RGBA')
alpha = im.getchannel('A').point(lambda v: 0 if v < 10 else v)
im.putalpha(alpha)
head = im.crop((196, 78, 430, 242))
upper = upper.crop(upper.getchannel('A').getbbox())
upper.save(DST)
print(f'wrote {DST} {upper.size}')
