"""Generate PNG icons for the Shared Browser extension."""
import struct
import zlib
import os

def create_png(size, color=(99, 102, 241)):
    """Create a minimal valid PNG with a rounded-rect icon."""
    w, h = size, size

    # Create RGBA pixel data
    pixels = []
    r, g, b = color
    radius = size // 4

    for y in range(h):
        row = []
        for x in range(w):
            # Rounded rectangle mask
            dx = min(x, w - 1 - x)
            dy = min(y, h - 1 - y)
            if dx < radius and dy < radius:
                dist = ((radius - dx) ** 2 + (radius - dy) ** 2) ** 0.5
                if dist > radius:
                    row += [0, 0, 0, 0]
                    continue
            # Simple icon: circle with dots representing people
            cx, cy = w / 2, h / 2
            dist_center = ((x - cx) ** 2 + (y - cy) ** 2) ** 0.5
            inner_r = size * 0.38

            # Outer circle fill
            if dist_center <= inner_r:
                alpha = 255
            else:
                alpha = 0

            row += [r, g, b, alpha]
        pixels.append(bytes(row))

    def pack_chunk(chunk_type, data):
        c = chunk_type + data
        return struct.pack('>I', len(data)) + c + struct.pack('>I', zlib.crc32(c) & 0xffffffff)

    # PNG signature
    sig = b'\x89PNG\r\n\x1a\n'

    # IHDR
    ihdr_data = struct.pack('>IIBBBBB', w, h, 8, 2, 0, 0, 0)
    ihdr = pack_chunk(b'IHDR', ihdr_data)

    # IDAT
    raw = b''
    for row in pixels:
        raw += b'\x00' + row[:w*4]
    compressed = zlib.compress(raw, 9)
    idat = pack_chunk(b'IDAT', compressed)

    # IEND
    iend = pack_chunk(b'IEND', b'')

    return sig + ihdr + idat + iend


def main():
    out_dir = os.path.join(os.path.dirname(__file__), '..', 'extension', 'icons')
    os.makedirs(out_dir, exist_ok=True)

    color = (99, 102, 241)  # Indigo

    for size in [16, 32, 48, 128]:
        data = create_png(size, color)
        path = os.path.join(out_dir, f'icon{size}.png')
        with open(path, 'wb') as f:
            f.write(data)
        print(f'Generated {path}')


if __name__ == '__main__':
    main()
