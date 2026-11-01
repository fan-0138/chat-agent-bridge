"""把 30fps 的无缝走路循环插成 60fps（相邻帧混合），减少 60Hz 屏幕上的顿感。

用法：
    python3 up60.py <30fps PNG 帧目录> <输出目录>
"""
from PIL import Image
import numpy as np, glob, subprocess
from pathlib import Path

SRC = Path(sys.argv[1])
OUT = Path(sys.argv[2])
OUT.mkdir(parents=True, exist_ok=True)
for f in OUT.glob('*.png'):
    f.unlink()

files = sorted(SRC.glob('*.png'))
frames = [np.asarray(Image.open(f).convert('RGBA')).astype(np.float32) for f in files]
N = len(frames)
for i in range(N):
    a = frames[i]
    b = frames[(i + 1) % N]
    Image.fromarray(np.clip(a, 0, 255).astype(np.uint8), 'RGBA').save(OUT / f'{i*2:04d}.png')
    Image.fromarray(np.clip((a + b) / 2, 0, 255).astype(np.uint8), 'RGBA').save(OUT / f'{i*2+1:04d}.png')
print('frames', N * 2, '=', N * 2 / 60, 's @60fps')

webm = OUT.parent / (OUT.name + '.webm')
subprocess.run(['ffmpeg','-v','error','-framerate','60','-i',str(OUT/'%04d.png'),
                '-c:v','libvpx-vp9','-pix_fmt','yuva420p','-b:v','0','-crf','31','-row-mt','1','-an',str(webm),'-y'], check=True)
print('webm', webm, round(webm.stat().st_size/1024), 'KB')
