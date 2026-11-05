# Tessera

Keyed tile scrambling for video that survives platform re-encoding, plus a
browser extension that descrambles it live in the YouTube player. Each frame
is cut into a mosaic of tiles, and a passphrase decides how they are shuffled,
flipped and inverted.

This is scrambling, not encryption. It hides content from casual viewers; it
does not resist a determined attacker.

## Files

| File | What it is |
|---|---|
| `scramble.py` | Scramble a video for upload; descramble a downloaded copy; preview one frame |
| `descrambler-extension/` | Chrome/Edge extension that descrambles scrambled videos on YouTube |
| `descrambler-extension/descrambler-core.js` | Key schedule + WebGL renderer used by the extension |

Requirements: Python 3 with numpy, ffmpeg/ffprobe on PATH, a WebGL-capable browser.

## Scramble a clip

```bash
python3 scramble.py scramble clip.mp4 clip_scr.mp4 --key "a long passphrase"
```

Writes `clip_scr.mp4` (1920×1080 H.264, upload this), `clip_scr.mp4.json`
(the manifest), and prints a `scrv1:` share code. The share code and manifest
hold only public parameters (grid, tile size, guard band, per-video salt).
The passphrase is never stored.

Audio is copied **unscrambled**. Add `--no-audio` to drop it.

Preview one frame without encoding the whole video:

```bash
python3 scramble.py frame clip.mp4 --key "a long passphrase" --at 5 --out preview.png
```

## Descramble YouTube's copy

Download your own upload from YouTube Studio (Content → ⋮ → Download), then:

```bash
python3 scramble.py descramble downloaded.mp4 restored.mp4 \
  --key "a long passphrase" --manifest clip_scr.mp4.json
```

`--manifest` also accepts the `scrv1:` share code. Any received resolution works.

## Watch it on YouTube with the extension (Phase 1 prototype)

1. In Chrome, open `chrome://extensions` and turn on **Developer mode**.
2. Click **Load unpacked**, pick the `descrambler-extension` folder, and pin
   the extension.
3. Open your uploaded (Unlisted) video's watch page and click the extension icon.
   The video ID fills in from the tab; paste the share code and key, press Save.
4. The player switches to the descrambled picture within a second.
   **Alt+Shift+D** flips between descrambled and raw for comparison.

Notes: works on `youtube.com/watch` pages and YouTube embeds, desktop Chrome
(and Edge). Ads are left alone. Picture-in-picture is disabled while
descrambling, because it would show the raw stream. Below 720p the player shows
a hint to raise the quality. Keys are stored unencrypted in the browser profile.

## Tuning knobs

| Option | Default | Effect |
|---|---|---|
| `--cols` / `--rows` | 48 / 27 | Tile grid. Fewer, larger tiles = better quality, weaker scrambling |
| `--pad` | 4 | Guard band (px at 1080p) that absorbs seam blur. Wider = cleaner seams, less picture resolution |
| `--crf` | 14 | Quality of the upload master. Keep it high; YouTube re-encodes anyway |

Picture resolution is `cols × (1920/cols − 2·pad)`: 1536×864 with the defaults.
Tiles must stay square and aligned (1920/cols = 1080/rows). Valid grids with
the 1920×1080 frame: 64×36 (30 px tiles), 48×27 (40 px), 32×18 (60 px),
16×9 (120 px).
