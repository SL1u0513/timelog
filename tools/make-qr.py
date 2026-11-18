# -*- coding: utf-8 -*-
"""生成「扫码打开」卡片：手机上扫一下就能打开时光账本。

用法：
    python tools/make-qr.py [主地址] [备用地址] [输出路径]

默认读取环境变量 TIMELOG_URL / TIMELOG_URL_ALT，输出到 .tmp/qr-android.png
"""
import os
import sys
from pathlib import Path

import segno
from PIL import Image, ImageDraw, ImageFont

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent

MAIN = sys.argv[1] if len(sys.argv) > 1 else os.environ.get('TIMELOG_URL', 'http://10.30.52.184:8765/')
ALT = sys.argv[2] if len(sys.argv) > 2 else os.environ.get('TIMELOG_URL_ALT', 'http://100.89.238.39:8765/')
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
    img = Image.open(buf).convert('RGB')
    img = img.resize((size, size), Image.NEAREST)
    buf.unlink(missing_ok=True)
    return img


W, H = 900, 1180
BG = (247, 247, 244)
INK = (20, 24, 32)
MUT = (108, 116, 130)
ACCENT = (200, 132, 20)

img = Image.new('RGB', (W, H), BG)
d = ImageDraw.Draw(img)

# 顶部色条
d.rectangle([0, 0, W, 8], fill=ACCENT)

d.text((60, 62), '时光账本', font=font(54, True), fill=INK)
d.text((60, 136), '手机扫一下就能打开', font=font(30), fill=MUT)

# 主二维码
main_qr = qr(MAIN, 520)
img.paste(main_qr, ((W - 520) // 2, 220))
d.rectangle([(W - 520) // 2 - 2, 218, (W + 520) // 2 + 2, 742], outline=(220, 220, 214), width=2)

d.text((60, 776), '同一个 WiFi 时用这个', font=font(26, True), fill=INK)
d.text((60, 816), MAIN, font=font(30), fill=ACCENT)

d.line([60, 884, W - 60, 884], fill=(225, 225, 219), width=2)

# 备用（Tailscale）
d.text((60, 906), '不在同一网络？装了 Tailscale 用这个', font=font(24, True), fill=INK)
alt_qr = qr(ALT, 190)
img.paste(alt_qr, (60, 950))
d.text((276, 976), ALT, font=font(26), fill=MUT)
d.text((276, 1020), '手机和电脑登录同一个 Tailscale 账号即可', font=font(22), fill=MUT)

d.text((60, 1130), '用 Edge 打开 → 菜单 →「添加到手机」即可常驻桌面图标', font=font(20), fill=(150, 156, 168))

OUT.parent.mkdir(parents=True, exist_ok=True)
img.save(OUT, optimize=True)
print('saved', OUT, os.path.getsize(OUT), 'bytes')
