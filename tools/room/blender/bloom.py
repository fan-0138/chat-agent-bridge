#!/usr/bin/env python3
"""给渲染图加辉光 + 暗角（Blender 5.x 的去掉了 Glare 的 quality，干脆用 PIL 做）。

    /usr/bin/python3 tools/room/blender/bloom.py /tmp/blroom/room_final.png tools/room/assets/room-bg.png

用的是系统自带 python3 的 Pillow（Blender 的 python 里没有）。
"""
import sys
from PIL import Image, ImageFilter, ImageEnhance, ImageChops, ImageDraw


def bloom(src, dst, threshold=165, gain1=0.55, gain2=0.35, vignette=0.55):
    im = Image.open(src).convert('RGB')
    w, h = im.size
    im = ImageEnhance.Brightness(im).enhance(1.04)
    im = ImageEnhance.Color(im).enhance(1.06)

    lum = im.convert('L')
    mask = lum.point(lambda v: max(0, v - threshold) * 2)
    black = Image.new('RGB', im.size, (0, 0, 0))
    glow = Image.composite(im, black, mask)
    glow1 = glow.filter(ImageFilter.GaussianBlur(18)).point(lambda v: int(v * gain1))
    glow2 = glow.filter(ImageFilter.GaussianBlur(48)).point(lambda v: int(v * gain2))
    im = ImageChops.add(ImageChops.add(im, glow1), glow2)

    vig = Image.new('L', im.size, 0)
    ImageDraw.Draw(vig).ellipse([-w * 0.28, -h * 0.34, w * 1.28, h * 1.34], fill=255)
    vig = vig.filter(ImageFilter.GaussianBlur(160))
    dark = Image.new('RGB', im.size, (4, 6, 12))
    im = Image.composite(im, Image.blend(im, dark, vignette), vig)

    im.save(dst, optimize=True)
    print('saved', dst, im.size)


if __name__ == '__main__':
    bloom(sys.argv[1], sys.argv[2])
