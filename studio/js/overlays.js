// Text, camera HUDs and spooks (stickers), drawn on a 2D canvas that the compositor lays over the footage.
import { drawSticker } from "./stickers.js";

export const FONTS = {
  serif: '"Times New Roman", Georgia, serif',
  type: '"Special Elite", "Courier New", monospace',
  creep: 'Creepster, Impact, sans-serif',
  drip: 'Nosifer, Creepster, Impact, sans-serif',
  sans: 'Inter, Arial, sans-serif',
  mono: '"Courier New", ui-monospace, monospace',
  impact: 'Impact, "Arial Black", sans-serif',
};

export async function loadFonts() {
  const fams = ["Creepster", "Special Elite", "Nosifer", "Inter"];
  try { await Promise.all(fams.map(f => document.fonts.load(`40px "${f}"`))); } catch (_) {}
}

export const TEXT_STYLES = {
  title:      { name: "Movie title",       font: "serif", color: "#efe9e2", spacing: 0.22, upper: true,  anim: "fade",    size: 0.075, desc: "Big spaced-out serif, fades in slow." },
  creepy:     { name: "Creepy",            font: "creep", color: "#d4202c", spacing: 0.04, upper: false, anim: "flicker", size: 0.09,  desc: "Horror-poster lettering in blood red." },
  drip:       { name: "Dripping",          font: "drip",  color: "#c0141f", spacing: 0.02, upper: true,  anim: "fade",    size: 0.065, desc: "Letters that look like they're bleeding." },
  typewriter: { name: "Typewriter",        font: "type",  color: "#e8e8e8", spacing: 0.0,  upper: false, anim: "type",    size: 0.04,  desc: "Types itself out with a blinking cursor." },
  subtitle:   { name: "Subtitle",          font: "sans",  color: "#ffffff", spacing: 0.0,  upper: false, anim: "none",    size: 0.036, desc: "Plain caption with a dark box, bottom of the frame.", pos: "bottom", box: true },
  glitch:     { name: "Glitch",            font: "mono",  color: "#ffffff", spacing: 0.1,  upper: true,  anim: "glitch",  size: 0.06,  desc: "Torn RGB text that jitters." },
  slam:       { name: "Trailer slam",      font: "impact",color: "#ffffff", spacing: 0.06, upper: true,  anim: "slam",    size: 0.085, desc: "Punches in big, like a movie trailer card." },
  whisper:    { name: "Whisper",           font: "serif", color: "#b9c4cc", spacing: 0.3,  upper: false, anim: "breathe", size: 0.04,  desc: "Faint italic text that drifts and fades." },
  evidence:   { name: "Case file",         font: "type",  color: "#111111", spacing: 0.04, upper: true,  anim: "type",    size: 0.04,  desc: "Typed onto a yellow evidence label.", tape: true },
  scrawl:     { name: "Scrawled warning",  font: "creep", color: "#7d0b12", spacing: 0.02, upper: true,  anim: "shake",   size: 0.11,  desc: "Shaky red letters, like GET OUT on a wall." },
  nightcard:  { name: "Night card",        font: "serif", color: "#efe9e2", spacing: 0.2,  upper: true,  anim: "fade",    size: 0.07,  desc: "NIGHT #1 with a date under it, on black.", bg: "black" },
};

export const HUDS = {
  camcorder: { name: "Camcorder", desc: "Blinking REC, battery, running time code and the date." },
  nightvision: { name: "Night-vision camcorder", desc: "REC, NIGHT SHOT, the clock and an IR icon." },
  seccam:    { name: "Security camera", desc: "CAM 01, live dot and a ticking timestamp." },
  vhs:       { name: "VHS playback", desc: "PLAY ▶, SP and an old VCR date in the corner." },
  ghosthunt: { name: "Ghost hunter", desc: "EMF meter that spikes, a falling temperature readout and spirit-box frequency." },
  bodycam:   { name: "Body cam", desc: "Unit number, timestamp and GPS coordinates." },
  phone:     { name: "Phone recording", desc: "Red recording pill and timer at the top, like a phone's camera." },
  found:     { name: "Recovered footage", desc: "EVIDENCE tag, tape number and a case-file stamp." },
};

