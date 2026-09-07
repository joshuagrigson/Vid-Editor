#!/usr/bin/env python3
"""GhostCut — splice short iPhone clips into one found-footage horror movie.

Double-click "Start GhostCut" (or run `python ghostcut.py`) and it:
  1. installs its two helpers the first time (a bundled ffmpeg + Pillow),
  2. opens http://localhost:4322 in your browser,
  3. lets you drop in the clips, put them in order, pick a look, add a
     jump scare, and press Render,
  4. writes one polished .mp4 into workspace/output/ (next to this file).

Command-line use (no browser):
  python ghostcut.py render /path/to/folder-of-clips --title "PARANORMAL ACTIVITY"
  python ghostcut.py render clip1.mov clip2.mov --style seccam --out movie.mp4

Everything is standard library except the two auto-installed packages.
"""

from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import math
import mimetypes
import os
import random
import re
import shutil
import subprocess
import sys
import threading
import time
import traceback
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, unquote, urlsplit

HERE = os.path.dirname(os.path.abspath(__file__))
WORKSPACE = os.path.join(HERE, "workspace")
UI_PATH = os.path.join(HERE, "ui.html")
VIDEO_EXTS = {".mov", ".mp4", ".m4v", ".mkv", ".avi", ".3gp", ".hevc", ".webm", ".mts", ".m2ts"}
DEFAULT_PORT = 4322

FPS = 30
AUDIO_RATE = 48000


class FriendlyError(Exception):
    """An error whose message is safe to show the user verbatim."""


# --------------------------------------------------------------------------
# Dependencies: a bundled ffmpeg (imageio-ffmpeg) and Pillow for text cards.
# --------------------------------------------------------------------------

FFMPEG: str | None = None


def ensure_deps() -> str:
    """Install imageio-ffmpeg and Pillow if missing; return the ffmpeg path."""
    global FFMPEG
    if FFMPEG:
        return FFMPEG
    missing = []
    try:
        import imageio_ffmpeg  # noqa: F401
    except ImportError:
        missing.append("imageio-ffmpeg")
    try:
        import PIL  # noqa: F401
    except ImportError:
        missing.append("pillow")
    if missing:
        print(f"First run: installing {', '.join(missing)} (one-time, ~60 MB) ...", flush=True)
        base = [sys.executable, "-m", "pip", "install", "--quiet", "--disable-pip-version-check"]
        rc = subprocess.call(base + missing)
        if rc != 0:
            rc = subprocess.call(base + ["--user"] + missing)
        if rc != 0:
            raise FriendlyError(
                "Could not install the helper packages automatically.\n"
                f"Run this once, then start GhostCut again:\n\n"
                f"    {sys.executable} -m pip install {' '.join(missing)}\n"
            )
    import imageio_ffmpeg

    FFMPEG = imageio_ffmpeg.get_ffmpeg_exe()
    return FFMPEG


# --------------------------------------------------------------------------
# Fonts (Pillow). We never depend on ffmpeg's drawtext: the bundled ffmpeg
# builds don't all ship it, so every piece of text is rendered to PNG first.
# --------------------------------------------------------------------------

def _font_candidates(kind: str) -> list[str]:
    win = os.path.join(os.environ.get("WINDIR", r"C:\Windows"), "Fonts")
    mac = "/System/Library/Fonts"
    macs = "/System/Library/Fonts/Supplemental"
    lin = "/usr/share/fonts/truetype"
    if kind == "mono":
        return [
            os.path.join(win, "consola.ttf"), os.path.join(win, "lucon.ttf"), os.path.join(win, "cour.ttf"),
            os.path.join(mac, "Menlo.ttc"), os.path.join(mac, "Monaco.ttf"),
            os.path.join(macs, "Courier New.ttf"),
            os.path.join(lin, "dejavu", "DejaVuSansMono.ttf"),
            os.path.join(lin, "liberation", "LiberationMono-Regular.ttf"),
        ]
    if kind == "serif":
        return [
            os.path.join(win, "times.ttf"), os.path.join(win, "georgia.ttf"),
            os.path.join(macs, "Times New Roman.ttf"), os.path.join(macs, "Georgia.ttf"),
            os.path.join(lin, "dejavu", "DejaVuSerif.ttf"),
            os.path.join(lin, "liberation", "LiberationSerif-Regular.ttf"),
        ]
    # sans
    return [
        os.path.join(win, "arial.ttf"), os.path.join(win, "segoeui.ttf"),
        os.path.join(mac, "Helvetica.ttc"), os.path.join(macs, "Arial.ttf"),
        os.path.join(lin, "dejavu", "DejaVuSans.ttf"),
        os.path.join(lin, "liberation", "LiberationSans-Regular.ttf"),
    ]


def load_font(kind: str, size: int):
    from PIL import ImageFont

    for path in _font_candidates(kind):
        if os.path.exists(path):
            try:
                return ImageFont.truetype(path, size)
            except Exception:
                continue
    try:
        return ImageFont.load_default(size=size)  # Pillow >= 10.1 ships a scalable default
    except TypeError:
        return ImageFont.load_default()


def text_width(font, text: str, spacing: float = 0) -> float:
    if not text:
        return 0
    return sum(font.getlength(c) for c in text) + spacing * (len(text) - 1)


def draw_spaced(draw, x: float, y: float, text: str, font, fill, spacing: float = 0, shadow=None):
    """Draw text one glyph at a time so we can letter-space it."""
    for ch in text:
        if shadow:
            draw.text((x + shadow[0], y + shadow[1]), ch, font=font, fill=shadow[2])
        draw.text((x, y), ch, font=font, fill=fill)
        x += font.getlength(ch) + spacing


def wrap_text(text: str, font, max_width: float, spacing: float = 0) -> list[str]:
    lines: list[str] = []
    for para in text.split("\n"):
        words = para.split()
        if not words:
            lines.append("")
            continue
        cur = words[0]
        for w in words[1:]:
            if text_width(font, cur + " " + w, spacing) <= max_width:
                cur += " " + w
            else:
                lines.append(cur)
                cur = w
        lines.append(cur)
    return lines


# --------------------------------------------------------------------------
# Card renderers (PNG)
# --------------------------------------------------------------------------

def make_card(path: str, W: int, H: int, title: str = "", subtitle: str = "", body: str = "",
              title_kind: str = "serif", title_scale: float = 0.075, body_kind: str = "mono",
              cursor: bool = False, dim: float = 1.0) -> None:
    """A black card with optional big title, small subtitle and/or body paragraph."""
    from PIL import Image, ImageDraw

    img = Image.new("RGB", (W, H), (0, 0, 0))
    d = ImageDraw.Draw(img)
    S = H / 1080.0
    white = tuple(int(v * dim) for v in (235, 235, 235))
    grey = tuple(int(v * dim) for v in (160, 160, 160))
    blocks = []  # (font, text, spacing, fill, gap_after, is_body)
    if title:
        f = load_font(title_kind, int(H * title_scale))
        sp = f.size * 0.18
        for ln in wrap_text(title.upper(), f, W * 0.86, sp):
            blocks.append((f, ln, sp, white, int(30 * S), False))
    if subtitle:
        f = load_font("mono", int(34 * S))
        blocks.append((f, subtitle, f.size * 0.08, grey, int(10 * S), False))
    if body:
        f = load_font(body_kind, int(40 * S))
        for ln in wrap_text(body, f, W * 0.72):
            blocks.append((f, ln, 0, white, int(12 * S), True))
    total = sum(b[0].size * 1.25 + b[4] for b in blocks)
    y = (H - total) / 2
    last_body_end = None
    for f, text, sp, fill, gap, is_body in blocks:
        w = text_width(f, text, sp)
        x = (W - w) / 2
        draw_spaced(d, x, y, text, f, fill, sp)
        if is_body:
            last_body_end = (x + w, y, f.size)
        y += f.size * 1.25 + gap
    if cursor and last_body_end:
        # typewriter block cursor after the last body line
        x, y0, fs = last_body_end
        d.rectangle([x + fs * 0.15, y0 + fs * 0.12, x + fs * 0.15 + fs * 0.55, y0 + fs * 1.05], fill=white)
    img.save(path, "PNG")


