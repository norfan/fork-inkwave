import math
import os
from PIL import Image, ImageDraw

# INKWAVE pad launcher icon: ink-dark rounded square + cyan gamepad glyph.
SIZES = {
    "mipmap-mdpi": 48,
    "mipmap-hdpi": 72,
    "mipmap-xhdpi": 96,
    "mipmap-xxhdpi": 144,
    "mipmap-xxxhdpi": 192,
}

res_dir = os.path.normpath(os.path.join(os.path.dirname(__file__), "..", "res"))


def make_icon(S):
    img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    pad = int(S * 0.05)
    r = int(S * 0.2)
    # ink-dark rounded background
    d.rounded_rectangle([pad, pad, S - pad, S - pad], radius=r, fill=(14, 22, 40, 255))
    cx, cy = S // 2, S // 2 + int(S * 0.02)
    # cyan gamepad body
    w, h = int(S * 0.62), int(S * 0.38)
    d.rounded_rectangle([cx - w // 2, cy - h // 2, cx + w // 2, cy + h // 2],
                        radius=int(S * 0.16), fill=(127, 212, 255, 255))
    # d-pad cross on the left
    arm = int(S * 0.13)
    t = int(S * 0.045)
    lx = cx - int(S * 0.20)
    d.rectangle([lx - arm // 2, cy - arm // 2, lx + arm // 2, cy + arm // 2], fill=(11, 14, 26, 255))
    d.rectangle([lx - arm // 2, cy - arm // 2, lx - arm // 2 + t, cy + arm // 2], fill=(11, 14, 26, 255))
    # right face buttons (two dots)
    r1 = int(S * 0.045)
    d.ellipse([cx + int(S * 0.13) - r1, cy - int(S * 0.09) - r1, cx + int(S * 0.13) + r1, cy - int(S * 0.09) + r1],
              fill=(11, 14, 26, 255))
    d.ellipse([cx + int(S * 0.13) - r1, cy + int(S * 0.09) - r1, cx + int(S * 0.13) + r1, cy + int(S * 0.09) + r1],
              fill=(11, 14, 26, 255))
    return img


def main():
    for folder, S in SIZES.items():
        out = os.path.join(res_dir, folder, "ic_launcher.png")
        os.makedirs(os.path.dirname(out), exist_ok=True)
        make_icon(S).save(out)
        print("wrote", out)


if __name__ == "__main__":
    main()