const pad = n => String(n).padStart(2, "0");
const clamp01 = x => Math.max(0, Math.min(1, x));
function rnd(seed) { let a = (seed * 1e9) >>> 0 || 1; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

function clockAt(project, t) {
  const base = new Date(project.clockStart || Date.now());
  return new Date((isNaN(base) ? Date.now() : base.getTime()) + t * 1000);
}
const time12 = d => { let h = d.getHours(); const ap = h >= 12 ? "PM" : "AM"; h = h % 12 || 12; return `${h}:${pad(d.getMinutes())}:${pad(d.getSeconds())} ${ap}`; };
const MON = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];

// ---------------------------------------------------------------------------------------------
export function drawOverlays(ctx, W, H, project, t, extra = []) {
  ctx.clearRect(0, 0, W, H);
  const items = project.overlays.filter(o => t >= o.start && t < o.start + o.dur).concat(extra);
  for (const o of items) {
    const lt = t - o.start;
    ctx.save();
    try {
      if (o.kind === "text") drawText(ctx, W, H, o.props, lt, o.dur, t);
      else if (o.kind === "hud") drawHud(ctx, W, H, o.props, lt, project, t);
      else if (o.kind === "sticker") drawSpook(ctx, W, H, o.props, lt, o.dur, o.id);
    } catch (e) { console.warn("overlay draw failed", e); }
    ctx.restore();
  }
}

// ---------------------------------------------------------------------------------------------
// text
function wrap(ctx, text, maxW, spacing) {
  const out = [];
  for (const para of String(text).split("\n")) {
    const words = para.split(/\s+/).filter(Boolean);
    if (!words.length) { out.push(""); continue; }
    let cur = words[0];
    for (const w of words.slice(1)) { const s = cur + " " + w; if (measure(ctx, s, spacing) <= maxW) cur = s; else { out.push(cur); cur = w; } }
    out.push(cur);
  }
  return out;
}
function measure(ctx, s, spacing) { return ctx.measureText(s).width + spacing * Math.max(0, [...s].length - 1); }
function spacedText(ctx, s, x, y, spacing, stroke = false) {
  if (!spacing) { stroke ? ctx.strokeText(s, x, y) : ctx.fillText(s, x, y); return; }
  for (const ch of s) { stroke ? ctx.strokeText(ch, x, y) : ctx.fillText(ch, x, y); x += ctx.measureText(ch).width + spacing; }
}

