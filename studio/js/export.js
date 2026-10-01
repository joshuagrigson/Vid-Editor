// Export: decode -> WebGL compositor -> hardware video encoder, with the sound mixed in short chunks so even a
// long movie never needs to sit in memory. Writes straight to a file on disk when the browser allows it.
import { Output, Mp4OutputFormat, WebMOutputFormat, BufferTarget, StreamTarget, CanvasSource, AudioBufferSource,
  getFirstEncodableVideoCodec, getFirstEncodableAudioCodec } from "../vendor/mediabunny.min.mjs";
import { layout, duration, outputSize, clipLen, FPS } from "./project.js";
import { sceneAt } from "./scene.js";
import { Compositor } from "./compositor.js";
import { drawOverlays } from "./overlays.js";
import { frames, audioBuffers } from "./media.js";
import { renderSfx, renderBed } from "./sfx.js";

const SR = 48000;
const CHUNK = 2;   // seconds of audio mixed at a time

export async function pickCodecs(w, h) {
  const video = await getFirstEncodableVideoCodec(["avc", "vp9", "av1"], { width: w, height: h });
  if (!video) return null;
  const mp4 = video === "avc";
  const audio = await getFirstEncodableAudioCodec(mp4 ? ["aac", "opus"] : ["opus"]);
  return { video, audio, ext: mp4 ? "mp4" : "webm" };
}

// Call from a click handler (before any await) so the save dialog is allowed to open.
export async function pickSaveFile(name, ext) {
  if (!window.showSaveFilePicker) return null;
  try {
    return await window.showSaveFilePicker({
      suggestedName: `${name}.${ext}`,
      types: [{ description: ext === "mp4" ? "MP4 video" : "WebM video", accept: { [ext === "mp4" ? "video/mp4" : "video/webm"]: ["." + ext] } }],
    });
  } catch (e) { if (e.name === "AbortError") throw e; return null; }
}

export async function exportMovie(app, { scale = 1, codecs, fileHandle = null, onProgress = () => {}, signal = {} }) {
  const project = structuredClone(app.project);
  const media = app.media;
  const lay = layout(project);
  const total = duration(project);
  if (total <= 0) throw new Error("The timeline is empty.");
  const { w, h } = outputSize(project, media, scale);
  const mp4 = codecs.ext === "mp4";

  let target, writable = null;
  if (fileHandle) { writable = await fileHandle.createWritable(); target = new StreamTarget(writable, { chunked: true }); }
  else target = new BufferTarget();
  const format = mp4 ? new Mp4OutputFormat({ fastStart: fileHandle ? false : "in-memory" }) : new WebMOutputFormat();
  const output = new Output({ format, target });

  const canvas = document.createElement("canvas");
  const comp = new Compositor(canvas, { preserve: true });
  comp.resize(w, h);
  const ov = document.createElement("canvas"); ov.width = w; ov.height = h;
  const ovCtx = ov.getContext("2d");

  const px = w * h;
  const bitrate = Math.round(Math.min(16e6, Math.max(3e6, px * FPS * 0.16)));
  const vsrc = new CanvasSource(canvas, { codec: codecs.video, bitrate, keyFrameInterval: 2, latencyMode: "quality" });
  output.addVideoTrack(vsrc, { frameRate: FPS });
  let asrc = null;
  if (codecs.audio) { asrc = new AudioBufferSource({ codec: codecs.audio, bitrate: 192000 }); output.addAudioTrack(asrc); }
  await output.start();

  const N = Math.max(1, Math.round(total * FPS));
  const t0 = performance.now();
  let done = 0, audioUpTo = 0;
  const audioChunk = async upTo => {
    if (!asrc) return;
    while (audioUpTo < Math.min(upTo, total) - 1e-6) {
      const a1 = Math.min(total, audioUpTo + CHUNK);
      await asrc.add(await mixAudio(project, media, lay, audioUpTo, a1, total));
      audioUpTo = a1;
    }
  };
  const emit = async (t, src, sw, sh) => {
    if (signal.cancelled) throw Object.assign(new Error("Export cancelled."), { cancelled: true });
    const sc = sceneAt(project, t, lay);
    const ovOn = project.overlays.some(o => t >= o.start && t < o.start + o.dur);
    if (ovOn) drawOverlays(ovCtx, w, h, project, t);
    comp.render({ src, srcW: sw, srcH: sh, fit: project.fit, xf: sc.xf, t, pre: sc.pre, overlay: ovOn ? ov : null, post: sc.post, transition: sc.transition });
    await vsrc.add(t, 1 / FPS);
    done++;
    if (done % 15 === 0 || done === N) {
      const el = (performance.now() - t0) / 1000;
      onProgress({ frac: done / N, frame: done, frames: N, elapsed: el, eta: el / done * (N - done), speed: (done / FPS) / el });
      await new Promise(r => setTimeout(r, 0));
    }
    if (t + 1 / FPS >= audioUpTo) await audioChunk(t + CHUNK);
  };

  try {
    let n = 0;
    for (const l of lay) {
      const m = media.get(l.clip.mediaId);
      const idx = [];
      while (n < N && n / FPS < l.end - 1e-9) { if (n / FPS >= l.start - 1e-9) idx.push(n); n++; }
      if (!idx.length) continue;
      const c = l.clip, sp = c.speed || 1;
      const times = idx.map(k => Math.min(c.out - 0.001, c.in + (k / FPS - l.start) * sp));
      if (!m) { for (const k of idx) await emit(k / FPS, null, 1, 1); continue; }
      let i = 0;
      for await (const fr of frames(m, times)) {
        const sw = fr.videoWidth || fr.width, sh = fr.videoHeight || fr.height;
        await emit(idx[i] / FPS, fr, sw, sh);
        if (++i >= idx.length) break;
      }
      while (i < idx.length) { await emit(idx[i] / FPS, null, 1, 1); i++; }   // decoder ran out early
    }
    for (; n < N; n++) await emit(n / FPS, null, 1, 1);   // overlays/sounds that run past the last clip
    await audioChunk(total);
    await output.finalize();
  } catch (e) {
    try { await output.cancel(); } catch (_) {}
    try { await writable?.abort?.(); } catch (_) {}
    throw e;
  } finally {
    comp.gl.getExtension("WEBGL_lose_context")?.loseContext();
  }
  const mime = mp4 ? "video/mp4" : "video/webm";
  if (fileHandle) return { saved: true, file: await fileHandle.getFile(), mime, codecs, w, h };
  return { saved: false, blob: new Blob([target.buffer], { type: mime }), mime, codecs, w, h };
}

