# Builds public/og/font.bin: Geist glyphs pre-rendered as alpha masks, so the worker can set text on the
# per-party link cards (src/worker/card.ts) without a font engine.
#   python3 scripts/og-font.py      (needs Pillow and Geist installed in ~/Library/Fonts)
#
# Layout (little-endian): u8 faces; per face: u8 size, u16 glyphs, then per glyph:
#   u16 codepoint, u16 advance×16, i16 x offset, i16 y offset (from the baseline, down is +), u16 w, u16 h, w×h alpha bytes.
import os
import struct
from PIL import Image, ImageDraw, ImageFont

FONTS = os.path.expanduser('~/Library/Fonts')
FACES = [('Geist-Bold.ttf', 64), ('Geist-Bold.ttf', 112), ('Geist-Regular.ttf', 30), ('Geist-Medium.ttf', 24)]
CHARS = [chr(c) for c in range(32, 127)] + list('·–—’‘“”…×Ξ')

out = bytearray(struct.pack('<B', len(FACES)))
for file, size in FACES:
    font = ImageFont.truetype(os.path.join(FONTS, file), size)
    out += struct.pack('<BH', size, len(CHARS))
    for ch in CHARS:
        adv = font.getlength(ch)
        l, t, r, b = font.getbbox(ch, anchor='ls')
        w, h = max(0, r - l), max(0, b - t)
        img = Image.new('L', (max(1, w), max(1, h)), 0)
        if w and h:
            ImageDraw.Draw(img).text((-l, -t), ch, font=font, fill=255, anchor='ls')
        out += struct.pack('<HHhhHH', ord(ch), round(adv * 16), l, t, w, h)
        if w and h:
            out += img.tobytes()

path = os.path.join(os.path.dirname(__file__), '..', 'public', 'og', 'font.bin')
with open(path, 'wb') as f:
    f.write(out)
print('og/font.bin', len(out), 'bytes')
