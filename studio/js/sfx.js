// FrightCut — procedurally synthesized horror sound effects and looping beds.
// Everything here is generated with the Web Audio API inside an OfflineAudioContext:
// oscillators, generated noise, biquads, wave-shapers, convolution with generated
// impulse responses, delays, and a little raw sample-level DSP. No recorded audio.

/* ------------------------------------------------------------------ utils */

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function hashStr(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}
const TAU = Math.PI * 2;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const midi = (n) => 440 * Math.pow(2, (n - 69) / 12);
function interp(pts, t) {
  if (t <= pts[0][0]) return pts[0][1];
  for (let i = 1; i < pts.length; i++) {
    if (t <= pts[i][0]) {
      const [t0, v0] = pts[i - 1], [t1, v1] = pts[i];
      return v0 + (v1 - v0) * ((t - t0) / (t1 - t0 || 1));
    }
  }
  return pts[pts.length - 1][1];
}

/* ------------------------------------------------------------------ synth kit */

class Kit {
  constructor(ctx, rng, opts = {}) {
    this.c = ctx; this.r = rng; this.sr = ctx.sampleRate;
    this.len = ctx.length / ctx.sampleRate;
    this.P = opts.loop || this.len; // loop period for beds
    this.out = ctx.createGain(); this.out.connect(ctx.destination);
    this._conv = new Map(); this._noise = new Map(); this._smooth = new Map();
  }
  rand(a = 0, b = 1) { return a + (b - a) * this.r(); }
  irand(a, b) { return Math.floor(this.rand(a, b + 1 - 1e-9)); }
  pick(a) { return a[Math.floor(this.r() * a.length)]; }
  /** quantize a frequency so it is exactly periodic over the loop period */
  q(f) { return Math.max(1, Math.round(f * this.P)) / this.P; }
  g(v = 1) { const n = this.c.createGain(); n.gain.value = v; return n; }
  ch(...n) { for (let i = 0; i < n.length - 1; i++) n[i].connect(n[i + 1]); return n[n.length - 1]; }
  osc(type, f, t0 = 0, t1 = this.len, det = 0) {
    const o = this.c.createOscillator(); o.type = type; o.frequency.value = f;
    if (det) o.detune.value = det;
    o.start(Math.max(0, t0)); o.stop(Math.max(t0 + 0.001, t1)); return o;
  }
  noiseBuf(kind) {
    if (this._noise.has(kind)) return this._noise.get(kind);
    const n = Math.ceil((this.len + 0.1) * this.sr), d = new Float32Array(n), r = this.r;
    if (kind === 'pink') {
      let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
      for (let i = 0; i < n; i++) {
        const w = r() * 2 - 1;
        b0 = 0.99886 * b0 + w * 0.0555179; b1 = 0.99332 * b1 + w * 0.0750759;
        b2 = 0.969 * b2 + w * 0.153852; b3 = 0.8665 * b3 + w * 0.3104856;
        b4 = 0.55 * b4 + w * 0.5329522; b5 = -0.7616 * b5 - w * 0.016898;
        d[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11; b6 = w * 0.115926;
      }
    } else if (kind === 'brown') {
      let l = 0;
      for (let i = 0; i < n; i++) { l = (l + 0.02 * (r() * 2 - 1)) / 1.02; d[i] = l * 3.5; }
    } else for (let i = 0; i < n; i++) d[i] = r() * 2 - 1;
    const b = this.buf([d]); this._noise.set(kind, b); return b;
  }
  noise(kind = 'white', t0 = 0, t1 = this.len) {
    const s = this.c.createBufferSource(); s.buffer = this.noiseBuf(kind); s.loop = true;
    s.start(Math.max(0, t0), this.rand(0, this.len)); s.stop(Math.max(t0 + 0.001, t1)); return s;
  }
  smoothBuf(rate) {
    const key = rate.toFixed(3);
    if (this._smooth.has(key)) return this._smooth.get(key);
    const n = Math.ceil((this.len + 0.1) * this.sr), d = new Float32Array(n);
    const step = this.sr / rate; let a = this.r() * 2 - 1, b = this.r() * 2 - 1, k = 0;
    for (let i = 0; i < n; i++) {
      const p = (i % step) / step;
      if (i > 0 && i % Math.round(step) === 0) { a = b; b = this.r() * 2 - 1; k++; }
      d[i] = a + (b - a) * (0.5 - 0.5 * Math.cos(Math.PI * clamp(p, 0, 1)));
    }
    const buf = this.buf([d]); this._smooth.set(key, buf); return buf;
  }
  /** random smooth modulation of an AudioParam */
  wobble(param, rate, depth, t0 = 0, t1 = this.len) {
    const s = this.c.createBufferSource(); s.buffer = this.smoothBuf(rate); s.loop = true;
    s.start(Math.max(0, t0), this.rand(0, this.len)); s.stop(Math.max(t0 + 0.001, t1));
    this.ch(s, this.g(depth)).connect(param); return s;
  }
  lfo(type, f, depth, param, t0 = 0, t1 = this.len) {
    const o = this.osc(type, f, t0, t1); this.ch(o, this.g(depth)).connect(param); return o;
  }
  f(type, freq, Q = 0.707, gain = 0) {
    const b = this.c.createBiquadFilter(); b.type = type; b.frequency.value = freq; b.Q.value = Q; b.gain.value = gain; return b;
  }
  pan(p) { const s = this.c.createStereoPanner(); s.pan.value = clamp(p, -1, 1); return s; }
  shape(drive = 2) {
    const ws = this.c.createWaveShaper(), n = 2048, c = new Float32Array(n), k = Math.tanh(drive);
    for (let i = 0; i < n; i++) { const x = (i / (n - 1)) * 2 - 1; c[i] = Math.tanh(drive * x) / k; }
    ws.curve = c; ws.oversample = '2x'; return ws;
  }
  crush(steps = 8) {
    const ws = this.c.createWaveShaper(), n = 4096, c = new Float32Array(n);
    for (let i = 0; i < n; i++) { const x = (i / (n - 1)) * 2 - 1; c[i] = Math.round(x * steps) / steps; }
    ws.curve = c; return ws;
  }
  irBuf(secs, decay, damp) {
    const n = Math.ceil(secs * this.sr), chs = [];
    for (let ch = 0; ch < 2; ch++) {
      const d = new Float32Array(n); let y = 0;
      const pre = Math.floor(this.sr * (0.008 + 0.006 * ch));
      for (let i = pre; i < n; i++) {
        const t = i / this.sr, e = Math.exp(-t * decay) * Math.min(1, (i - pre) / (this.sr * 0.004));
        const a = clamp(0.05 + damp * (t / secs), 0, 0.97);
        y += (1 - a) * ((this.r() * 2 - 1) * e - y); d[i] = y;
      }
      const fo = Math.floor(n * 0.1);
      for (let i = 0; i < fo; i++) d[n - 1 - i] *= i / fo;
      chs.push(d);
    }
    return this.buf(chs);
  }
  /** returns a send (GainNode) feeding a shared convolution reverb */
  verb(secs = 2.5, decay = 2.5, wet = 0.3, damp = 0.6) {
    const key = `${secs}|${decay}|${damp}`;
    let conv = this._conv.get(key);
    if (!conv) {
      conv = this.c.createConvolver(); conv.buffer = this.irBuf(secs, decay, damp);
      conv.connect(this.out); this._conv.set(key, conv);
    }
    const s = this.g(wet); s.connect(conv); return s;
  }
  /** a bus that goes dry to out and to a reverb */
  bus(wet = 0.3, secs = 2.5, decay = 2.5, dest = this.out) {
    const b = this.g(1); b.connect(dest); b.connect(this.verb(secs, decay, wet)); return b;
  }
  echo(time, fb, wet, dest = this.out, tone = 3000) {
    const i = this.g(1), d = this.c.createDelay(Math.max(1, time + 0.1)); d.delayTime.value = time;
    const lp = this.f('lowpass', tone), fg = this.g(fb), w = this.g(wet);
    i.connect(d); d.connect(lp); lp.connect(fg); fg.connect(d); lp.connect(w); w.connect(dest); i.connect(dest);
    return i;
  }
  env(param, pts) {
    pts.forEach(([t, v, m], i) => {
      t = Math.max(0, t);
      if (i === 0 || m === 's') param.setValueAtTime(v, t);
      else if (m === 'e') param.exponentialRampToValueAtTime(Math.max(v, 1e-4), t);
      else param.linearRampToValueAtTime(v, t);
    });
    return param;
  }
  /** attack then exponential-ish decay; dec = time to about -40 dB */
  hit(param, t, a, peak, dec) {
    param.setValueAtTime(0, t); param.linearRampToValueAtTime(peak, t + a);
    param.setTargetAtTime(0, t + a, dec / 4.6); return param;
  }
  buf(chs) {
    const b = this.c.createBuffer(chs.length, chs[0].length, this.sr);
    chs.forEach((d, i) => b.copyToChannel(d, i)); return b;
  }
  play(b, t0 = 0, rate = 1) {
    const s = this.c.createBufferSource(); s.buffer = b; s.playbackRate.value = rate; s.start(Math.max(0, t0)); return s;
  }
  raw(secs = this.len) { const n = Math.ceil(secs * this.sr); return [new Float32Array(n), new Float32Array(n)]; }
  playRaw(B, t0 = 0) { return this.play(this.buf(B), t0); }
  async sub(secs, fn) {
    const c = new OfflineAudioContext(2, Math.ceil(secs * this.sr), this.sr);
    const k = new Kit(c, this.r); await fn(k); return c.startRendering();
  }
  reverse(b) {
    const chs = [];
    for (let ch = 0; ch < b.numberOfChannels; ch++) chs.push(b.getChannelData(ch).slice().reverse());
    return this.buf(chs);
  }
}

/* ------------------------------------------------------------------ raw DSP helpers */

function ping(k, B, t, f, dec, amp, pan = 0, att = 0.0004) {
  const sr = k.sr, i0 = Math.floor(t * sr);
  if (i0 < 0 || i0 >= B[0].length || f >= sr / 2) return;
  const n = Math.min(B[0].length - i0, Math.ceil(dec * sr * 1.2));
  const gl = amp * Math.cos((pan + 1) * Math.PI / 4), gr = amp * Math.sin((pan + 1) * Math.PI / 4);
  const w = TAU * f / sr, dk = Math.exp(-6.9 / (dec * sr)), na = Math.max(1, att * sr);
  // recursive sine oscillator
  let s1 = Math.sin(k.r() * TAU), s0 = Math.sin(Math.asin(s1) - w); const c2 = 2 * Math.cos(w); let e = 1;
  for (let i = 0; i < n; i++) {
    const s = c2 * s1 - s0; s0 = s1; s1 = s;
    const v = s * e * (i < na ? i / na : 1);
    B[0][i0 + i] += v * gl; B[1][i0 + i] += v * gr; e *= dk;
  }
}
function burst(k, B, t, dec, amp, pan = 0, att = 0.0003) {
  const sr = k.sr, i0 = Math.floor(t * sr); if (i0 < 0) return;
  const n = Math.min(B[0].length - i0, Math.ceil(dec * sr * 1.2));
  const gl = amp * Math.cos((pan + 1) * Math.PI / 4), gr = amp * Math.sin((pan + 1) * Math.PI / 4);
  const dk = Math.exp(-6.9 / (dec * sr)), na = Math.max(1, att * sr); let e = 1;
  for (let i = 0; i < n; i++) {
    const v = (k.r() * 2 - 1) * e * (i < na ? i / na : 1);
    B[0][i0 + i] += v * gl; B[1][i0 + i] += v * gr; e *= dk;
  }
}
/** stick-slip friction impulse train (creaks) */
function friction(k, secs, ratePts, ampPts, jit = 0.15) {
  const n = Math.ceil(secs * k.sr), x = new Float32Array(n);
  let ph = k.r(), wob = 0;
  for (let i = 0; i < n; i++) {
    const t = i / k.sr;
    if ((i & 63) === 0) wob = 0.9 * wob + 0.1 * (k.r() * 2 - 1) * jit * 4;
    const a = interp(ampPts, t);
    ph += interp(ratePts, t) * (1 + wob) / k.sr;
    if (ph >= 1) {
      ph -= 1; const v = a * (0.5 + 0.5 * k.r());
      x[i] += v; if (i + 1 < n) x[i + 1] -= v * 0.7;
    }
    x[i] += a * 0.012 * (k.r() * 2 - 1);
  }
  return x;
}
const WOOD = [[480, 22, 1], [1080, 28, 0.9], [1650, 30, 0.6], [2400, 35, 0.45], [3500, 40, 0.3]];
const FLOOR = [[240, 14, 1], [610, 20, 0.8], [1050, 24, 0.5], [1700, 30, 0.3]];
function creak(k, t0, secs, ratePts, ampPts, res, out, amp = 1, jit = 0.15) {
  const x = friction(k, secs, ratePts, ampPts, jit), src = k.play(k.buf([x]), t0);
  const sum = k.g(amp * 30);
  res.forEach(([f, q, a]) => {
    const bp = k.f('bandpass', f * k.rand(0.94, 1.06), q);
    bp.frequency.setValueAtTime(bp.frequency.value, t0);
    bp.frequency.linearRampToValueAtTime(bp.frequency.value * k.rand(0.93, 1.07), t0 + secs);
    k.ch(src, bp, k.g(a), sum);
  });
  k.ch(src, k.f('lowpass', 260, 6), k.g(0.15), sum);
  const lp = k.f('lowpass', 5500); sum.connect(lp); lp.connect(out); return sum;
}
function crackle(k, B, t0, t1, density, amp, hp = true) {
  const n = Math.floor((t1 - t0) * density);
  for (let i = 0; i < n; i++) {
    const t = k.rand(t0, t1), a = amp * Math.pow(k.r(), 2);
    burst(k, B, t, k.rand(0.0005, 0.004), a, k.rand(-0.6, 0.6));
  }
}
function glitchRaw(k, B, t0, secs, amp = 1, rng = k.r) {
  const R = (a, b) => a + (b - a) * rng();
  const sr = k.sr, m = Math.floor(0.4 * sr), mat = new Float32Array(m);
  let i = 0;
  while (i < m) {
    const L = Math.floor(R(0.01, 0.06) * sr), type = Math.floor(rng() * 4), f = R(80, 2500);
    for (let j = 0; j < L && i < m; j++, i++) {
      const t = j / sr, p = (f * t) % 1;
      mat[i] = 0.7 * (type === 0 ? Math.sin(TAU * p) : type === 1 ? (p < 0.5 ? 1 : -1) : type === 2 ? rng() * 2 - 1 : p * 2 - 1);
    }
  }
  let pos = Math.floor(t0 * sr); const end = Math.min(B[0].length, Math.floor((t0 + secs) * sr));
  while (pos < end) {
    if (rng() < 0.12) { pos += Math.floor(R(0.02, 0.07) * sr); continue; }
    const cl = Math.floor(R(0.012, 0.07) * sr), reps = 1 + Math.floor(rng() * 6), off = Math.floor(rng() * (m - cl - 1));
    const steps = rng() < 0.5 ? 2 + Math.floor(rng() * 5) : 0, hold = rng() < 0.4 ? 2 + Math.floor(rng() * 10) : 1;
    const pan = R(-0.8, 0.8), rev = rng() < 0.25, g = R(0.4, 1) * amp;
    const gl = g * Math.cos((pan + 1) * Math.PI / 4), gr = g * Math.sin((pan + 1) * Math.PI / 4);
    for (let r = 0; r < reps && pos < end; r++) {
      for (let j = 0; j < cl && pos < end; j++, pos++) {
        let jj = j - (j % hold), idx = rev ? off + cl - 1 - jj : off + jj;
        let v = mat[idx];
        if (steps) v = Math.round(v * steps) / steps;
        const fade = Math.min(1, j / 48, (cl - j) / 48);
        B[0][pos] += v * gl * fade; B[1][pos] += v * gr * fade;
      }
    }
  }
}

/* ------------------------------------------------------------------ voice / formant synthesis */

const VOW = {
  a: [730, 1090, 2440, 3400], ae: [660, 1720, 2410, 3400], e: [530, 1840, 2480, 3500],
  i: [270, 2290, 3010, 3600], o: [570, 840, 2410, 3300], u: [300, 870, 2240, 3300], er: [490, 1350, 1690, 3300],
};
const FBW = [90, 110, 160, 200], FG = [1, 0.85, 0.7, 0.5];
function formants(k, input, vowels, scale = 1, bwMul = 1) {
  const sum = k.g(3);
  for (let j = 0; j < 4; j++) {
    const F0 = VOW[vowels[0][1]][j] * scale;
    const bp = k.f('bandpass', F0, F0 / (FBW[j] * bwMul * scale));
    vowels.forEach(([t, v], n) => {
      const F = VOW[v][j] * scale;
      if (n === 0) bp.frequency.setValueAtTime(F, Math.max(0, t)); else bp.frequency.linearRampToValueAtTime(F, t);
    });
    k.ch(input, bp, k.g(FG[j]), sum);
  }
  return sum;
}
function voice(k, o) {
  const { t0 = 0, t1 = k.len, f0, vib = [5.5, 20], jit = 15, scale = 1, src = 'sawtooth', breath = 0.1,
    rough = null, drive = 0, out = k.out, pan = 0, bw = 1, gain = 1 } = o;
  const vowels = o.vowels || [[t0, 'a']];
  const amp = o.amp || [[t0, 0], [t0 + 0.05, 1], [t1 - 0.1, 1], [t1, 0]];
  const osc = k.osc(src, f0[0][1], t0, t1 + 0.05);
  k.env(osc.frequency, f0.map(([t, f], i) => [t, f, i ? 'e' : 0]));
  if (vib) k.lfo('sine', vib[0], vib[1], osc.detune, t0, t1 + 0.05);
  if (jit) k.wobble(osc.detune, 14, jit, t0, t1 + 0.05);
  const srcG = k.g(1); osc.connect(srcG);
  if (breath) k.ch(k.noise('white', t0, t1 + 0.05), k.f('highpass', 300), k.g(breath), srcG);
  let head = srcG;
  if (rough) {
    const am = k.g(1 - rough[1]); srcG.connect(am); k.lfo('sine', rough[0], rough[1], am.gain, t0, t1 + 0.05); head = am;
  }
  let tail = formants(k, head, vowels, scale, bw);
  if (drive) tail = k.ch(tail, k.g(2), k.shape(drive));
  const env = k.g(0); k.env(env.gain, amp.map(([t, v, m]) => [t, v * gain, m]));
  const p = k.pan(pan); k.ch(tail, env, p); p.connect(out);
  return p;
}
function thump(k, t, f, amp, dec, out) {
  const s = k.osc('sine', f * 1.7, t, t + dec * 1.3);
  k.env(s.frequency, [[t, f * 1.7], [t + 0.04, f, 'e'], [t + dec, f * 0.8, 'e']]);
  const g = k.g(0); k.hit(g.gain, t, 0.003, amp, dec); k.ch(s, g, out);
  const n = k.noise('brown', t, t + dec); const ng = k.g(0); k.hit(ng.gain, t, 0.002, amp * 0.6, dec * 0.6);
  k.ch(n, k.f('lowpass', f * 3), ng, out);
}
function boom(k, t, amp, out, f1 = 90, f2 = 28, dec = 2.4) {
  const s = k.osc('sine', f1, t, t + dec + 0.2);
  k.env(s.frequency, [[t, f1], [t + 0.5, f2, 'e']]);
  const sg = k.g(0); k.env(sg.gain, [[t, 0], [t + 0.004, amp], [t + dec, 0.001, 'e']]);
  k.ch(s, k.shape(1.5), sg, out);
}

/* ------------------------------------------------------------------ SFX recipes */

export const SFX_CATEGORIES = [
  { id: 'hits', name: 'Hits & Stingers', icon: '💥' },
  { id: 'creatures', name: 'Creatures & Voices', icon: '👹' },
  { id: 'house', name: 'Haunted House', icon: '🏚️' },
  { id: 'tech', name: 'Tech & Paranormal', icon: '📺' },
  { id: 'tension', name: 'Risers & Tension', icon: '📈' },
];

const DEFS = [];
const def = (id, name, cat, dur, desc, fn) => DEFS.push({ id, name, cat, dur, desc, fn });

/* ---- hits */
def('jumpscare', 'Jump Scare Stinger', 'hits', 3, 'Sub boom, metallic shriek and noise slam all at once.', (k) => {
  const t = 0.01, b = k.bus(0.35, 3, 2);
  boom(k, t, 1.1, k.out, 110, 30, 2.6);
  const ng = k.g(0); k.env(ng.gain, [[t, 0], [t + 0.002, 0.8], [t + 0.9, 0.001, 'e']]);
  k.ch(k.noise('white', t, t + 1.5), k.f('lowpass', 7000), ng, b);
  [1244, 1318, 1864, 2489, 2637, 3729].forEach((f) => {
    const o = k.osc('sawtooth', f, t, t + 2.7, k.rand(-15, 15));
    k.env(o.frequency, [[t, f * 1.08], [t + 0.12, f, 'e'], [t + 2.5, f * 0.78, 'e']]);
    k.lfo('sine', k.rand(6, 9), 30, o.detune);
    const g = k.g(0); k.env(g.gain, [[t, 0], [t + 0.012, 0.13], [t + 0.4, 0.07], [t + 2.6, 0.0005, 'e']]);
    k.ch(o, g, k.f('bandpass', 2400, 0.8), k.shape(2.5), k.pan(k.rand(-0.7, 0.7)), b);
  });
  [55, 58.27, 82.4, 87.3, 110, 116.5].forEach((f) => {
    const o = k.osc('sawtooth', f, t, t + 2, k.rand(-10, 10)), g = k.g(0);
    k.env(g.gain, [[t, 0], [t + 0.01, 0.22], [t + 1.8, 0.001, 'e']]);
    k.ch(o, k.f('lowpass', 1400), g, b);
  });
});

def('string_stab', 'String Stab', 'hits', 2.5, 'Dissonant orchestral string cluster with a hard attack.', (k) => {
  const t = 0.01, b = k.bus(0.4, 2.5, 2.2), lp = k.f('lowpass', 6000, 1.5);
  k.env(lp.frequency, [[t, 7000], [t + 0.25, 2200, 'e'], [t + 2.2, 700, 'e']]);
  const g = k.g(0); k.env(g.gain, [[t, 0], [t + 0.008, 1], [t + 0.3, 0.45], [t + 2.3, 0.001, 'e']]);
  k.ch(lp, g, b);
  [48, 49, 54, 55, 60, 61, 67].forEach((n) => {
    for (const d of [-12, 0, 12]) {
      const o = k.osc('sawtooth', midi(n), t, t + 2.5, d + k.rand(-4, 4));
      k.lfo('sine', k.rand(4.5, 6), 8, o.detune); k.ch(o, k.g(0.09), lp);
    }
  });
  const hi = k.osc('sawtooth', midi(80), t, t + 2.4); k.lfo('sine', 6.2, 25, hi.detune);
  const hg = k.g(0); k.env(hg.gain, [[t, 0], [t + 0.02, 0.08], [t + 2.3, 0.001, 'e']]);
  k.ch(hi, k.f('bandpass', 2500, 1), hg, b);
});

def('sub_boom', 'Sub Boom', 'hits', 3, 'Deep cinematic sub-bass drop you feel in your chest.', (k) => {
  boom(k, 0.01, 1, k.bus(0.2, 2, 2), 75, 24, 2.9);
  const ng = k.g(0); k.hit(ng.gain, 0.01, 0.001, 0.6, 0.05);
  k.ch(k.noise('white', 0, 0.2), k.f('lowpass', 2500), ng, k.out);
});

def('braam', 'Braam', 'hits', 4.5, 'Huge low brass-like blast, movie-trailer style.', (k) => {
  const t = 0.02, b = k.bus(0.35, 3.5, 1.6), lp = k.f('lowpass', 150, 6);
  k.env(lp.frequency, [[t, 150], [t + 0.18, 2000, 'e'], [t + 1, 900, 'e'], [t + 4.2, 250, 'e']]);
  const g = k.g(0); k.env(g.gain, [[t, 0], [t + 0.06, 1], [t + 3.2, 0.7], [t + 4.4, 0.001, 'e']]);
  [[55, 4], [82.4, 2], [110, 2], [41.2, 1]].forEach(([f, n]) => {
    for (let i = 0; i < n; i++) { const o = k.osc('sawtooth', f, t, t + 4.5, k.rand(-14, 14)); k.ch(o, k.g(0.18), lp); }
  });
  k.ch(lp, k.g(1.5), k.shape(3), g, b);
  const s = k.osc('sine', 55, t, t + 4.5), sg = k.g(0); k.env(sg.gain, [[t, 0], [t + 0.05, 0.5], [t + 4.3, 0.001, 'e']]); k.ch(s, sg, k.out);
});

def('reverse_hit', 'Reverse Riser Hit', 'hits', 3.5, 'Reversed reverb swell that slams into an impact.', async (k) => {
  const T = 2.0;
  const fw = await k.sub(T, (s) => {
    const b = s.bus(0.9, 2, 2.2), g = s.g(0); s.hit(g.gain, 0.005, 0.001, 1, 1.3);
    s.ch(s.noise('white'), s.f('highpass', 2000), g, b);
    [220, 233, 330, 349].forEach((f) => { const o = s.osc('sawtooth', f, 0, 1.6), og = s.g(0); s.hit(og.gain, 0.005, 0.005, 0.2, 1.4); s.ch(o, s.f('lowpass', 3000), og, b); });
  });
  k.ch(k.play(k.reverse(fw), 0), k.g(1), k.out);
  const b = k.bus(0.3, 3, 2); boom(k, T, 1.1, b, 100, 30, 1.4);
  const ng = k.g(0); k.hit(ng.gain, T, 0.001, 0.7, 0.6); k.ch(k.noise('white', T, T + 1), k.f('lowpass', 5000), ng, b);
});

def('whoosh', 'Whoosh', 'hits', 1.5, 'Fast swoosh of air passing the camera.', (k) => {
  const bp = k.f('bandpass', 300, 1.6);
  k.env(bp.frequency, [[0, 250], [0.55, 2600, 'e'], [1.4, 350, 'e']]);
  const g = k.g(0); k.env(g.gain, [[0, 0], [0.55, 1], [1.45, 0]]);
  const p = k.pan(-0.9); k.env(p.pan, [[0, -0.9], [1.4, 0.9]]);
  k.ch(k.noise('pink'), bp, g, p, k.bus(0.15, 1, 3));
  const lg = k.g(0); k.env(lg.gain, [[0, 0], [0.5, 0.5], [1.4, 0]]);
  k.ch(k.noise('brown'), k.f('lowpass', 200), lg, k.out);
});

def('glass_shatter', 'Glass Shatter', 'hits', 2.5, 'A window smashing into tinkling shards.', (k) => {
  const B = k.raw();
  burst(k, B, 0.01, 0.05, 1.2); burst(k, B, 0.012, 0.15, 0.4, 0.3);
  for (let i = 0; i < 150; i++) {
    const t = 0.01 + 1.6 * Math.pow(k.r(), 2.2), f = k.rand(2200, 10000), d = k.rand(0.05, 0.35), a = k.rand(0.1, 0.4) * (1 - t / 1.8), p = k.rand(-0.8, 0.8);
    ping(k, B, t, f, d, a, p); ping(k, B, t, f * 2.31, d * 0.6, a * 0.5, p);
  }
  for (let i = 0; i < 20; i++) ping(k, B, k.rand(1.0, 2.2), k.rand(3000, 8000), 0.08, k.rand(0.05, 0.15), k.rand(-1, 1));
  k.ch(k.playRaw(B), k.f('highpass', 900), k.bus(0.25, 1.8, 3));
  thump(k, 0.01, 120, 0.5, 0.15, k.out);
});

def('metal_clang', 'Metal Clang', 'hits', 3, 'Heavy metal pipe struck in a big empty space.', (k) => {
  const B = k.raw(), base = 180 * k.rand(0.95, 1.05);
  const P = [[1, 1, 2.6], [1.007, 0.8, 2.4], [2.32, 0.7, 1.8], [2.335, 0.5, 1.6], [4.25, 0.45, 1.2], [5.1, 0.35, 0.9], [6.8, 0.25, 0.7], [8.9, 0.2, 0.5], [11.3, 0.15, 0.35]];
  for (const [t, a] of [[0.01, 1], [0.34, 0.3]]) {
    P.forEach(([r, pa, d]) => ping(k, B, t, base * r, d * (a < 1 ? 0.5 : 1), pa * a * 0.3, k.rand(-0.3, 0.3)));
    burst(k, B, t, 0.02, 0.6 * a);
  }
  k.ch(k.playRaw(B), k.bus(0.35, 3, 1.6));
});

def('heartbeat_hit', 'Heartbeat Hit', 'hits', 1.5, 'One huge pounding lub-dub.', (k) => {
  const b = k.bus(0.15, 1.2, 4);
  thump(k, 0.01, 55, 1, 0.35, b); thump(k, 0.27, 50, 0.7, 0.4, b);
});

def('dark_hit', 'Dark Impact', 'hits', 4, 'Deep trailer impact with a long dark tail.', (k) => {
  const b = k.bus(0.5, 4, 1.4, k.out);
  boom(k, 0.01, 1, b, 95, 26, 3);
  const ng = k.g(0); k.hit(ng.gain, 0.01, 0.002, 0.8, 0.7); k.ch(k.noise('white', 0, 1.2), k.f('lowpass', 3500), ng, b);
  const B = k.raw(); [1, 2.32, 4.25, 6.8].forEach((r, i) => ping(k, B, 0.01, 97 * r, 2.5 - i * 0.5, 0.25 / (i + 1)));
  k.ch(k.playRaw(B), b);
});

/* ---- creatures & voices */
def('scream_f', 'Scream (high)', 'creatures', 2.6, 'Piercing high-pitched horror-movie scream.', (k) => {
  const out = k.bus(0.35, 2.5, 2.5);
  const f0 = [[0.02, 760], [0.12, 1060], [0.6, 1130], [1.6, 960], [2.5, 610]];
  const amp = [[0.02, 0], [0.09, 1], [1.8, 0.85], [2.5, 0]];
  voice(k, { t0: 0.02, t1: 2.5, f0, vib: [6.5, 45], jit: 60, vowels: [[0.02, 'a'], [1.3, 'ae'], [2.5, 'e']], scale: 1.32, breath: 0.25, rough: [72, 0.35], drive: 2.5, amp, out });
  voice(k, { t0: 0.02, t1: 2.5, f0: f0.map(([t, f]) => [t, f * 1.012]), vib: [5.9, 35], jit: 50, vowels: [[0.02, 'a'], [2.5, 'ae']], scale: 1.3, breath: 0.1, rough: [97, 0.3], drive: 2, amp, out, gain: 0.5, pan: 0.15 });
  const sg = k.g(0); k.env(sg.gain, [[0.02, 0], [0.1, 0.12], [2.4, 0]]);
  k.ch(k.noise('white'), k.f('bandpass', 3200, 1.2), sg, out);
});

def('scream_m', 'Scream (low)', 'creatures', 2.5, 'Rough terrified yell, lower and raspier.', (k) => {
  const out = k.bus(0.3, 2.5, 2.5);
  const f0 = [[0.02, 240], [0.12, 410], [0.8, 440], [1.8, 330], [2.4, 190]];
  const amp = [[0.02, 0], [0.1, 1], [1.8, 0.8], [2.42, 0]];
  voice(k, { t0: 0.02, t1: 2.42, f0, vib: [5.5, 40], jit: 70, vowels: [[0.02, 'a'], [1.6, 'a'], [2.4, 'o']], scale: 1.08, breath: 0.35, rough: [55, 0.45], drive: 4, amp, out });
  voice(k, { t0: 0.02, t1: 2.42, f0: f0.map(([t, f]) => [t, f * 0.5]), vib: [5.5, 30], jit: 40, vowels: [[0.02, 'a'], [2.4, 'o']], scale: 1.0, breath: 0.2, drive: 3, amp, out, gain: 0.35 });
});

def('growl', 'Demonic Growl', 'creatures', 3, 'Low inhuman ring-modulated snarl.', (k) => {
  const t0 = 0.02, t1 = 2.9, out = k.bus(0.25, 2, 3);
  const o = k.osc('sawtooth', 55, t0, t1); k.env(o.frequency, [[t0, 55], [0.4, 75], [2.0, 62], [t1, 45, 'e']]); k.wobble(o.detune, 18, 120);
  const sub = k.osc('square', 27.5, t0, t1); k.env(sub.frequency, [[t0, 27.5], [0.4, 37.5], [2.0, 31], [t1, 22.5, 'e']]);
  const mix = k.g(1); o.connect(mix); k.ch(sub, k.g(0.5), mix);
  k.ch(k.noise('pink'), k.f('bandpass', 400, 1), k.g(0.8), mix);
  const rm = k.g(0); mix.connect(rm); k.lfo('sine', 31, 1, rm.gain);
  const blend = k.g(1); k.ch(mix, k.g(0.5), blend); rm.connect(blend);
  const am = k.g(0.6); k.wobble(am.gain, 28, 0.4); blend.connect(am);
  const fm = formants(k, am, [[t0, 'o'], [1, 'a'], [2.2, 'o'], [t1, 'u']], 0.8, 2.5);
  const env = k.g(0); k.env(env.gain, [[t0, 0], [0.3, 1], [2.2, 0.9], [t1, 0]]);
  k.ch(fm, k.g(2), k.shape(6), k.f('lowpass', 2500), env, out);
});

def('demon_laugh', 'Demon Laugh', 'creatures', 2.6, 'Slow, deep, distorted "ha… ha… ha".', (k) => {
  const out = k.bus(0.45, 3, 1.8);
  for (let i = 0; i < 5; i++) {
    const ts = 0.08 + i * 0.32, f = 125 - i * 8, amp = [[ts, 0], [ts + 0.03, 1], [ts + 0.15, 0.7], [ts + 0.26, 0]];
    for (const [m, gn] of [[1, 1], [0.5, 0.8]]) {
      voice(k, { t0: ts, t1: ts + 0.26, f0: [[ts, f * m], [ts + 0.26, f * m * 0.75]], vib: null, jit: 40, vowels: [[ts, 'a'], [ts + 0.26, 'o']], scale: m === 1 ? 0.95 : 0.8, breath: 0.5, rough: [40, 0.3], drive: 5, amp, out, gain: gn });
    }
  }
});

def('whisper', 'Whispers', 'creatures', 3, 'Unintelligible whispering that moves around you.', (k) => {
  const out = k.bus(0.3, 1.8, 3);
  let t = 0.08;
  while (t < 2.7) {
    const d = k.rand(0.12, 0.35), v1 = k.pick(Object.keys(VOW)), v2 = k.pick(Object.keys(VOW)), p = k.pan(k.rand(-0.85, 0.85));
    const src = k.noise('white', t, t + d + 0.05);
    const fm = formants(k, src, [[t, v1], [t + d, v2]], 1.1, 1.6);
    const g = k.g(0); k.env(g.gain, [[t, 0], [t + 0.03, 1], [t + d * 0.7, 0.6], [t + d, 0]]);
    k.ch(fm, g, p, out);
    if (k.r() < 0.4) {
      const sg = k.g(0); k.env(sg.gain, [[t, 0], [t + 0.02, 0.35], [t + 0.09, 0]]);
      k.ch(k.noise('white', t, t + 0.1), k.f('highpass', 4500), sg, p);
    }
    t += d + k.rand(0.03, 0.15);
  }
});

def('ghost_moan', 'Ghost Moan', 'creatures', 4.5, 'Hollow, wavering "oooooo" from the walls.', (k) => {
  const out = k.echo(0.33, 0.4, 0.35, k.bus(0.7, 4, 1.2));
  const f0 = [[0.05, 200], [1, 285], [2.2, 245], [3.4, 170], [4.3, 150]];
  const amp = [[0.05, 0], [0.8, 1], [3.0, 0.8], [4.35, 0]];
  voice(k, { t0: 0.05, t1: 4.35, f0, vib: [4.5, 30], jit: 25, vowels: [[0.05, 'u'], [1.5, 'o'], [3.2, 'u']], scale: 1.1, src: 'triangle', breath: 0.15, amp, out, pan: -0.2 });
  voice(k, { t0: 0.15, t1: 4.35, f0: f0.map(([t, f]) => [t + 0.1, f * 1.012]), vib: [4.1, 25], jit: 25, vowels: [[0.15, 'u'], [1.6, 'o'], [3.3, 'u']], scale: 1.15, src: 'triangle', breath: 0.1, amp: amp.map(([t, v]) => [t + 0.1, v]), out, pan: 0.3, gain: 0.6 });
});

def('giggle', 'Creepy Giggle', 'creatures', 2.4, 'Small, distant, echoing giggle — very unsettling.', (k) => {
  const out = k.echo(0.23, 0.35, 0.3, k.bus(0.45, 2.5, 2));
  for (let i = 0; i < 7; i++) {
    const ts = 0.05 + i * 0.12, base = 560 - i * 16;
    voice(k, { t0: ts, t1: ts + 0.09, f0: [[ts, base * 1.1], [ts + 0.04, base * 1.15], [ts + 0.09, base]], vib: null, jit: 30, vowels: [[ts, 'i'], [ts + 0.09, 'e']], scale: 1.45, breath: 0.35, amp: [[ts, 0], [ts + 0.015, 1], [ts + 0.06, 0.6], [ts + 0.09, 0]], out, pan: 0.2 });
  }
  const ts = 1.0;
  voice(k, { t0: ts, t1: ts + 0.7, f0: [[ts, 620], [ts + 0.7, 400]], vib: [7, 50], jit: 30, vowels: [[ts, 'i'], [ts + 0.7, 'e']], scale: 1.45, breath: 0.3, amp: [[ts, 0], [ts + 0.05, 0.9], [ts + 0.5, 0.5], [ts + 0.7, 0]], out, pan: -0.2 });
  voice(k, { t0: ts, t1: ts + 0.7, f0: [[ts, 310], [ts + 0.7, 200]], vib: [7, 50], jit: 30, vowels: [[ts, 'i'], [ts + 0.7, 'e']], scale: 1.1, breath: 0.1, amp: [[ts, 0], [ts + 0.05, 0.9], [ts + 0.5, 0.5], [ts + 0.7, 0]], out, gain: 0.25 });
});

def('breathing', 'Heavy Breathing', 'creatures', 5, 'Slow, shaky breathing right behind you.', (k) => {
  const out = k.bus(0.1, 1, 4), trem = k.g(0.75); k.wobble(trem.gain, 9, 0.25); trem.connect(out);
  const cyc = [[0.15, 1.3, 'in'], [1.45, 2.9, 'out'], [3.05, 3.95, 'in'], [4.05, 4.95, 'out']];
  for (const [a, b, kind] of cyc) {
    const src = k.noise('pink', a, b + 0.05);
    const fm = formants(k, src, kind === 'in' ? [[a, 'u'], [b, 'i']] : [[a, 'a'], [b, 'er']], 1.15, 3);
    const g = k.g(0);
    if (kind === 'in') k.env(g.gain, [[a, 0], [b - 0.25, 0.7], [b, 0]]);
    else k.env(g.gain, [[a, 0], [a + 0.12, 1], [b, 0]]);
    k.ch(fm, k.f('highpass', 250), g, trem);
  }
});

def('heartbeat', 'Heartbeat (loop)', 'creatures', 2.4, 'Three steady heartbeats; loops cleanly.', (k) => {
  const b = k.f('lowpass', 400);
  b.connect(k.out);
  for (const t of [0.02, 0.82, 1.62]) { thump(k, t, 52, 1, 0.3, b); thump(k, t + 0.27, 48, 0.65, 0.35, b); }
});

def('hiss', 'Creature Hiss', 'creatures', 1.8, 'Sharp hiss of something you should not have woken.', (k) => {
  const out = k.bus(0.15, 1.2, 3), am = k.g(0.7); k.lfo('sine', 27, 0.3, am.gain);
  const g = k.g(0); k.env(g.gain, [[0.01, 0], [0.09, 1], [1.2, 0.8], [1.75, 0]]);
  k.ch(k.noise('white'), k.f('highpass', 2500), k.f('peaking', 6000, 1.5, 9), am, g, out);
  const fm = formants(k, k.noise('white'), [[0, 'i'], [1.7, 'e']], 1.2, 2);
  const g2 = k.g(0); k.env(g2.gain, [[0.01, 0], [0.09, 0.4], [1.75, 0]]); k.ch(fm, g2, out);
});

def('banshee', 'Banshee Wail', 'creatures', 4, 'Rising and falling ghostly wail.', (k) => {
  const out = k.echo(0.29, 0.35, 0.3, k.bus(0.6, 3.5, 1.4));
  voice(k, { t0: 0.05, t1: 3.9, f0: [[0.05, 480], [0.9, 900], [1.7, 1250], [2.7, 820], [3.9, 470]], vib: [5.2, 60], jit: 40, vowels: [[0.05, 'u'], [1.2, 'o'], [1.8, 'a'], [3.9, 'u']], scale: 1.3, src: 'triangle', breath: 0.2, amp: [[0.05, 0], [0.6, 0.7], [1.8, 1], [3.9, 0]], out });
});

/* ---- house */
def('door_creak', 'Door Creak', 'house', 3.2, 'Slow, groaning creak of an old wooden door.', (k) => {
  const out = k.bus(0.22, 1.5, 3), head = k.g(1); k.ch(head, k.f('highpass', 120), out);
  creak(k, 0, 3.2, [[0, 14], [0.4, 22], [0.9, 55], [1.4, 180], [1.8, 320], [2.2, 140], [2.6, 40], [3.1, 16]], [[0, 0], [0.12, 0.7], [1.5, 1], [2.6, 0.8], [3.15, 0]], WOOD, head);
});

def('door_slam', 'Door Slam', 'house', 2.5, 'A door slammed shut somewhere in the house.', (k) => {
  const b = k.bus(0.45, 2, 3), t = 0.05;
  thump(k, t, 55, 1, 0.3, b);
  const ng = k.g(0); k.hit(ng.gain, t, 0.002, 0.9, 0.25); k.ch(k.noise('brown', t, t + 0.5), k.f('lowpass', 500), ng, b);
  const cg = k.g(0); k.hit(cg.gain, t, 0.001, 0.5, 0.08); k.ch(k.noise('white', t, t + 0.2), k.f('bandpass', 1200, 1.5), cg, b);
  const B = k.raw(); ping(k, B, t + 0.03, 3200, 0.04, 0.2); ping(k, B, t + 0.03, 5100, 0.03, 0.12);
  for (const tr of [0.15, 0.22, 0.31]) { ping(k, B, t + tr, k.rand(800, 1500), 0.04, 0.08); burst(k, B, t + tr, 0.01, 0.06); }
  k.ch(k.playRaw(B), b);
});

def('footsteps', 'Footsteps on Wood', 'house', 3.6, 'Slow footsteps creeping across a wooden floor.', (k) => {
  const b = k.bus(0.25, 1.4, 3.5);
  for (let i = 0; i < 5; i++) {
    const t = 0.12 + i * 0.66 + k.rand(-0.04, 0.04), a = i % 2 ? 0.8 : 1;
    thump(k, t, 95, a * 0.8, 0.13, b);
    const sg = k.g(0); k.hit(sg.gain, t + 0.01, 0.005, a * 0.12, 0.07); k.ch(k.noise('white', t, t + 0.15), k.f('bandpass', 2500, 0.8), sg, b);
    const wg = k.g(0); k.hit(wg.gain, t, 0.002, a * 0.5, 0.1); k.ch(k.noise('white', t, t + 0.2), k.f('bandpass', 380, 2), wg, b);
    if (i === 1 || i === 3) creak(k, t + 0.03, 0.4, [[0, 25], [0.15, 60], [0.4, 22]], [[0, 0], [0.05, 0.5], [0.35, 0.3], [0.4, 0]], FLOOR, b, 0.6);
  }
});

def('knock', 'Knocking', 'house', 2, 'Three slow knocks on a wooden door.', (k) => {
  const b = k.bus(0.3, 1.2, 3.5);
  for (const t of [0.08, 0.38, 0.68]) {
    const n = k.noise('white', t, t + 0.3);
    [[160, 4, 1, 0.13], [420, 6, 0.6, 0.08], [2200, 1, 0.12, 0.015]].forEach(([f, q, a, d]) => {
      const g = k.g(0); k.hit(g.gain, t, 0.001, a * 3, d); k.ch(n, k.f('bandpass', f, q), g, b);
    });
    thump(k, t, 110, 0.5, 0.1, b);
  }
});

def('floor_creak', 'Floor Creak', 'house', 2, 'A single floorboard groaning under weight.', (k) => {
  creak(k, 0, 2, [[0, 8], [0.5, 25], [1.0, 48], [1.5, 20], [1.95, 8]], [[0, 0], [0.2, 0.8], [1.2, 1], [1.95, 0]], FLOOR, k.bus(0.25, 1.5, 3));
});

def('chain_rattle', 'Chain Rattle', 'house', 2.5, 'Rusty chains shaken in the dark.', (k) => {
  const B = k.raw();
  for (const c of [0.25, 0.95, 1.65]) {
    for (let i = 0; i < 24; i++) {
      const t = clamp(c + (k.r() + k.r() + k.r() - 1.5) * 0.15, 0.01, 2.3), f = k.rand(1700, 4500), d = k.rand(0.04, 0.12), a = k.rand(0.2, 1) * 0.25, p = k.rand(-0.7, 0.7);
      ping(k, B, t, f, d, a, p); ping(k, B, t, f * 2.4, d * 0.7, a * 0.5, p); ping(k, B, t, f * 3.9, d * 0.5, a * 0.3, p);
      burst(k, B, t, 0.004, a * 0.6, p);
    }
  }
  k.ch(k.playRaw(B), k.f('highpass', 400), k.bus(0.2, 1.5, 3));
});

function musicNote(k, B, t, f, amp, pan = 0) {
  [[1, 1, 1.4], [2.0, 0.25, 0.8], [4.1, 0.12, 0.3], [6.3, 0.05, 0.15]].forEach(([r, a, d]) => ping(k, B, t, f * r, d, amp * a, pan, 0.002));
  burst(k, B, t, 0.003, amp * 0.15, pan);
}
def('music_box', 'Music Box Wind-Down', 'house', 6, 'Tinkling minor lullaby that slows and goes flat.', (k) => {
  const B = k.raw(), mel = [81, 76, 72, 76, 74, 72, 71, 72, 69, 71, 64];
  let t = 0.05, iv = 0.28;
  mel.forEach((n, i) => {
    musicNote(k, B, t, midi(n) * Math.pow(2, (-i * 9 + k.rand(-10, 10)) / 1200), 0.35, k.rand(-0.3, 0.3));
    if (i % 3 === 0) musicNote(k, B, t, midi(n - 24), 0.15);
    t += iv; iv *= 1.09 + i * 0.006;
  });
  k.ch(k.playRaw(B), k.f('highpass', 300), k.echo(0.37, 0.25, 0.2, k.bus(0.35, 2.5, 2)));
});

def('clock_tick', 'Clock Ticking', 'house', 4, 'An old clock ticking in an empty room.', (k) => {
  const B = k.raw();
  for (let i = 0; i < 8; i++) {
    const t = 0.05 + i * 0.5, tick = i % 2 === 0;
    (tick ? [2800, 4200, 6100] : [2100, 3300, 5000]).forEach((f, j) => ping(k, B, t, f, 0.02 - j * 0.004, 0.3 / (j + 1)));
    ping(k, B, t, tick ? 950 : 820, 0.03, 0.25); burst(k, B, t, 0.002, 0.4);
  }
  k.ch(k.playRaw(B), k.bus(0.2, 1, 4));
});

def('phone_ring', 'Static Phone Ring', 'house', 4, 'An old bell phone ringing through crackling static.', (k) => {
  const B = k.raw();
  for (const [a, b] of [[0.05, 1.35], [2.05, 3.35]]) {
    for (let t = a, n = 0; t < b; t += 0.05, n++) {
      const f = n % 2 ? 1180 : 1050;
      [[1, 0.4, 0.18], [2.3, 0.25, 0.12], [3.6, 0.15, 0.08]].forEach(([r, am, d]) => ping(k, B, t, f * r, d, am * 0.4));
    }
  }
  crackle(k, B, 0, 4, 60, 0.4);
  const head = k.f('highpass', 380); k.ch(head, k.f('lowpass', 3400), k.shape(2.5), k.bus(0.15, 1, 4));
  k.ch(k.playRaw(B), head);
  k.ch(k.noise('white'), k.f('highpass', 1000), k.g(0.05), k.out);
});

def('thunder', 'Thunder', 'house', 6, 'Close lightning crack and a long rolling rumble.', (k) => {
  const b = k.bus(0.4, 4, 1.2);
  const cg = k.g(0); k.hit(cg.gain, 0.05, 0.003, 0.8, 0.5); k.ch(k.noise('white', 0, 1), k.f('highpass', 1200), cg, b);
  const lp = k.f('lowpass', 900); k.env(lp.frequency, [[0.05, 900], [2.5, 220, 'e'], [5.9, 120, 'e']]);
  const am = k.g(0.5); k.wobble(am.gain, 6, 0.5);
  const g = k.g(0); k.env(g.gain, [[0.05, 0], [0.3, 1], [0.9, 0.8], [2.2, 0.6], [5.9, 0.001, 'e']]);
  k.ch(k.noise('brown'), lp, am, g, b);
  boom(k, 0.2, 0.5, b, 60, 30, 3);
});

def('wind_gust', 'Wind Gust', 'house', 5, 'Howling gust of wind around the house.', (k) => {
  const p = k.pan(-0.6); k.env(p.pan, [[0, -0.6], [5, 0.6]]); p.connect(k.bus(0.2, 2, 2));
  const env = k.g(0); k.env(env.gain, [[0, 0], [1.6, 1], [3, 0.8], [4.95, 0]]); env.connect(p);
  const fpts = [[0, 350], [1.5, 800], [2.8, 1100], [4, 600], [5, 400]];
  for (const [m, q, a] of [[1, 8, 1], [1.6, 11, 0.6]]) {
    const bp = k.f('bandpass', 350 * m, q); k.env(bp.frequency, fpts.map(([t, f], i) => [t, f * m, i ? 'e' : 0])); k.wobble(bp.detune, 2, 200);
    k.ch(k.noise('pink'), bp, k.g(a * 4), env);
  }
  k.ch(k.noise('pink'), k.f('lowpass', 1200), k.g(0.5), env);
});

def('rain', 'Rain Burst', 'house', 4, 'Sudden downpour against the windows.', (k) => {
  const g = k.g(0); k.env(g.gain, [[0, 0], [0.8, 0.5], [3.2, 0.5], [4, 0]]);
  k.ch(k.noise('pink'), k.f('highpass', 600), k.f('lowpass', 7000), g, k.out);
  const B = k.raw();
  for (let i = 0; i < 1100; i++) {
    const t = k.rand(0.05, 3.9), e = interp([[0, 0], [0.8, 1], [3.2, 1], [4, 0]], t);
    ping(k, B, t, k.rand(2000, 6000), k.rand(0.004, 0.012), k.rand(0.05, 0.3) * e, k.rand(-0.9, 0.9));
    if (k.r() < 0.05) ping(k, B, t, k.rand(700, 1100), 0.02, 0.3 * e, k.rand(-0.9, 0.9));
  }
  k.ch(k.playRaw(B), k.bus(0.15, 1.2, 3));
});

def('glass_tap', 'Tap on Glass', 'house', 2.2, 'Three slow taps on the window… from outside.', (k) => {
  const B = k.raw();
  for (const t of [0.08, 0.5, 0.92]) {
    const f = 2650 * k.rand(0.98, 1.02);
    [[1, 1, 0.35], [1.52, 0.6, 0.25], [2.7, 0.35, 0.12], [4.1, 0.2, 0.08]].forEach(([r, a, d]) => ping(k, B, t, f * r, d, a * 0.3));
    burst(k, B, t, 0.003, 0.4);
  }
  k.ch(k.playRaw(B), k.bus(0.3, 1.5, 3));
});

def('water_drip', 'Basement Drip', 'house', 3, 'Water dripping in a cold, echoing basement.', (k) => {
  const B = k.raw(), sr = k.sr;
  for (const t0 of [0.15, 1.05, 1.85]) {
    const f0 = k.rand(700, 900), i0 = Math.floor(t0 * sr), n = Math.floor(0.06 * sr); let ph = 0;
    for (let i = 0; i < n; i++) {
      const t = i / sr, f = f0 * (1 + 1.4 * Math.min(1, t / 0.02)); ph += TAU * f / sr;
      const v = Math.sin(ph) * Math.exp(-t / 0.015) * 0.6; B[0][i0 + i] += v; B[1][i0 + i] += v;
    }
  }
  k.ch(k.playRaw(B), k.echo(0.31, 0.3, 0.25, k.bus(0.6, 3, 1.5)));
});

/* ---- tech & paranormal */
def('tv_static', 'TV Static Burst', 'tech', 2, 'Harsh analog TV snow with CRT whine.', (k) => {
  const g = k.g(0); const pts = [[0, 0], [0.005, 1]];
  for (let t = 0.05; t < 1.9; t += k.rand(0.03, 0.08)) pts.push([t, k.rand(0.6, 1), 's']);
  pts.push([1.9, 1], [1.99, 0]); k.env(g.gain, pts);
  k.ch(k.noise('white'), k.f('highpass', 150), k.g(0.6), g, k.out);
  const B = k.raw(); crackle(k, B, 0.01, 1.95, 120, 0.8); k.ch(k.playRaw(B), g);
  k.ch(k.osc('sine', 15734), k.g(0.04), g); k.ch(k.osc('sawtooth', 60), k.f('lowpass', 300), k.g(0.08), g);
});

def('spirit_box', 'Spirit Box Sweep', 'tech', 4, 'Radio scanning stations — fragments of voices in the noise.', (k) => {
  const head = k.f('highpass', 300); k.ch(head, k.f('lowpass', 3200), k.g(1.5), k.shape(2), k.bus(0.12, 1, 4));
  k.ch(k.noise('white'), k.g(0.06), head);
  let t = 0.05;
  while (t < 3.9) {
    const d = k.rand(0.07, 0.13), r = k.r(), gate = k.g(0);
    k.env(gate.gain, [[t, 0], [t + 0.005, 1], [t + d - 0.005, 1], [t + d, 0]]); gate.connect(head);
    if (r < 0.4) k.ch(k.noise('white', t, t + d), k.f('bandpass', k.rand(500, 3000), k.rand(1, 4)), k.g(0.7), gate);
    else if (r < 0.65) {
      const o = k.osc('sine', k.rand(600, 3000), t, t + d); k.env(o.frequency, [[t, o.frequency.value], [t + d, o.frequency.value * k.rand(0.7, 1.4), 'e']]);
      k.ch(o, k.g(0.25), gate);
    } else voice(k, { t0: t, t1: t + d, f0: [[t, k.rand(110, 260)], [t + d, k.rand(100, 240)]], vib: null, jit: 30, vowels: [[t, k.pick(['a', 'e', 'o', 'u', 'i'])], [t + d, k.pick(['a', 'e', 'o', 'u'])]], scale: k.rand(0.95, 1.2), breath: 0.2, drive: 2, out: gate, amp: [[t, 1], [t + d, 1]] });
    t += d;
  }
});

function buzzSrc(k, t0, t1) {
  const sum = k.g(1);
  [['sawtooth', 60, 1], ['sawtooth', 120.3, 0.6], ['square', 180, 0.3]].forEach(([ty, f, a]) => k.ch(k.osc(ty, f, t0, t1), k.g(a), sum));
  return { sum, out: k.ch(sum, k.f('bandpass', 600, 0.7), k.g(2), k.shape(4)) };
}
def('power_cut', 'Power Cut', 'tech', 3, 'Electrical buzz, sparks, then everything dies.', (k) => {
  const g = k.g(0); k.env(g.gain, [[0, 0], [0.03, 0.8], [1.7, 0.8], [2.3, 0.0001, 'e']]);
  const B = k.raw();
  const sum = k.g(1);
  [['sawtooth', 60, 1], ['sawtooth', 120.3, 0.6], ['square', 180, 0.3]].forEach(([ty, f, a]) => {
    const o = k.osc(ty, f, 0, 2.4); k.env(o.frequency, [[0, f], [1.7, f], [2.3, f / 5, 'e']]); k.ch(o, k.g(a), sum);
  });
  const am = k.g(0.7); k.wobble(am.gain, 15, 0.3);
  k.ch(sum, k.f('bandpass', 600, 0.7), k.g(2), k.shape(4), am, g, k.bus(0.15, 1.2, 3));
  for (let i = 0; i < 6; i++) { const t = k.rand(0.2, 1.65); crackle(k, B, t, t + k.rand(0.03, 0.12), 900, 0.7); }
  ping(k, B, 1.7, 3000, 0.02, 0.4); burst(k, B, 1.7, 0.005, 0.6);
  k.ch(k.playRaw(B), k.f('highpass', 1500), k.out);
  thump(k, 1.72, 60, 0.7, 0.3, k.bus(0.3, 1.5, 3));
});

def('elec_buzz', 'Electrical Buzz', 'tech', 3, 'Flickering fluorescent light buzzing and sparking.', (k) => {
  const { out } = buzzSrc(k, 0, 3);
  const g = k.g(0), pts = [[0, 0], [0.02, 1]];
  for (let t = 0.1; t < 2.8; t += k.rand(0.04, 0.22)) { pts.push([t, k.r() < 0.3 ? 0.15 : 1, 's']); }
  pts.push([2.8, 1], [2.97, 0]); k.env(g.gain, pts);
  k.ch(out, g, k.bus(0.12, 1, 3));
  const B = k.raw(); for (let i = 0; i < 5; i++) { const t = k.rand(0.2, 2.7); crackle(k, B, t, t + k.rand(0.02, 0.1), 800, 0.6); }
  k.ch(k.playRaw(B), k.f('highpass', 1500), k.out);
});

def('rec_beep', 'Camcorder REC Beep', 'tech', 0.7, 'The little double beep when a camcorder starts recording.', (k) => {
  for (const t of [0.04, 0.24]) {
    const g = k.g(0); k.env(g.gain, [[t, 0], [t + 0.003, 1], [t + 0.12, 1], [t + 0.125, 0]]);
    const s = k.osc('sine', 2700, t, t + 0.13), q = k.osc('square', 2700, t, t + 0.13);
    s.connect(g); k.ch(q, k.g(0.08), g); k.ch(g, k.f('lowpass', 6000), k.out);
  }
});

def('vhs_eject', 'VHS Eject', 'tech', 1.8, 'Motor whir and clunk of a tape popping out.', (k) => {
  const b = k.bus(0.15, 1, 4), o = k.osc('sawtooth', 80, 0, 0.85); k.env(o.frequency, [[0, 80], [0.6, 160, 'e']]);
  const g = k.g(0); k.env(g.gain, [[0, 0], [0.05, 0.4], [0.7, 0.4], [0.8, 0]]);
  const am = k.g(0.7); k.lfo('square', 30, 0.3, am.gain); k.ch(o, k.f('lowpass', 600), am, g, b);
  const B = k.raw(); burst(k, B, 0.05, 0.01, 0.4);
  burst(k, B, 1.05, 0.015, 0.5); ping(k, B, 1.05, 1800, 0.05, 0.25); ping(k, B, 1.05, 2700, 0.04, 0.2);
  for (let i = 0; i < 4; i++) ping(k, B, 1.1 + i * 0.04 + k.rand(0, 0.02), k.rand(900, 2000), 0.03, 0.1);
  k.ch(k.playRaw(B), b);
  thump(k, 0.75, 90, 0.7, 0.15, b); thump(k, 1.05, 140, 0.5, 0.1, b);
});

def('vhs_rewind', 'VHS Rewind', 'tech', 3.2, 'Whining rewind that speeds up and clunks to a stop.', (k) => {
  const b = k.bus(0.12, 1, 4), g = k.g(0); k.env(g.gain, [[0, 0], [0.1, 0.5], [2.6, 1], [2.75, 0]]); g.connect(b);
  const o = k.osc('sawtooth', 120, 0, 2.8); k.env(o.frequency, [[0, 120], [2.6, 900, 'e']]);
  const am = k.g(0.7), lf = k.lfo('sine', 40, 0.3, am.gain); k.env(lf.frequency, [[0, 40], [2.6, 120, 'e']]);
  k.ch(o, k.f('bandpass', 1200, 1), am, g);
  const sq = k.osc('sine', 3000, 0, 2.8); k.env(sq.frequency, [[0, 3000], [2.6, 5200]]); k.lfo('sine', 7, 20, sq.detune); k.ch(sq, k.g(0.05), g);
  k.ch(k.noise('white'), k.f('highpass', 3000), k.g(0.15), g);
  thump(k, 2.75, 100, 0.8, 0.15, b);
  const B = k.raw(); burst(k, B, 2.75, 0.01, 0.4); ping(k, B, 2.76, 2200, 0.04, 0.2); k.ch(k.playRaw(B), b);
});

def('glitch', 'Glitch Stutter', 'tech', 1.6, 'Digital stutter, bit-crush and data corruption.', (k) => {
  const B = k.raw(); glitchRaw(k, B, 0.01, 1.55); k.ch(k.playRaw(B), k.out);
});

def('evp', 'EVP Voice', 'tech', 3.2, 'Ghostly backwards voice buried in recorder hiss.', async (k) => {
  const fw = await k.sub(2.6, (s) => {
    const o = s.bus(0.5, 1.5, 2.5);
    voice(s, { t0: 0.1, t1: 0.8, f0: [[0.1, 140], [0.8, 110]], vowels: [[0.1, 'e'], [0.8, 'a']], breath: 0.3, out: o });
    voice(s, { t0: 0.95, t1: 1.9, f0: [[0.95, 125], [1.4, 150], [1.9, 95]], vowels: [[0.95, 'a'], [1.5, 'u'], [1.9, 'o']], breath: 0.3, out: o });
  });
  const am = k.g(0.6); k.lfo('sine', 6, 0.4, am.gain);
  k.ch(k.play(k.reverse(fw), 0.3), k.f('highpass', 450), k.f('lowpass', 2200), k.g(3), k.crush(24), am, k.bus(0.3, 2, 2));
  k.ch(k.noise('pink'), k.f('bandpass', 1500, 0.5), k.g(0.12), k.out);
  const B = k.raw(); crackle(k, B, 0, 3.2, 25, 0.3); k.ch(k.playRaw(B), k.f('highpass', 800), k.out);
});

def('distortion_burst', 'Distortion Drone Burst', 'tech', 2.5, 'Crushing wall of distorted low drone.', (k) => {
  const lp = k.f('lowpass', 4000, 2); k.env(lp.frequency, [[0, 4000], [2.4, 300, 'e']]);
  const g = k.g(0); k.env(g.gain, [[0, 0], [0.02, 1], [0.3, 0.8], [2.4, 0.001, 'e']]);
  const am = k.g(0.75); k.lfo('square', 17, 0.25, am.gain);
  const sum = k.g(1); [41.2, 43.65, 61.7, 82.4 * 1.01].forEach((f) => k.ch(k.osc('sawtooth', f), k.g(0.4), sum));
  k.ch(k.noise('brown'), k.g(0.5), sum);
  k.ch(sum, k.g(3), k.shape(8), lp, am, g, k.bus(0.2, 1.5, 2.5));
});

def('tinnitus', 'Tinnitus Ring', 'tech', 5, 'Muffled blast followed by a high ringing in your ears.', (k) => {
  const lp = k.f('lowpass', 250); lp.connect(k.out); boom(k, 0.02, 1, lp, 60, 35, 0.8);
  const ng = k.g(0); k.hit(ng.gain, 0.02, 0.003, 0.6, 0.5); k.ch(k.noise('brown', 0, 1), k.f('lowpass', 300), ng, k.out);
  const g = k.g(0); k.env(g.gain, [[0.05, 0], [0.3, 0.25], [2, 0.22], [4.9, 0]]);
  k.ch(k.osc('sine', 7040), g, k.out); k.ch(k.osc('sine', 7052), k.g(0.5), g);
});

/* ---- risers & tension */
def('riser', 'Tension Riser', 'tension', 4, 'Four-second build that cuts off right before the scare.', (k) => {
  const T = 3.92, b = k.bus(0.25, 2, 2), cut = k.g(1); k.env(cut.gain, [[0, 1], [T, 1], [T + 0.03, 0]]); cut.connect(b);
  const bp = k.f('bandpass', 200, 2.5); k.env(bp.frequency, [[0, 200], [T, 9000, 'e']]);
  const ng = k.g(0.0001); k.env(ng.gain, [[0, 0.0001], [T, 1, 'e']]); k.ch(k.noise('white'), bp, ng, cut);
  const lp = k.f('lowpass', 400); k.env(lp.frequency, [[0, 400], [T, 6000, 'e']]);
  const trem = k.g(0.6), lf = k.lfo('sine', 3, 0.4, trem.gain); k.env(lf.frequency, [[0, 3], [T, 22, 'e']]);
  const sg = k.g(0.0001); k.env(sg.gain, [[0, 0.0001], [T, 0.8, 'e']]);
  k.ch(lp, trem, sg, cut);
  [110, 116.5, 164.8, 220 * 1.01].forEach((f) => { const o = k.osc('sawtooth', f); k.env(o.frequency, [[0, f], [T, f * 4, 'e']]); k.ch(o, k.g(0.25), lp); });
});

def('shepard', 'Endless Rise', 'tension', 6, 'Shepard-tone illusion: a pitch that rises forever.', (k) => {
  const B = k.raw(), sr = k.sr, n = B[0].length, V = 8, fmin = 40, per = 3, ph = new Float64Array(V * 2);
  for (let i = 0; i < n; i++) {
    const t = i / sr, ge = Math.min(1, t / 0.4, (k.len - t) / 0.2);
    let l = 0, r = 0;
    for (let v = 0; v < V; v++) {
      const oct = (v + t / per) % V, f = fmin * Math.pow(2, oct), x = (oct - 3.5) / 1.4, a = Math.exp(-x * x / 2);
      for (let d = 0; d < 2; d++) {
        const j = v * 2 + d; ph[j] += TAU * f * (d ? 1.0047 : 1) / sr; const s = Math.sin(ph[j]) * a;
        if ((v + d) % 2) l += s; else r += s;
      }
    }
    B[0][i] = l * ge * 0.2; B[1][i] = r * ge * 0.2;
  }
  k.ch(k.playRaw(B), k.bus(0.3, 2, 2));
});

def('string_swell', 'String Tremolo Swell', 'tension', 5, 'Trembling dissonant strings swelling up.', (k) => {
  const lp = k.f('lowpass', 500); k.env(lp.frequency, [[0, 500], [4.6, 6000, 'e']]);
  const trem = k.g(0.55); k.lfo('sine', 11, 0.45, trem.gain);
  const g = k.g(0.0001); k.env(g.gain, [[0, 0.0001], [4.6, 1, 'e'], [4.95, 0]]);
  k.ch(lp, trem, g, k.bus(0.3, 2.5, 2));
  [146.8, 155.6, 220, 233, 349, 370, 587].forEach((f) => { for (const d of [-10, 10]) { const o = k.osc('sawtooth', f, 0, 5, d); k.lfo('sine', k.rand(4.5, 6), 8, o.detune); k.ch(o, k.g(0.1), lp); } });
});

def('drone_swell', 'Low Drone Swell', 'tension', 6, 'Ominous low drone rising out of nothing.', (k) => {
  const lp = k.f('lowpass', 120, 3); k.env(lp.frequency, [[0, 120], [5, 1400, 'e']]);
  const g = k.g(0.0001); k.env(g.gain, [[0, 0.0001], [5.2, 1, 'e'], [5.95, 0]]);
  const sum = k.g(1); [36.7, 55, 55 * 1.006, 73.4 * 0.997].forEach((f) => k.ch(k.osc('sawtooth', f), k.g(0.3), sum));
  k.ch(k.noise('brown'), k.g(0.4), sum); k.ch(k.osc('sine', 27.5), k.g(0.5), g);
  k.ch(sum, lp, k.shape(2), g, k.bus(0.35, 3, 1.5));
});

def('silence_suck', 'Silence Suck', 'tension', 2.8, 'Reverse reverb that sucks all sound into dead silence.', async (k) => {
  const fw = await k.sub(2.5, (s) => {
    const b = s.bus(1.2, 2.5, 1.8); boom(s, 0.005, 0.8, b, 100, 40, 1.5);
    const ng = s.g(0); s.hit(ng.gain, 0.005, 0.001, 1, 1); s.ch(s.noise('white', 0, 1.5), s.f('lowpass', 6000), ng, b);
    [110, 116.5, 155.6].forEach((f) => { const o = s.osc('sawtooth', f, 0, 2), og = s.g(0); s.hit(og.gain, 0.005, 0.005, 0.25, 1.6); s.ch(o, s.f('lowpass', 2000), og, b); });
  });
  const g = k.g(1); k.env(g.gain, [[0, 1], [2.48, 1], [2.49, 0]]);
  k.ch(k.play(k.reverse(fw), 0), g, k.out);
});

def('heartbeat_race', 'Racing Heartbeat', 'tension', 6, 'Heartbeat that speeds up as panic sets in.', (k) => {
  const b = k.f('lowpass', 450); b.connect(k.out);
  let t = 0.05, iv = 0.95, i = 0;
  while (t < 5.7) { const a = 0.6 + 0.4 * (t / 6); thump(k, t, 50 + i, a, 0.28, b); thump(k, t + iv * 0.3, 46 + i, a * 0.65, 0.3, b); t += iv; iv = Math.max(0.36, iv * 0.9); i++; }
  const dg = k.g(0.0001); k.env(dg.gain, [[0, 0.0001], [5.8, 0.25, 'e'], [5.98, 0]]);
  k.ch(k.osc('sawtooth', 41.2), k.f('lowpass', 200), dg, k.out);
});

/* ------------------------------------------------------------------ beds */

const BED_DEFS = [];
const bed = (id, name, desc, fn, opts = {}) => BED_DEFS.push({ id, name, desc, fn, opts });

bed('dread', 'Dread Drone', 'Dark, slowly breathing low drone with beating overtones.', (k) => {
  const L = k.len, P = k.P, out = k.bus(0.4, 4, 1.5);
  const lp = k.f('lowpass', 320, 2); k.lfo('sine', k.q(2 / P), 140, lp.frequency); k.ch(lp, k.g(0.5), out);
  [36.7, 55, 58.3, 73.4].forEach((f) => { for (const d of [0.997, 1.003]) k.ch(k.osc('sawtooth', k.q(f * d), 0, L), k.g(0.25), lp); });
  k.ch(k.osc('sine', k.q(36.7), 0, L), k.g(0.35), out);
  const wg = k.g(0.12); k.lfo('sine', k.q(3 / P), 0.08, wg.gain); k.ch(k.noise('pink', 0, L), k.f('bandpass', 600, 0.8), wg, out);
  const hg = k.g(0.02); k.lfo('sine', k.q(1 / P), 0.02, hg.gain);
  k.ch(k.osc('sine', k.q(1760), 0, L), hg, out); k.ch(k.osc('sine', k.q(1866), 0, L), hg);
});

bed('haunted_house', 'Haunted House', 'Wind outside, creaking timbers and distant thumps.', (k) => {
  const L = k.len, out = k.bus(0.3, 3, 1.8);
  const bp = k.f('bandpass', 500, 5); k.wobble(bp.detune, 0.3, 700); const wg = k.g(1.2); k.wobble(wg.gain, 0.2, 0.6);
  k.ch(k.noise('pink', 0, L), bp, wg, out); k.ch(k.noise('pink', 0, L), k.f('lowpass', 800), k.g(0.18), out);
  for (let t = k.rand(1, 3); t < L - 1; t += k.rand(3.5, 8)) {
    const d = k.rand(0.6, 1.6), r1 = k.rand(10, 30), r2 = k.rand(40, 160);
    creak(k, t, d, [[0, r1], [d * 0.5, r2], [d, r1]], [[0, 0], [d * 0.3, 1], [d, 0]], k.r() < 0.5 ? WOOD : FLOOR, k.ch(k.pan(k.rand(-0.8, 0.8)), out), 0.25);
  }
  const far = k.verb(4, 1.2, 1.2);
  for (let t = k.rand(2, 6); t < L - 1; t += k.rand(5, 10)) { thump(k, t, 50, 0.35, 0.3, far); if (k.r() < 0.5) thump(k, t + 0.4, 55, 0.25, 0.3, far); }
});

bed('lullaby', 'Creepy Music Box Lullaby', 'Detuned minor music-box melody with slightly wrong timing.', (k) => {
  const P = k.P, L = k.len, B = k.raw();
  const mel = [69, 72, 76, 72, 74, 72, 71, 68, 69, 71, 72, 69, 64, 65, 64, 63, 69, 72, 76, 79, 77, 76, 74, 71, 72, 71, 69, 68, 69, 64, 69, null];
  const bass = [45, 41, 40, 45, 45, 41, 40, 44];
  const phrases = Math.max(1, Math.round(P / 15)), beat = P / (phrases * mel.length);
  const total = phrases * mel.length;
  for (let idx = 0; idx * beat < L; idx++) {
    const n = idx % total, rr = mulberry32(n * 7919 + 13), note = mel[n % mel.length];
    const t = idx * beat + (rr() - 0.5) * beat * 0.18;
    const det = Math.pow(2, ((rr() - 0.5) * 40 - (n % 7 === 3 ? 35 : 0)) / 1200);
    if (note) musicNote(k, B, Math.max(0, t), midi(note + 12) * det, 0.3, (rr() - 0.5) * 0.4);
    if (n % 4 === 0) musicNote(k, B, Math.max(0, t), midi(bass[(n / 4) % bass.length] + 12) * det, 0.18);
  }
  k.ch(k.playRaw(B), k.f('highpass', 250), k.echo(beat * 3, 0.25, 0.18, k.bus(0.4, 3, 1.6)));
  k.ch(k.noise('pink', 0, L), k.f('lowpass', 1500), k.g(0.01), k.out);
}, { xfade: 'linear' });

bed('heartbeat_amb', 'Heartbeat Ambience', 'Slow heartbeat under a dark breathing drone.', (k) => {
  const P = k.P, L = k.len, n = Math.max(1, Math.round(P / 1.05)), iv = P / n, b = k.f('lowpass', 420); b.connect(k.out);
  for (let t = 0.02; t < L; t += iv) { thump(k, t, 52, 1, 0.3, b); thump(k, t + 0.28, 48, 0.62, 0.34, b); }
  const dg = k.g(0.08); k.lfo('sine', k.q(2 / P), 0.04, dg.gain);
  k.ch(k.osc('sawtooth', k.q(41.2), 0, L), k.f('lowpass', 180), dg, k.out);
  const ng = k.g(0.03); k.lfo('sine', k.q(0.25), 0.025, ng.gain); k.ch(k.noise('pink', 0, L), k.f('bandpass', 900, 1), ng, k.out);
}, { xfade: 'linear' });

bed('hospital', 'Abandoned Hospital', 'Fluorescent hum, air vents and distant metal clanks.', (k) => {
  const L = k.len, out = k.bus(0.25, 3, 1.5);
  k.ch(k.osc('sawtooth', k.q(60), 0, L), k.f('lowpass', 400), k.g(0.12), out);
  const fg = k.g(0.04); k.wobble(fg.gain, 4, 0.03); k.ch(k.osc('square', k.q(120), 0, L), k.f('bandpass', 2400, 2), fg, out);
  k.ch(k.noise('pink', 0, L), k.f('lowpass', 1200), k.g(0.15), out);
  const B = k.raw(), far = k.bus(0.9, 4, 1.1);
  for (let t = k.rand(1, 4); t < L - 2; t += k.rand(4, 9)) {
    const base = k.rand(150, 400), p = k.rand(-0.7, 0.7);
    [[1, 1, 1.5], [2.32, 0.6, 1], [4.25, 0.4, 0.6], [6.8, 0.2, 0.4]].forEach(([r, a, d]) => ping(k, B, t, base * r, d, a * 0.12, p));
    burst(k, B, t, 0.02, 0.1, p);
  }
  k.ch(k.playRaw(B), k.f('lowpass', 2500), far);
});

bed('forest_night', 'Forest at Night', 'Crickets, a cold breeze and an owl somewhere out there.', (k) => {
  const L = k.len, B = k.raw();
  for (let c = 0; c < 4; c++) {
    const f = k.rand(4300, 5300), p = k.rand(-0.8, 0.8), per = k.rand(0.45, 0.8);
    for (let t = k.rand(0, 1); t < L; t += per * k.rand(0.95, 1.05)) for (let j = 0; j < 3; j++) ping(k, B, t + j * 0.028, f, 0.018, 0.05, p, 0.003);
  }
  for (let t = k.rand(3, 8); t < L - 2; t += k.rand(9, 15)) {
    const p = k.rand(-0.6, 0.6);
    [0, 0.55, 0.8].forEach((o, j) => {
      const i0 = Math.floor((t + o) * k.sr), n = Math.floor(0.32 * k.sr), f = 380 - j * 12;
      for (let i = 0; i < n && i0 + i < B[0].length; i++) {
        const tt = i / k.sr, e = Math.sin(Math.PI * tt / 0.32) ** 2, v = (Math.sin(TAU * f * tt) + 0.15 * Math.sin(TAU * 2 * f * tt)) * e * 0.12;
        B[0][i0 + i] += v * (1 - p) / 2; B[1][i0 + i] += v * (1 + p) / 2;
      }
    });
  }
  for (let t = k.rand(2, 6); t < L - 1; t += k.rand(6, 12)) burst(k, B, t, 0.01, 0.12, k.rand(-1, 1));
  k.ch(k.playRaw(B), k.bus(0.3, 2.5, 2));
  const wg = k.g(0.25); k.wobble(wg.gain, 0.15, 0.15); k.ch(k.noise('pink', 0, L), k.f('lowpass', 600), wg, k.out);
});

bed('ritual', 'Ritual Chant', 'Low chanting voices and a slow drum, deep in the woods.', (k) => {
  const P = k.P, L = k.len, out = k.bus(0.55, 4, 1.2);
  const nb = Math.max(1, Math.round(P / 1.4)), beat = P / nb;
  const seq = ['o', 'a', 'u', 'o', 'a', 'o', 'u', 'u'];
  const vow = []; for (let i = 0; i * beat * 2 < L + 1; i++) vow.push([i * beat * 2, seq[i % seq.length]]);
  [[73.4, 0, 1], [110, 0.2, 0.7], [146.8, -0.3, 0.5], [73.4 * 1.004, 0.4, 0.6]].forEach(([f, p, a]) => {
    voice(k, { t0: 0, t1: L, f0: [[0, k.q(f)], [L, k.q(f)]], vib: [k.q(4.5), 12], jit: 10, vowels: vow, scale: 0.85, breath: 0.08, out, pan: p, gain: a, amp: [[0, a], [L, a]] });
  });
  for (let t = 0.02; t < L; t += beat) thump(k, t, 70, 0.4, 0.4, out);
}, { xfade: 'linear' });

bed('tension_strings', 'Tension Strings', 'Sustained dissonant strings that never resolve.', (k) => {
  const P = k.P, L = k.len, lp = k.f('lowpass', 1500); k.lfo('sine', k.q(2 / P), 900, lp.frequency);
  const trem = k.g(0.7); k.lfo('sine', k.q(8), 0.25, trem.gain);
  const sw = k.g(0.6); k.lfo('sine', k.q(3 / P), 0.35, sw.gain);
  k.ch(lp, trem, sw, k.bus(0.4, 3, 1.6));
  [110, 116.5, 164.8, 233, 246.9, 349.2, 659.3, 698.5].forEach((f, i) => {
    for (const d of [0.996, 1.004]) { const o = k.osc('sawtooth', k.q(f * d), 0, L); k.ch(o, k.g(i > 5 ? 0.05 : 0.12), lp); }
  });
});

bed('glitch_amb', 'Glitch Ambience', 'Broken electronics: hum, data chatter and stutters.', (k) => {
  const L = k.len, B = k.raw();
  k.ch(k.osc('sine', k.q(45), 0, L), k.g(0.2), k.out);
  k.ch(k.osc('square', k.q(90), 0, L), k.f('lowpass', 300), k.g(0.05), k.out);
  for (let t = k.rand(0.5, 2); t < L - 1; t += k.rand(1.5, 4)) {
    if (k.r() < 0.6) glitchRaw(k, B, t, k.rand(0.15, 0.6), 0.35);
    else for (let j = 0; j < k.irand(2, 6); j++) ping(k, B, t + j * 0.07, k.rand(1000, 3000), 0.05, 0.12, k.rand(-0.7, 0.7), 0.002);
  }
  k.ch(k.playRaw(B), k.bus(0.2, 1.5, 3));
  k.ch(k.noise('white', 0, L), k.f('highpass', 4000), k.g(0.015), k.out);
});

bed('room_tone', 'Silence with Room Tone', 'Near-silence: quiet room air with a rare distant sound.', (k) => {
  const L = k.len;
  k.ch(k.noise('pink', 0, L), k.f('lowpass', 500), k.g(0.035), k.out);
  k.ch(k.osc('sine', k.q(50), 0, L), k.g(0.004), k.out);
  const far = k.ch(k.f('lowpass', 1200), k.g(1)); far.connect(k.verb(3, 1.5, 0.8));
  let t = k.rand(3, 8);
  creak(k, t, 1, [[0, 15], [0.5, 40], [1, 15]], [[0, 0], [0.3, 1], [1, 0]], FLOOR, k.verb(3, 1.5, 0.6), 0.15);
  t += k.rand(8, 14); if (t < L - 1) thump(k, t, 60, 0.12, 0.3, k.verb(3, 1.5, 0.8));
});

/* ------------------------------------------------------------------ public API */

export const SFX = DEFS.map(({ id, name, cat, dur, desc }) => ({ id, name, cat, dur, desc }));
export const BEDS = BED_DEFS.map(({ id, name, desc }) => ({ id, name, desc }));
const SFX_MAP = new Map(DEFS.map((d) => [d.id, d]));
const BED_MAP = new Map(BED_DEFS.map((d) => [d.id, d]));
const cache = new Map();

function finish(buf, target, fadeIn, fadeOut) {
  let peak = 0;
  const chs = [];
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const d = buf.getChannelData(c); chs.push(d);
    for (let i = 0; i < d.length; i++) {
      const v = d[i];
      if (!Number.isFinite(v)) d[i] = 0; else if (Math.abs(v) > peak) peak = Math.abs(v);
    }
  }
  const s = peak > 1e-9 ? target / peak : 0;
  const fi = Math.floor(fadeIn * buf.sampleRate), fo = Math.floor(fadeOut * buf.sampleRate);
  for (const d of chs) {
    const n = d.length;
    for (let i = 0; i < n; i++) d[i] *= s;
    for (let i = 0; i < fi && i < n; i++) d[i] *= i / fi;
    for (let i = 0; i < fo && i < n; i++) d[n - 1 - i] *= i / fo;
  }
  return buf;
}

