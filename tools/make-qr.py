# -*- coding: utf-8 -*-
"""生成「扫码打开」卡片：手机上扫一下就能打开时光账本。

用法：
    python tools/make-qr.py [主地址] [备用地址] [输出路径]

默认主地址是线上 PWA，备用地址是本机局域网（同一 WiFi 调试用）。
"""
import os
import sys
from pathlib import Path

import segno
from PIL import Image, ImageDraw, ImageFont

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent

MAIN = sys.argv[1] if len(sys.argv) > 1 else os.environ.get('TIMELOG_URL', 'https://sl1u0513.github.io/timelog/')
ALT = sys.argv[2] if len(sys.argv) > 2 else os.environ.get('TIMELOG_URL_ALT', 'http://10.30.52.184:8765/')
OUT = Path(sys.argv[3]) if len(sys.argv) > 3 else ROOT / '.tmp' / 'qr-android.png'

FONT = 'C:/Windows/Fonts/msyh.ttc'
FONT_BD = 'C:/Windows/Fonts/msyhbd.ttc'


def font(size, bold=False):
    try:
        return ImageFont.truetype(FONT_BD if bold else FONT, size)
    except Exception:
        return ImageFont.load_default()


def qr(text, size):
    q = segno.make(text, error='m')
    buf = ROOT / '.tmp' / (str(abs(hash(text))) + '.png')
    buf.parent.mkdir(parents=True, exist_ok=True)
    q.save(buf, scale=10, border=2, dark='#0f131b', light='#ffffff')
    img = Image.open(buf).convert('RGB').resize((size, size), Image.NEAREST)
    buf.unlink(missing_ok=True)
    return img


W, H = 900, 1250
BG = (247, 247, 244)
INK = (20, 24, 32)
MUT = (108, 116, 130)
ACCENT = (200, 132, 20)

img = Image.new('RGB', (W, H), BG)
d = ImageDraw.Draw(img)

d.rectangle([0, 0, W, 8], fill=ACCENT)

d.text((60, 56), '时光账本', font=font(54, True), fill=INK)
d.text((60, 130), '手机扫一下，随时打开', font=font(28), fill=MUT)

# 主二维码（线上）
main_qr = qr(MAIN, 500)
img.paste(main_qr, ((W - 500) // 2, 204))
d.rectangle([(W - 500) // 2 - 2, 202, (W + 500) // 2 + 2, 706], outline=(220, 220, 214), width=2)

d.text((60, 736), '任意网络都能开（HTTPS，可装到桌面、断网可用）', font=font(24, True), fill=INK)
d.text((60, 774), MAIN, font=font(28), fill=ACCENT)

d.line([60, 838, W - 60, 838], fill=(225, 225, 219), width=2)

# 备用：局域网
d.text((60, 860), '改代码后想立刻看效果？同一 WiFi 用这个', font=font(22, True), fill=INK)
alt_qr = qr(ALT, 180)
img.paste(alt_qr, (60, 900))
d.text((264, 924), ALT, font=font(24), fill=MUT)
d.text((264, 962), '电脑要开着静态服务，无需重新部署', font=font(20), fill=MUT)
d.text((264, 994), '（http 下没有 Service Worker，不能离线）', font=font(18), fill=(150, 156, 168))

d.text((60, 1140), 'Edge 打开后：菜单 →「添加到手机」，桌面就有独立图标', font=font(22), fill=INK)
d.text((60, 1180), '数据只存在手机浏览器本地，换机前先在「数据」页导出 JSON', font=font(19), fill=MUT)

OUT.parent.mkdir(parents=True, exist_ok=True)
img.save(OUT, optimize=True)
print('saved', OUT, os.path.getsize(OUT), 'bytes')
