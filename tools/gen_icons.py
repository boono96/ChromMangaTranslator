# Generates icons/icon{16,48,128}.png without any third-party dependencies.
# Design: indigo rounded square, white speech bubble with tail, three dots.
import math
import os
import struct
import zlib

TOP = (79, 70, 229)     # #4F46E5
BOTTOM = (124, 58, 237) # #7C3AED
WHITE = (255, 255, 255)
DOT = (79, 70, 229)
SS = 4  # supersampling factor


def sd_rounded_rect(px, py, cx, cy, hw, hh, r):
    qx = abs(px - cx) - (hw - r)
    qy = abs(py - cy) - (hh - r)
    ax, ay = max(qx, 0.0), max(qy, 0.0)
    return math.hypot(ax, ay) + min(max(qx, qy), 0.0) - r


def sign(x1, y1, x2, y2, x3, y3):
    return (x1 - x3) * (y2 - y3) - (x2 - x3) * (y1 - y3)


def in_triangle(px, py, a, b, c):
    d1 = sign(px, py, a[0], a[1], b[0], b[1])
    d2 = sign(px, py, b[0], b[1], c[0], c[1])
    d3 = sign(px, py, c[0], c[1], a[0], a[1])
    has_neg = d1 < 0 or d2 < 0 or d3 < 0
    has_pos = d1 > 0 or d2 > 0 or d3 > 0
    return not (has_neg and has_pos)


def render(size):
    n = size * SS
    buf = bytearray(n * n * 4)
    scale = n / 128.0

    bubble = (22.0, 26.0, 106.0, 80.0, 18.0)  # x0 y0 x1 y1 radius
    bcx = (bubble[0] + bubble[2]) / 2
    bcy = (bubble[1] + bubble[3]) / 2
    bhw = (bubble[2] - bubble[0]) / 2
    bhh = (bubble[3] - bubble[1]) / 2
    tail = ((36.0, 78.0), (56.0, 78.0), (28.0, 106.0))
    dots = [(48.0, 53.0), (64.0, 53.0), (80.0, 53.0)]

    for y in range(n):
        py = (y + 0.5) / scale
        for x in range(n):
            px = (x + 0.5) / scale

            # background rounded square
            bg_d = sd_rounded_rect(px, py, 64, 64, 62, 62, 26)
            if bg_d > 0.7 / scale:
                continue  # fully transparent, skip work

            color = None
            d_dot = min(
                math.hypot(px - dx, py - dy) for dx, dy in dots
            )
            in_bubble = sd_rounded_rect(px, py, bcx, bcy, bhw, bhh, bubble[4]) <= 0
            in_tail = in_triangle(px, py, *tail)

            if d_dot <= 7.0:
                color = DOT
            elif in_bubble or in_tail:
                color = WHITE
            else:
                t = max(0.0, min(1.0, py / 128.0))
                color = tuple(
                    round(TOP[i] + (BOTTOM[i] - TOP[i]) * t) for i in range(3)
                )

            off = (y * n + x) * 4
            buf[off] = color[0]
            buf[off + 1] = color[1]
            buf[off + 2] = color[2]
            buf[off + 3] = 255

    # box-downsample
    out = bytearray(size * size * 4)
    for y in range(size):
        for x in range(size):
            r = g = b = a = 0
            for sy in range(SS):
                for sx in range(SS):
                    off = ((y * SS + sy) * n + (x * SS + sx)) * 4
                    r += buf[off]
                    g += buf[off + 1]
                    b += buf[off + 2]
                    a += buf[off + 3]
            cnt = SS * SS
            o = (y * size + x) * 4
            out[o] = round(r / cnt)
            out[o + 1] = round(g / cnt)
            out[o + 2] = round(b / cnt)
            out[o + 3] = round(a / cnt)
    return bytes(out)


def write_png(path, size, rgba):
    def chunk(tag, data):
        c = struct.pack('>I', len(data)) + tag + data
        return c + struct.pack('>I', zlib.crc32(tag + data) & 0xFFFFFFFF)

    raw = bytearray()
    stride = size * 4
    for y in range(size):
        raw.append(0)  # filter: none
        raw += rgba[y * stride:(y + 1) * stride]

    png = b'\x89PNG\r\n\x1a\n'
    png += chunk(b'IHDR', struct.pack('>IIBBBBB', size, size, 8, 6, 0, 0, 0))
    png += chunk(b'IDAT', zlib.compress(bytes(raw), 9))
    png += chunk(b'IEND', b'')
    with open(path, 'wb') as f:
        f.write(png)


def main():
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    icons = os.path.join(root, 'icons')
    os.makedirs(icons, exist_ok=True)
    for size in (16, 48, 128):
        write_png(os.path.join(icons, f'icon{size}.png'), size, render(size))
        print(f'wrote icons/icon{size}.png')


if __name__ == '__main__':
    main()
