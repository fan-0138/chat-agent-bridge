#!/usr/bin/env python3
"""把 AI 生成的绿幕走路视频转成 640×360 透明 webm（和 dsh-pet 素材同一个规格）。

用法:
    python3 key_and_encode.py <生成的绿幕 mp4> <工作目录>

这套流程配合 Wan（万相）图生视频用：把她的立绘抠出来贴纯绿幕当 first_frame，
生成 5 秒「原地横走」视频，再用这个脚本抠绿、对齐比例、输出带 alpha 的 webm。

步骤:
    1. 从视频里抠绿（按每帧采样背景色，软边 + 去绿溢色）
    2. 按第一帧的人物包围盒算缩放/落点，统一变换（保留走路本身的起伏，不逐帧对中）
    3. 输出 640×360 透明 PNG 序列
    4. ffmpeg 编码 yuva420p 的 VP9 webm
"""
from __future__ import annotations

import subprocess
import sys
from pathlib import Path

import numpy as np
from PIL import Image

FRAME_W, FRAME_H = 640, 360
CHAR_H = 270          # 人物在 360 高的帧里约占 75%（和 dsh-pet 素材一致）
FEET_Y = 330          # 脚底（帧底边留 ~8% 透明）
FPS = 24

def extract(video: Path, out_dir: Path) -> list[Path]:
    out_dir.mkdir(parents=True, exist_ok=True)
    for old in out_dir.glob("*.png"):
        old.unlink()
    subprocess.run(
        ["ffmpeg", "-v", "error", "-i", str(video), "-fps_mode", "passthrough", str(out_dir / "%04d.png"), "-y"],
        check=True,
    )
    return sorted(out_dir.glob("*.png"))

def key_frame(img: Image.Image) -> np.ndarray:
    rgb = np.asarray(img.convert("RGB")).astype(np.float32)
    h, w, _ = rgb.shape
    # 四角采样背景色（生成视频可能有轻微渐变）
    corners = np.concatenate([
        rgb[:8, :8].reshape(-1, 3), rgb[:8, -8:].reshape(-1, 3),
        rgb[-8:, :8].reshape(-1, 3), rgb[-8:, -8:].reshape(-1, 3),
    ])
    bg = np.median(corners, axis=0)
    diff = np.sqrt(((rgb - bg) ** 2).sum(axis=2))
    # 绿幕距离 -> alpha：靠得太近算背景，远一点算人物；中间软过渡
    alpha = np.clip((diff - 28.0) / 46.0, 0.0, 1.0)
    # 去绿溢：把绿色通道里明显高出的部分压回去
    r, g, b = rgb[..., 0], rgb[..., 1], rgb[..., 2]
    excess = np.clip(g - np.maximum(r, b), 0, None) * 0.85
    rgb2 = np.stack([r, np.clip(g - excess, 0, 255), b], axis=-1)
    return np.dstack([rgb2, alpha * 255.0]).astype(np.uint8)

def main() -> None:
    src = Path(sys.argv[1])
    work = Path(sys.argv[2])
    frames_dir = work / "src"
    keyed_dir = work / "keyed"
    out_dir = work / "frames"
    for d in (keyed_dir, out_dir):
        d.mkdir(parents=True, exist_ok=True)

    srcs = extract(src, frames_dir)
    if not srcs:
        sys.exit("没有帧")
    print(f"源帧数：{len(srcs)}")

    # 第一帧：抠绿 + 找人物框 + 算统一变换
    first = key_frame(Image.open(srcs[0]))
    ys, xs = np.where(first[:, :, 3] > 40)
    if len(ys) == 0:
        sys.exit("第一帧没抠出人物，背景可能不是纯绿")
    top, bottom = ys.min(), ys.max() + 1
    left, right = xs.min(), xs.max() + 1
    char_h = bottom - top
    scale = CHAR_H / char_h
    print(f"人物框：x {left}-{right} y {top}-{bottom} 高 {char_h}px -> 缩放 {scale:.3f}")

    def place(arr: np.ndarray) -> Image.Image:
        img = Image.fromarray(arr, "RGBA")
        w = max(1, round((right - left) * scale))
        h = max(1, round((bottom - top) * scale))
        char = img.crop((left, top, right, bottom)).resize((w, h), Image.LANCZOS)
        canvas = Image.new("RGBA", (FRAME_W, FRAME_H), (0, 0, 0, 0))
        cx = FRAME_W // 2
        canvas.alpha_composite(char, (cx - w // 2, FEET_Y - h))
        return canvas

    for i, path in enumerate(srcs):
        arr = key_frame(Image.open(path))
        out = place(arr)
        out.save(out_dir / f"{i:04d}.png")
        if i % 20 == 0:
            print(f"  抠帧 {i}/{len(srcs)}")

    webm = work / "walk-ai.webm"
    subprocess.run(
        [
            "ffmpeg", "-v", "error", "-framerate", str(FPS), "-i", str(out_dir / "%04d.png"),
            "-c:v", "libvpx-vp9", "-pix_fmt", "yuva420p", "-b:v", "0", "-crf", "32",
            "-row-mt", "1", "-an", str(webm), "-y",
        ],
        check=True,
    )
    print(f"输出：{webm}")

if __name__ == "__main__":
    main()