// ------------------------------------------------------------------------------------------------
// Mix [a0, a1) of the timeline: clip sound, effect sounds, the bed. Stateless soft clipper at the end, so
// chunk boundaries never click.
const softClip = (() => {
  const n = 2048, curve = new Float32Array(n);
  for (let i = 0; i < n; i++) { const x = i / (n - 1) * 2 - 1; curve[i] = Math.abs(x) < 0.8 ? x : Math.sign(x) * (0.8 + 0.2 * Math.tanh((Math.abs(x) - 0.8) / 0.2)); }
  return curve;
})();

export async function mixAudio(project, media, lay, a0, a1, total) {
  const len = Math.max(1, Math.round((a1 - a0) * SR));
  const ctx = new OfflineAudioContext(2, len, SR);
  const bus = ctx.createGain();
  const clip = ctx.createWaveShaper(); clip.curve = softClip; clip.oversample = "none";
  bus.connect(clip).connect(ctx.destination);
  const span = (s, e) => [Math.max(a0, s), Math.min(a1, e)];

  // clip audio, with short fades at every cut and a dip across transitions
  for (let i = 0; i < lay.length; i++) {
    const l = lay[i], c = l.clip;
    if (l.end <= a0 || l.start >= a1 || c.mute) continue;
    const m = media.get(c.mediaId);
    if (!m || m.kind === "image" || !m.hasAudio) continue;
    const sp = c.speed || 1;
    const [s0, s1] = span(l.start, l.end);
    if (s1 - s0 <= 0) continue;
    const fin = c.transition?.type ? Math.min(c.transition.dur / 2, clipLen(c) / 2) : 0.01;
    const nt = lay[i + 1]?.clip.transition;
    const fout = nt?.type ? Math.min(nt.dur / 2, clipLen(c) / 2) : 0.01;
    const vol = c.volume ?? 1;
    const env = t => vol * Math.max(0, Math.min(1, (t - l.start) / fin, (l.end - t) / fout));
    const g = ctx.createGain(); g.connect(bus);
    g.gain.setValueAtTime(env(s0), s0 - a0);
    for (const k of [l.start + fin, l.end - fout, s1]) if (k > s0 && k <= s1) g.gain.linearRampToValueAtTime(env(Math.min(k, l.end - 1e-4)), k - a0);
    const srcA = c.in + (s0 - l.start) * sp, srcB = c.in + (s1 - l.start) * sp;
    for await (const wb of audioBuffers(m, srcA - 0.1, srcB + 0.1)) {
      const buf = wb.buffer;
      let when = l.start + (wb.timestamp - c.in) / sp - a0;
      let off = 0;
      if (when < s0 - a0) { off = (s0 - a0 - when) * sp; when = s0 - a0; }
      if (off >= buf.duration || when >= s1 - a0) continue;
      const n = ctx.createBufferSource(); n.buffer = buf; n.playbackRate.value = sp;
      n.connect(g); n.start(when, off); n.stop(s1 - a0);
    }
  }

  // effect sounds and imported audio
  for (const snd of project.sounds) {
    let buf = null;
    if (snd.kind === "file") buf = media.get(snd.ref)?.audioBuffer || null;
    else buf = await renderSfx(snd.ref, { seed: snd.seed || 1 }).catch(() => null);
    if (!buf) continue;
    const end = snd.start + Math.min(snd.dur || buf.duration, buf.duration);
    if (end <= a0 || snd.start >= a1) continue;
    const n = ctx.createBufferSource(); n.buffer = buf;
    const g = ctx.createGain(); g.gain.value = snd.gain ?? 1;
    n.connect(g).connect(bus);
    let when = snd.start - a0, off = 0;
    if (when < 0) { off = -when; when = 0; }
    n.start(when, off); n.stop(Math.min(a1, end) - a0);
  }

  // music bed, looped, faded in over the first 2 s and out over the last 3 s of the movie
  const bed = project.bed;
  if (bed && bed.type && bed.type !== "none") {
    let buf = null;
    if (bed.type === "file") buf = media.get(bed.mediaId)?.audioBuffer || null;
    else buf = await renderBed(bed.type, { seconds: 30 }).catch(() => null);
    if (buf) {
      const n = ctx.createBufferSource(); n.buffer = buf; n.loop = true;
      const g = ctx.createGain();
      const env = t => (bed.gain ?? 0.45) * Math.max(0, Math.min(1, t / 2, (total - t) / 3));
      g.gain.setValueAtTime(env(a0), 0);
      for (const k of [2, total - 3, a1]) if (k > a0 && k <= a1) g.gain.linearRampToValueAtTime(env(k), k - a0);
      n.connect(g).connect(bus);
      n.start(0, a0 % buf.duration);
    }
  }
  return await ctx.startRendering();
}
