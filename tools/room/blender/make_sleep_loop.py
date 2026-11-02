#!/usr/bin/env python3
"""从 assets/sleep.webm 裁一段，接成无缝的睡觉循环（VP9 alpha）。

背景：原片 10 秒一个循环（睁眼 → 睡着 → zzz → 睁眼），直接 <video loop> 会让她反复醒。
这里取「已经睡着、zzz 正常冒泡」的 4.58s–6.54s，正放 + 倒放接成 ping-pong，
首尾天然一致，3.9 秒一个循环。

坑：VP9 的 alpha 必须显式 `-c:v libvpx-vp9` 解码，默认解码器会把 alpha 丢掉，
出来的 PNG 是黑底——再编码回去就成了"带黑框的人"（这里踩过）。

    python3 tools/room/blender/make_sleep_loop.py

产物：tools/room/assets/sleep-loop.webm
"""

import glob
import os
import shutil
import subprocess
import tempfile

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))  # tools/room
SRC = os.path.join(ROOT, 'assets', 'sleep.webm')
DST = os.path.join(ROOT, 'assets', 'sleep-loop.webm')
START, END = 110, 157  # 24fps 下的帧号：4.58s ~ 6.54s


def main():
    tmp = tempfile.mkdtemp(prefix='sleep-loop-')
    try:
        # 抽帧：必须带 libvpx-vp9，否则 alpha 全丢
        subprocess.run(
            ['ffmpeg', '-loglevel', 'error', '-c:v', 'libvpx-vp9', '-i', SRC,
             '-f', 'image2', '-pix_fmt', 'rgba', os.path.join(tmp, 'f%04d.png')],
            check=True,
        )
        frames = sorted(glob.glob(os.path.join(tmp, 'f*.png')))
        seg = frames[START:END + 1]
        seq = seg + seg[-2:0:-1]  # 正放 + 倒放（不重复端点）
        for i, frame in enumerate(seq):
            shutil.copy(frame, os.path.join(tmp, 'l%04d.png' % (i + 1)))
        subprocess.run(
            ['ffmpeg', '-y', '-loglevel', 'error', '-framerate', '24', '-i', os.path.join(tmp, 'l%04d.png'),
             '-c:v', 'libvpx-vp9', '-pix_fmt', 'yuva420p', '-b:v', '1400k',
             '-auto-alt-ref', '0', '-an', DST],
            check=True,
        )
        print('OK', DST, '%d 帧' % len(seq))
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


if __name__ == '__main__':
    main()