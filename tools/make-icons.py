"""生成 PWA 图标（时光账本）

用法：
    python tools/make-icons.py

输出到 icons/：
    icon-192.png / icon-512.png           普通图标（圆角，透明外角）
    icon-maskable-512.png                 安卓自适应图标（满幅底色 + 80% 安全区）
    apple-touch-icon.png                  iOS 主屏图标（180，不透明）
"""
import os
from PIL import Image, ImageDraw, ImageFilter

S = 4  # 超采样倍数
HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, '..', 'icons')

BG_TOP = (32, 26, 20)
BG_BOTTOM = (14, 11, 9)
AMBER = (232, 176, 75)
RING_TRACK = (52, 44, 34)


def vertical_gradient(size, top, bottom):
    grad = Image.new('RGB', (1, size[1]))
    px = grad.load()
    for y in range(size[1]):
        t = y / max(1, size[1] - 1)
        px[0, y] = tuple(round(top[i] + (bottom[i] - top[i]) * t) for i in range(3))
    return grad.resize(size, Image.BILINEAR)


def draw_clock(img, cx, cy, r, scale=S):
    """在 img 上画表盘：外环 + 内盘 + 时针分针 + 圆心点"""
    d = ImageDraw.Draw(img)
    cx, cy, r = cx * scale, cy * scale, r * scale
    stroke = 0.19 * r

    # 底环
    d.ellipse([cx - r, cy - r, cx + r, cy + r], outline=RING_TRACK, width=int(stroke))
    # 琥珀色进度弧：从 12 点顺时针 265°
    d.arc([cx - r, cy - r, cx + r, cy + r], start=270, end=270 + 265,
          fill=AMBER, width=int(stroke))
    # 内盘
    inner = r - stroke
    d.ellipse([cx - inner, cy - inner, cx + inner, cy + inner], fill=(20, 16, 12))

    # 分针（指向 4 点）
    hx, hy = cx + 0.40 * inner, cy + 0.26 * inner
    d.line([cx, cy, hx, hy], fill=AMBER, width=int(0.085 * r))
    d.ellipse([hx - 0.042 * r, hy - 0.042 * r, hx + 0.042 * r, hy + 0.042 * r], fill=AMBER)
    # 时针（指向 11 点）
    hx2, hy2 = cx - 0.20 * inner, cy - 0.42 * inner
    d.line([cx, cy, hx2, hy2], fill=AMBER, width=int(0.105 * r))
    d.ellipse([hx2 - 0.05 * r, hy2 - 0.05 * r, hx2 + 0.05 * r, hy2 + 0.05 * r], fill=AMBER)
    # 圆心
    d.ellipse([cx - 0.055 * r, cy - 0.055 * r, cx + 0.055 * r, cy + 0.055 * r], fill=AMBER)


def rounded_mask(size, radius):
    m = Image.new('L', size, 0)
    ImageDraw.Draw(m).rounded_rectangle([0, 0, size[0] - 1, size[1] - 1], radius=radius, fill=255)
    return m


def make_icon(px, rounded=True, full_bleed=False):
    w = px * S
    img = vertical_gradient((w, w), BG_TOP, BG_BOTTOM).convert('RGBA')

    # 顶部柔光（大幅模糊，避免出现硬边）
    glow = Image.new('RGBA', (w, w), (0, 0, 0, 0))
    gd = ImageDraw.Draw(glow)
    gd.ellipse([-0.35 * w, -0.70 * w, 1.35 * w, 0.40 * w], fill=(210, 170, 110, 40))
    glow = glow.filter(ImageFilter.GaussianBlur(w * 0.13))
    img = Image.alpha_composite(img, glow)

    ratio = 0.72 if full_bleed else 0.62
    draw_clock(img, px / 2, px / 2, px * ratio / 2)

    if rounded and not full_bleed:
        mask = rounded_mask((w, w), int(w * 0.225))
        out = Image.new('RGBA', (w, w), (0, 0, 0, 0))
        out.paste(img, (0, 0), mask)
        img = out

    return img.resize((px, px), Image.LANCZOS)


def main():
    os.makedirs(OUT, exist_ok=True)
    make_icon(192).save(os.path.join(OUT, 'icon-192.png'))
    make_icon(512).save(os.path.join(OUT, 'icon-512.png'))
    make_icon(512, rounded=False, full_bleed=True).save(os.path.join(OUT, 'icon-maskable-512.png'))
    apple = make_icon(180, rounded=False, full_bleed=True).convert('RGB')
    apple.save(os.path.join(OUT, 'apple-touch-icon.png'))
    for f in sorted(os.listdir(OUT)):
        p = os.path.join(OUT, f)
        print('%s  %d bytes' % (f, os.path.getsize(p)))


if __name__ == '__main__':
    main()