export function drawText(ctx, W, H, p, lt, dur, tAbs = 0) {
  const st = TEXT_STYLES[p.style] || TEXT_STYLES.title;
  const M = Math.min(W, H);
  const size = Math.round(M * (p.size || st.size) * (H > W ? 1.0 : 1.0));
  const anim = p.anim || st.anim;
  let text = p.text ?? "";
  if (st.upper) text = text.toUpperCase();
  const r = rnd((p.seed || 0.37) + Math.floor(tAbs * 24) * 0.001);

  // background card
  const bg = p.bg || st.bg;
  if (bg === "black" || bg === "dim") {
    const a = bg === "black" ? clamp01(Math.min(lt / 0.25, (dur - lt) / 0.25)) : 0.55;
    ctx.fillStyle = `rgba(0,0,0,${bg === "black" ? Math.max(a, 0) : a})`; ctx.fillRect(0, 0, W, H);
  }

  // alpha envelope
  let alpha = 1;
  const fin = Math.min(0.8, dur * 0.25), fout = Math.min(0.7, dur * 0.25);
  if (anim === "fade" || anim === "breathe" || anim === "flicker") alpha = clamp01(Math.min(lt / fin, (dur - lt) / fout));
  if (anim === "flicker" && r() < 0.12) alpha *= 0.25 + r() * 0.4;
  if (anim === "breathe") alpha *= 0.55 + 0.35 * Math.sin(lt * 2.1);
  if (anim === "type" || anim === "glitch" || anim === "slam" || anim === "shake" || anim === "none") alpha = clamp01((dur - lt) / 0.2);
  ctx.globalAlpha = alpha * (p.opacity ?? 1);

  ctx.font = `${st.font === "type" || st.font === "serif" ? "" : ""}${size}px ${FONTS[st.font]}`;
  if (st.font === "serif" && p.style === "whisper") ctx.font = `italic ${size}px ${FONTS.serif}`;
  const spacing = size * st.spacing;
  ctx.textBaseline = "middle";
  const lines = wrap(ctx, text, W * 0.86, spacing);
  const lh = size * 1.25;
  const pos = p.pos || st.pos || "center";
  let cy = pos === "top" ? H * 0.14 + lh * lines.length / 2 : pos === "bottom" ? H * 0.86 - lh * lines.length / 2 : pos === "custom" ? H * (p.y ?? 0.5) : H / 2;
  const cx = pos === "custom" ? W * (p.x ?? 0.5) : W / 2;

  // typewriter reveal
  let shown = lines.join("\n").length;
  if (anim === "type") shown = Math.floor(lt * (p.cps || 16));
  let scale = 1, dx = 0, dy = 0;
  if (anim === "slam") { const k = clamp01(lt / 0.12); scale = 1.6 - 0.6 * k + 0.04 * clamp01((lt - 0.12) / Math.max(0.1, dur)); if (lt < 0.05) { ctx.fillStyle = "rgba(255,255,255,0.8)"; ctx.fillRect(0, 0, W, H); } }
  if (anim === "breathe") { dy = Math.sin(lt * 0.9) * size * 0.15; dx = Math.sin(lt * 0.6) * size * 0.2; }
  ctx.translate(cx + dx, cy + dy); ctx.scale(scale, scale);

  let y = -lh * (lines.length - 1) / 2, used = 0;
  for (const ln of lines) {
    let s = ln, cursor = false;
    if (anim === "type") {
      const left = shown - used, last = ln === lines[lines.length - 1] && used + ln.length >= shown - 1;
      s = left <= 0 ? "" : ln.slice(0, left);
      cursor = (left >= 0 && left <= ln.length) || (last && left > ln.length) || (used === 0 && left <= 0);
      used += ln.length + 1;
    }
    const w = measure(ctx, ln, spacing);
    let x = -w / 2;
    if (st.box || p.box) {
      ctx.fillStyle = "rgba(0,0,0,0.62)";
      const ww = measure(ctx, s, spacing);
      if (s) ctx.fillRect(-ww / 2 - size * 0.4, y - lh / 2, ww + size * 0.8, lh);
      x = -ww / 2;
    }
    if (st.tape) {
      ctx.save(); ctx.fillStyle = "#f2c82c"; ctx.rotate(-0.03);
      ctx.fillRect(-w / 2 - size * 0.6, y - lh * 0.55, w + size * 1.2, lh * 1.1);
      ctx.restore();
    }
    const color = p.color || st.color;
    if (anim === "glitch") {
      const j = () => (r() - 0.5) * size * (r() < 0.25 ? 0.6 : 0.12);
      ctx.globalCompositeOperation = "lighter";
      ctx.fillStyle = "rgba(255,0,40,0.85)"; spacedText(ctx, s, x + j() - size * 0.05, y + j() * 0.3, spacing);
      ctx.fillStyle = "rgba(0,220,255,0.85)"; spacedText(ctx, s, x + j() + size * 0.05, y + j() * 0.3, spacing);
      ctx.fillStyle = color; spacedText(ctx, s, x + j() * 0.3, y, spacing);
      ctx.globalCompositeOperation = "source-over";
      if (r() < 0.3) { ctx.clearRect(x - 5, y + (r() - 0.5) * size, w + 10, size * 0.12 * r()); }
    } else {
      if (anim === "shake") { ctx.save(); ctx.translate((r() - 0.5) * size * 0.08, (r() - 0.5) * size * 0.08); }
      if (st.font === "creep" || st.font === "drip") { ctx.shadowColor = "rgba(120,0,0,0.9)"; ctx.shadowBlur = size * 0.25; }
      else if (!st.tape) { ctx.shadowColor = "rgba(0,0,0,0.85)"; ctx.shadowBlur = size * 0.12; ctx.shadowOffsetY = size * 0.04; }
      ctx.fillStyle = color; spacedText(ctx, s, x, y, spacing);
      ctx.shadowBlur = 0; ctx.shadowOffsetY = 0;
      if (p.style === "drip" || p.style === "scrawl") drips(ctx, s, x, y, size, spacing, lt, color, p.seed || 0.5);
      if (anim === "shake") ctx.restore();
    }
    if (cursor && Math.floor(lt * 2.5) % 2 === 0) {
      const cw = measure(ctx, s, spacing);
      ctx.fillStyle = p.color || st.color; ctx.fillRect(x + cw + size * 0.08, y - size * 0.45, size * 0.5, size * 0.9);
    }
    y += lh;
  }
}