def make_typewriter_frames(folder: str, W: int, H: int, text: str, hold_frames: int = 34) -> int:
    """PNG sequence typing `text` one character per frame, then blinking cursor. Returns frame count."""
    os.makedirs(folder, exist_ok=True)
    n = 0
    for i in range(1, len(text) + 1):
        make_card(os.path.join(folder, f"f_{n:04d}.png"), W, H, body=text[:i], cursor=True)
        n += 1
    for k in range(hold_frames):
        make_card(os.path.join(folder, f"f_{n:04d}.png"), W, H, body=text, cursor=(k // 7) % 2 == 0)
        n += 1
    return n


def make_scanlines(path: str, W: int, H: int, strength: int = 46, period: int = 3) -> None:
    from PIL import Image, ImageDraw

    img = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    for y in range(0, H, period):
        d.line([(0, y), (W, y)], fill=(0, 0, 0, strength))
    img.save(path, "PNG")


def make_timestamp_frames(folder: str, W: int, H: int, style: str, night: int,
                          start: dt.datetime, seconds: int) -> int:
    """One RGBA overlay PNG per second of footage (camcorder clock, REC dot, etc.)."""
    from PIL import Image, ImageDraw

    os.makedirs(folder, exist_ok=True)
    S = H / 1080.0
    small = load_font("mono", int(34 * S))
    big = load_font("mono", int(44 * S))
    margin = int(44 * S)
    shadow = (max(2, int(2 * S)), max(2, int(2 * S)), (0, 0, 0, 220))
    for i in range(seconds):
        t = start + dt.timedelta(seconds=i)
        img = Image.new("RGBA", (W, H), (0, 0, 0, 0))
        d = ImageDraw.Draw(img)
        white = (240, 240, 240, 235)
        if style == "night":
            # blinking REC dot top-left, night + clock bottom-right
            if i % 2 == 0:
                r = int(14 * S)
                d.ellipse([margin, margin + int(10 * S), margin + 2 * r, margin + 2 * r + int(10 * S)], fill=(230, 40, 40, 235))
            draw_spaced(d, margin + int(44 * S), margin, "REC", big, white, 2, shadow)
            l1 = f"NIGHT {night}"
            l2 = t.strftime("%I:%M:%S %p") + "   " + t.strftime("%m/%d/%Y")
            w1, w2 = text_width(big, l1, 2), text_width(small, l2, 1)
            draw_spaced(d, W - margin - w1, H - margin - big.size * 1.3 - small.size * 1.3, l1, big, white, 2, shadow)
            draw_spaced(d, W - margin - w2, H - margin - small.size * 1.3, l2, small, white, 1, shadow)
        elif style == "vhs":
            # triangle play glyph + PLAY, SP mode, date bottom-left
            tri = [(margin, margin + int(6 * S)), (margin, margin + int(40 * S)), (margin + int(30 * S), margin + int(23 * S))]
            d.polygon(tri, fill=white)
            draw_spaced(d, margin + int(46 * S), margin, "PLAY", big, white, 2, shadow)
            draw_spaced(d, W - margin - text_width(big, "SP", 2), margin, "SP", big, white, 2, shadow)
            l1 = t.strftime("%b %d %Y").upper() + "   " + t.strftime("%I:%M %p").lstrip("0")
            draw_spaced(d, margin, H - margin - big.size * 1.3, l1, big, white, 2, shadow)
        else:  # seccam and anything else that asks for a clock
            draw_spaced(d, margin, margin, "CAM 01", big, white, 2, shadow)
            l1 = f"NIGHT {night}"
            l2 = t.strftime("%m/%d/%Y  %I:%M:%S %p")
            draw_spaced(d, margin, H - margin - big.size * 1.3, l1, big, white, 2, shadow)
            draw_spaced(d, W - margin - text_width(small, l2, 1), H - margin - small.size * 1.3, l2, small, white, 1, shadow)
        img.save(os.path.join(folder, f"ts_{i:04d}.png"), "PNG")
    return seconds


# --------------------------------------------------------------------------
# ffmpeg helpers
# --------------------------------------------------------------------------

class RenderError(Exception):
    pass


def ff_base() -> list[str]:
    return [ensure_deps(), "-hide_banner", "-y", "-nostdin", "-loglevel", "error"]


def run_ffmpeg(args: list[str], expected: float, on_progress=None, log_path: str | None = None) -> None:
    """Run ffmpeg with -progress on stdout; call on_progress(fraction) as it goes."""
    cmd = ff_base() + ["-progress", "pipe:1", "-nostats"] + args
    log = open(log_path, "wb") if log_path else subprocess.DEVNULL
    if log_path:
        log.write(("$ " + " ".join(cmd) + "\n\n").encode("utf-8", "replace"))
        log.flush()
    try:
        proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=log, stdin=subprocess.DEVNULL)
        assert proc.stdout is not None
        for raw in proc.stdout:
            line = raw.decode("utf-8", "replace").strip()
            if line.startswith("out_time_us=") or line.startswith("out_time_ms="):
                try:
                    us = int(line.split("=", 1)[1])
                except ValueError:
                    continue
                if on_progress and expected > 0:
                    on_progress(max(0.0, min(1.0, (us / 1e6) / expected)))
        rc = proc.wait()
    finally:
        if log_path:
            log.close()
    if rc != 0:
        tail = ""
        if log_path and os.path.exists(log_path):
            with open(log_path, "rb") as f:
                tail = f.read()[-2500:].decode("utf-8", "replace")
        raise RenderError(f"ffmpeg failed (exit {rc}).\n{tail}")
    if on_progress:
        on_progress(1.0)


def probe(path: str) -> dict:
    """Read duration/size/rotation/audio/HDR from `ffmpeg -i` (the bundle has no ffprobe)."""
    r = subprocess.run(ff_base()[:2] + ["-i", path], capture_output=True, text=True, errors="replace")
    err = r.stderr
    info: dict = {"duration": 0.0, "width": 0, "height": 0, "has_audio": "Audio:" in err,
                  "hdr": None, "fps": 30.0, "created": None}
    m = re.search(r"Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)", err)
    if m:
        info["duration"] = int(m.group(1)) * 3600 + int(m.group(2)) * 60 + float(m.group(3))
    vm = re.search(r"Stream #\d+:\d+.*?: Video: ([^\n]*)", err)
    if not vm:
        raise FriendlyError(f"No video stream found in {os.path.basename(path)}")
    vline = vm.group(1)
    dm = re.search(r"\b(\d{2,5})x(\d{2,5})\b", vline)
    if dm:
        info["width"], info["height"] = int(dm.group(1)), int(dm.group(2))
    fm = re.search(r"(\d+(?:\.\d+)?) fps", vline)
    if fm:
        info["fps"] = float(fm.group(1))
    rot = 0.0
    rm = re.search(r"rotation of (-?\d+(?:\.\d+)?) degrees", err) or re.search(r"rotate\s*:\s*(-?\d+)", err)
    if rm:
        rot = float(rm.group(1))
    if abs(rot) % 180 == 90:
        info["width"], info["height"] = info["height"], info["width"]
    if "arib-std-b67" in vline:
        info["hdr"] = "arib-std-b67"
    elif "smpte2084" in vline:
        info["hdr"] = "smpte2084"
    elif "yuv420p10" in vline and "bt2020" in vline:
        info["hdr"] = "arib-std-b67"  # iPhone HLG with the tag missing
    cm = re.search(r"creation_time\s*:\s*(\S+)", err)
    if cm:
        info["created"] = cm.group(1)
    info["portrait"] = info["height"] > info["width"]
    return info


def ffconcat_path(p: str) -> str:
    return p.replace("\\", "/").replace("'", r"'\''")


# --------------------------------------------------------------------------
# Looks
# --------------------------------------------------------------------------

STYLES = {
    "night": {"name": "Night Vision", "clock": True, "scanlines": False,
              "blurb": "Green-tinted infrared camcorder. The classic 'something is in the room' look."},
    "seccam": {"name": "Security Cam", "clock": True, "scanlines": True,
               "blurb": "Cold, desaturated, choppy 15fps fixed-camera footage with scanlines."},
    "vhs": {"name": "VHS Found Footage", "clock": True, "scanlines": True,
            "blurb": "Warm, smeary tape with colour bleed, jitter, and a PLAY overlay."},
    "cinematic": {"name": "Cinematic Dark", "clock": False, "scanlines": False,
                  "blurb": "Moody teal-shadow grade, widescreen bars, light grain. No camcorder text."},
    "clean": {"name": "Clean", "clock": False, "scanlines": False,
              "blurb": "No look applied. Just the splice, titles, transitions and sound."},
}

TRANSITIONS = {
    "static": "TV static burst",
    "black": "Fade through black",
    "cut": "Hard cut",
}


def style_video_chain(style: str, W: int, H: int) -> str:
    if style == "night":
        return (
            "hue=s=0,eq=brightness=0.10:contrast=1.22:gamma=1.55,"
            "curves=r='0/0 0.5/0.22 1/0.55':g='0/0 0.5/0.66 1/1':b='0/0 0.5/0.18 1/0.45',"
            "noise=alls=26:allf=t+u,unsharp=5:5:0.9,vignette=angle=PI/3.8"
        )
    if style == "seccam":
        return (
            "fps=15,fps=30,hue=s=0.25,eq=contrast=1.18:brightness=-0.02:gamma=1.15,"
            "colorbalance=bs=0.14:bm=0.07:bh=0.03,noise=alls=14:allf=t,"
            "gblur=sigma=0.5,vignette=angle=PI/4.2"
        )
    if style == "vhs":
        jitter = "pad=iw+16:ih+16:8:8:color=black," \
                 f"crop={W}:{H}:'8+4*sin(t*23)*gt(random(0),0.82)':'8+2*sin(t*17)'"
        return (
            "eq=saturation=1.2:contrast=0.94:brightness=0.02,rgbashift=rh=3:bh=-3,"
            "gblur=sigma=0.7,unsharp=3:3:0.6,noise=alls=22:allf=t+u," + jitter + ",vignette=angle=PI/4.6"
        )
    if style == "cinematic":
        bar = int(round(H * 0.11 / 2)) * 2
        return (
            "eq=contrast=1.12:saturation=0.78:brightness=-0.04,"
            "colorbalance=bs=0.09:bm=0.04:bh=-0.05:rh=-0.03,"
            "curves=all='0/0 0.25/0.17 0.75/0.8 1/0.98',vignette=angle=PI/4,noise=alls=6:allf=t,"
            f"drawbox=x=0:y=0:w=iw:h={bar}:c=black:t=fill,drawbox=x=0:y=ih-{bar}:w=iw:h={bar}:c=black:t=fill"
        )
    return "null"


def style_audio_chain(style: str) -> str:
    if style in ("night", "seccam"):
        return "highpass=f=60,lowpass=f=9000,acompressor=threshold=-20dB:ratio=3:attack=20:release=250:makeup=5dB"
    if style == "vhs":
        return "highpass=f=100,lowpass=f=6500,acompressor=threshold=-20dB:ratio=2.5:makeup=4dB"
    if style == "cinematic":
        return "acompressor=threshold=-22dB:ratio=2.5:makeup=3dB"
    return "anull"


def hdr_to_sdr_chain(tf: str) -> str:
    """Tone-map iPhone HDR (HLG / Dolby Vision) so it doesn't come out washed out."""
    return (
        f"zscale=tin={tf}:min=bt2020nc:pin=bt2020:t=linear:npl=100,format=gbrpf32le,"
        "zscale=p=bt709,tonemap=tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv,format=yuv420p"
    )


def fit_chain(src_w: int, src_h: int, W: int, H: int) -> str:
    """Fit any clip onto the canvas; mismatched aspect gets a blurred, darkened copy behind it."""
    if src_w and src_h and abs((src_w / src_h) - (W / H)) < 0.02:
        return f"scale={W}:{H}:flags=lanczos,setsar=1[base]"
    return (
        f"split[bg0][fg0];[bg0]scale={W}:{H}:force_original_aspect_ratio=increase:flags=bicubic,"
        f"crop={W}:{H},gblur=sigma=40,eq=brightness=-0.28[bg];"
        f"[fg0]scale={W}:{H}:force_original_aspect_ratio=decrease:force_divisible_by=2:flags=lanczos[fg];"
        "[bg][fg]overlay=(W-w)/2:(H-h)/2,setsar=1[base]"
    )


def jump_scare_video(T: float, W: int, H: int) -> str:
    """Sudden zoom + shake + strobe/negative flashes starting at T (seconds into the clip)."""
    z = f"(1+0.85*min(1,max(0,(t-{T:.3f})/0.32))*between(t,{T:.3f},{T + 1.15:.3f}))"
    return (
        f"scale=w='trunc(iw*{z}/2)*2':h='trunc(ih*{z}/2)*2':eval=frame,"
        f"crop={W}:{H}:x='(iw-{W})/2+0.03*iw*sin(t*97)*between(t,{T + 0.05:.3f},{T + 1.0:.3f})'"
        f":y='(ih-{H})/2+0.03*ih*sin(t*83)*between(t,{T + 0.05:.3f},{T + 1.0:.3f})',"
        f"negate=enable='between(t,{T:.3f},{T + 0.06:.3f})+between(t,{T + 0.13:.3f},{T + 0.17:.3f})',"
        f"eq=brightness=0.45:enable='between(t,{T + 0.06:.3f},{T + 0.10:.3f})',"
        f"noise=alls=70:allf=t+u:enable='between(t,{T:.3f},{T + 0.75:.3f})'"
    )


def jump_scare_audio_source(T: float, label: str) -> str:
    ms = int(T * 1000)
    sting = ("0.9*sin(2*PI*52*t)*exp(-2.2*t)"
             "+0.45*sin(2*PI*(650+2400*t)*t)*exp(-5*t)"
             "+0.35*(random(0)-0.5)*exp(-9*t)")
    return (f"aevalsrc=exprs='{sting}':s={AUDIO_RATE}:d=3,aformat=channel_layouts=stereo,"
            f"adelay={ms}:all=1{label}")


# --------------------------------------------------------------------------
# Project model
# --------------------------------------------------------------------------

def default_project() -> dict:
    return {
        "title": "PARANORMAL ACTIVITY",
        "subtitle": "",
        "family": "the Grigson",
        "intro_text": "",              # blank = auto-generated from family
        "outro_text": "The whereabouts of the family remain unknown.",
        "credits": "",                 # one line each
        "style": "night",
        "transition": "static",
        "canvas": "auto",              # auto | landscape | portrait
        "title_card": True,
        "night_cards": True,
        "nights_mode": "per_clip",     # per_clip | single | manual
        "timestamps": True,
        "drone": 0.55,                 # 0..1 background dread volume
        "end_card": True,
        "start_date": "",              # YYYY-MM-DD, blank = 21 days ago
        "output_name": "",
        "trailer_length": 60,
        "trailer_taglines": "",
        "seed": random.randint(1, 999999),
        "clips": [],                   # [{id, file, name, meta, start, end, effect, scare_at, new_night}]
    }


def intro_text_for(proj: dict) -> str:
    if proj.get("intro_text", "").strip():
        return proj["intro_text"].strip()
    fam = (proj.get("family") or "the").strip()
    return (f"The following footage was recovered from {fam} residence. "
            "It has not been altered.")


def clip_span(clip: dict) -> tuple[float, float]:
    dur = float(clip["meta"]["duration"])
    start = max(0.0, float(clip.get("start") or 0))
    end = float(clip.get("end") or 0)
    if end <= 0 or end > dur:
        end = dur
    if end - start < 0.4:
        start, end = 0.0, dur
    return start, end


def choose_canvas(proj: dict) -> tuple[int, int]:
    mode = proj.get("canvas", "auto")
    if mode == "portrait":
        return 1080, 1920
    if mode == "landscape":
        return 1920, 1080
    portrait = sum(1 for c in proj["clips"] if c["meta"].get("portrait"))
    return (1080, 1920) if portrait > len(proj["clips"]) / 2 else (1920, 1080)


def plan_nights(proj: dict) -> list[dict]:
    """Assign each clip a night number and a fake camcorder clock, in order."""
    mode = proj.get("nights_mode", "per_clip")
    try:
        d0 = dt.date.fromisoformat(proj.get("start_date") or "")
    except ValueError:
        d0 = dt.date.today() - dt.timedelta(days=21)
    rng = random.Random(int(proj.get("seed") or 1))
    plan = []
    night = 0
    clock: dt.datetime | None = None
    for i, clip in enumerate(proj["clips"]):
        new_night = (i == 0 or mode == "per_clip" or (mode == "manual" and clip.get("new_night")))
        if new_night:
            night += 1
            day = d0 + dt.timedelta(days=night - 1)
            clock = dt.datetime.combine(day, dt.time(0, 0)) + dt.timedelta(
                minutes=rng.randint(35, 235))  # between 00:35 and 03:55
        else:
            assert clock is not None
            clock += dt.timedelta(minutes=rng.randint(3, 40))
        start, end = clip_span(clip)
        plan.append({"night": night, "new_night": new_night, "clock": clock, "start": start, "end": end,
                     "duration": end - start})
        clock = clock + dt.timedelta(seconds=end - start)
    return plan


# --------------------------------------------------------------------------
# Renderer
# --------------------------------------------------------------------------

# Every segment is encoded once, at delivery quality, with identical parameters so the
# final assembly can stitch the video without re-encoding (only the audio is remixed).
ENC_INTER = ["-c:v", "libx264", "-preset", "fast", "-crf", "19", "-maxrate", "14M", "-bufsize", "28M",
             "-pix_fmt", "yuv420p", "-r", str(FPS), "-g", str(FPS * 2), "-profile:v", "high", "-level", "4.1",
             "-c:a", "aac", "-b:a", "192k", "-ar", str(AUDIO_RATE), "-ac", "2"]
ENC_FINAL = ["-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-ar", str(AUDIO_RATE), "-ac", "2",
             "-movflags", "+faststart"]

# A sub-bass hit with a little click, 1.4 s. Used on trailer cuts and cards.
BOOM = ("aevalsrc=exprs='0.9*sin(2*PI*48*t)*exp(-3.5*t)+0.4*sin(2*PI*95*t)*exp(-6*t)"
        f"+0.25*(random(0)-0.5)*exp(-14*t)':s={AUDIO_RATE}:d=1.4,aformat=channel_layouts=stereo")


# --------------------------------------------------------------------------
# Trailer: find the loud, sudden moments and cut them into a trailer
# --------------------------------------------------------------------------

TRAILER_LENGTHS = {45: (2, 4, 6), 60: (3, 5, 8), 90: (4, 7, 12)}   # setup, escalation, montage shots
DEFAULT_TAGLINES = "THIS HALLOWEEN\nSOMETHING IS IN THE HOUSE\nNO ONE WILL BELIEVE THEM\nCOMING SOON"


def analyze_loudness(path: str, start: float, dur: float) -> list[dict]:
    """RMS loudness per half second (audio only, quick): [{t, db}], t relative to start."""
    cmd = ff_base() + ["-nostats", "-loglevel", "info", "-ss", f"{start:.3f}", "-t", f"{dur:.3f}", "-i", path, "-vn",
                       "-af", "aresample=8000,aformat=channel_layouts=mono,asetnsamples=n=4000,astats=metadata=1:reset=1,"
                              "ametadata=mode=print:key=lavfi.astats.Overall.RMS_level",
                       "-f", "null", "-"]
    r = subprocess.run(cmd, capture_output=True, text=True, errors="replace")
    out, t = [], None
    for line in r.stderr.splitlines():
        m = re.search(r"pts_time:([\d.]+)", line)
        if m:
            t = float(m.group(1))
            continue
        m = re.search(r"RMS_level=(-?[\d.]+|-inf)", line)
        if m and t is not None:
            out.append({"t": t, "db": -100.0 if m.group(1) == "-inf" else max(-100.0, float(m.group(1)))})
            t = None
    return out


def plan_trailer(proj: dict, analyses: dict[int, list[dict]], length: int = 60) -> dict:
    """Pick the moments and lay out the trailer. Deterministic for a given seed. Mirrors app.js planTrailer."""
    counts = TRAILER_LENGTHS.get(int(length), TRAILER_LENGTHS[60])
    clips = proj["clips"]
    plans = plan_nights(proj)
    rng = random.Random(int(proj.get("seed") or 1) + 77)
    wins: list[dict] = []
    for ci, clip in enumerate(clips):
        dur = plans[ci]["duration"]
        a = [w for w in (analyses.get(ci) or []) if 0 <= w["t"] <= dur]
        if len(a) < 4:
            a = [{"t": i / 2, "db": -40 + rng.random() * 6} for i in range(int(dur * 2))]
        dbs = [w["db"] for w in a]
        lo, hi = min(dbs), max(dbs)
        span = max(6.0, hi - lo)
        for i, w in enumerate(a):
            prev = [x["db"] for x in a[max(0, i - 6):i]]
            before = sum(prev) / len(prev) if prev else w["db"]
            loud = (w["db"] - lo) / span
            jump = max(0.0, w["db"] - before) / span
            wins.append({"clip": ci, "t": w["t"], "db": w["db"], "dur": dur,
                         "score": 0.55 * loud + 0.45 * min(1.0, jump * 2) + rng.random() * 0.02})
    taken: list[dict] = []
    total_dur = sum(p["duration"] for p in plans)
    wanted = sum(counts) + 1
    gap = max(1.2, min(6.0, total_dur / (wanted * 2.5)))

    def free(w):
        return not any(x["clip"] == w["clip"] and abs(x["t"] - w["t"]) < gap for x in taken)

    def fit(w, lead, ln):
        return w["t"] - lead >= 0 and w["t"] - lead + ln <= w["dur"]

    by_score = sorted(wins, key=lambda w: -w["score"])
    finale = next((w for w in by_score if fit(w, 1.4, 2.4)), by_score[0] if by_score else None)
    if finale:
        taken.append(finale)

    def pick(n, ln, lead):
        out, per_clip = [], {}
        cap = math.ceil(n / max(1, len(clips))) + 1
        for w in by_score:
            if len(out) >= n:
                break
            if w is finale or not free(w) or not fit(w, lead, ln) or per_clip.get(w["clip"], 0) >= cap:
                continue
            out.append(w)
            taken.append(w)
            per_clip[w["clip"]] = per_clip.get(w["clip"], 0) + 1
        return out

    esc = pick(counts[1], 1.5, 0.6)
    montage = pick(counts[2], 0.8, 0.3)
    setup = []
    for w in sorted(wins, key=lambda w: w["score"]):
        if len(setup) >= counts[0]:
            break
        if w["t"] > w["dur"] * 0.6 or not fit(w, 0, 2.4) or not free(w):
            continue
        if any(s["clip"] == w["clip"] for s in setup) and len(setup) < len(clips):
            continue
        setup.append(w)
        taken.append(w)
    chrono = lambda arr: sorted(arr, key=lambda w: (w["clip"], w["t"]))  # noqa: E731
    setup, esc = chrono(setup), chrono(esc)
    by_clip: dict[int, list[dict]] = {}
    for w in chrono(montage):
        by_clip.setdefault(w["clip"], []).append(w)
    mont = []
    while any(by_clip.values()):
        for k in list(by_clip):
            if by_clip[k]:
                mont.append(by_clip[k].pop(0))

    tags = [s.strip() for s in (proj.get("trailer_taglines") or DEFAULT_TAGLINES).splitlines() if s.strip()]
    items: list[dict] = [{"type": "black", "dur": 1.0}]
    if len(tags) > 0:
        items.append({"type": "card", "title": tags[0], "dur": 1.9})
    items += [{"type": "moment", "clip": w["clip"], "start": w["t"], "dur": 2.4, "transition": "black"} for w in setup]
    if len(tags) > 1:
        items.append({"type": "card", "title": tags[1], "dur": 1.9})
    for i, w in enumerate(esc):
        if i > 0:
            items.append({"type": "static", "dur": 0.14})
        items.append({"type": "moment", "clip": w["clip"], "start": w["t"] - 0.6, "dur": 1.5, "boom": True})
    if len(tags) > 2:
        items.append({"type": "card", "title": tags[2], "dur": 1.9})
    items += [{"type": "moment", "clip": w["clip"], "start": w["t"] - 0.3, "dur": 0.8, "flash": True, "riser": True} for w in mont]
    items.append({"type": "black", "dur": 0.9, "quiet": True})
    if finale:
        items.append({"type": "moment", "clip": finale["clip"], "start": max(0.0, finale["t"] - 1.4), "dur": 2.4, "scare": 1.4})
    items.append({"type": "static", "dur": 0.2})
    items.append({"type": "card", "title": proj.get("title") or "UNTITLED", "subtitle": proj.get("subtitle") or "",
                  "dur": 3.4, "big": True, "fade_out": 0.7})
    if len(tags) > 3:
        items.append({"type": "card", "title": tags[3], "dur": 2.0, "fade_out": 0.8})
    items.append({"type": "black", "dur": 1.0})
    return {"length": int(length), "items": items, "total": sum(it["dur"] for it in items)}


class Renderer:
    def __init__(self, proj: dict, workspace: str, progress=None, preview_clip: str | None = None):
        self.proj = proj
        self.ws = workspace
        self.build = os.path.join(workspace, "build")
        self.progress = progress or (lambda frac, msg: None)
        self.preview_clip = preview_clip
        self.W, self.H = choose_canvas(proj)
        self.segments: list[tuple[str, float]] = []  # (path, duration)
        self.total_work = 1.0
        self.done_work = 0.0

    # -- progress -----------------------------------------------------------
    def _job(self, weight: float, msg: str):
        def cb(frac: float):
            self.progress(min(0.999, (self.done_work + weight * frac) / self.total_work), msg)
        return cb

    def _finish(self, weight: float):
        self.done_work += weight

    # -- pieces -------------------------------------------------------------
    def _seg(self, name: str) -> str:
        return os.path.join(self.build, name + ".mp4")

    def render_card(self, name: str, png: str, duration: float, fade_in=0.8, fade_out=0.7,
                    slam: bool = False, boom: bool = False) -> str:
        """slam: no fade-in, a two-frame white flash and a slow push-in instead. boom: sub hit on entry."""
        out = self._seg(name)
        W, H = self.W, self.H
        if slam:
            vf = (f"scale=w='trunc(iw*(1+0.05*t/{duration:.3f})/2)*2':h='trunc(ih*(1+0.05*t/{duration:.3f})/2)*2':eval=frame,"
                  f"crop={W}:{H},eq=brightness=0.7:enable='lt(t,0.07)',")
        else:
            vf = f"fade=t=in:st=0:d={fade_in},"
        vf += (f"fade=t=out:st={duration - fade_out:.3f}:d={fade_out},"
               f"noise=alls=7:allf=t,eq=brightness='0.012*sin(t*31)':eval=frame,format=yuv420p")
        audio = f"{BOOM},apad" if boom else f"anullsrc=r={AUDIO_RATE}:cl=stereo"
        args = ["-loop", "1", "-framerate", str(FPS), "-i", png,
                "-f", "lavfi", "-i", audio,
                "-t", f"{duration:.3f}", "-vf", vf] + ENC_INTER + [out]
        run_ffmpeg(args, duration, self._job(duration * 0.25, f"Title card: {name}"),
                   os.path.join(self.build, name + ".log"))
        self._finish(duration * 0.25)
        self.segments.append((out, duration))
        return out

    def render_typewriter(self, name: str, text: str) -> str:
        folder = os.path.join(self.build, name + "_frames")
        shutil.rmtree(folder, ignore_errors=True)
        n = make_typewriter_frames(folder, self.W, self.H, text)
        type_fps = 14
        typing_secs = len(text) / type_fps
        duration = n / type_fps + 0.6
        out = self._seg(name)
        clicks = (f"aevalsrc=exprs='0.35*(random(0)-0.5)*lt(mod(t,1/{type_fps}),0.011)*lt(t,{typing_secs:.3f})'"
                  f":s={AUDIO_RATE}:d={duration:.3f},aformat=channel_layouts=stereo,lowpass=f=5000")
        vf = (f"fps={FPS},tpad=stop_mode=clone:stop_duration=1,trim=duration={duration:.3f},"
              f"fade=t=out:st={duration - 0.5:.3f}:d=0.5,noise=alls=6:allf=t,format=yuv420p")
        args = ["-framerate", str(type_fps), "-i", os.path.join(folder, "f_%04d.png"),
                "-f", "lavfi", "-i", clicks, "-t", f"{duration:.3f}", "-vf", vf] + ENC_INTER + [out]
        run_ffmpeg(args, duration, self._job(duration * 0.25, "Opening text"), os.path.join(self.build, name + ".log"))
        self._finish(duration * 0.25)
        self.segments.append((out, duration))
        return out

    def render_black(self, name: str, duration: float) -> str:
        out = self._seg(name)
        args = ["-f", "lavfi", "-i", f"color=c=black:s={self.W}x{self.H}:r={FPS}:d={duration:.3f}",
                "-f", "lavfi", "-i", f"anullsrc=r={AUDIO_RATE}:cl=stereo", "-t", f"{duration:.3f}",
                "-vf", "format=yuv420p", "-shortest"] + ENC_INTER + [out]
        run_ffmpeg(args, duration, None, os.path.join(self.build, name + ".log"))
        self.segments.append((out, duration))
        return out

    def render_static(self, name: str, duration: float = 0.2) -> str:
        out = self._seg(name)
        vsrc = (f"color=c=black:s={self.W}x{self.H}:r={FPS}:d={duration:.3f},format=gray,"
                "geq=lum='random(1)*255',format=yuv420p")
        asrc = f"anoisesrc=color=white:amplitude=0.55:r={AUDIO_RATE}:d={duration:.3f}"
        args = ["-f", "lavfi", "-i", vsrc, "-f", "lavfi", "-i", asrc, "-t", f"{duration:.3f}", "-shortest"] + ENC_INTER + [out]
        run_ffmpeg(args, duration, None, os.path.join(self.build, name + ".log"))
        self.segments.append((out, duration))
        return out

    def render_clip(self, idx: int, clip: dict, plan: dict, preview: bool = False, *,
                    piece: dict | None = None, name: str | None = None, transition: str | None = None,
                    flash: bool = False, boom: bool = False, scare_T: float | None | str = "clip",
                    label: str = "") -> str:
        """piece = {start, dur} relative to the trimmed clip (default: the whole clip).
        transition overrides the movie setting; flash = white flash on the first frames; boom = sub hit at the
        start; scare_T = seconds into the piece for a jump scare, None for none, "clip" = the clip's own marker."""
        proj = self.proj
        W, H = self.W, self.H
        style = clip.get("effect") or "style"
        if style == "style":
            style = proj["style"]
        meta = clip["meta"]
        start, D = plan["start"], plan["duration"]
        if piece:
            start, D = start + piece["start"], piece["dur"]
        if preview:
            D = min(D, 6.0)
        name = name or (f"clip{idx:02d}" if not preview else f"preview_{clip['id']}")
        transition = transition or proj["transition"]
        clock = plan["clock"] + dt.timedelta(seconds=piece["start"] if piece else 0)
        out = self._seg(name)
        src = os.path.join(self.ws, "clips", clip["file"])

        inputs = ["-ss", f"{start:.3f}", "-i", src]
        n_in = 1
        graph = []

        # video: fps -> HDR fix -> fit onto canvas -> [base]
        pre = f"[0:v]fps={FPS},"
        if meta.get("hdr"):
            pre += hdr_to_sdr_chain(meta["hdr"]) + ","
        graph.append(pre + fit_chain(meta.get("width", 0), meta.get("height", 0), W, H))
        cur = "[base]"

        # look
        graph.append(f"{cur}{style_video_chain(style, W, H)}[fx]")
        cur = "[fx]"

        # jump scare
        if scare_T == "clip":
            scare = clip.get("scare_at")
            scare_T = None
            if scare not in (None, "", False):
                try:
                    scare_T = float(scare)
                except (TypeError, ValueError):
                    scare_T = None
            if scare_T is not None and not (0.3 <= scare_T <= D - 0.4):
                scare_T = None if D < 1.5 else max(0.3, min(D - 0.4, scare_T))
        if scare_T is not None:
            graph.append(f"{cur}{jump_scare_video(scare_T, W, H)}[sc]")
            cur = "[sc]"
        if flash:
            graph.append(f"{cur}eq=brightness=0.75:enable='lt(t,0.07)'[fl]")
            cur = "[fl]"

        # scanlines overlay
        if STYLES.get(style, {}).get("scanlines"):
            scan = os.path.join(self.build, f"scan_{W}x{H}.png")
            if not os.path.exists(scan):
                make_scanlines(scan, W, H)
            inputs += ["-loop", "1", "-framerate", str(FPS), "-i", scan]
            graph.append(f"{cur}[{n_in}:v]overlay=0:0:format=auto[sl]")
            cur = "[sl]"
            n_in += 1

        # camcorder clock overlay (one PNG per second)
        if proj.get("timestamps") and STYLES.get(style, {}).get("clock"):
            folder = os.path.join(self.build, name + "_ts")
            shutil.rmtree(folder, ignore_errors=True)
            secs = int(math.ceil(D)) + 2
            make_timestamp_frames(folder, W, H, style, plan["night"], clock, secs)
            inputs += ["-framerate", "1", "-i", os.path.join(folder, "ts_%04d.png")]
            graph.append(f"{cur}[{n_in}:v]overlay=0:0:format=auto[ts]")
            cur = "[ts]"
            n_in += 1

        # fades + exact length
        fade = (0.35 if piece else 0.5) if transition == "black" else 0.0
        tail = ""
        if fade:
            tail += f"fade=t=in:st=0:d={fade},fade=t=out:st={D - fade:.3f}:d={fade},"
        if preview:
            tail += "scale=iw/2:-2,"
        tail += f"format=yuv420p,tpad=stop_mode=clone:stop_duration=2,trim=duration={D:.3f},setpts=PTS-STARTPTS[vout]"
        graph.append(f"{cur}{tail}")

        # audio
        if meta.get("has_audio"):
            asrc = "[0:a]"
        else:
            inputs += ["-f", "lavfi", "-i", f"anullsrc=r={AUDIO_RATE}:cl=stereo"]
            asrc = f"[{n_in}:a]"
            n_in += 1
        achain = (f"{asrc}aresample={AUDIO_RATE},aformat=sample_fmts=fltp:channel_layouts=stereo,"
                  f"{style_audio_chain(style)}")
        if scare_T is not None:
            achain += f",volume=0.12:enable='between(t,{max(0, scare_T - 0.8):.3f},{scare_T - 0.02:.3f})'[a1];"
            achain += jump_scare_audio_source(scare_T, "[sting]") + ";"
            achain += "[a1][sting]amix=inputs=2:duration=first:normalize=0,alimiter=limit=0.97"
        if boom:
            achain += f"[a2];{BOOM}[bm];[a2][bm]amix=inputs=2:duration=first:normalize=0,alimiter=limit=0.97"
        if fade:
            achain += f",afade=t=in:st=0:d={fade},afade=t=out:st={D - fade:.3f}:d={fade}"
        achain += f",apad=whole_dur={D + 2:.3f},atrim=duration={D:.3f},asetpts=PTS-STARTPTS[aout]"
        graph.append(achain)

        script = os.path.join(self.build, name + ".filters.txt")
        with open(script, "w", encoding="utf-8") as f:
            f.write(";\n".join(graph) + "\n")

        enc = list(ENC_INTER)
        if preview:
            enc[enc.index("-preset") + 1] = "ultrafast"
            enc[enc.index("-crf") + 1] = "26"
            enc += ["-movflags", "+faststart"]
        args = inputs + ["-filter_complex_script", script, "-map", "[vout]", "-map", "[aout]"] + enc + [out]
        weight = D * (1.0 if not meta.get("hdr") else 1.6)
        run_ffmpeg(args, D, self._job(weight, f"Clip {idx + 1}: {clip['name']}{label}"), os.path.join(self.build, name + ".log"))
        self._finish(weight)
        if not preview:
            self.segments.append((out, D))
        return out

    def render_final(self, out_path: str, riser: tuple[float, float] | None = None,
                     quiet: list[tuple[float, float]] | None = None, drone_gain: float = 1.0) -> None:
        """riser=(at, dur): rising shriek under that stretch. quiet=[(at, dur)]: drone pulled down there."""
        total = sum(d for _, d in self.segments)
        lst = os.path.join(self.build, "concat.txt")
        with open(lst, "w", encoding="utf-8") as f:
            f.write("ffconcat version 1.0\n")
            for p, d in self.segments:
                f.write(f"file '{ffconcat_path(p)}'\nduration {d:.3f}\n")
        drone = float(self.proj.get("drone") or 0) * drone_gain
        graph = []
        if drone > 0:
            vol = 0.30 * drone
            q = "".join(f",volume=0.05:enable='between(t,{a:.3f},{a + d:.3f})'" for a, d in (quiet or []))
            graph.append(
                "aevalsrc=exprs='0.55*sin(2*PI*46*t)*(0.75+0.25*sin(2*PI*0.11*t))"
                "+0.35*sin(2*PI*47.6*t)+0.22*sin(2*PI*92*t)*(0.5+0.5*sin(2*PI*0.07*t+1))"
                f"+0.18*sin(2*PI*138.5*t)*(0.5+0.5*sin(2*PI*0.05*t+2))':s={AUDIO_RATE},"
                "aformat=channel_layouts=stereo[dr1]")
            graph.append(f"anoisesrc=color=brown:amplitude=0.6:r={AUDIO_RATE},aformat=channel_layouts=stereo,"
                         "lowpass=f=300[dr2]")
            graph.append(f"[dr1][dr2]amix=inputs=2:normalize=0,volume={vol:.3f}{q},"
                         f"afade=t=in:st=0:d=3,afade=t=out:st={max(0, total - 4):.3f}:d=4[drone]")
            graph.append("[0:a][drone]amix=inputs=2:duration=first:normalize=0[amix]")
            acur = "[amix]"
        else:
            acur = "[0:a]"
        if riser and riser[1] > 1:
            at, dr = riser
            graph.append(
                f"aevalsrc=exprs='(0.28*sin(2*PI*(70+900*pow(t/{dr:.3f},2))*t)+0.22*(random(0)-0.5)"
                f"+0.18*sin(2*PI*(35+300*pow(t/{dr:.3f},2))*t))*(0.15+0.85*pow(t/{dr:.3f},1.5))'"
                f":s={AUDIO_RATE}:d={dr:.3f},aformat=channel_layouts=stereo,adelay={int(at * 1000)}:all=1[riser]")
            graph.append(f"{acur}[riser]amix=inputs=2:duration=first:normalize=0[amixr]")
            acur = "[amixr]"
        graph.append(f"{acur}alimiter=limit=0.95,afade=t=out:st={max(0, total - 1.5):.3f}:d=1.5[aout]")
        script = os.path.join(self.build, "final.filters.txt")
        with open(script, "w", encoding="utf-8") as f:
            f.write(";\n".join(graph) + "\n")
        args = ["-f", "concat", "-safe", "0", "-i", lst, "-filter_complex_script", script,
                "-map", "0:v", "-map", "[aout]", "-t", f"{total:.3f}"] + ENC_FINAL + [out_path]
        weight = total * 0.08
        run_ffmpeg(args, total, self._job(weight, "Final assembly"), os.path.join(self.build, "final.log"))
        self._finish(weight)

    # -- trailer -------------------------------------------------------------
    def run_trailer(self, out_path: str, length: int | None = None) -> str:
        proj = self.proj
        if not proj["clips"]:
            raise FriendlyError("Add at least one clip first.")
        os.makedirs(self.build, exist_ok=True)
        os.makedirs(os.path.dirname(out_path), exist_ok=True)
        plans = plan_nights(proj)
        analyses: dict[int, list[dict]] = {}
        for i, (clip, pl) in enumerate(zip(proj["clips"], plans)):
            self.progress(0.01 * i / len(plans), f"Listening to clip {i + 1} of {len(plans)} for the loud parts…")
            src = os.path.join(self.ws, "clips", clip["file"])
            analyses[i] = analyze_loudness(src, pl["start"], pl["duration"]) if clip["meta"].get("has_audio") else []
        tp = plan_trailer(proj, analyses, int(length or proj.get("trailer_length") or 60))
        work = 1.0
        for it in tp["items"]:
            if it["type"] == "moment":
                work += it["dur"] * (1.6 if proj["clips"][it["clip"]]["meta"].get("hdr") else 1.0)
            elif it["type"] == "card":
                work += it["dur"] * 0.25
        self.total_work = work + work * 0.08
        self.segments = []
        at, riser, quiet = 0.0, None, []
        for k, it in enumerate(tp["items"]):
            nm = f"tr{k:02d}_{it['type']}"
            if it["type"] == "black":
                self.render_black(nm, it["dur"])
                if it.get("quiet"):
                    quiet.append((at, it["dur"]))
            elif it["type"] == "static":
                self.render_static(nm, it["dur"])
            elif it["type"] == "card":
                png = os.path.join(self.build, nm + ".png")
                big = it.get("big")
                make_card(png, self.W, self.H, title=it.get("title", ""), subtitle=it.get("subtitle", ""),
                          title_scale=(0.085 if len(it.get("title", "")) < 22 else 0.06) if big else 0.05)
                self.render_card(nm, png, it["dur"], 0.8, it.get("fade_out", 0.4), slam=True, boom=True)
            elif it["type"] == "moment":
                if it.get("riser"):
                    riser = (riser[0], at + it["dur"] - riser[0]) if riser else (at, it["dur"])
                clip = proj["clips"][it["clip"]]
                self.render_clip(it["clip"], clip, plans[it["clip"]], piece={"start": it["start"], "dur": it["dur"]},
                                 name=nm, transition=it.get("transition", "cut"), flash=bool(it.get("flash")),
                                 boom=bool(it.get("boom")),
                                 scare_T=(min(it["dur"] - 0.4, it["scare"]) if it.get("scare") else None),
                                 label=f" (trailer moment {k + 1} of {len(tp['items'])})")
            at += it["dur"]
        self.render_final(out_path, riser=riser, quiet=quiet, drone_gain=1.35)
        self.progress(1.0, "Done")
        return out_path

    # -- orchestration -----------------------------------------------------
    def estimate_work(self, plan: list[dict]) -> float:
        clips = sum(p["duration"] * (1.6 if c["meta"].get("hdr") else 1.0) for c, p in zip(self.proj["clips"], plan))
        cards = 0.25 * (12 if self.proj.get("title_card") else 0) + 0.25 * 2.2 * len(plan) + 0.25 * 10
        total = clips + cards
        return total + total * 0.08 + 1

    def run(self, out_path: str) -> str:
        proj = self.proj
        if not proj["clips"]:
            raise FriendlyError("Add at least one clip first.")
        os.makedirs(self.build, exist_ok=True)
        os.makedirs(os.path.dirname(out_path), exist_ok=True)
        plan = plan_nights(proj)
        self.total_work = self.estimate_work(plan)
        self.segments = []

        if proj.get("title_card"):
            self.render_black("black_open", 1.2)
            self.render_typewriter("intro", intro_text_for(proj))
            card = os.path.join(self.build, "title.png")
            make_card(card, self.W, self.H, title=proj["title"] or "UNTITLED", subtitle=proj.get("subtitle", ""),
                      title_scale=0.085 if len(proj["title"]) < 22 else 0.06)
            self.render_card("title", card, 4.0, fade_in=1.6, fade_out=0.3)
            self.render_black("black_after_title", 0.8)

        for i, (clip, p) in enumerate(zip(proj["clips"], plan)):
            if proj.get("night_cards") and p["new_night"]:
                png = os.path.join(self.build, f"night{p['night']:02d}.png")
                make_card(png, self.W, self.H, title=f"Night #{p['night']}",
                          subtitle=p["clock"].strftime("%B %d, %Y").replace(" 0", " "),
                          title_kind="serif", title_scale=0.06)
                self.render_card(f"night{p['night']:02d}", png, 2.6)
            elif i > 0:
                if proj["transition"] == "static":
                    self.render_static(f"static{i:02d}", 0.18 + 0.02 * (i % 3))
            self.render_clip(i, clip, p)
            if i == len(plan) - 1 and proj["transition"] == "static" and (proj.get("end_card") or proj.get("outro_text")):
                self.render_static("static_end", 0.25)

        if proj.get("end_card"):
            self.render_black("black_end", 1.0)
            if proj.get("outro_text", "").strip():
                png = os.path.join(self.build, "outro.png")
                make_card(png, self.W, self.H, body=proj["outro_text"].strip())
                self.render_card("outro", png, 4.5, fade_in=1.0, fade_out=1.0)
            credits = [ln.strip() for ln in (proj.get("credits") or "").splitlines() if ln.strip()]
            if credits:
                png = os.path.join(self.build, "credits.png")
                make_card(png, self.W, self.H, title=proj["title"] or "", body="\n".join(credits),
                          title_scale=0.045)
                self.render_card("credits", png, 5.0, fade_in=1.0, fade_out=1.5)
            self.render_black("black_final", 1.0)

        self.render_final(out_path)
        self.progress(1.0, "Done")
        return out_path


# --------------------------------------------------------------------------
# Workspace (clips on disk + project.json)
# --------------------------------------------------------------------------

class Workspace:
    def __init__(self, root: str):
        self.root = root
        self.clips_dir = os.path.join(root, "clips")
        self.thumbs_dir = os.path.join(root, "thumbs")
        self.previews_dir = os.path.join(root, "previews")
        self.output_dir = os.path.join(root, "output")
        for d in (self.clips_dir, self.thumbs_dir, self.previews_dir, self.output_dir):
            os.makedirs(d, exist_ok=True)
        self.path = os.path.join(root, "project.json")
        self.lock = threading.Lock()
        self.proj = self._load()

    def _load(self) -> dict:
        proj = default_project()
        if os.path.exists(self.path):
            try:
                with open(self.path, encoding="utf-8") as f:
                    saved = json.load(f)
                proj.update({k: v for k, v in saved.items() if k in proj})
            except (OSError, ValueError):
                pass
        # drop clips whose files vanished
        proj["clips"] = [c for c in proj["clips"] if os.path.exists(os.path.join(self.clips_dir, c["file"]))]
        return proj

    def save(self) -> None:
        tmp = self.path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(self.proj, f, indent=2)
        os.replace(tmp, self.path)

    def add_clip(self, src_path: str, display_name: str | None = None, move: bool = False) -> dict:
        display_name = display_name or os.path.basename(src_path)
        h = hashlib.sha1()
        with open(src_path, "rb") as f:
            for chunk in iter(lambda: f.read(1 << 20), b""):
                h.update(chunk)
        cid = h.hexdigest()[:10]
        for c in self.proj["clips"]:
            if c["id"] == cid:
                if move:
                    os.remove(src_path)
                return c
        safe = re.sub(r"[^A-Za-z0-9._-]+", "_", display_name)[:80]
        dest = os.path.join(self.clips_dir, f"{cid}__{safe}")
        if move:
            shutil.move(src_path, dest)
        else:
            shutil.copy2(src_path, dest)
        try:
            meta = probe(dest)
        except FriendlyError:
            os.remove(dest)
            raise
        if meta["duration"] <= 0.2:
            os.remove(dest)
            raise FriendlyError(f"{display_name} has no usable video.")
        clip = {"id": cid, "file": os.path.basename(dest), "name": display_name, "meta": meta,
                "start": 0, "end": 0, "effect": "style", "scare_at": None, "new_night": False}
        self.make_thumb(clip)
        with self.lock:
            self.proj["clips"].append(clip)
            self.save()
        return clip

    def make_thumb(self, clip: dict) -> str:
        out = os.path.join(self.thumbs_dir, clip["id"] + ".jpg")
        if not os.path.exists(out):
            at = min(1.0, clip["meta"]["duration"] / 2)
            args = ["-ss", f"{at:.2f}", "-i", os.path.join(self.clips_dir, clip["file"]), "-frames:v", "1",
                    "-vf", "scale=360:-2", "-q:v", "4", out]
            try:
                subprocess.run(ff_base() + args, capture_output=True, timeout=120)
            except subprocess.TimeoutExpired:
                pass
        return out

    def import_folder(self, folder: str) -> list[dict]:
        folder = os.path.expanduser(folder)
        if not os.path.isdir(folder):
            raise FriendlyError(f"Folder not found: {folder}")
        files = [os.path.join(folder, n) for n in os.listdir(folder)
                 if os.path.splitext(n)[1].lower() in VIDEO_EXTS and not n.startswith(".")]
        files.sort(key=lambda p: os.path.getmtime(p))
        before = {c["id"] for c in self.proj["clips"]}
        added = []
        for p in files:
            try:
                clip = self.add_clip(p)
            except FriendlyError:
                continue
            if clip["id"] not in before:
                added.append(clip)
        # keep chronological order by the camera's own timestamp where known
        with self.lock:
            self.proj["clips"].sort(key=lambda c: (c["meta"].get("created") or "9999", c["name"]))
            self.save()
        return added

    def public_state(self) -> dict:
        d = dict(self.proj)
        d["canvas_resolved"] = list(choose_canvas(self.proj)) if self.proj["clips"] else [1920, 1080]
        plan = plan_nights(self.proj) if self.proj["clips"] else []
        d["plan"] = [{"night": p["night"], "new_night": p["new_night"], "clock": p["clock"].strftime("%m/%d %I:%M %p"),
                      "duration": round(p["duration"], 1)} for p in plan]
        d["total_clip_seconds"] = round(sum(p["duration"] for p in plan), 1)
        d["styles"] = STYLES
        d["transitions"] = TRANSITIONS
        d["downloads"] = os.path.expanduser("~/Downloads")
        d["output_dir"] = self.output_dir
        return d

    def reset(self) -> None:
        stamp = time.strftime("%Y%m%d-%H%M%S")
        archive = os.path.join(self.root, "archive", stamp)
        os.makedirs(archive, exist_ok=True)
        for name in ("clips", "thumbs", "previews", "build", "project.json"):
            p = os.path.join(self.root, name)
            if os.path.exists(p):
                shutil.move(p, os.path.join(archive, name))
        self.__init__(self.root)


# --------------------------------------------------------------------------
# Web UI server
# --------------------------------------------------------------------------

class RenderJob:
    def __init__(self):
        self.lock = threading.Lock()
        self.running = False
        self.percent = 0.0
        self.message = ""
        self.error = ""
        self.output = ""
        self.started = 0.0

    def status(self) -> dict:
        with self.lock:
            return {"running": self.running, "percent": round(self.percent * 100, 1), "message": self.message,
                    "error": self.error, "output": self.output,
                    "elapsed": round(time.time() - self.started) if self.running else 0}

    def start(self, fn):
        with self.lock:
            if self.running:
                raise FriendlyError("A render is already running.")
            self.running, self.percent, self.message, self.error, self.output = True, 0.0, "Starting", "", ""
            self.started = time.time()

        def progress(frac, msg):
            with self.lock:
                self.percent, self.message = frac, msg

        def worker():
            try:
                out = fn(progress)
                with self.lock:
                    self.output, self.percent, self.message = out, 1.0, "Done"
            except Exception as e:  # noqa: BLE001
                tb = traceback.format_exc()
                with self.lock:
                    self.error = str(e) if isinstance(e, (FriendlyError, RenderError)) else tb
            finally:
                with self.lock:
                    self.running = False

        threading.Thread(target=worker, daemon=True).start()


def make_handler(ws: Workspace, job: RenderJob):
    class Handler(BaseHTTPRequestHandler):
        server_version = "GhostCut/1.0"

        def log_message(self, fmt, *args):  # quiet
            pass

        # -- helpers -----------------------------------------------------
        def _json(self, obj, code=200):
            body = json.dumps(obj).encode()
            self.send_response(code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)

        def _body(self) -> bytes:
            n = int(self.headers.get("Content-Length") or 0)
            return self.rfile.read(n) if n else b""

        def _file(self, path: str, ctype: str | None = None):
            if not os.path.isfile(path):
                return self._json({"error": "not found"}, 404)
            size = os.path.getsize(path)
            ctype = ctype or mimetypes.guess_type(path)[0] or "application/octet-stream"
            rng = self.headers.get("Range")
            start, end = 0, size - 1
            if rng and rng.startswith("bytes="):
                a, _, b = rng[6:].partition("-")
                start = int(a or 0)
                end = int(b) if b else size - 1
                end = min(end, size - 1)
                self.send_response(206)
                self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
            else:
                self.send_response(200)
            self.send_header("Accept-Ranges", "bytes")
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(end - start + 1))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            with open(path, "rb") as f:
                f.seek(start)
                left = end - start + 1
                while left > 0:
                    chunk = f.read(min(1 << 20, left))
                    if not chunk:
                        break
                    try:
                        self.wfile.write(chunk)
                    except (BrokenPipeError, ConnectionResetError):
                        return
                    left -= len(chunk)

        def _clip(self, cid: str) -> dict:
            for c in ws.proj["clips"]:
                if c["id"] == cid:
                    return c
            raise FriendlyError("Clip not found (was it deleted?)")

        # -- routes ------------------------------------------------------
        def do_GET(self):
            u = urlsplit(self.path)
            p = unquote(u.path)
            try:
                if p == "/" or p == "/index.html":
                    return self._file(UI_PATH, "text/html; charset=utf-8")
                if p == "/api/state":
                    return self._json(ws.public_state())
                if p == "/api/status":
                    return self._json(job.status())
                if p.startswith("/files/"):
                    rel = os.path.normpath(p[len("/files/"):]).replace("\\", "/")
                    if rel.startswith("..") or os.path.isabs(rel):
                        return self._json({"error": "bad path"}, 400)
                    return self._file(os.path.join(ws.root, rel))
                return self._json({"error": "not found"}, 404)
            except FriendlyError as e:
                return self._json({"error": str(e)}, 400)

        def do_PUT(self):
            u = urlsplit(self.path)
            if u.path != "/api/upload":
                return self._json({"error": "not found"}, 404)
            name = parse_qs(u.query).get("name", ["clip.mov"])[0]
            name = os.path.basename(name) or "clip.mov"
            n = int(self.headers.get("Content-Length") or 0)
            if n <= 0:
                return self._json({"error": "empty upload"}, 400)
            tmp_dir = os.path.join(ws.root, "incoming")
            os.makedirs(tmp_dir, exist_ok=True)
            tmp = os.path.join(tmp_dir, f"{int(time.time() * 1000)}_{re.sub(r'[^A-Za-z0-9._-]+', '_', name)}")
            left = n
            with open(tmp, "wb") as f:
                while left > 0:
                    chunk = self.rfile.read(min(1 << 20, left))
                    if not chunk:
                        break
                    f.write(chunk)
                    left -= len(chunk)
            try:
                clip = ws.add_clip(tmp, name, move=True)
            except FriendlyError as e:
                if os.path.exists(tmp):
                    os.remove(tmp)
                return self._json({"error": str(e)}, 400)
            return self._json({"ok": True, "clip": clip})

        def do_POST(self):
            u = urlsplit(self.path)
            p = u.path
            try:
                data = json.loads(self._body() or b"{}")
            except ValueError:
                return self._json({"error": "bad json"}, 400)
            try:
                if p == "/api/settings":
                    allowed = set(default_project()) - {"clips", "seed"}
                    with ws.lock:
                        for k, v in data.items():
                            if k in allowed:
                                ws.proj[k] = v
                        ws.save()
                    return self._json(ws.public_state())
                if p == "/api/clip/update":
                    clip = self._clip(data.get("id", ""))
                    with ws.lock:
                        for k in ("start", "end", "effect", "scare_at", "new_night", "name"):
                            if k in data:
                                clip[k] = data[k]
                        ws.save()
                    return self._json(ws.public_state())
                if p == "/api/clip/delete":
                    clip = self._clip(data.get("id", ""))
                    with ws.lock:
                        ws.proj["clips"] = [c for c in ws.proj["clips"] if c["id"] != clip["id"]]
                        ws.save()
                    for f in (os.path.join(ws.clips_dir, clip["file"]), os.path.join(ws.thumbs_dir, clip["id"] + ".jpg")):
                        if os.path.exists(f):
                            os.remove(f)
                    return self._json(ws.public_state())
                if p == "/api/clips/order":
                    ids = data.get("ids", [])
                    by_id = {c["id"]: c for c in ws.proj["clips"]}
                    with ws.lock:
                        ws.proj["clips"] = [by_id[i] for i in ids if i in by_id] + \
                                           [c for c in ws.proj["clips"] if c["id"] not in ids]
                        ws.save()
                    return self._json(ws.public_state())
                if p == "/api/import":
                    added = ws.import_folder(data.get("folder") or "~/Downloads")
                    return self._json({"added": len(added), "state": ws.public_state()})
                if p == "/api/render":
                    proj = json.loads(json.dumps(ws.proj))
                    name = re.sub(r"[^A-Za-z0-9 ._-]+", "", proj.get("output_name") or proj["title"] or "ghostcut").strip() or "ghostcut"
                    out = os.path.join(ws.output_dir, f"{name} {time.strftime('%Y-%m-%d %H%M')}.mp4")

                    def work(progress):
                        Renderer(proj, ws.root, progress).run(out)
                        return "/files/output/" + os.path.basename(out)

                    job.start(work)
                    return self._json(job.status())
                if p == "/api/trailer":
                    proj = json.loads(json.dumps(ws.proj))
                    name = re.sub(r"[^A-Za-z0-9 ._-]+", "", proj.get("output_name") or proj["title"] or "ghostcut").strip() or "ghostcut"
                    out = os.path.join(ws.output_dir, f"{name} - Trailer {time.strftime('%Y-%m-%d %H%M')}.mp4")

                    def work(progress):
                        Renderer(proj, ws.root, progress).run_trailer(out)
                        return "/files/output/" + os.path.basename(out)

                    job.start(work)
                    return self._json(job.status())
                if p == "/api/preview":
                    clip = self._clip(data.get("id", ""))
                    proj = json.loads(json.dumps(ws.proj))
                    idx = [c["id"] for c in proj["clips"]].index(clip["id"])
                    plan = plan_nights(proj)[idx]

                    def work(progress):
                        r = Renderer(proj, ws.root, progress, preview_clip=clip["id"])
                        os.makedirs(r.build, exist_ok=True)
                        r.total_work = plan["duration"] + 0.1
                        src = r.render_clip(idx, proj["clips"][idx], plan, preview=True)
                        dest = os.path.join(ws.previews_dir, f"{clip['id']}_{int(time.time())}.mp4")
                        shutil.move(src, dest)
                        return "/files/previews/" + os.path.basename(dest)

                    job.start(work)
                    return self._json(job.status())
                if p == "/api/reset":
                    if job.status()["running"]:
                        raise FriendlyError("Wait for the render to finish first.")
                    ws.reset()
                    return self._json(ws.public_state())
                if p == "/api/open_output":
                    open_folder(ws.output_dir)
                    return self._json({"ok": True})
                return self._json({"error": "not found"}, 404)
            except FriendlyError as e:
                return self._json({"error": str(e)}, 400)
            except Exception:  # noqa: BLE001
                return self._json({"error": traceback.format_exc()}, 500)

    return Handler


