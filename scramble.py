#!/usr/bin/env python3
"""
Tessera frame scrambler (experiment v1)

Keyed, compression-tolerant block scrambling for video frames, designed to
survive re-encoding by video platforms (YouTube, Facebook, ...) so a browser
extension can descramble each frame during playback.

This is SCRAMBLING, not encryption. It hides content from casual viewers;
it does not resist a determined attacker.

How a frame is scrambled
------------------------
1. The source frame is scaled (letterboxed) to  cols*inner x rows*inner.
2. It is cut into  cols x rows  tiles of  inner x inner  pixels.
3. Each tile gets a keyed transform: transpose / mirror / flip (8 options)
   and an optional colour inversion (255 - x).
4. Each tile is padded with a guard band of `pad` replicated edge pixels,
   so codec blur at tile seams lands in the band, not in the picture.
5. Tiles are placed at keyed, shuffled positions in a  cols*tile x rows*tile
   output frame (default 1920x1080, a standard upload size).

The descrambler (this script, the WebGL test page, or the extension) reverses
this for any received resolution by working in normalised coordinates.

Key schedule (identical in Python and JavaScript)
-------------------------------------------------
stream block k = HMAC-SHA256(passphrase, "scrv1|" + salt + "|" + k)  (k as text)
each block yields 8 big-endian uint32 words.
Words are consumed in order: first a Fisher-Yates shuffle of tile positions
(unbiased via rejection sampling), then one word per source tile for its
transform (bits 0-2 = transform, bit 3 = invert).

Usage
-----
  python3 scramble.py scramble  input.mp4 scrambled.mp4 --key "passphrase"
  python3 scramble.py descramble downloaded.mp4 restored.mp4 --key "passphrase" --manifest scrambled.mp4.json
  python3 scramble.py frame     input.mp4 --key "passphrase" --at 3.0 --out preview.png   (one-frame preview)

Requires: python3, numpy, ffmpeg/ffprobe on PATH.
"""

import argparse
import base64
import hashlib
import hmac
import json
import os
import secrets
import struct
import subprocess
import sys

import numpy as np

VERSION = 1


# --------------------------------------------------------------------------
# Key schedule
# --------------------------------------------------------------------------