function drips(ctx, s, x, y, size, spacing, lt, color, seed) {
  const r = rnd(seed);
  ctx.fillStyle = color;
  let cx = x;
  for (const ch of s) {
    const cw = ctx.measureText(ch).width;
    if (ch.trim() && r() < 0.55) {
      const dx = cx + cw * (0.2 + 0.6 * r());
      const len = size * (0.2 + 0.9 * r()) * clamp01(lt / (1.2 + r() * 2));
      const wd = size * (0.04 + 0.05 * r());
      ctx.beginPath(); ctx.moveTo(dx - wd / 2, y + size * 0.3); ctx.lineTo(dx + wd / 2, y + size * 0.3);
      ctx.lineTo(dx + wd * 0.35, y + size * 0.3 + len); ctx.arc(dx, y + size * 0.3 + len, wd * 0.7, 0, Math.PI); ctx.closePath(); ctx.fill();
    }
    cx += cw + spacing;
  }
}

// ---------------------------------------------------------------------------------------------
// HUDs
function hudText(ctx, s, x, y, size, align = "left", color = "rgba(245,245,245,0.93)", font = FONTS.mono) {
  ctx.font = `bold ${size}px ${font}`; ctx.textAlign = align; ctx.textBaseline = "top";
  ctx.shadowColor = "rgba(0,0,0,0.9)"; ctx.shadowBlur = size * 0.15; ctx.shadowOffsetX = size * 0.05; ctx.shadowOffsetY = size * 0.05;
  ctx.fillStyle = color; ctx.fillText(s, x, y);
  ctx.shadowBlur = 0; ctx.shadowOffsetX = 0; ctx.shadowOffsetY = 0;
}

