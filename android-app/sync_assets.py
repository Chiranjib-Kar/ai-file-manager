"""
Bundles the shared web UI + offline JS backend + vendor libraries into
android-app/app/src/main/assets/ and generates fallback launcher PNGs.
"""
import os
import re
import shutil
import struct
import zlib

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ANDROID_DIR = os.path.join(ROOT, "android-app")
STATIC_DIR = os.path.join(ROOT, "static")
VENDOR_SRC = os.path.join(ANDROID_DIR, "vendor")
LOCAL_API = os.path.join(ANDROID_DIR, "web", "local-api.js")

MAIN_DIR = os.path.join(ANDROID_DIR, "app", "src", "main")
ASSETS_DIR = os.path.join(MAIN_DIR, "assets")
RES_DIR = os.path.join(MAIN_DIR, "res")


def sync_web_assets():
    if os.path.exists(ASSETS_DIR):
        shutil.rmtree(ASSETS_DIR)
    os.makedirs(os.path.join(ASSETS_DIR, "vendor"), exist_ok=True)

    # 1. Copy offline vendor libraries
    for fname in os.listdir(VENDOR_SRC):
        shutil.copy2(os.path.join(VENDOR_SRC, fname), os.path.join(ASSETS_DIR, "vendor", fname))

    # 2. Copy local-api.js and shared app.js
    shutil.copy2(LOCAL_API, os.path.join(ASSETS_DIR, "local-api.js"))
    shutil.copy2(os.path.join(STATIC_DIR, "app.js"), os.path.join(ASSETS_DIR, "app.js"))

    # 3. Copy styles.css without remote @import so offline startup is instant
    css = open(os.path.join(STATIC_DIR, "styles.css"), encoding="utf-8").read()
    css = re.sub(r"@import\s+url\([^)]+\);\s*", "", css)
    with open(os.path.join(ASSETS_DIR, "styles.css"), "w", encoding="utf-8") as f:
        f.write(css)

    # 4. Adapt index.html to load local bundled vendor & backend scripts
    html = open(os.path.join(STATIC_DIR, "index.html"), encoding="utf-8").read()
    html = html.replace('https://cdn.tailwindcss.com', 'vendor/tailwind.js')
    html = html.replace('https://unpkg.com/lucide@latest', 'vendor/lucide.min.js')
    html = html.replace('/static/styles.css', 'styles.css')
    html = html.replace(
        '<script src="/static/app.js"></script>',
        '<script src="vendor/pdf.min.js"></script>\n'
        '  <script src="vendor/jszip.min.js"></script>\n'
        '  <script src="local-api.js"></script>\n'
        '  <script src="app.js"></script>'
    )
    with open(os.path.join(ASSETS_DIR, "index.html"), "w", encoding="utf-8") as f:
        f.write(html)
    print("Synced offline web assets into", ASSETS_DIR)


def make_icon_png(size: int) -> bytes:
    """Renders a crisp emerald-cyan shield/vault PNG icon in pure Python."""
    rows = []
    cx = cy = (size - 1) / 2.0
    r_outer = size * 0.46
    for y in range(size):
        row = bytearray([0])  # PNG filter type 0
        for x in range(size):
            dx = (x - cx) / (size / 2.0)
            dy = (y - cy) / (size / 2.0)
            # Rounded squircle mask
            inside_bg = (abs(dx) ** 4 + abs(dy) ** 4) <= 0.92
            if not inside_bg:
                row.extend((0, 0, 0, 0))
                continue
            # Deep emerald gradient background
            t = (x + y) / (2.0 * size)
            br = int(6 + 10 * t)
            bg = int(28 + 38 * t)
            bb = int(24 + 34 * t)

            # Shield / diamond sparkle emblem in center
            adx, ady = abs(dx), abs(dy)
            in_diamond = (adx * 1.25 + ady) < 0.46 and ady < 0.42
            in_inner = (adx * 1.25 + ady) < 0.24
            if in_inner:
                row.extend((110, 231, 183, 255))  # bright mint core
            elif in_diamond:
                row.extend((16, 185, 129, 255))   # vibrant emerald
            else:
                row.extend((br, bg, bb, 255))
        rows.append(bytes(row))

    raw = b"".join(rows)
    def chunk(tag: bytes, data: bytes) -> bytes:
        return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

    ihdr = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr) + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b"")


def generate_fallback_icons():
    densities = {
        "mipmap-mdpi": 48,
        "mipmap-hdpi": 72,
        "mipmap-xhdpi": 96,
        "mipmap-xxhdpi": 144,
        "mipmap-xxxhdpi": 192,
    }
    for folder, px in densities.items():
        d = os.path.join(RES_DIR, folder)
        os.makedirs(d, exist_ok=True)
        png = make_icon_png(px)
        for name in ("ic_launcher.png", "ic_launcher_round.png"):
            with open(os.path.join(d, name), "wb") as f:
                f.write(png)
    print("Generated launcher PNG icons.")


if __name__ == "__main__":
    sync_web_assets()
    generate_fallback_icons()
