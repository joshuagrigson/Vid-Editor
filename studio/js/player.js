// Live preview: plays the timeline with <video> elements for picture + clip sound, Web Audio for effects
// sounds and the music bed, and the WebGL compositor for every effect.
import { layout, duration, outputSize, FPS } from "./project.js";
import { sceneAt } from "./scene.js";
import { Compositor } from "./compositor.js";
import { drawOverlays } from "./overlays.js";
import { renderSfx, renderBed } from "./sfx.js";
import { lookById, effectById } from "./effects.js";

export class Player {
  constructor(canvas, app) {
    this.canvas = canvas; this.app = app;
    this.comp = new Compositor(canvas);
    this.t = 0; this.playing = false;
    this.src = document.createElement("canvas"); this.srcCtx = this.src.getContext("2d", { willReadFrequently: false });
    this.ov = document.createElement("canvas"); this.ovCtx = this.ov.getContext("2d");
    this.activeEl = null; this.activeClipId = null;
    this.hoverFx = null;
    this.master = 0.9;
    this.audio = null; this.nodes = [];
    this.onTime = () => {};
    this.pendingRender = false;
    this.lastSrcOk = false;
  }

  get project() { return this.app.project; }
  get media() { return this.app.media; }

  ensureAudio() {
    if (!this.audio) {
      this.audio = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 48000 });
      this.masterGain = this.audio.createGain(); this.masterGain.connect(this.audio.destination);
    }
    this.masterGain.gain.value = this.master;
    if (this.audio.state === "suspended") this.audio.resume();
    return this.audio;
  }

  sizeFor() {
    const { w, h } = outputSize(this.project, this.media);
    const s = Math.min(1, 960 / Math.max(w, h));
    return { w: Math.round(w * s / 2) * 2, h: Math.round(h * s / 2) * 2 };
  }

  // ---------------- drawing ----------------
  drawSource(scene) {
    const l = scene.l;
    if (!l) return null;
    const m = this.media.get(l.clip.mediaId);
    if (!m) return null;
    if (m.kind === "image") return { src: m.bitmap, w: m.width, h: m.height };
    const el = m.element();
    if (el.readyState >= 2 && el.videoWidth) {
      const maxS = Math.max(this.comp.w, this.comp.h) * 1.25;
      const s = Math.min(1, maxS / Math.max(el.videoWidth, el.videoHeight));
      const w = Math.max(2, Math.round(el.videoWidth * s)), h = Math.max(2, Math.round(el.videoHeight * s));
      if (this.src.width !== w || this.src.height !== h) { this.src.width = w; this.src.height = h; }
      this.srcCtx.drawImage(el, 0, 0, w, h);
      this.lastSrcOk = true;
      return { src: this.src, w, h };
    }
    return this.lastSrcOk ? { src: this.src, w: this.src.width, h: this.src.height } : null;
  }

  render() {
    const { w, h } = this.sizeFor();
    this.comp.resize(w, h);
    if (this.ov.width !== w || this.ov.height !== h) { this.ov.width = w; this.ov.height = h; }
    const lay = this._lay || layout(this.project);
    const ht = this.hoverFx || this.hoverOverlay ? (performance.now() - this.hoverStart) / 1000 : 0;
    const sc = sceneAt(this.project, this.t, lay, this.hoverFx ? this.hoverFx.map(f => ({ ...f, local: ht })) : null);
    const s = this.drawSource(sc);
    const ovItems = this.project.overlays.some(o => this.t >= o.start && this.t < o.start + o.dur) || this.hoverOverlay;
    if (ovItems) drawOverlays(this.ovCtx, w, h, this.project, this.t, this.hoverOverlay ? [{ ...this.hoverOverlay, start: this.t - (0.3 + ht % 3.2), dur: 3.6 }] : []);
    const frame = { src: s?.src, srcW: s?.w, srcH: s?.h, fit: this.project.fit, xf: sc.xf, t: this.t + ht,
      pre: sc.pre, overlay: ovItems ? this.ov : null, post: sc.post, transition: sc.transition };
    // Effects that hold frames read the previous output; when paused/scrubbing that would be some other moment,
    // so prime the feedback buffer with this frame first.
    if (!this.playing && !ht && [...sc.pre, ...sc.post].some(f => effectById(f.type)?.feedback)) this.comp.render(frame);
    this.comp.render(frame);
  }

  // ---------------- seeking ----------------
  seek(t) {
    const dur = duration(this.project);
    this.t = Math.max(0, Math.min(t, Math.max(0, dur - 0.001)));
    this._lay = layout(this.project);
    if (this.playing) { this.restartAudio(); this.syncVideo(true); }
    else this.syncPaused();
    this.onTime(this.t);
  }

  syncPaused() {
    const sc = sceneAt(this.project, this.t, this._lay || layout(this.project));
    const l = sc.l;
    if (this.activeEl) { this.activeEl.pause(); }
    if (!l) { this.render(); return; }
    const m = this.media.get(l.clip.mediaId);
    if (!m || m.kind !== "video") { this.render(); return; }
    const el = m.element();
    this.activeEl = el; this.activeClipId = l.clip.id;
    const target = Math.min(sc.srcTime, Math.max(0, m.duration - 0.03));
    if (Math.abs(el.currentTime - target) < 0.004 && el.readyState >= 2) { this.render(); return; }
    const done = () => { this.render(); };
    if ("requestVideoFrameCallback" in el) el.requestVideoFrameCallback(done);
    el.addEventListener("seeked", done, { once: true });
    el.currentTime = target;
    this.render();
  }

  syncVideo(force = false) {
    const sc = sceneAt(this.project, this.t, this._lay);
    const l = sc.l;
    if (!l) { if (this.activeEl) this.activeEl.pause(); this.activeEl = null; this.activeClipId = null; return; }
    const m = this.media.get(l.clip.mediaId);
    const el = m && m.kind === "video" ? m.element() : null;
    if (el !== this.activeEl && this.activeEl) this.activeEl.pause();
    if (!el) { this.activeEl = null; this.activeClipId = l.clip.id; return; }
    const c = l.clip;
    el.playbackRate = Math.max(0.0625, Math.min(16, c.speed || 1));
    el.preservesPitch = false;
    el.volume = c.mute ? 0 : Math.max(0, Math.min(1, (c.volume ?? 1) * this.master));
    const changed = this.activeClipId !== c.id;
    if (force || changed || Math.abs(el.currentTime - sc.srcTime) > 0.25) el.currentTime = sc.srcTime;
    if (el.paused) el.play().catch(() => {});
    this.activeEl = el; this.activeClipId = c.id;
    // warm up the next clip's element so the cut is clean
    const next = this._lay[l.index + 1];
    if (next && l.end - this.t < 1.2) {
      const nm = this.media.get(next.clip.mediaId);
      if (nm && nm.kind === "video" && nm !== m) { const ne = nm.element(); if (ne.paused && Math.abs(ne.currentTime - next.clip.in) > 0.05) ne.currentTime = next.clip.in; }
    }
  }

  // ---------------- play / pause ----------------
  play() {
    if (this.playing) return;
    const dur = duration(this.project);
    if (dur <= 0) return;
    if (this.t >= dur - 0.05) this.t = 0;
    this.ensureAudio();
    this.playing = true;
    this._lay = layout(this.project);
    this.wall0 = performance.now(); this.t0 = this.t;
    this.comp.resetFeedback();
    this.syncVideo(true);
    this.restartAudio();
    const tick = () => {
      if (!this.playing) return;
      this.t = this.t0 + (performance.now() - this.wall0) / 1000;
      const d = duration(this.project);
      if (this.t >= d) { this.t = d; this.pause(); this.onTime(this.t); return; }
      this.syncVideo();
      this.render();
      this.onTime(this.t);
      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  }

  pause() {
    this.playing = false;
    cancelAnimationFrame(this.raf);
    if (this.activeEl) this.activeEl.pause();
    this.stopAudio();
    this.render();
  }

  toggle() { this.playing ? this.pause() : this.play(); }

  stopAudio() { for (const n of this.nodes) { try { n.stop(); } catch (_) {} } this.nodes = []; }

  async restartAudio() {
    this.stopAudio();
    if (!this.playing) return;
    const ctx = this.ensureAudio();
    const token = (this._audioToken = (this._audioToken || 0) + 1);
    const t = this.t, now = ctx.currentTime + 0.05;
    const p = this.project;
    // music bed
    if (p.bed && p.bed.type && p.bed.type !== "none") {
      let buf = null;
      if (p.bed.type === "file") { const m = this.media.get(p.bed.mediaId); buf = m?.audioBuffer || null; }
      else buf = await renderBed(p.bed.type, { seconds: 30 }).catch(() => null);
      if (token !== this._audioToken || !buf) {} else {
        const s = ctx.createBufferSource(); s.buffer = buf; s.loop = true;
        const g = ctx.createGain(); g.gain.value = p.bed.gain ?? 0.45;
        s.connect(g).connect(this.masterGain);
        s.start(now, t % buf.duration); this.nodes.push(s);
      }
    }
    for (const snd of p.sounds) {
      if (snd.start + (snd.dur || 0) < t) continue;
      if (snd.start - t > 120) continue;
      let buf = null;
      if (snd.kind === "file") buf = this.media.get(snd.ref)?.audioBuffer || null;
      else buf = await renderSfx(snd.ref, { seed: snd.seed || 1 }).catch(() => null);
      if (!buf || token !== this._audioToken || !this.playing) continue;
      const s = ctx.createBufferSource(); s.buffer = buf;
      const g = ctx.createGain(); g.gain.value = snd.gain ?? 1;
      s.connect(g).connect(this.masterGain);
      const off = Math.max(0, this.t - snd.start);
      const when = ctx.currentTime + Math.max(0, snd.start - this.t);
      if (off < buf.duration) { s.start(when, off, Math.max(0.01, Math.min(buf.duration - off, (snd.dur || buf.duration) - off))); this.nodes.push(s); }
    }
  }

  setMaster(v) {
    this.master = v;
    if (this.masterGain) this.masterGain.gain.value = v;
    if (this.activeEl && this.playing) this.syncVideo();
  }

  // Hovering a library card previews it on the paused frame, animated.
  startHover(spec) {
    if (this.playing) return;
    const list = [];
    if (spec.fx) list.push(spec.fx);
    if (spec.look) for (const [i, e] of (lookById(spec.look)?.effects || []).entries()) list.push({ type: e.type, params: e.params || {}, seed: 0.3 + i * 0.1 });
    this.hoverFx = list.length ? list : null;
    this.hoverOverlay = spec.overlay || null;
    this.hoverStart = performance.now();
    cancelAnimationFrame(this.hoverRaf);
    const loop = () => { if (!this.hoverFx && !this.hoverOverlay) return; if (!this.playing) this.render(); this.hoverRaf = requestAnimationFrame(loop); };
    this.hoverRaf = requestAnimationFrame(loop);
  }
  stopHover() {
    this.hoverFx = null; this.hoverOverlay = null;
    cancelAnimationFrame(this.hoverRaf);
    if (!this.playing) this.render();
  }

  step(frames) { if (this.playing) this.pause(); this.seek(Math.round(this.t * FPS + frames) / FPS); }
}
