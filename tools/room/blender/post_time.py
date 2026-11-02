#!/usr/bin/env python3
"""渲染图的后期：辉光 + 暖调 + 暗角 + 颗粒。

房间那张图「有镜头感」靠的就是这一层；只在 Blender 里渲出来是干净的 CG，不是照片。

    python3 tools/room/blender/post_time.py /tmp/blroom/room-day-raw.png \\
        tools/room/assets/room-bg-day.png 1.05

第三个参数是暖调强度：白天 1.05、黄昏 1.10，夜里别用这套（夜图有自己的 bloom.py）。
用系统 python（Pillow）跑，Blender 里没有 Pillow。
"""

import math
import sys

from PIL import Image, ImageDraw, ImageEnhance, ImageFilter


def bloom(img, threshold=200, radius=16, amount=0.33):
    gray = img.convert("L")
    mask = gray.point(lambda v: 255 if v >= threshold else 0)
    bright = Image.composite(img, Image.new("RGB", img.size, (0, 0, 0)), mask)
    glow = bright.filter(ImageFilter.GaussianBlur(radius))
    return Image.blend(img, Image.blend(img, glow, 0.9), amount)


def grade(img, warm=1.0, contrast=1.04, sat=1.05):
    img = ImageEnhance.Contrast(img).enhance(contrast)
    img = ImageEnhance.Color(img).enhance(sat)
    if warm != 1.0:
        r, g, b = img.split()
        r = r.point(lambda v: min(255, int(v * warm)))
        b = b.point(lambda v: int(v / warm))
        img = Image.merge("RGB", (r, g, b))
    return img


def vignette(img, strength=0.30):
    w, h = img.size
    small = Image.new("L", (160, 90), 0)
    draw = ImageDraw.Draw(small)
    for y in range(90):
        for x in range(160):
            dx = (x - 80) / 80.0
            dy = (y - 45) / 45.0
            r = min(1.0, math.hypot(dx, dy) / 1.25)
            draw.point((x, y), int(255 * (1 - strength * r * r)))
    mask = small.resize((w, h), Image.BICUBIC)
    return Image.composite(img, Image.new("RGB", img.size, (0, 0, 0)), mask)


def grain(img, amount=3.5, mix=0.035):
    noise = Image.effect_noise(img.size, amount).convert("L")
    return Image.blend(img, Image.merge("RGB", (noise, noise, noise)), mix)


def main():
    src, dst = sys.argv[1], sys.argv[2]
    warm = float(sys.argv[3]) if len(sys.argv) > 3 else 1.0
    img = Image.open(src).convert("RGB")
    img = bloom(img)
    img = grade(img, warm=warm)
    img = vignette(img)
    img = grain(img)
    img.save(dst, optimize=True)
    print("OK", dst, img.size)


if __name__ == "__main__":
    main()