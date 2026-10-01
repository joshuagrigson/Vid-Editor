// Media: reading phone videos, photos and audio files. Decoding goes through mediabunny + WebCodecs
// (hardware decoders, frame-accurate), with an <video>-element fallback for anything the decoder refuses.
import { Input, BlobSource, ALL_FORMATS, CanvasSink, AudioBufferSink } from "../vendor/mediabunny.min.mjs";

export const media = new Map();   // id -> MediaItem

const VIDEO_EXT = /\.(mov|mp4|m4v|webm|mkv|avi|3gp|hevc|mts|m2ts)$/i;
const IMAGE_EXT = /\.(jpe?g|png|gif|webp|heic|heif|bmp|avif)$/i;
const AUDIO_EXT = /\.(mp3|m4a|aac|wav|ogg|oga|flac|opus)$/i;

export function kindOf(file) {
  const t = file.type || "";
  if (t.startsWith("video/") || VIDEO_EXT.test(file.name)) return "video";
  if (t.startsWith("image/") || IMAGE_EXT.test(file.name)) return "image";
  if (t.startsWith("audio/") || AUDIO_EXT.test(file.name)) return "audio";
  return null;
}

export class MediaItem {
  constructor(id, file) {
    this.id = id; this.file = file; this.name = file.name; this.kind = kindOf(file);
    this.duration = 0; this.width = 0; this.height = 0; this.hasAudio = false;
    this.canDecode = false; this.canDecodeAudio = false; this.thumbs = []; this.created = null;
    this._input = null; this._el = null; this._url = null; this.bitmap = null; this.audioBuffer = null;
  }
  get url() { return this._url ||= URL.createObjectURL(this.file); }
  input() {
    return this._input ||= new Input({ source: new BlobSource(this.file), formats: ALL_FORMATS });
  }
  // A <video> element for live preview playback (one per media item).
  element() {
    if (this._el) return this._el;
    const v = document.createElement("video");
    v.src = this.url; v.preload = "auto"; v.playsInline = true; v.crossOrigin = "anonymous";
    v.muted = false;
    this._el = v;
    return v;
  }
  toJSON() { return { id: this.id, name: this.name, kind: this.kind, duration: this.duration, width: this.width, height: this.height, hasAudio: this.hasAudio, thumbs: this.thumbs, created: this.created }; }
}

// Read metadata + a thumbnail strip. Throws with a friendly message if the file can't be used.
export async function probe(item, { thumbs = true } = {}) {
  if (item.kind === "image") {
    // stored as a canvas (not an ImageBitmap): WebGL's flip-on-upload ignores ImageBitmaps
    const bmp = await createImageBitmap(item.file, { imageOrientation: "from-image" });
    const s = Math.min(1, 2160 / Math.max(bmp.width, bmp.height));
    const cv = document.createElement("canvas"); cv.width = Math.round(bmp.width * s); cv.height = Math.round(bmp.height * s);
    cv.getContext("2d").drawImage(bmp, 0, 0, cv.width, cv.height); bmp.close?.();
    item.bitmap = cv;
    item.width = cv.width; item.height = cv.height; item.duration = 3600;
    if (thumbs || !item.thumbs?.length) item.thumbs = [scaledCanvas(item.bitmap, 200).toDataURL("image/jpeg", 0.7)];
    return item;
  }
  if (item.kind === "audio") {
    item.audioBuffer = await decodeAudioFile(item.file);
    item.duration = item.audioBuffer.duration; item.hasAudio = true;
    return item;
  }
  // video
  let vt = null, at = null;
  try {
    const input = item.input();
    vt = await input.getPrimaryVideoTrack();
    at = await input.getPrimaryAudioTrack();
    if (vt) {
      item.width = await vt.getDisplayWidth(); item.height = await vt.getDisplayHeight();
      item.canDecode = await vt.canDecode();
      item.duration = await input.computeDuration();
    }
    if (at) { item.hasAudio = true; item.canDecodeAudio = await at.canDecode(); }
    try { const tags = await input.getMetadataTags?.(); if (tags?.date) item.created = new Date(tags.date).toISOString(); } catch (_) {}
  } catch (e) {
    console.warn("mediabunny could not read", item.name, e);
  }
  if (!vt || !item.duration || !item.width) await probeWithElement(item);
  if (thumbs || !item.thumbs?.length) item.thumbs = await thumbStrip(item, 6);
  return item;
}