class KeyStream:
    """Deterministic uint32 stream from HMAC-SHA256. Mirrored in JS."""

    def __init__(self, passphrase: str, salt: str):
        self.key = passphrase.encode("utf-8")
        self.salt = salt
        self.counter = 0
        self.buf = []

    def next_u32(self) -> int:
        if not self.buf:
            msg = f"scrv1|{self.salt}|{self.counter}".encode("utf-8")
            digest = hmac.new(self.key, msg, hashlib.sha256).digest()
            self.buf = list(struct.unpack(">8I", digest))
            self.counter += 1
        return self.buf.pop(0)

    def uniform(self, n: int) -> int:
        """Unbiased integer in [0, n)."""
        limit = (2 ** 32 // n) * n
        while True:
            x = self.next_u32()
            if x < limit:
                return x % n


def build_tables(passphrase: str, salt: str, n_tiles: int):
    """
    Returns
      pos[s]   : scrambled slot that holds source tile s
      xform[s] : transform code 0-7 for source tile s
      inv[s]   : 1 if source tile s is colour-inverted
    """
    ks = KeyStream(passphrase, salt)
    perm = list(range(n_tiles))
    for i in range(n_tiles - 1, 0, -1):          # Fisher-Yates
        j = ks.uniform(i + 1)
        perm[i], perm[j] = perm[j], perm[i]
    pos = np.array(perm, dtype=np.int64)          # pos[s] = slot
    words = np.array([ks.next_u32() for _ in range(n_tiles)], dtype=np.uint64)
    xform = (words & 7).astype(np.int64)
    inv = ((words >> 3) & 1).astype(np.int64)
    return pos, xform, inv


# --------------------------------------------------------------------------
# Tile transforms. Code bits: 1 = transpose, 2 = mirror (x), 4 = flip (y),
# applied in that order. Arrays are (n, H, W, C).
# --------------------------------------------------------------------------

def forward_xform(tiles: np.ndarray, code: int) -> np.ndarray:
    t = tiles
    if code & 1:
        t = t.swapaxes(1, 2)
    if code & 2:
        t = t[:, :, ::-1]
    if code & 4:
        t = t[:, ::-1, :]
    return t


def inverse_xform(tiles: np.ndarray, code: int) -> np.ndarray:
    t = tiles
    if code & 4:
        t = t[:, ::-1, :]
    if code & 2:
        t = t[:, :, ::-1]
    if code & 1:
        t = t.swapaxes(1, 2)
    return t


# --------------------------------------------------------------------------
# Frame ops
# --------------------------------------------------------------------------

def to_tiles(frame: np.ndarray, rows: int, cols: int, size: int) -> np.ndarray:
    h, w, c = frame.shape
    assert h == rows * size and w == cols * size, (frame.shape, rows, cols, size)
    return (frame.reshape(rows, size, cols, size, c)
                 .transpose(0, 2, 1, 3, 4)
                 .reshape(rows * cols, size, size, c))


def from_tiles(tiles: np.ndarray, rows: int, cols: int) -> np.ndarray:
    n, size, _, c = tiles.shape
    return (tiles.reshape(rows, cols, size, size, c)
                 .transpose(0, 2, 1, 3, 4)
                 .reshape(rows * size, cols * size, c))


class Scrambler:
    def __init__(self, m: dict, passphrase: str):
        self.m = m
        self.rows, self.cols = m["rows"], m["cols"]
        self.inner, self.pad = m["inner"], m["pad"]
        self.tile = self.inner + 2 * self.pad
        n = self.rows * self.cols
        self.pos, self.xform, self.inv = build_tables(passphrase, m["salt"], n)
        self.groups = [np.nonzero(self.xform == c)[0] for c in range(8)]
        self.inv_mask = self.inv.astype(bool)

    def scramble(self, src: np.ndarray) -> np.ndarray:
        """src: (rows*inner, cols*inner, 3) uint8 -> (rows*tile, cols*tile, 3)"""
        tiles = to_tiles(src, self.rows, self.cols, self.inner)
        tiles = tiles.copy()
        tiles[self.inv_mask] = 255 - tiles[self.inv_mask]
        out_tiles = np.empty_like(tiles)
        for code, idx in enumerate(self.groups):
            if len(idx):
                out_tiles[idx] = forward_xform(tiles[idx], code)
        p = self.pad
        padded = np.pad(out_tiles, ((0, 0), (p, p), (p, p), (0, 0)), mode="edge")
        slots = np.empty_like(padded)
        slots[self.pos] = padded                   # slot pos[s] <- tile s
        return from_tiles(slots, self.rows, self.cols)

    def descramble(self, scr: np.ndarray) -> np.ndarray:
        """scr: (rows*tile, cols*tile, 3) uint8 -> (rows*inner, cols*inner, 3)"""
        slots = to_tiles(scr, self.rows, self.cols, self.tile)
        p = self.pad
        inner = slots[self.pos, p:p + self.inner, p:p + self.inner]  # by source tile
        out = np.empty_like(inner)
        for code, idx in enumerate(self.groups):
            if len(idx):
                out[idx] = inverse_xform(inner[idx], code)
        out[self.inv_mask] = 255 - out[self.inv_mask]
        return from_tiles(out, self.rows, self.cols)


# --------------------------------------------------------------------------
# ffmpeg plumbing
# --------------------------------------------------------------------------

def probe(path: str) -> dict:
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "v:0",
         "-show_entries", "stream=width,height,r_frame_rate,nb_frames",
         "-show_entries", "format=duration", "-of", "json", path],
        check=True, capture_output=True, text=True).stdout
    j = json.loads(out)
    s = j["streams"][0]
    num, den = s["r_frame_rate"].split("/")
    has_audio = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "a", "-show_entries",
         "stream=index", "-of", "csv=p=0", path],
        capture_output=True, text=True).stdout.strip() != ""
    return {"w": int(s["width"]), "h": int(s["height"]),
            "fps": float(num) / float(den), "fps_str": s["r_frame_rate"],
            "duration": float(j["format"].get("duration", 0) or 0),
            "audio": has_audio}


