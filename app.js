// GhostCut Web — the browser edition. Same pipeline as ghostcut.py, but the
// video work happens in your browser with ffmpeg.wasm; nothing is uploaded.
import { FFmpeg } from "./vendor/ffmpeg/index.js";
import { toBlobURL } from "./vendor/util/index.js";

const FPS = 30;
const AR = 48000;
const CORE_ST_CDN = [
  "https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.10/dist/esm",
  "https://unpkg.com/@ffmpeg/core@0.12.10/dist/esm",
];

export const STYLES = {
  night: { name: "Night Vision", clock: true, scanlines: false,
    blurb: "Green-tinted infrared camcorder. The classic 'something is in the room' look." },
  seccam: { name: "Security Cam", clock: true, scanlines: true,
    blurb: "Cold, desaturated, choppy 15fps fixed-camera footage with scanlines." },
  vhs: { name: "VHS Found Footage", clock: true, scanlines: true,
    blurb: "Warm, smeary tape with colour bleed, jitter, and a PLAY overlay." },
  cinematic: { name: "Cinematic Dark", clock: false, scanlines: false,
    blurb: "Moody teal-shadow grade, widescreen bars, light grain. No camcorder text." },
  clean: { name: "Clean", clock: false, scanlines: false,
    blurb: "No look applied. Just the splice, titles, transitions and sound." },
};
export const TRANSITIONS = { static: "TV static burst", black: "Fade through black", cut: "Hard cut" };

export function defaultProject() {
  return {
    title: "PARANORMAL ACTIVITY", subtitle: "", family: "the Grigson", intro_text: "",
    outro_text: "The whereabouts of the family remain unknown.", credits: "",
    style: "night", transition: "static", canvas: "auto", title_card: true, night_cards: true,
    nights_mode: "per_clip", timestamps: true, drone: 0.55, end_card: true, start_date: "",
    output_name: "", seed: Math.floor(Math.random() * 999999) + 1,
    trailer_length: "60", trailer_taglines: "",
  };
}

// --------------------------------------------------------------------------
// Engine (ffmpeg.wasm) with a log buffer and time-based progress
// --------------------------------------------------------------------------

export class Engine {
  constructor() {
    this.ff = null;
    this.log = [];
    this.onProgressTime = null;
    this.filters = null;
    this.mode = "";
    this.queue = Promise.resolve();
    // Thread budget. The wasm core pre-spawns a pool of 32 pthreads and deadlocks if ffmpeg asks for more,
    // and some combinations deadlock well below that, so these are deliberately conservative.
    this.threads = { dec: 2, filt: 1, enc: 4 };
  }

  static STALL_MS = 60000;