async function probeWithElement(item) {
  const v = item.element();
  await new Promise((res, rej) => {
    if (v.readyState >= 1) return res();
    v.addEventListener("loadedmetadata", res, { once: true });
    v.addEventListener("error", () => rej(new Error(`This browser can't play ${item.name}. Try Chrome or Edge, or export it from the phone as "Most Compatible".`)), { once: true });
  });
  item.width = v.videoWidth; item.height = v.videoHeight; item.duration = v.duration;
  item.canDecode = false;
}

function scaledCanvas(src, maxW) {
  const w0 = src.displayWidth || src.videoWidth || src.width, h0 = src.displayHeight || src.videoHeight || src.height;
  const s = Math.min(1, maxW / w0);
  const c = document.createElement("canvas"); c.width = Math.max(1, Math.round(w0 * s)); c.height = Math.max(1, Math.round(h0 * s));
  c.getContext("2d").drawImage(src, 0, 0, c.width, c.height);
  return c;
}

async function thumbStrip(item, n) {
  const times = Array.from({ length: n }, (_, i) => Math.min(item.duration - 0.05, (i + 0.5) * item.duration / n));
  const out = [];
  try {
    if (item.canDecode) {
      const vt = await item.input().getPrimaryVideoTrack();
      const sink = new CanvasSink(vt, { width: 160 });
      for await (const w of sink.canvasesAtTimestamps(times)) if (w) out.push(toUrl(w.canvas));
      if (out.length) return out;
    }
  } catch (e) { console.warn("thumbs via decoder failed", e); }
  for (const t of times) {
    try { out.push(toUrl(await frameFromElement(item, t, 160))); } catch (_) { break; }
  }
  return out;
}

function toUrl(canvas) {
  if (canvas instanceof HTMLCanvasElement) return canvas.toDataURL("image/jpeg", 0.7);
  const c = document.createElement("canvas"); c.width = canvas.width; c.height = canvas.height;
  c.getContext("2d").drawImage(canvas, 0, 0); return c.toDataURL("image/jpeg", 0.7);
}

// Seek a (private) element to t and grab the frame. Slow; only the fallback path uses it.
const seekEls = new Map();
async function frameFromElement(item, t, maxW = 0) {
  let v = seekEls.get(item.id);
  if (!v) { v = document.createElement("video"); v.src = item.url; v.muted = true; v.preload = "auto"; v.playsInline = true; seekEls.set(item.id, v); }
  if (v.readyState < 2) await new Promise((res, rej) => { v.addEventListener("loadeddata", res, { once: true }); v.addEventListener("error", rej, { once: true }); });
  if (Math.abs(v.currentTime - t) > 0.001) {
    await new Promise(res => {
      const done = () => { if ("requestVideoFrameCallback" in v) v.requestVideoFrameCallback(() => res()); else res(); };
      v.addEventListener("seeked", done, { once: true });
      v.currentTime = t;
    });
  }
  if (maxW) return scaledCanvas(v, maxW);
  return v;
}

// Frames for export, one per requested source time (times must ascend). Yields a drawable each time.
export async function* frames(item, times) {
  if (item.kind === "image") { for (const _ of times) yield item.bitmap; return; }
  if (item.canDecode) {
    const vt = await item.input().getPrimaryVideoTrack();
    const sink = new CanvasSink(vt, { poolSize: 3 });
    let last = null;
    for await (const w of sink.canvasesAtTimestamps(times)) {
      if (w) last = w.canvas;
      if (last) yield last;
    }
    return;
  }
  for (const t of times) yield await frameFromElement(item, Math.min(t, item.duration - 0.01));
}

// Decoded audio between two source times, as [{buffer: AudioBuffer, timestamp}] (timestamps in source seconds).
export async function* audioBuffers(item, start, end) {
  if (item.kind === "audio") { yield { buffer: item.audioBuffer, timestamp: 0 }; return; }
  if (!item.hasAudio) return;
  if (item.canDecodeAudio) {
    const at = await item.input().getPrimaryAudioTrack();
    const sink = new AudioBufferSink(at);
    for await (const w of sink.buffers(Math.max(0, start), end)) yield w;
    return;
  }
  // fallback: decode the whole file with Web Audio once
  if (!item.audioBuffer) item.audioBuffer = await decodeAudioFile(item.file).catch(() => null);
  if (item.audioBuffer) yield { buffer: item.audioBuffer, timestamp: 0 };
}

let decodeCtx = null;
export async function decodeAudioFile(file) {
  decodeCtx ||= new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 48000 });
  const buf = await file.arrayBuffer();
  return await decodeCtx.decodeAudioData(buf);
}
