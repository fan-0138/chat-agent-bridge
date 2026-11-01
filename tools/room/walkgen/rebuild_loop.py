"""把 AI 横走片段修成顺滑的无缝循环：去掉开头静止帧、首尾交叉淡化、轻度时域平滑。

用法：
    python3 rebuild_loop.py <抠好的 640x360 PNG 帧目录> <输出目录>
可选环境变量：START / END（截取帧范围）、XFADE（交叉淡化帧数）、SMOOTH（时域平滑权重）
"""
from PIL import Image
import numpy as np, sys, subprocess
from pathlib import Path

import os
SRC = Path(sys.argv[1])
OUT = Path(sys.argv[2])
START = int(os.environ.get('START', 6))
END = int(os.environ.get('END', 132))          # 之前算出的最佳缝合点（含 START，不含 END）
XFADE = int(os.environ.get('XFADE', 8))                    # 首尾交叉淡化帧数
SMOOTH = float(os.environ.get('SMOOTH', 0.12))                # 轻度时域平滑：和前后帧混一点，压掉 AI 抽帧的抖

OUT.mkdir(parents=True, exist_ok=True)
for f in OUT.glob('*.png'):
    f.unlink()

files = sorted(SRC.glob('*.png'))[START:END]
frames = []
for f in files:
    im = np.asarray(Image.open(f).convert('RGBA')).astype(np.float32)
    frames.append(im)
N = len(frames)
print('frames', N)

# 1) 轻度时域平滑（首尾循环相接）
smoothed = []
for i in range(N):
    prev = frames[(i - 1) % N]
    nxt = frames[(i + 1) % N]
    cur = frames[i]
    mix = cur * (1 - 2 * SMOOTH) + prev * SMOOTH + nxt * SMOOTH
    smoothed.append(mix)

# 2) 首尾交叉淡化：把尾部 XFADE 帧折进开头，生成 N-XFADE 帧的无缝循环
out = []
for i in range(N - XFADE):
    if i < XFADE:
        w = i / XFADE
        tail = smoothed[N - XFADE + i]
        out.append(smoothed[i] * w + tail * (1 - w))
    else:
        out.append(smoothed[i])
print('loop frames', len(out), f'= {len(out)/30:.2f}s @30fps')

for i, arr in enumerate(out):
    Image.fromarray(np.clip(arr, 0, 255).astype(np.uint8), 'RGBA').save(OUT / f'{i:04d}.png')

# 3) 编码：30fps VP9 alpha
webm = OUT.parent / (OUT.name + '.webm')
subprocess.run(['ffmpeg','-v','error','-framerate','30','-i',str(OUT/'%04d.png'),
                '-c:v','libvpx-vp9','-pix_fmt','yuva420p','-b:v','0','-crf','30','-row-mt','1','-an',str(webm),'-y'], check=True)
print('webm', webm, webm.stat().st_size)