export function drawHud(ctx, W, H, p, lt, project, t) {
  const M = Math.min(W, H), m = M * 0.05, fs = Math.round(M * 0.038), fsS = Math.round(M * 0.03);
  const clock = clockAt(project, t);
  const style = p.style || "camcorder";
  const blink = Math.floor(lt * 1.6) % 2 === 0;
  const tc = s => `${pad(Math.floor(s / 3600))}:${pad(Math.floor(s / 60) % 60)}:${pad(Math.floor(s) % 60)}`;
  const dateUS = `${pad(clock.getMonth() + 1)}/${pad(clock.getDate())}/${clock.getFullYear()}`;
  ctx.lineWidth = Math.max(2, M * 0.004); ctx.strokeStyle = "rgba(245,245,245,0.85)";

  if (style === "camcorder" || style === "nightvision") {
    if (blink) { ctx.fillStyle = "#e3262e"; ctx.beginPath(); ctx.arc(m + fs * 0.45, m + fs * 0.55, fs * 0.38, 0, Math.PI * 2); ctx.fill(); }
    hudText(ctx, "REC", m + fs * 1.1, m, fs);
    // battery
    const bw = fs * 1.7, bh = fs * 0.8, bx = W - m - bw, by = m + fs * 0.1;
    ctx.strokeRect(bx, by, bw, bh); ctx.fillStyle = "rgba(245,245,245,0.85)"; ctx.fillRect(bx + bw, by + bh * 0.3, bw * 0.08, bh * 0.4);
    const lvl = (p.battery ?? 0.35); ctx.fillStyle = lvl < 0.25 && blink ? "#e3262e" : "rgba(245,245,245,0.85)"; ctx.fillRect(bx + 3, by + 3, (bw - 6) * lvl, bh - 6);
    hudText(ctx, tc(lt + (p.offset || 0)), m, H - m - fs * 1.1, fs);
    hudText(ctx, time12(clock), W - m, H - m - fs * 2.3, fsS, "right");
    hudText(ctx, dateUS, W - m, H - m - fs * 1.1, fsS, "right");
    if (style === "nightvision") {
      hudText(ctx, "NIGHT SHOT", m, m + fs * 1.5, fsS, "left", "rgba(190,255,190,0.95)");
      hudText(ctx, "IR ◉", W - m, m + fs * 1.4, fsS, "right", "rgba(190,255,190,0.95)");
    }
    // viewfinder corners
    const c = M * 0.06, x0 = m * 0.55, y0 = m * 0.55, x1 = W - m * 0.55, y1 = H - m * 0.55;
    ctx.beginPath();
    ctx.moveTo(x0, y0 + c); ctx.lineTo(x0, y0); ctx.lineTo(x0 + c, y0);
    ctx.moveTo(x1 - c, y0); ctx.lineTo(x1, y0); ctx.lineTo(x1, y0 + c);
    ctx.moveTo(x0, y1 - c); ctx.lineTo(x0, y1); ctx.lineTo(x0 + c, y1);
    ctx.moveTo(x1 - c, y1); ctx.lineTo(x1, y1); ctx.lineTo(x1, y1 - c);
    ctx.stroke();
    if (p.label) hudText(ctx, p.label, W / 2, m, fsS, "center");
  } else if (style === "seccam") {
    hudText(ctx, p.label || "CAM 01", m, m, fs);
    if (blink) { ctx.fillStyle = "#e3262e"; ctx.beginPath(); ctx.arc(W - m - fs * 2.6, m + fs * 0.55, fs * 0.3, 0, Math.PI * 2); ctx.fill(); }
    hudText(ctx, "LIVE", W - m, m, fs, "right");
    hudText(ctx, `${clock.getFullYear()}-${pad(clock.getMonth() + 1)}-${pad(clock.getDate())}  ${pad(clock.getHours())}:${pad(clock.getMinutes())}:${pad(clock.getSeconds())}`, m, H - m - fs * 1.1, fsS);
  } else if (style === "vhs") {
    const vf = Math.round(fs * 1.25);
    ctx.fillStyle = "rgba(245,245,245,0.93)";
    ctx.beginPath(); ctx.moveTo(m, m + vf * 0.1); ctx.lineTo(m, m + vf * 0.9); ctx.lineTo(m + vf * 0.75, m + vf * 0.5); ctx.closePath(); ctx.fill();
    hudText(ctx, "PLAY", m + vf * 1.05, m, vf, "left", undefined, FONTS.type);
    hudText(ctx, "SP", W - m, m, vf, "right", undefined, FONTS.type);
    hudText(ctx, `${MON[clock.getMonth()]}. ${pad(clock.getDate())} ${clock.getFullYear()}`, m, H - m - vf * 2.3, vf, "left", undefined, FONTS.type);
    hudText(ctx, time12(clock).replace(/:\d\d /, " "), m, H - m - vf * 1.1, vf, "left", undefined, FONTS.type);
  } else if (style === "ghosthunt") {
    const r = rnd(0.77 + Math.floor(t * 8) * 0.013);
    // EMF meter
    const spike = (Math.sin(t * 1.3) + Math.sin(t * 3.7) * 0.6 + r() * 0.9) / 2.5 + (p.spike ? 0.6 : 0);
    const lv = Math.max(1, Math.min(5, Math.round(1 + spike * 4)));
    hudText(ctx, "EMF", m, m, fsS);
    const cols = ["#3fb37f", "#9bd34a", "#f7c948", "#f08a24", "#e3262e"];
    for (let i = 0; i < 5; i++) { ctx.fillStyle = i < lv ? cols[i] : "rgba(255,255,255,0.15)"; ctx.fillRect(m + fsS * 2.2 + i * fsS * 0.9, m + fsS * 0.1, fsS * 0.7, fsS * 0.8); }
    const temp = (62 - Math.min(lt, 40) * 0.45 - (lv >= 4 ? 6 : 0) + Math.sin(t) * 0.3).toFixed(1);
    hudText(ctx, `TEMP ${temp}°F`, m, m + fsS * 1.5, fsS, "left", +temp < 50 ? "#7ec8ff" : undefined);
    const fq = (88 + ((t * 7.3) % 20)).toFixed(1);
    hudText(ctx, `SPIRIT BOX ${fq} FM`, W - m, m, fsS, "right");
    hudText(ctx, `${dateUS}  ${time12(clock)}`, W - m, H - m - fsS * 1.2, fsS, "right");
    if (blink) { ctx.fillStyle = "#e3262e"; ctx.beginPath(); ctx.arc(m + fsS * 0.4, H - m - fsS * 0.6, fsS * 0.32, 0, Math.PI * 2); ctx.fill(); }
    hudText(ctx, "EVP REC", m + fsS * 1.0, H - m - fsS * 1.2, fsS);
  } else if (style === "bodycam") {
    hudText(ctx, p.label || "UNIT 7 · BODY CAM", W - m, m, fsS, "right");
    hudText(ctx, `${clock.getFullYear()}-${pad(clock.getMonth() + 1)}-${pad(clock.getDate())} T${pad(clock.getHours())}:${pad(clock.getMinutes())}:${pad(clock.getSeconds())}`, W - m, m + fsS * 1.3, fsS, "right");
    hudText(ctx, "N 37.2431  W 115.7930", W - m, m + fsS * 2.6, fsS, "right");
  } else if (style === "phone") {
    const tw = fs * 4.4, th = fs * 1.35, x = W / 2 - tw / 2, y = m * 0.8;
    ctx.fillStyle = "rgba(227,38,46,0.92)"; roundRect(ctx, x, y, tw, th, th / 2); ctx.fill();
    const s = Math.floor(lt + (p.offset || 0));
    hudText(ctx, `${pad(Math.floor(s / 60))}:${pad(s % 60)}`, W / 2, y + th * 0.17, fs, "center", "#fff", FONTS.sans);
  } else if (style === "found") {
    hudText(ctx, "EVIDENCE", m, m, fs, "left", "#f2c82c", FONTS.type);
    hudText(ctx, p.label || "TAPE 03 OF 07", m, m + fs * 1.3, fsS, "left", undefined, FONTS.type);
    hudText(ctx, `CASE #${(p.caseNo || "1987-0423")}`, W - m, H - m - fsS * 1.2, fsS, "right", undefined, FONTS.type);
    ctx.save(); ctx.translate(W - m - fs * 3, m + fs * 1.4); ctx.rotate(-0.18);
    ctx.strokeStyle = "rgba(200,30,40,0.85)"; ctx.lineWidth = fs * 0.12; ctx.strokeRect(-fs * 2.6, -fs * 0.75, fs * 5.2, fs * 1.5);
    hudText(ctx, "UNEXPLAINED", 0, -fs * 0.5, Math.round(fs * 0.8), "center", "rgba(200,30,40,0.9)", FONTS.impact); ctx.restore();
  }
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
}