  async load(status = () => {}) {
    if (this.ff) return;
    const ff = new FFmpeg();
    ff.on("log", ({ message }) => {
      this.log.push(message);
      if (this.log.length > 3000) this.log.splice(0, 1000);
      if (!this.onProgressTime) return;
      const u = /^out_time_(?:us|ms)=(\d+)/.exec(message);
      if (u) { this.onProgressTime(+u[1] / 1e6); return; }
      const m = /time=(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(message);
      if (m) this.onProgressTime(+m[1] * 3600 + +m[2] * 60 + +m[3]);
    });
    const isolated = typeof SharedArrayBuffer !== "undefined" && self.crossOriginIsolated;
    if (isolated) {
      status("Loading the video engine (multi-core)…");
      const base = new URL("./core/", location.href).href;
      await ff.load({ coreURL: base + "ffmpeg-core.js", wasmURL: base + "ffmpeg-core.wasm", workerURL: base + "ffmpeg-core.worker.js" });
      this.mode = `multi-core (${navigator.hardwareConcurrency || "?"} threads)`;
    } else {
      status("Loading the video engine (single-core)…");
      let lastErr = null;
      for (const base of CORE_ST_CDN) {
        try {
          await ff.load({ coreURL: await toBlobURL(`${base}/ffmpeg-core.js`, "text/javascript"),
                          wasmURL: await toBlobURL(`${base}/ffmpeg-core.wasm`, "application/wasm") });
          lastErr = null; break;
        } catch (e) { lastErr = e; }
      }
      if (lastErr) throw lastErr;
      this.mode = "single-core";
    }
    this.ff = ff;
    // what does this build have?
    this.log = [];
    await ff.exec(["-hide_banner", "-loglevel", "info", "-filters"]);
    this.filters = new Set(this.log.map(l => (/^\s*[TSC.]{3}\s+(\S+)/.exec(l) || [])[1]).filter(Boolean));
    this.log = [];
  }

  has(f) { return !this.filters || this.filters.has(f); }

  terminate() { try { this.ff?.terminate(); } catch (_) {} this.ff = null; this.filters = null; }

  // Serialise everything: ffmpeg.wasm runs one command at a time.
  run(fn) { const p = this.queue.then(fn, fn); this.queue = p.catch(() => {}); return p; }

  async exec(args, expected = 0, onFrac = null, label = "") {
    this.log = [];
    let lastTick = Date.now(), stalled = false;
    this.onProgressTime = t => { lastTick = Date.now(); if (expected > 0 && onFrac) onFrac(Math.max(0, Math.min(1, t / expected))); };
    // Watchdog: a deadlocked wasm run never errors, it just sits there. Kill it and let the caller retry.
    const timer = setInterval(() => {
      if (Date.now() - lastTick > Engine.STALL_MS || this.forceStallOnce) {
        this.forceStallOnce = false; stalled = true; clearInterval(timer);
        try { this.ff?.terminate(); } catch (_) {}
      }
    }, 1000);
    // -progress writes newline-terminated key=value lines, which is what reaches the log pipe (stats lines end in \r and don't)
    const t = this.threads;
    const out = args[args.length - 1];
    let rc;
    try {
      rc = await this.ff.exec(["-hide_banner", "-y", "-nostdin", "-loglevel", "warning", "-nostats", "-progress", "pipe:1",
        "-filter_threads", String(t.filt), "-filter_complex_threads", String(t.filt), "-threads", String(t.dec),
        ...args.slice(0, -1), "-threads", String(t.enc), out]);
    } catch (e) {
      if (stalled) {
        this.ff = null; this.filters = null;
        throw Object.assign(new Error(`The video engine stalled for ${Engine.STALL_MS / 1000}s on ${label || "a step"}.`), { stalled: true });
      }
      throw e;
    } finally { clearInterval(timer); this.onProgressTime = null; }
    if (rc !== 0) {
      const tail = this.log.filter(l => !/^frame=|^size=/.test(l.trim())).slice(-30).join("\n");
      throw new Error(`ffmpeg failed (exit ${rc}) on ${label || "a step"}.\n$ ffmpeg ${args.join(" ")}\n\n${tail}`);
    }
    if (onFrac) onFrac(1);
  }

  async mountFiles(files, point) {
    try { await this.ff.createDir(point); } catch (_) {}
    await this.ff.mount("WORKERFS", { files }, point);
  }
  async unmount(point) {
    if (!this.ff) return;
    try { await this.ff.unmount(point); } catch (_) {}
    try { await this.ff.deleteDir(point); } catch (_) {}
  }
  async take(path) {  // read a file out of MEMFS as a Blob and delete it
    const data = await this.ff.readFile(path);
    const blob = new Blob([data], { type: path.endsWith(".png") ? "image/png" : path.endsWith(".jpg") ? "image/jpeg" : "video/mp4" });
    try { await this.ff.deleteFile(path); } catch (_) {}
    return blob;
  }
  async rmDir(dir) {
    if (!this.ff) return;
    try { for (const e of await this.ff.listDir(dir)) if (!e.isDir) await this.ff.deleteFile(`${dir}/${e.name}`); await this.ff.deleteDir(dir); } catch (_) {}
  }

  // `ffmpeg -i file` → duration, size, rotation, audio, HDR, creation time
  async probe(file) {
    return this.run(async () => {
      const safe = safeName(file.name);
      const f = new File([file], safe, { type: file.type });
      await this.mountFiles([f], "/probe");
      this.log = [];
      // the log level persists between runs inside the wasm instance, so ask for info explicitly
      await this.ff.exec(["-hide_banner", "-loglevel", "info", "-i", `/probe/${safe}`]);
      const err = this.log.join("\n");
      await this.unmount("/probe");
      const info = { duration: 0, width: 0, height: 0, has_audio: /Audio:/.test(err), hdr: null, fps: 30, created: null };
      let m = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(err);
      if (m) info.duration = +m[1] * 3600 + +m[2] * 60 + +m[3];
      const vm = /Stream #\d+:\d+.*?: Video: ([^\n]*)/.exec(err);
      if (!vm) throw new Error(`No video stream found in ${file.name}`);
      const vline = vm[1];
      m = /\b(\d{2,5})x(\d{2,5})\b/.exec(vline);
      if (m) { info.width = +m[1]; info.height = +m[2]; }
      m = /(\d+(?:\.\d+)?) fps/.exec(vline);
      if (m) info.fps = +m[1];
      let rot = 0;
      m = /rotation of (-?\d+(?:\.\d+)?) degrees/.exec(err) || /rotate\s*:\s*(-?\d+)/.exec(err);
      if (m) rot = +m[1];
      if (Math.abs(rot) % 180 === 90) [info.width, info.height] = [info.height, info.width];
      if (vline.includes("arib-std-b67")) info.hdr = "arib-std-b67";
      else if (vline.includes("smpte2084")) info.hdr = "smpte2084";
      else if (vline.includes("yuv420p10") && vline.includes("bt2020")) info.hdr = "arib-std-b67";
      m = /creation_time\s*:\s*(\S+)/.exec(err);
      if (m) info.created = m[1];
      info.portrait = info.height > info.width;
      return info;
    });
  }

  // Loudness per half-second of a clip (audio only, so it's quick): [{t, db}], t relative to `start`.
  // Used to find the screams and bangs for the trailer.
  analyze(file, start, dur) { return this.run(() => this._analyze(file, start, dur)); }
  async _analyze(file, start, dur) {   // unqueued: for use from inside a running job
    {
      const safe = safeName(file.name);
      await this.mountFiles([new File([file], safe)], "/probe");
      this.log = [];
      try {
        await this.ff.exec(["-hide_banner", "-loglevel", "info", "-nostats", "-ss", f3(start), "-t", f3(dur), "-i", `/probe/${safe}`, "-vn", "-threads", "1",
          "-af", `aresample=8000,aformat=channel_layouts=mono,asetnsamples=n=4000,astats=metadata=1:reset=1,ametadata=mode=print:key=lavfi.astats.Overall.RMS_level`,
          "-f", "null", "-"]);
      } finally { await this.unmount("/probe"); }
      const out = []; let t = null;
      for (const line of this.log) {
        let m = /pts_time:([\d.]+)/.exec(line);
        if (m) { t = +m[1]; continue; }
        m = /RMS_level=(-?[\d.]+|-inf)/.exec(line);
        if (m && t != null) { out.push({ t, db: m[1] === "-inf" ? -100 : Math.max(-100, +m[1]) }); t = null; }
      }
      this.log = [];
      return out;
    }
  }

  async thumbnail(file, at) {
    return this.run(async () => {
      const safe = safeName(file.name);
      await this.mountFiles([new File([file], safe)], "/probe");
      try {
        await this.exec(["-ss", at.toFixed(2), "-i", `/probe/${safe}`, "-frames:v", "1", "-vf", "scale=320:-2", "-q:v", "4", "thumb.jpg"], 0, null, "thumbnail");
        return await this.take("thumb.jpg");
      } finally { await this.unmount("/probe"); }
    });
  }
}

export function safeName(name) {
  return name.replace(/[^A-Za-z0-9._-]+/g, "_").slice(-80) || "clip.mov";
}

// --------------------------------------------------------------------------
// Canvas text rendering (cards, typewriter frames, camcorder clock overlays)
// --------------------------------------------------------------------------

const FONT = {
  mono: '"Courier New", "Lucida Console", Menlo, Monaco, Consolas, "DejaVu Sans Mono", monospace',
  serif: '"Times New Roman", Times, Georgia, "DejaVu Serif", serif',
  sans: 'Arial, Helvetica, "Segoe UI", sans-serif',
};

function canvasToPng(c) {
  return new Promise((res, rej) => c.toBlob(b => b ? b.arrayBuffer().then(ab => res(new Uint8Array(ab))) : rej(new Error("PNG encode failed")), "image/png"));
}
function textWidth(ctx, text, spacing = 0) {
  if (!text) return 0;
  let w = 0;
  for (const ch of text) w += ctx.measureText(ch).width;
  return w + spacing * (Array.from(text).length - 1);
}
function drawSpaced(ctx, x, y, text, fill, spacing = 0, shadow = null) {
  for (const ch of text) {
    if (shadow) { ctx.fillStyle = shadow.color; ctx.fillText(ch, x + shadow.dx, y + shadow.dy); }
    ctx.fillStyle = fill;
    ctx.fillText(ch, x, y);
    x += ctx.measureText(ch).width + spacing;
  }
}
function wrapText(ctx, text, maxW, spacing = 0) {
  const lines = [];
  for (const para of text.split("\n")) {
    const words = para.split(/\s+/).filter(Boolean);
    if (!words.length) { lines.push(""); continue; }
    let cur = words[0];
    for (const w of words.slice(1)) {
      if (textWidth(ctx, cur + " " + w, spacing) <= maxW) cur += " " + w; else { lines.push(cur); cur = w; }
    }
    lines.push(cur);
  }
  return lines;
}

export async function makeCard(W, H, { title = "", subtitle = "", body = "", titleKind = "serif", titleScale = 0.075, cursor = false } = {}) {
  const c = document.createElement("canvas"); c.width = W; c.height = H;
  const ctx = c.getContext("2d");
  ctx.fillStyle = "#000"; ctx.fillRect(0, 0, W, H);
  ctx.textBaseline = "top";
  const S = H / 1080;
  const white = "rgb(235,235,235)", grey = "rgb(160,160,160)";
  const blocks = []; // {font, size, text, spacing, fill, gap, body}
  if (title) {
    const size = Math.round(H * titleScale); ctx.font = `${size}px ${FONT[titleKind]}`;
    const sp = size * 0.18;
    for (const ln of wrapText(ctx, title.toUpperCase(), W * 0.86, sp)) blocks.push({ font: ctx.font, size, text: ln, spacing: sp, fill: white, gap: 30 * S, body: false });
  }
  if (subtitle) {
    const size = Math.round(34 * S); ctx.font = `${size}px ${FONT.mono}`;
    blocks.push({ font: ctx.font, size, text: subtitle, spacing: size * 0.08, fill: grey, gap: 10 * S, body: false });
  }
  if (body) {
    const size = Math.round(40 * S); ctx.font = `${size}px ${FONT.mono}`;
    for (const ln of wrapText(ctx, body, W * 0.72)) blocks.push({ font: ctx.font, size, text: ln, spacing: 0, fill: white, gap: 12 * S, body: true });
  }
  const total = blocks.reduce((a, b) => a + b.size * 1.25 + b.gap, 0);
  let y = (H - total) / 2, lastBody = null;
  for (const b of blocks) {
    ctx.font = b.font;
    const w = textWidth(ctx, b.text, b.spacing), x = (W - w) / 2;
    drawSpaced(ctx, x, y, b.text, b.fill, b.spacing);
    if (b.body) lastBody = { x: x + w, y, size: b.size };
    y += b.size * 1.25 + b.gap;
  }
  if (cursor && lastBody) {
    const { x, y: y0, size } = lastBody;
    ctx.fillStyle = white; ctx.fillRect(x + size * 0.15, y0 + size * 0.12, size * 0.55, size * 0.93);
  }
  return canvasToPng(c);
}

export async function makeTypewriterFrames(W, H, text, hold = 34) {
  const frames = [];
  const chars = Array.from(text);
  for (let i = 1; i <= chars.length; i++) frames.push(await makeCard(W, H, { body: chars.slice(0, i).join(""), cursor: true }));
  for (let k = 0; k < hold; k++) frames.push(await makeCard(W, H, { body: text, cursor: Math.floor(k / 7) % 2 === 0 }));
  return frames;
}

export async function makeScanlines(W, H, strength = 46, period = 3) {
  const c = document.createElement("canvas"); c.width = W; c.height = H;
  const ctx = c.getContext("2d");
  ctx.fillStyle = `rgba(0,0,0,${strength / 255})`;
  for (let y = 0; y < H; y += period) ctx.fillRect(0, y, W, 1);
  return canvasToPng(c);
}

const pad2 = n => String(n).padStart(2, "0");
function fmtTime12(d, secs = true) {
  let h = d.getHours(); const ap = h >= 12 ? "PM" : "AM"; h = h % 12 || 12;
  return `${pad2(h)}:${pad2(d.getMinutes())}${secs ? ":" + pad2(d.getSeconds()) : ""} ${ap}`;
}
const fmtDate = d => `${pad2(d.getMonth() + 1)}/${pad2(d.getDate())}/${d.getFullYear()}`;
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

export async function makeTimestampFrames(W, H, style, night, start, seconds) {
  const frames = [];
  const S = H / 1080, margin = Math.round(44 * S);
  const small = `${Math.round(34 * S)}px ${FONT.mono}`, big = `${Math.round(44 * S)}px ${FONT.mono}`;
  const bigSize = Math.round(44 * S), smallSize = Math.round(34 * S);
  const shadow = { dx: Math.max(2, 2 * S), dy: Math.max(2, 2 * S), color: "rgba(0,0,0,0.86)" };
  const white = "rgba(240,240,240,0.92)";
  for (let i = 0; i < seconds; i++) {
    const t = new Date(start.getTime() + i * 1000);
    const c = document.createElement("canvas"); c.width = W; c.height = H;
    const ctx = c.getContext("2d"); ctx.textBaseline = "top";
    if (style === "night") {
      if (i % 2 === 0) { ctx.fillStyle = "rgba(230,40,40,0.92)"; ctx.beginPath(); ctx.arc(margin + 14 * S, margin + 10 * S + 14 * S, 14 * S, 0, Math.PI * 2); ctx.fill(); }
      ctx.font = big; drawSpaced(ctx, margin + 44 * S, margin, "REC", white, 2, shadow);
      const l1 = `NIGHT ${night}`, l2 = `${fmtTime12(t)}   ${fmtDate(t)}`;
      ctx.font = big; const w1 = textWidth(ctx, l1, 2);
      drawSpaced(ctx, W - margin - w1, H - margin - bigSize * 1.3 - smallSize * 1.3, l1, white, 2, shadow);
      ctx.font = small; const w2 = textWidth(ctx, l2, 1);
      drawSpaced(ctx, W - margin - w2, H - margin - smallSize * 1.3, l2, white, 1, shadow);
    } else if (style === "vhs") {
      ctx.fillStyle = white; ctx.beginPath();
      ctx.moveTo(margin, margin + 6 * S); ctx.lineTo(margin, margin + 40 * S); ctx.lineTo(margin + 30 * S, margin + 23 * S); ctx.closePath(); ctx.fill();
      ctx.font = big; drawSpaced(ctx, margin + 46 * S, margin, "PLAY", white, 2, shadow);
      drawSpaced(ctx, W - margin - textWidth(ctx, "SP", 2), margin, "SP", white, 2, shadow);
      const mon = MONTHS[t.getMonth()].slice(0, 3).toUpperCase();
      const l1 = `${mon} ${pad2(t.getDate())} ${t.getFullYear()}   ${fmtTime12(t, false).replace(/^0/, "")}`;
      drawSpaced(ctx, margin, H - margin - bigSize * 1.3, l1, white, 2, shadow);
    } else {
      ctx.font = big; drawSpaced(ctx, margin, margin, "CAM 01", white, 2, shadow);
      const l1 = `NIGHT ${night}`, l2 = `${fmtDate(t)}  ${fmtTime12(t)}`;
      drawSpaced(ctx, margin, H - margin - bigSize * 1.3, l1, white, 2, shadow);
      ctx.font = small; drawSpaced(ctx, W - margin - textWidth(ctx, l2, 1), H - margin - smallSize * 1.3, l2, white, 1, shadow);
    }
    frames.push(await canvasToPng(c));
  }
  return frames;
}

// --------------------------------------------------------------------------
// Filter chains (identical to ghostcut.py, with fallbacks for missing filters)
// --------------------------------------------------------------------------

// These stay in yuv420p wherever possible: in WebAssembly every RGB round-trip (curves, colorbalance)
// roughly doubles the per-frame cost, so tints are done with chroma LUTs instead.
function styleVideoChain(eng, style, W, H) {
  const blur = s => eng.has("gblur") ? `gblur=sigma=${s}` : `boxblur=${Math.max(1, Math.round(s))}:1`;
  if (style === "night") {
    // grey it out, lift the shadows, then paint the chroma green
    return "eq=brightness=0.10:contrast=1.22:gamma=1.55,lutyuv=u=96:v=106,noise=alls=26:allf=t+u,unsharp=5:5:0.9,vignette=angle=PI/3.8";
  }
  if (style === "seccam") {
    return "fps=15,fps=30,hue=s=0.25,eq=contrast=1.18:brightness=-0.02:gamma=1.15,lutyuv=u='clip(val+9,0,255)':v='clip(val-6,0,255)'," +
      "noise=alls=14:allf=t," + blur(0.5) + ",vignette=angle=PI/4.2";
  }
  if (style === "vhs") {
    const jitter = `pad=iw+16:ih+16:8:8:color=black,crop=${W}:${H}:'8+4*sin(t*23)*gt(random(0),0.82)':'8+2*sin(t*17)'`;
    return "eq=saturation=1.2:contrast=0.94:brightness=0.02,rgbashift=rh=3:bh=-3,format=yuv420p," + blur(0.7) +
      ",unsharp=3:3:0.6,noise=alls=22:allf=t+u," + jitter + ",vignette=angle=PI/4.6";
  }
  if (style === "cinematic") {
    const bar = Math.round(H * 0.11 / 2) * 2;
    return "eq=contrast=1.14:saturation=0.78:brightness=-0.05:gamma=0.96,lutyuv=u='clip(val+6,0,255)':v='clip(val-5,0,255)'," +
      "vignette=angle=PI/4,noise=alls=6:allf=t," +
      `drawbox=x=0:y=0:w=iw:h=${bar}:c=black:t=fill,drawbox=x=0:y=ih-${bar}:w=iw:h=${bar}:c=black:t=fill`;
  }
  return "null";
}
function styleAudioChain(style) {
  if (style === "night" || style === "seccam") return "highpass=f=60,lowpass=f=9000,acompressor=threshold=-20dB:ratio=3:attack=20:release=250:makeup=5dB";
  if (style === "vhs") return "highpass=f=100,lowpass=f=6500,acompressor=threshold=-20dB:ratio=2.5:makeup=4dB";
  if (style === "cinematic") return "acompressor=threshold=-22dB:ratio=2.5:makeup=3dB";
  return "anull";
}
function hdrChain(eng, tf) {
  if (!(eng.has("zscale") && eng.has("tonemap"))) return "eq=saturation=1.35:contrast=1.15";
  return `zscale=tin=${tf}:min=bt2020nc:pin=bt2020:t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv,format=yuv420p`;
}
function fitChain(eng, sw, sh, W, H) {
  if (sw && sh && Math.abs(sw / sh - W / H) < 0.02) return `scale=${W}:${H}:flags=lanczos,setsar=1[base]`;
  // blur the background at 1/8 size and scale back up: same look, a fraction of the work
  const w8 = Math.round(W / 16) * 2, h8 = Math.round(H / 16) * 2;
  const blur = `scale=${w8}:${h8},${eng.has("gblur") ? "gblur=sigma=4" : "boxblur=3:2"},scale=${W}:${H}:flags=bilinear`;
  return `split[bg0][fg0];[bg0]scale=${W}:${H}:force_original_aspect_ratio=increase:flags=bicubic,crop=${W}:${H},${blur},eq=brightness=-0.28[bg];` +
    `[fg0]scale=${W}:${H}:force_original_aspect_ratio=decrease:force_divisible_by=2:flags=lanczos[fg];[bg][fg]overlay=(W-w)/2:(H-h)/2,setsar=1[base]`;
}
const f3 = x => x.toFixed(3);
function jumpScareVideo(T, W, H) {
  const z = `(1+0.85*min(1,max(0,(t-${f3(T)})/0.32))*between(t,${f3(T)},${f3(T + 1.15)}))`;
  return `scale=w='trunc(iw*${z}/2)*2':h='trunc(ih*${z}/2)*2':eval=frame,` +
    `crop=${W}:${H}:x='(iw-${W})/2+0.03*iw*sin(t*97)*between(t,${f3(T + 0.05)},${f3(T + 1.0)})':y='(ih-${H})/2+0.03*ih*sin(t*83)*between(t,${f3(T + 0.05)},${f3(T + 1.0)})',` +
    `negate=enable='between(t,${f3(T)},${f3(T + 0.06)})+between(t,${f3(T + 0.13)},${f3(T + 0.17)})',` +
    `eq=brightness=0.45:enable='between(t,${f3(T + 0.06)},${f3(T + 0.10)})',noise=alls=70:allf=t+u:enable='between(t,${f3(T)},${f3(T + 0.75)})'`;
}
function jumpScareAudioSource(T, label) {
  const sting = "0.9*sin(2*PI*52*t)*exp(-2.2*t)+0.45*sin(2*PI*(650+2400*t)*t)*exp(-5*t)+0.35*(random(0)-0.5)*exp(-9*t)";
  return `aevalsrc=exprs='${sting}':s=${AR}:d=3,aformat=channel_layouts=stereo,adelay=${Math.round(T * 1000)}:all=1${label}`;
}

// --------------------------------------------------------------------------
// Project helpers
// --------------------------------------------------------------------------

export function introTextFor(p) {
  if ((p.intro_text || "").trim()) return p.intro_text.trim();
  return `The following footage was recovered from ${(p.family || "the").trim()} residence. It has not been altered.`;
}
export function clipSpan(clip) {
  const dur = clip.meta.duration;
  let start = Math.max(0, +clip.start || 0), end = +clip.end || 0;
  if (end <= 0 || end > dur) end = dur;
  if (end - start < 0.4) { start = 0; end = dur; }
  return [start, end];
}
export function chooseCanvas(p, clips) {
  if (p.canvas === "portrait") return [1080, 1920];
  if (p.canvas === "landscape") return [1920, 1080];
  const portrait = clips.filter(c => c.meta.portrait).length;
  return portrait > clips.length / 2 ? [1080, 1920] : [1920, 1080];
}
function mulberry(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
export function planNights(p, clips) {
  const mode = p.nights_mode || "per_clip";
  let d0 = /^\d{4}-\d{2}-\d{2}$/.test(p.start_date || "") ? new Date(p.start_date + "T00:00:00") : null;
  if (!d0 || isNaN(d0)) { d0 = new Date(); d0.setHours(0, 0, 0, 0); d0.setDate(d0.getDate() - 21); }
  const rnd = mulberry(+p.seed || 1);
  const rint = (a, b) => a + Math.floor(rnd() * (b - a + 1));
  const plan = []; let night = 0, clock = null;
  clips.forEach((clip, i) => {
    const nn = i === 0 || mode === "per_clip" || (mode === "manual" && clip.new_night);
    if (nn) { night++; clock = new Date(d0.getTime() + (night - 1) * 86400000 + rint(35, 235) * 60000); }
    else clock = new Date(clock.getTime() + rint(3, 40) * 60000);
    const [start, end] = clipSpan(clip);
    plan.push({ night, new_night: nn, clock: new Date(clock), start, end, duration: end - start });
    clock = new Date(clock.getTime() + (end - start) * 1000);
  });
  return plan;
}

// --------------------------------------------------------------------------
// Renderer
// --------------------------------------------------------------------------

// A sub-bass hit with a little click, 1.4 s. Used on trailer cuts and cards.
const BOOM = `aevalsrc=exprs='0.9*sin(2*PI*48*t)*exp(-3.5*t)+0.4*sin(2*PI*95*t)*exp(-6*t)+0.25*(random(0)-0.5)*exp(-14*t)':s=${AR}:d=1.4,aformat=channel_layouts=stereo`;

const ENC = ["-c:v", "libx264", "-preset", "superfast", "-crf", "22", "-maxrate", "10M", "-bufsize", "20M", "-pix_fmt", "yuv420p",
  "-r", String(FPS), "-g", String(FPS * 2), "-profile:v", "high", "-level", "4.1", "-c:a", "aac", "-b:a", "160k", "-ar", String(AR), "-ac", "2"];

// Long clips are rendered in pieces this long, so a stall or a closed tab loses minutes, not the clip.
export const PART_SECONDS = 60;

export function clipParts(duration) {
  const n = Math.max(1, Math.round(duration / PART_SECONDS));
  const len = duration / n;
  return Array.from({ length: n }, (_, i) => ({ i, start: i * len, dur: i === n - 1 ? duration - i * len : len, first: i === 0, last: i === n - 1 }));
}

export class Renderer {
  constructor(eng, proj, clips, progress = () => {}, { resume = null, onSegment = null, onStall = null } = {}) {
    this.eng = eng; this.p = proj; this.clips = clips; this.progress = progress;
    [this.W, this.H] = chooseCanvas(proj, clips);
    this.segments = []; // {name, blob, duration}
    this.totalWork = 1; this.doneWork = 0;
    this.resume = resume;        // Map(name -> {blob, duration}) of segments finished before a restart
    this.onSegment = onSegment;  // called with each finished segment so the page can persist it
    this.onStall = onStall;      // called when the engine deadlocks; expected to persist state and reload the page
  }
  job(weight, msg) { return frac => this.progress(Math.min(0.999, (this.doneWork + weight * frac) / this.totalWork), msg); }
  finish(w) { this.doneWork += w; }

  // One segment: reuse it if a previous attempt already finished it, otherwise render it and hand it to onSegment.
  async seg(name, weight, fn) {
    const cached = this.resume?.get(name + ".mp4");
    if (cached) { this.segments.push({ name: name + ".mp4", blob: cached.blob, duration: cached.duration }); this.finish(weight); return; }
    try { await fn(); }
    catch (e) {
      if (e.stalled && this.onStall) { await this.onStall(e); }
      throw e;
    }
    const s = this.segments[this.segments.length - 1];
    if (s && this.onSegment) await this.onSegment(s);
  }

  async writePngs(dir, prefix, frames) {
    try { await this.eng.ff.createDir(dir); } catch (_) {}
    for (let i = 0; i < frames.length; i++) await this.eng.ff.writeFile(`${dir}/${prefix}${String(i).padStart(4, "0")}.png`, frames[i]);
  }
  async push(name, dur) { this.segments.push({ name: name + ".mp4", blob: await this.eng.take(name + ".mp4"), duration: dur }); }

  // slam: no fade-in, a two-frame white flash and a slow push-in instead (trailer cards). boom: a sub hit on entry.
  async renderCard(name, png, duration, fadeIn = 0.8, fadeOut = 0.7, label = "Title card", { slam = false, boom = false } = {}) {
    await this.eng.ff.writeFile(name + ".png", png);
    const W = this.W, H = this.H;
    let vf = slam
      ? `scale=w='trunc(iw*(1+0.05*t/${f3(duration)})/2)*2':h='trunc(ih*(1+0.05*t/${f3(duration)})/2)*2':eval=frame,crop=${W}:${H},eq=brightness=0.7:enable='lt(t,0.07)',`
      : `fade=t=in:st=0:d=${fadeIn},`;
    vf += `fade=t=out:st=${f3(duration - fadeOut)}:d=${fadeOut},noise=alls=7:allf=t,eq=brightness='0.012*sin(t*31)':eval=frame,format=yuv420p`;
    const audio = boom ? `${BOOM},apad` : `anullsrc=r=${AR}:cl=stereo`;
    const w = duration * 0.25;
    await this.eng.exec(["-loop", "1", "-framerate", String(FPS), "-threads", "1", "-i", name + ".png", "-f", "lavfi", "-threads", "1", "-i", audio,
      "-t", f3(duration), "-vf", vf, ...ENC, name + ".mp4"], duration, this.job(w, label), label);
    await this.eng.ff.deleteFile(name + ".png");
    this.finish(w); await this.push(name, duration);
  }

  async renderTypewriter(name, text) {
    this.progress(this.doneWork / this.totalWork, "Drawing the opening text…");
    const frames = await makeTypewriterFrames(this.W, this.H, text);
    await this.writePngs("/tw", "f_", frames);
    const typeFps = 14, typing = Array.from(text).length / typeFps, duration = frames.length / typeFps + 0.6;
    const clicks = `aevalsrc=exprs='0.35*(random(0)-0.5)*lt(mod(t,1/${typeFps}),0.011)*lt(t,${f3(typing)})':s=${AR}:d=${f3(duration)},aformat=channel_layouts=stereo,lowpass=f=5000`;
    const vf = `fps=${FPS},tpad=stop_mode=clone:stop_duration=1,trim=duration=${f3(duration)},fade=t=out:st=${f3(duration - 0.5)}:d=0.5,noise=alls=6:allf=t,format=yuv420p`;
    const w = duration * 0.25;
    await this.eng.exec(["-framerate", String(typeFps), "-threads", "1", "-i", "/tw/f_%04d.png", "-f", "lavfi", "-i", clicks, "-t", f3(duration), "-vf", vf, ...ENC, name + ".mp4"],
      duration, this.job(w, "Opening text"), "opening text");
    await this.eng.rmDir("/tw");
    this.finish(w); await this.push(name, duration);
  }

  async renderBlack(name, duration) {
    await this.eng.exec(["-f", "lavfi", "-i", `color=c=black:s=${this.W}x${this.H}:r=${FPS}:d=${f3(duration)}`, "-f", "lavfi", "-threads", "1", "-i", `anullsrc=r=${AR}:cl=stereo`,
      "-t", f3(duration), "-vf", "format=yuv420p", "-shortest", ...ENC, name + ".mp4"], 0, null, "black");
    await this.push(name, duration);
  }

  async renderStatic(name, duration = 0.2) {
    // The noise is drawn in the main -vf graph, not inside the lavfi source: a lavfi input runs its own
    // filter graph with one thread per CPU core, ignoring the caps, which deadlocks the wasm engine on big machines.
    await this.eng.exec(["-f", "lavfi", "-i", `color=c=black:s=${this.W}x${this.H}:r=${FPS}:d=${f3(duration)}`,
      "-f", "lavfi", "-threads", "1", "-i", `anoisesrc=color=white:amplitude=0.55:r=${AR}:d=${f3(duration)}`,
      "-t", f3(duration), "-vf", "format=gray,geq=lum='random(1)*255',format=yuv420p", "-shortest", ...ENC, name + ".mp4"], 0, null, "static burst");
    await this.push(name, duration);
  }

  // opts: preview (6 s, half size), name (segment name), transition (overrides the movie setting),
  // flash (white flash on the first frames), boom (sub hit at the start), scareT (jump scare at this
  // second of the piece; undefined = use the clip's own marker, null = none), label.
  async renderClip(idx, clip, plan, part, opts = {}) {
    const preview = opts === true || opts.preview === true;
    if (opts === true) opts = {};
    const eng = this.eng, p = this.p, W = this.W, H = this.H;
    let style = clip.effect && clip.effect !== "style" ? clip.effect : p.style;
    const meta = clip.meta;
    let D = part.dur; if (preview) D = Math.min(D, 6);
    const name = opts.name || (preview ? "preview" : `clip${String(idx).padStart(2, "0")}_${String(part.i).padStart(2, "0")}`);
    const transition = opts.transition || p.transition;
    const safe = safeName(clip.file.name);
    const clock = new Date(plan.clock.getTime() + part.start * 1000);
    await eng.mountFiles([new File([clip.file], safe)], "/in");
    try {
      const inputs = ["-ss", f3(plan.start + part.start), "-i", `/in/${safe}`];
      let nIn = 1;
      const graph = [];
      let pre = `[0:v]fps=${FPS},`;
      if (meta.hdr) pre += hdrChain(eng, meta.hdr) + ",";
      graph.push(pre + fitChain(eng, meta.width, meta.height, W, H));
      let cur = "[base]";
      graph.push(`${cur}${styleVideoChain(eng, style, W, H)}[fx]`); cur = "[fx]";

      // jump scare time is relative to the trimmed clip; keep it only if it lands inside this part
      let T;
      if (opts.scareT !== undefined) T = opts.scareT;
      else {
        T = clip.scare_at == null || clip.scare_at === "" ? null : +clip.scare_at;
        if (T != null && isNaN(T)) T = null;
        if (T != null) {
          const clipLen = plan.duration;
          T = Math.max(0.3, Math.min(clipLen - 0.4, T)) - part.start;
          if (T < 0 || T > D) T = null;
          else if (!(T >= 0.3 && T <= D - 0.4)) T = D < 1.5 ? null : Math.max(0.3, Math.min(D - 0.4, T));
        }
      }
      if (T != null) { graph.push(`${cur}${jumpScareVideo(T, W, H)}[sc]`); cur = "[sc]"; }
      if (opts.flash) { graph.push(`${cur}eq=brightness=0.75:enable='lt(t,0.07)'[fl]`); cur = "[fl]"; }

      if (STYLES[style]?.scanlines) {
        await eng.ff.writeFile("scan.png", await makeScanlines(W, H));
        inputs.push("-loop", "1", "-framerate", String(FPS), "-threads", "1", "-i", "scan.png");
        graph.push(`${cur}[${nIn}:v]overlay=0:0:format=yuv420[sl]`); cur = "[sl]"; nIn++;
      }
      if (p.timestamps && STYLES[style]?.clock) {
        const secs = Math.ceil(D) + 2;
        this.progress(this.doneWork / this.totalWork, `Clip ${idx + 1}: drawing the clock…`);
        await this.writePngs("/ts", "ts_", await makeTimestampFrames(W, H, style, plan.night, clock, secs));
        inputs.push("-framerate", "1", "-threads", "1", "-i", "/ts/ts_%04d.png");
        graph.push(`${cur}[${nIn}:v]overlay=0:0:format=yuv420[ts]`); cur = "[ts]"; nIn++;
      }
      const fade = transition === "black" ? (opts.fade || 0.5) : 0;
      const fadeIn = fade && (part.first || preview), fadeOut = fade && (part.last || preview);
      let tail = "";
      if (fadeIn) tail += `fade=t=in:st=0:d=${fade},`;
      if (fadeOut) tail += `fade=t=out:st=${f3(D - fade)}:d=${fade},`;
      if (preview) tail += "scale=iw/2:-2,";
      tail += `format=yuv420p,tpad=stop_mode=clone:stop_duration=2,trim=duration=${f3(D)},setpts=PTS-STARTPTS[vout]`;
      graph.push(cur + tail);

      let asrc = "[0:a]";
      if (!meta.has_audio) { inputs.push("-f", "lavfi", "-i", `anullsrc=r=${AR}:cl=stereo`); asrc = `[${nIn}:a]`; nIn++; }
      let a = `${asrc}aresample=${AR},aformat=sample_fmts=fltp:channel_layouts=stereo,${styleAudioChain(style)}`;
      if (T != null) {
        a += `,volume=0.12:enable='between(t,${f3(Math.max(0, T - 0.8))},${f3(T - 0.02)})'[a1];` + jumpScareAudioSource(T, "[sting]") + ";" +
             "[a1][sting]amix=inputs=2:duration=first:normalize=0,alimiter=limit=0.97";
      }
      if (opts.boom) { a += `[a2];${BOOM}[bm];[a2][bm]amix=inputs=2:duration=first:normalize=0,alimiter=limit=0.97`; }
      if (fadeIn) a += `,afade=t=in:st=0:d=${fade}`;
      if (fadeOut) a += `,afade=t=out:st=${f3(D - fade)}:d=${fade}`;
      a += `,apad=whole_dur=${f3(D + 2)},atrim=duration=${f3(D)},asetpts=PTS-STARTPTS[aout]`;
      graph.push(a);

      await eng.ff.writeFile("graph.txt", graph.join(";\n") + "\n");
      const enc = [...ENC];
      if (preview) { enc[enc.indexOf("-preset") + 1] = "ultrafast"; enc[enc.indexOf("-crf") + 1] = "26"; }
      const weight = D * (meta.hdr ? 3 : 1);
      const partLabel = opts.label !== undefined ? opts.label : (clipParts(plan.duration).length > 1 ? ` (part ${part.i + 1} of ${clipParts(plan.duration).length})` : "");
      await eng.exec([...inputs, "-filter_complex_script", "graph.txt", "-map", "[vout]", "-map", "[aout]", ...enc, "-movflags", "+faststart", name + ".mp4"],
        D, this.job(weight, `Clip ${idx + 1}: ${clip.name}${partLabel}`), `clip ${idx + 1} (${clip.name})${partLabel}`);
      this.finish(weight);
      for (const f of ["graph.txt", "scan.png"]) try { await eng.ff.deleteFile(f); } catch (_) {}
      await eng.rmDir("/ts");
      if (preview) return await eng.take(name + ".mp4");
      await this.push(name, D);
    } finally { await eng.unmount("/in"); }
  }

  // opts.riser = {at, dur}: a rising shriek/noise sweep mixed in over that stretch (trailer montage).
  // opts.droneGain scales the drone; opts.quiet = [{at, dur}] stretches where the drone is pulled down (silence before the hit).
  async renderFinal(outName, opts = {}) {
    const total = this.segments.reduce((a, s) => a + s.duration, 0);
    const files = this.segments.map(s => new File([s.blob], s.name, { type: "video/mp4" }));
    await this.eng.mountFiles(files, "/segs");
    try {
      let list = "ffconcat version 1.0\n";
      for (const s of this.segments) list += `file '/segs/${s.name}'\nduration ${f3(s.duration)}\n`;
      await this.eng.ff.writeFile("concat.txt", list);
      const graph = [];
      const drone = (+this.p.drone || 0) * (opts.droneGain || 1);
      let acur = "[0:a]";
      if (drone > 0) {
        const quiet = (opts.quiet || []).map(q => `,volume=0.05:enable='between(t,${f3(q.at)},${f3(q.at + q.dur)})'`).join("");
        graph.push(`aevalsrc=exprs='0.55*sin(2*PI*46*t)*(0.75+0.25*sin(2*PI*0.11*t))+0.35*sin(2*PI*47.6*t)+0.22*sin(2*PI*92*t)*(0.5+0.5*sin(2*PI*0.07*t+1))+0.18*sin(2*PI*138.5*t)*(0.5+0.5*sin(2*PI*0.05*t+2))':s=${AR},aformat=channel_layouts=stereo[dr1]`);
        graph.push(`anoisesrc=color=brown:amplitude=0.6:r=${AR},aformat=channel_layouts=stereo,lowpass=f=300[dr2]`);
        graph.push(`[dr1][dr2]amix=inputs=2:normalize=0,volume=${f3(0.30 * drone)}${quiet},afade=t=in:st=0:d=3,afade=t=out:st=${f3(Math.max(0, total - 4))}:d=4[drone]`);
        graph.push("[0:a][drone]amix=inputs=2:duration=first:normalize=0[amix]"); acur = "[amix]";
      }
      if (opts.riser && opts.riser.dur > 1) {
        const Dr = f3(opts.riser.dur);
        graph.push(`aevalsrc=exprs='(0.28*sin(2*PI*(70+900*pow(t/${Dr},2))*t)+0.22*(random(0)-0.5)+0.18*sin(2*PI*(35+300*pow(t/${Dr},2))*t))*(0.15+0.85*pow(t/${Dr},1.5))':s=${AR}:d=${Dr},aformat=channel_layouts=stereo,adelay=${Math.round(opts.riser.at * 1000)}:all=1[riser]`);
        graph.push(`${acur}[riser]amix=inputs=2:duration=first:normalize=0[amixr]`); acur = "[amixr]";
      }
      graph.push(`${acur}alimiter=limit=0.95,afade=t=out:st=${f3(Math.max(0, total - 1.5))}:d=1.5[aout]`);
      await this.eng.ff.writeFile("final.txt", graph.join(";\n") + "\n");
      const w = total * 0.08;
      await this.eng.exec(["-f", "concat", "-safe", "0", "-i", "concat.txt", "-filter_complex_script", "final.txt", "-map", "0:v", "-map", "[aout]",
        "-t", f3(total), "-c:v", "copy", "-c:a", "aac", "-b:a", "160k", "-ar", String(AR), "-ac", "2", "-movflags", "+faststart", outName],
        total, this.job(w, "Final assembly"), "final assembly");
      this.finish(w);
      for (const f of ["concat.txt", "final.txt"]) try { await this.eng.ff.deleteFile(f); } catch (_) {}
      return await this.eng.take(outName);
    } finally { await this.eng.unmount("/segs"); }
  }

  estimateWork(plan) {
    const clips = plan.reduce((a, pl, i) => a + pl.duration * (this.clips[i].meta.hdr ? 3 : 1), 0);
    const cards = 0.25 * (this.p.title_card ? 12 : 0) + 0.25 * 2.2 * plan.length + 0.25 * 10;
    const t = clips + cards; return t + t * 0.08 + 1;
  }

  async run() {
    const p = this.p;
    if (!this.clips.length) throw new Error("Add at least one clip first.");
    const plan = planNights(p, this.clips);
    this.totalWork = this.estimateWork(plan); this.segments = [];
    const S = (name, weight, fn) => this.seg(name, weight, fn);
    if (p.title_card) {
      await S("black_open", 0, () => this.renderBlack("black_open", 1.2));
      await S("intro", 2.5, () => this.renderTypewriter("intro", introTextFor(p)));
      await S("title", 1, async () => this.renderCard("title", await makeCard(this.W, this.H, { title: p.title || "UNTITLED", subtitle: p.subtitle || "", titleScale: (p.title || "").length < 22 ? 0.085 : 0.06 }), 4.0, 1.6, 0.3, "Title card"));
      await S("black_after_title", 0, () => this.renderBlack("black_after_title", 0.8));
    }
    for (let i = 0; i < this.clips.length; i++) {
      const pl = plan[i];
      if (p.night_cards && pl.new_night) {
        const d = pl.clock, nm = `night${String(pl.night).padStart(2, "0")}`;
        await S(nm, 0.65, async () => this.renderCard(nm, await makeCard(this.W, this.H, { title: `Night #${pl.night}`, subtitle: `${MONTHS[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`, titleScale: 0.06 }), 2.6, 0.8, 0.7, `Night #${pl.night} card`));
      } else if (i > 0 && p.transition === "static") {
        const nm = `static${String(i).padStart(2, "0")}`;
        await S(nm, 0, () => this.renderStatic(nm, 0.18 + 0.02 * (i % 3)));
      }
      for (const part of clipParts(pl.duration)) {
        const nm = `clip${String(i).padStart(2, "0")}_${String(part.i).padStart(2, "0")}`;
        await S(nm, part.dur * (this.clips[i].meta.hdr ? 3 : 1), () => this.renderClip(i, this.clips[i], pl, part));
      }
      if (i === this.clips.length - 1 && p.transition === "static" && (p.end_card || (p.outro_text || "").trim())) await S("static_end", 0, () => this.renderStatic("static_end", 0.25));
    }
    if (p.end_card) {
      await S("black_end", 0, () => this.renderBlack("black_end", 1.0));
      if ((p.outro_text || "").trim()) await S("outro", 1.1, async () => this.renderCard("outro", await makeCard(this.W, this.H, { body: p.outro_text.trim() }), 4.5, 1.0, 1.0, "Closing text"));
      const credits = (p.credits || "").split("\n").map(s => s.trim()).filter(Boolean);
      if (credits.length) await S("credits", 1.25, async () => this.renderCard("credits", await makeCard(this.W, this.H, { title: p.title || "", body: credits.join("\n"), titleScale: 0.045 }), 5.0, 1.0, 1.5, "Credits"));
      await S("black_final", 0, () => this.renderBlack("black_final", 1.0));
    }
    let blob;
    try { blob = await this.renderFinal("movie.mp4"); }
    catch (e) { if (e.stalled && this.onStall) await this.onStall(e); throw e; }
    this.segments = [];
    this.progress(1, "Done");
    return blob;
  }

  async preview(idx) {
    const plan = planNights(this.p, this.clips)[idx];
    this.totalWork = Math.min(plan.duration, 6) + 0.1;
    // preview the stretch around the jump scare if there is one, otherwise the start
    let start = 0;
    const T = +this.clips[idx].scare_at;
    if (this.clips[idx].scare_at != null && this.clips[idx].scare_at !== "" && !isNaN(T)) start = Math.max(0, Math.min(plan.duration - 6, T - 2.5));
    const part = { i: 0, start, dur: Math.min(6, plan.duration - start), first: true, last: true };
    return this.renderClip(idx, this.clips[idx], plan, part, { preview: true });
  }

  // ---------------- trailer ----------------
  estimateTrailerWork(tp) {
    let w = 1;
    for (const it of tp.items) {
      if (it.type === "moment") w += it.dur * (this.clips[it.clip].meta.hdr ? 3 : 1);
      else if (it.type === "card") w += it.dur * 0.25;
    }
    return w + w * 0.08;
  }

  async runTrailer(tp) {
    const p = this.p;
    if (!this.clips.length) throw new Error("Add at least one clip first.");
    const plans = planNights(p, this.clips);
    this.totalWork = this.estimateTrailerWork(tp); this.segments = [];
    const S = (name, weight, fn) => this.seg(name, weight, fn);
    let at = 0, riser = null, quiet = [];
    for (let k = 0; k < tp.items.length; k++) {
      const it = tp.items[k], nm = `tr${String(k).padStart(2, "0")}_${it.type}`;
      if (it.type === "black") { await S(nm, 0, () => this.renderBlack(nm, it.dur)); if (it.quiet) quiet.push({ at, dur: it.dur }); }
      else if (it.type === "static") await S(nm, 0, () => this.renderStatic(nm, it.dur));
      else if (it.type === "card") {
        await S(nm, it.dur * 0.25, async () => this.renderCard(nm, await makeCard(this.W, this.H, {
          title: it.title || "", subtitle: it.subtitle || "", titleScale: it.big ? ((it.title || "").length < 22 ? 0.085 : 0.06) : 0.05,
        }), it.dur, 0.8, it.fadeOut ?? 0.4, it.big ? "Title card" : `Card: ${it.title}`, { slam: true, boom: true }));
      } else if (it.type === "moment") {
        const clip = this.clips[it.clip], pl = plans[it.clip];
        const part = { i: 0, start: it.start, dur: it.dur, first: true, last: true };
        if (it.riser) riser = riser ? { at: riser.at, dur: at + it.dur - riser.at } : { at, dur: it.dur };
        await S(nm, it.dur * (clip.meta.hdr ? 3 : 1), () => this.renderClip(it.clip, clip, pl, part, {
          name: nm, transition: it.transition || "cut", fade: 0.35, flash: !!it.flash, boom: !!it.boom,
          scareT: it.scare ? Math.min(it.dur - 0.4, it.scare) : null, label: ` (trailer moment ${k + 1} of ${tp.items.length})`,
        }));
      }
      at += it.dur;
    }
    let blob;
    try { blob = await this.renderFinal("trailer.mp4", { riser, quiet, droneGain: 1.35 }); }
    catch (e) { if (e.stalled && this.onStall) await this.onStall(e); throw e; }
    this.segments = [];
    this.progress(1, "Done");
    return blob;
  }
}

// --------------------------------------------------------------------------
// Trailer planning: pick the loudest / most sudden moments and lay them out as a trailer.
// --------------------------------------------------------------------------

export const TRAILER_LENGTHS = { 45: { setup: 2, esc: 4, montage: 6 }, 60: { setup: 3, esc: 5, montage: 8 }, 90: { setup: 4, esc: 7, montage: 12 } };
export const DEFAULT_TAGLINES = "THIS HALLOWEEN\nSOMETHING IS IN THE HOUSE\nNO ONE WILL BELIEVE THEM\nCOMING SOON";

// analyses: {clipIdx -> [{t, db}]} with t relative to the trimmed clip start. Deterministic given the seed.
export function planTrailer(proj, clips, analyses, length = 60) {
  const counts = TRAILER_LENGTHS[length] || TRAILER_LENGTHS[60];
  const plans = planNights(proj, clips);
  const rnd = mulberry((+proj.seed || 1) + 77);
  // score every half-second window: loudness plus how much louder it is than the seconds before it
  const wins = [];
  clips.forEach((c, ci) => {
    const dur = plans[ci].duration;
    let a = (analyses[ci] || []).filter(w => w.t >= 0 && w.t <= dur);
    if (a.length < 4) a = Array.from({ length: Math.floor(dur * 2) }, (_, i) => ({ t: i / 2, db: -40 + rnd() * 6 }));
    const dbs = a.map(w => w.db);
    const lo = Math.min(...dbs), hi = Math.max(...dbs), span = Math.max(6, hi - lo);
    a.forEach((w, i) => {
      const prev = a.slice(Math.max(0, i - 6), i).map(x => x.db);
      const before = prev.length ? prev.reduce((s, x) => s + x, 0) / prev.length : w.db;
      const loud = (w.db - lo) / span, jump = Math.max(0, w.db - before) / span;
      wins.push({ clip: ci, t: w.t, db: w.db, score: 0.55 * loud + 0.45 * Math.min(1, jump * 2) + rnd() * 0.02, dur });
    });
  });
  const taken = [];
  // how far apart picks must be within one clip: generous with lots of footage, tight with little
  const totalDur = plans.reduce((s, pl) => s + pl.duration, 0);
  const wanted = counts.setup + counts.esc + counts.montage + 1;
  const GAP = Math.max(1.2, Math.min(6, totalDur / (wanted * 2.5)));
  const free = (w, gap = GAP) => !taken.some(x => x.clip === w.clip && Math.abs(x.t - w.t) < gap);
  const fit = (w, lead, len) => w.t - lead >= 0 && w.t - lead + len <= w.dur;

  // the big one: the single most striking moment, with a lead-in so the hit lands 1.4 s in
  const byScore = [...wins].sort((a, b) => b.score - a.score);
  let finale = byScore.find(w => fit(w, 1.4, 2.4)) || byScore[0];
  if (finale) taken.push(finale);

  const pick = (n, len, lead, minScore) => {
    const out = [], perClip = {};
    const cap = Math.ceil(n / Math.max(1, clips.length)) + 1;
    for (const w of byScore) {
      if (out.length >= n) break;
      if (w === finale || !free(w) || !fit(w, lead, len)) continue;
      if ((perClip[w.clip] || 0) >= cap) continue;
      if (minScore != null && w.score < minScore) continue;
      out.push(w); taken.push(w); perClip[w.clip] = (perClip[w.clip] || 0) + 1;
    }
    return out;
  };
  const esc = pick(counts.esc, 1.5, 0.6);
  const montage = pick(counts.montage, 0.8, 0.3);
  // setup: quiet, early stretches, one per clip where possible
  const setup = [];
  const quietSorted = [...wins].sort((a, b) => a.score - b.score);
  for (const w of quietSorted) {
    if (setup.length >= counts.setup) break;
    if (w.t > w.dur * 0.6 || !fit(w, 0, 2.4) || !free(w)) continue;
    if (setup.some(s => s.clip === w.clip) && setup.length < clips.length) continue;
    setup.push(w); taken.push(w);
  }
  const chrono = arr => arr.sort((a, b) => a.clip - b.clip || a.t - b.t);
  chrono(setup); chrono(esc);
  // montage: interleave clips so consecutive shots come from different places
  const byClip = {}; chrono(montage).forEach(w => (byClip[w.clip] ||= []).push(w));
  const mont = []; let more = true;
  while (more) { more = false; for (const k of Object.keys(byClip)) { const w = byClip[k].shift(); if (w) { mont.push(w); more = true; } } }

  const tags = (proj.trailer_taglines || DEFAULT_TAGLINES).split("\n").map(s => s.trim()).filter(Boolean);
  const items = [];
  items.push({ type: "black", dur: 1.0 });
  if (tags[0]) items.push({ type: "card", title: tags[0], dur: 1.9 });
  setup.forEach(w => items.push({ type: "moment", clip: w.clip, start: w.t, dur: 2.4, transition: "black" }));
  if (tags[1]) items.push({ type: "card", title: tags[1], dur: 1.9 });
  esc.forEach((w, i) => { if (i > 0) items.push({ type: "static", dur: 0.14 }); items.push({ type: "moment", clip: w.clip, start: w.t - 0.6, dur: 1.5, boom: true }); });
  if (tags[2]) items.push({ type: "card", title: tags[2], dur: 1.9 });
  mont.forEach(w => items.push({ type: "moment", clip: w.clip, start: w.t - 0.3, dur: 0.8, flash: true, riser: true }));
  items.push({ type: "black", dur: 0.9, quiet: true });
  if (finale) items.push({ type: "moment", clip: finale.clip, start: Math.max(0, finale.t - 1.4), dur: 2.4, scare: 1.4 });
  items.push({ type: "static", dur: 0.2 });
  items.push({ type: "card", title: proj.title || "UNTITLED", subtitle: proj.subtitle || "", dur: 3.4, big: true, fadeOut: 0.7 });
  if (tags[3]) items.push({ type: "card", title: tags[3], dur: 2.0, fadeOut: 0.8 });
  items.push({ type: "black", dur: 1.0 });
  return { length, items, total: items.reduce((s, it) => s + it.dur, 0) };
}