def reader(path: str, w: int, h: int, letterbox: bool, start=None, frames=None):
    vf = (f"scale={w}:{h}:force_original_aspect_ratio=decrease:flags=lanczos,"
          f"pad={w}:{h}:(ow-iw)/2:(oh-ih)/2,setsar=1") if letterbox else \
         f"scale={w}:{h}:flags=bicubic,setsar=1"
    cmd = ["ffmpeg", "-v", "error"]
    if start is not None:
        cmd += ["-ss", str(start)]
    cmd += ["-i", path, "-an", "-vf", vf]
    if frames is not None:
        cmd += ["-frames:v", str(frames)]
    cmd += ["-pix_fmt", "rgb24", "-f", "rawvideo", "-"]
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE)
    size = w * h * 3
    try:
        while True:
            buf = proc.stdout.read(size)
            if len(buf) < size:
                break
            yield np.frombuffer(buf, np.uint8).reshape(h, w, 3)
    finally:
        proc.stdout.close()
        proc.wait()


def writer(path: str, w: int, h: int, fps_str: str, crf: int, audio_from=None):
    cmd = ["ffmpeg", "-v", "error", "-y",
           "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{w}x{h}", "-r", fps_str, "-i", "-"]
    if audio_from:
        cmd += ["-i", audio_from, "-map", "0:v", "-map", "1:a?", "-c:a", "aac", "-b:a", "192k"]
    cmd += ["-c:v", "libx264", "-preset", "slow", "-crf", str(crf),
            "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-shortest", path]
    return subprocess.Popen(cmd, stdin=subprocess.PIPE)


def share_code(m: dict) -> str:
    raw = json.dumps(m, separators=(",", ":")).encode()
    return "scrv1:" + base64.urlsafe_b64encode(raw).decode().rstrip("=")


def parse_share_code(code: str) -> dict:
    assert code.startswith("scrv1:"), "not a scrv1 share code"
    b = code[6:]
    b += "=" * (-len(b) % 4)
    return json.loads(base64.urlsafe_b64decode(b))


def load_manifest(arg: str) -> dict:
    if arg.startswith("scrv1:"):
        return parse_share_code(arg)
    with open(arg) as f:
        return json.load(f)


# --------------------------------------------------------------------------
# Commands
# --------------------------------------------------------------------------

def progress(i, total):
    if total:
        sys.stderr.write(f"\r  frame {i}/{total} ({100 * i // total}%)")
    else:
        sys.stderr.write(f"\r  frame {i}")
    sys.stderr.flush()


def cmd_scramble(a):
    info = probe(a.input)
    tile = a.width // a.cols
    if a.width % a.cols or a.height % a.rows or a.height // a.rows != tile:
        sys.exit(f"--width/--height must split into square tiles: {a.width}x{a.height} "
                 f"with {a.cols}x{a.rows} gives non-square or fractional tiles")
    inner = tile - 2 * a.pad
    if inner < 8:
        sys.exit("tile too small for that guard band")
    m = {"v": VERSION, "cols": a.cols, "rows": a.rows, "inner": inner, "pad": a.pad,
         "width": a.width, "height": a.height,
         "salt": a.salt or secrets.token_hex(8), "fps": info["fps_str"]}
    sc = Scrambler(m, a.key)
    sw, sh = a.cols * inner, a.rows * inner
    total = int(info["duration"] * info["fps"]) if info["duration"] else 0
    print(f"source {info['w']}x{info['h']} @ {info['fps']:.3f} fps -> picture {sw}x{sh} "
          f"-> scrambled {a.width}x{a.height} ({a.cols}x{a.rows} tiles, {inner}px + {a.pad}px guard)",
          file=sys.stderr)
    if info["audio"] and not a.no_audio:
        print("  note: audio is copied UNSCRAMBLED (use --no-audio to drop it)", file=sys.stderr)
    w = writer(a.output, a.width, a.height, info["fps_str"], a.crf,
               audio_from=None if a.no_audio or not info["audio"] else a.input)
    i = 0
    for frame in reader(a.input, sw, sh, letterbox=True):
        w.stdin.write(sc.scramble(frame).tobytes())
        i += 1
        if i % 10 == 0:
            progress(i, total)
    w.stdin.close()
    w.wait()
    sys.stderr.write("\n")
    mpath = a.output + ".json"
    with open(mpath, "w") as f:
        json.dump(m, f, indent=2)
    print(f"wrote {a.output}  ({i} frames)")
    print(f"wrote {mpath}")
    print(f"share code (public parameters, no key): {share_code(m)}")