function memo(key, fn) {
  if (!cache.has(key)) {
    const p = fn(); cache.set(key, p); p.catch(() => cache.delete(key));
  }
  return cache.get(key);
}

export async function renderSfx(id, { sampleRate = 48000, seed = 1 } = {}) {
  const d = SFX_MAP.get(id);
  if (!d) throw new Error(`Unknown SFX id: ${id}`);
  return memo(`sfx|${id}|${seed}|${sampleRate}`, async () => {
    const ctx = new OfflineAudioContext(2, Math.round(d.dur * sampleRate), sampleRate);
    const k = new Kit(ctx, mulberry32(hashStr(id) ^ Math.imul(seed, 2654435761)));
    await d.fn(k);
    return finish(await ctx.startRendering(), 0.891, 0.002, 0.03);
  });
}

export async function renderBed(id, { seconds = 30, sampleRate = 48000, seed = 1 } = {}) {
  const d = BED_MAP.get(id);
  if (!d) throw new Error(`Unknown bed id: ${id}`);
  seconds = Math.max(4, seconds);
  return memo(`bed|${id}|${seed}|${sampleRate}|${seconds}`, async () => {
    const N = Math.round(seconds * sampleRate), X = Math.round(Math.min(3, seconds * 0.25) * sampleRate);
    const ctx = new OfflineAudioContext(2, N + X, sampleRate);
    const k = new Kit(ctx, mulberry32(hashStr('bed:' + id) ^ Math.imul(seed, 2654435761)), { loop: seconds });
    await d.fn(k);
    const r = await ctx.startRendering();
    const out = new AudioBuffer({ numberOfChannels: 2, length: N, sampleRate });
    const lin = d.opts.xfade === 'linear';
    for (let c = 0; c < 2; c++) {
      const src = r.getChannelData(c), o = out.getChannelData(c);
      o.set(src.subarray(0, N));
      // crossfade the overrun tail into the head: o[0] continues exactly from o[N-1]
      for (let i = 0; i < X; i++) {
        const a = i / X, fi = lin ? a : Math.sin(a * Math.PI / 2), fo = lin ? 1 - a : Math.cos(a * Math.PI / 2);
        o[i] = src[i] * fi + src[N + i] * fo;
      }
    }
    return finish(out, 0.505, 0, 0);
  });
}