// ---------------------------------------------------------------------------------------------
// spooks (stickers) with simple motion
export const MOVES = {
  none: "Stays put",
  "fade-flicker": "Flickers in and out",
  "drift-left": "Drifts right to left",
  "drift-right": "Drifts left to right",
  rise: "Rises up",
  fall: "Drops down",
  creep: "Creeps closer (grows)",
  shake: "Trembles",
  peek: "Peeks in from the side and back out",
  flash: "Appears for a split second",
};

function drawSpook(ctx, W, H, p, lt, dur, id) {
  const M = Math.min(W, H);
  const k = clamp01(lt / Math.max(0.01, dur));
  let x = (p.x ?? 0.5) * W, y = (p.y ?? 0.5) * H, s = (p.scale ?? 0.4) * M, op = p.opacity ?? 1;
  const move = p.move || "none";
  const r = rnd((p.seed || 0.3) + Math.floor(lt * 20) * 0.01);
  if (move === "drift-left") x = W * (1.15 - 1.3 * k);
  if (move === "drift-right") x = W * (-0.15 + 1.3 * k);
  if (move === "rise") y = H * (1.2 - (1.2 - (p.y ?? 0.5)) * Math.min(1, k * 1.6));
  if (move === "fall") y = H * (-0.2 + ((p.y ?? 0.5) + 0.2) * Math.min(1, k * 2.2));
  if (move === "creep") s *= 0.6 + 0.8 * k;
  if (move === "shake") { x += (r() - 0.5) * M * 0.015; y += (r() - 0.5) * M * 0.015; }
  if (move === "fade-flicker") op *= (r() < 0.25 ? 0.15 : 0.85) * clamp01(Math.min(lt / 0.3, (dur - lt) / 0.3));
  if (move === "peek") { const e = Math.sin(Math.PI * k); x = (p.x ?? 0.5) < 0.5 ? -s * 0.35 + s * 0.6 * e : W + s * 0.35 - s * 0.6 * e; }
  if (move === "flash") op *= lt < Math.min(0.35, dur) ? 1 : 0;
  if (move === "none" || move === "creep") op *= clamp01(Math.min(lt / 0.25, (dur - lt) / 0.25));
  if (op <= 0.001) return;
  const asp = p.aspect || 1;
  const w = asp >= 1 ? s : s * asp, h = asp >= 1 ? s / asp : s;
  drawSticker(ctx, p.sticker, x - w / 2, y - h / 2, w, h, lt, { opacity: op, seed: p.seed || 1, flip: !!p.flip, color: p.color });
}