def cmd_descramble(a):
    m = load_manifest(a.manifest)
    info = probe(a.input)
    sc = Scrambler(m, a.key)
    W, H = m["width"], m["height"]
    sw, sh = m["cols"] * m["inner"], m["rows"] * m["inner"]
    if (info["w"], info["h"]) != (W, H):
        print(f"received {info['w']}x{info['h']}, rescaling to {W}x{H} before descrambling",
              file=sys.stderr)
    total = int(info["duration"] * info["fps"]) if info["duration"] else 0
    w = writer(a.output, sw, sh, info["fps_str"], a.crf,
               audio_from=a.input if info["audio"] else None)
    i = 0
    for frame in reader(a.input, W, H, letterbox=False):
        w.stdin.write(sc.descramble(frame).tobytes())
        i += 1
        if i % 10 == 0:
            progress(i, total)
    w.stdin.close()
    w.wait()
    sys.stderr.write("\n")
    print(f"wrote {a.output}  ({i} frames, {sw}x{sh})")


def cmd_frame(a):
    """Scramble + descramble one frame and save a side-by-side PNG preview."""
    m = {"v": VERSION, "cols": a.cols, "rows": a.rows,
         "inner": a.width // a.cols - 2 * a.pad, "pad": a.pad,
         "width": a.width, "height": a.height, "salt": a.salt or "preview"}
    sc = Scrambler(m, a.key)
    sw, sh = m["cols"] * m["inner"], m["rows"] * m["inner"]
    frame = next(reader(a.input, sw, sh, letterbox=True, start=a.at, frames=1))
    scr = sc.scramble(frame)
    back = sc.descramble(scr)
    assert np.array_equal(back, frame), "lossless round trip failed"
    cmd = ["ffmpeg", "-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "rgb24",
           "-s", f"{a.width}x{a.height}", "-i", "-", a.out]
    subprocess.run(cmd, input=scr.tobytes(), check=True)
    print(f"wrote {a.out} (lossless round trip verified)")


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="cmd", required=True)

    def geometry(sp):
        sp.add_argument("--cols", type=int, default=48)
        sp.add_argument("--rows", type=int, default=27)
        sp.add_argument("--width", type=int, default=1920)
        sp.add_argument("--height", type=int, default=1080)
        sp.add_argument("--pad", type=int, default=4, help="guard band in px at upload resolution")
        sp.add_argument("--salt", help="per-video salt (random if omitted)")

    s = sub.add_parser("scramble", help="scramble a video for upload")
    s.add_argument("input"); s.add_argument("output")
    s.add_argument("--key", required=True)
    s.add_argument("--crf", type=int, default=14, help="x264 quality for the upload master")
    s.add_argument("--no-audio", action="store_true")
    geometry(s)
    s.set_defaults(fn=cmd_scramble)

    d = sub.add_parser("descramble", help="descramble a (downloaded) video")
    d.add_argument("input"); d.add_argument("output")
    d.add_argument("--key", required=True)
    d.add_argument("--manifest", required=True, help="manifest .json or scrv1: share code")
    d.add_argument("--crf", type=int, default=16)
    d.set_defaults(fn=cmd_descramble)

    f = sub.add_parser("frame", help="preview one scrambled frame as PNG")
    f.add_argument("input")
    f.add_argument("--key", required=True)
    f.add_argument("--at", type=float, default=0.0)
    f.add_argument("--out", default="preview.png")
    geometry(f)
    f.set_defaults(fn=cmd_frame)

    a = p.parse_args()
    a.fn(a)


if __name__ == "__main__":
    main()