def open_folder(path: str) -> None:
    try:
        if sys.platform.startswith("win"):
            os.startfile(path)  # type: ignore[attr-defined]
        elif sys.platform == "darwin":
            subprocess.Popen(["open", path])
        else:
            subprocess.Popen(["xdg-open", path])
    except Exception:  # noqa: BLE001
        pass


def serve(port: int, open_browser: bool = True) -> None:
    ensure_deps()
    ws = Workspace(WORKSPACE)
    job = RenderJob()
    httpd = ThreadingHTTPServer(("127.0.0.1", port), make_handler(ws, job))
    httpd.daemon_threads = True
    url = f"http://localhost:{port}/"
    print(f"\nGhostCut is running at {url}\nKeep this window open. Press Ctrl+C to stop.\n", flush=True)
    if open_browser:
        threading.Timer(0.6, lambda: webbrowser.open(url)).start()
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")


# --------------------------------------------------------------------------
# CLI
# --------------------------------------------------------------------------

def cli_render(args) -> None:
    ensure_deps()
    root = os.path.join(WORKSPACE, "cli")
    shutil.rmtree(os.path.join(root, "clips"), ignore_errors=True)
    shutil.rmtree(os.path.join(root, "build"), ignore_errors=True)
    if os.path.exists(os.path.join(root, "project.json")):
        os.remove(os.path.join(root, "project.json"))
    ws = Workspace(root)
    for p in args.inputs:
        if os.path.isdir(p):
            ws.import_folder(p)
        elif os.path.isfile(p):
            ws.add_clip(p)
        else:
            raise FriendlyError(f"Not found: {p}")
    proj = ws.proj
    if args.title:
        proj["title"] = args.title
    if args.family:
        proj["family"] = args.family
    if args.style:
        proj["style"] = args.style
    if args.transition:
        proj["transition"] = args.transition
    if args.credits:
        proj["credits"] = "\n".join(args.credits)
    if args.scare:
        idx, at = args.scare.split(":")
        proj["clips"][int(idx) - 1]["scare_at"] = float(at)
    proj["nights_mode"] = args.nights
    proj["drone"] = args.drone
    proj["timestamps"] = not args.no_clock
    proj["title_card"] = not args.no_title
    ws.save()
    out = os.path.abspath(args.out or os.path.join(ws.output_dir, f"{proj['title']}.mp4"))
    last = [-1]

    def progress(frac, msg):
        pct = int(frac * 100)
        if pct != last[0]:
            last[0] = pct
            print(f"\r{pct:3d}%  {msg:<60}", end="", flush=True)

    Renderer(proj, ws.root, progress).run(out)
    print(f"\nWrote {out}")


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="GhostCut — found-footage horror splicer")
    sub = ap.add_subparsers(dest="cmd")
    s = sub.add_parser("serve", help="open the web UI (default)")
    s.add_argument("--port", type=int, default=DEFAULT_PORT)
    s.add_argument("--no-browser", action="store_true")
    r = sub.add_parser("render", help="render straight from the command line")
    r.add_argument("inputs", nargs="+", help="clip files and/or folders of clips")
    r.add_argument("--title")
    r.add_argument("--family", help='e.g. "the Grigson" -> "recovered from the Grigson residence"')
    r.add_argument("--style", choices=list(STYLES))
    r.add_argument("--transition", choices=list(TRANSITIONS))
    r.add_argument("--nights", choices=["per_clip", "single", "manual"], default="per_clip")
    r.add_argument("--credits", nargs="*", help='lines, e.g. "Directed by Scarlet"')
    r.add_argument("--scare", help='CLIP:SECONDS, e.g. 3:4.5 = jump scare 4.5s into clip 3')
    r.add_argument("--drone", type=float, default=0.55)
    r.add_argument("--no-clock", action="store_true")
    r.add_argument("--no-title", action="store_true")
    r.add_argument("--out")
    a = ap.parse_args(argv)
    try:
        if a.cmd == "render":
            cli_render(a)
        else:
            serve(getattr(a, "port", DEFAULT_PORT), not getattr(a, "no_browser", False))
    except FriendlyError as e:
        print(f"\n{e}", file=sys.stderr)
        return 1
    except RenderError as e:
        print(f"\nRender failed:\n{e}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
