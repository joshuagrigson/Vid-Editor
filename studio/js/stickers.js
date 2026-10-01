// FrightCut — procedurally drawn, animated horror overlays (Canvas 2D only).
// Every sticker is vector-drawn with paths, gradients and shadow blur; no images.
// Halloween-scary, never gory.

const TAU = Math.PI * 2;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const lerp = (a, b, t) => a + (b - a) * t;
const smooth = (t) => { t = clamp(t, 0, 1); return t * t * (3 - 2 * t); };
const fract = (x) => x - Math.floor(x);

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
function hash1(n) { n = Math.imul((n | 0) ^ 0x27d4eb2d, 0x165667b1); n ^= n >>> 15; n = Math.imul(n, 0x85ebca6b); n ^= n >>> 13; return (n >>> 0) / 4294967296; }
/** smooth 1-D value noise in [0,1] */
function vnoise(x, seed = 0) {
  const i = Math.floor(x), f = x - i, u = f * f * (3 - 2 * f);
  return lerp(hash1(i + seed * 7919), hash1(i + 1 + seed * 7919), u);
}

/* ------------------------------------------------------------------ drawing helpers */

function rgbStr(c, fb) {
  if (!c) return fb;
  if (c[0] === '#') {
    let h = c.slice(1); if (h.length === 3) h = h.split('').map((x) => x + x).join('');
    const n = parseInt(h.slice(0, 6), 16); return `${(n >> 16) & 255},${(n >> 8) & 255},${n & 255}`;
  }
  const m = c.match(/(\d+)\D+(\d+)\D+(\d+)/); return m ? `${m[1]},${m[2]},${m[3]}` : fb;
}
function pxScale(ctx) { const m = ctx.getTransform(); return Math.hypot(m.a, m.b) || 1; }
function glow(ctx, color, blur) { ctx.shadowColor = color; ctx.shadowBlur = blur * pxScale(ctx); ctx.shadowOffsetX = 0; ctx.shadowOffsetY = 0; }
function noGlow(ctx) { ctx.shadowColor = 'rgba(0,0,0,0)'; ctx.shadowBlur = 0; }
/** hairline-safe line width: never thinner than ~1 device pixel */
function lw(ctx, w) { ctx.lineWidth = Math.max(w, 0.9 / pxScale(ctx)); }
/** fill a path rendered only through its blurred shadow → soft-edged silhouette with no ctx.filter */
function softFill(ctx, path, color, blur) {
  const m = ctx.getTransform(), k = pxScale(ctx), D = 40000 / k;
  ctx.save();
  ctx.shadowColor = color; ctx.shadowBlur = Math.max(0.5, blur * k);
  ctx.shadowOffsetX = D * m.a; ctx.shadowOffsetY = D * m.b;
  ctx.translate(-D, 0); ctx.fillStyle = '#000'; ctx.beginPath(); path(); ctx.fill();
  ctx.restore();
}
function smoothPath(ctx, pts, closed = true) {
  const n = pts.length;
  if (closed) {
    ctx.moveTo((pts[n - 1][0] + pts[0][0]) / 2, (pts[n - 1][1] + pts[0][1]) / 2);
    for (let i = 0; i < n; i++) {
      const p = pts[i], q = pts[(i + 1) % n];
      ctx.quadraticCurveTo(p[0], p[1], (p[0] + q[0]) / 2, (p[1] + q[1]) / 2);
    }
    ctx.closePath();
  } else {
    ctx.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < n - 1; i++) ctx.quadraticCurveTo(pts[i][0], pts[i][1], (pts[i][0] + pts[i + 1][0]) / 2, (pts[i][1] + pts[i + 1][1]) / 2);
    ctx.lineTo(pts[n - 1][0], pts[n - 1][1]);
  }
}
const sym = (cx, half) => [...half, ...half.slice().reverse().map(([x, y]) => [2 * cx - x, y])];
function ell(ctx, x, y, rx, ry, rot = 0) { ctx.moveTo(x + rx * Math.cos(rot), y + rx * Math.sin(rot)); ctx.ellipse(x, y, Math.abs(rx), Math.abs(ry), rot, 0, TAU); }
function circ(ctx, x, y, r) { ctx.moveTo(x + r, y); ctx.arc(x, y, Math.abs(r), 0, TAU); }
const FONT_BOLD = '"Impact", "Haettenschweiler", "Arial Black", "DejaVu Sans", sans-serif';
const FONT_SERIF = '"Georgia", "Times New Roman", "DejaVu Serif", serif';
/** draw text with a size in current (possibly tiny) units, robust across browsers */
function text(ctx, str, x, y, size, font = FONT_BOLD, mode = 'fill', weight = 'bold') {
  ctx.save(); ctx.translate(x, y); ctx.scale(size / 100, size / 100);
  ctx.font = `${weight} 100px ${font}`;
  if (mode === 'stroke') { ctx.lineWidth = ctx.lineWidth * 100 / size; ctx.strokeText(str, 0, 0); } else ctx.fillText(str, 0, 0);
  ctx.restore();
}
function measure(ctx, str, size, font = FONT_BOLD, weight = 'bold') {
  ctx.save(); ctx.font = `${weight} 100px ${font}`; const w = ctx.measureText(str).width; ctx.restore(); return w * size / 100;
}
function makeCanvas(w, h) {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
  const c = document.createElement('canvas'); c.width = w; c.height = h; return c;
}
function eyeBlink(t, period = 3.7, offset = 0) {
  const p = fract((t + offset) / period) * period;
  if (p > period - 0.22) return Math.sin(((p - (period - 0.22)) / 0.22) * Math.PI); // 0 → 1 → 0
  return 0;
}

/* ------------------------------------------------------------------ registry */

export const STICKER_CATEGORIES = [
  { id: 'figures', name: 'Ghosts & Figures', icon: '👻' },
  { id: 'critters', name: 'Creepy Critters', icon: '🕷️' },
  { id: 'marks', name: 'Marks & Messages', icon: '🖐️' },
  { id: 'objects', name: 'Haunted Objects', icon: '🕯️' },
  { id: 'atmos', name: 'Atmosphere & Frames', icon: '🌫️' },
];
const DEFS = [];
/** fit: 'contain' (keeps aspect, draws in units where height = 1) | 'stretch' (fills box, pixel units) */
function st(id, name, cat, aspect, anim, desc, draw, extra = {}) {
  DEFS.push({ id, name, cat, aspect, anim, desc, draw, fit: extra.fit || 'contain', clip: !!extra.clip || extra.fit === 'stretch', defaults: { opacity: 1, ...(extra.defaults || {}) } });
}

/* ================================================================== FIGURES */

st('shadow_figure', 'Shadow Figure', 'figures', 0.38, true, 'Tall dark silhouette standing very still… almost.', (ctx, W, H, t, r, o) => {
  const cx = W / 2;
  ctx.translate(cx, 1); ctx.rotate(Math.sin(t * 0.7) * 0.012); ctx.translate(-cx, -1);
  const breathe = 1 + Math.sin(t * 1.3) * 0.004;
  const body = sym(cx, [[cx - 0.026, 0.17], [cx - 0.036, 0.205], [cx - 0.11, 0.232], [cx - 0.142, 0.27], [cx - 0.152, 0.42], [cx - 0.158, 0.6],
    [cx - 0.148, 0.665], [cx - 0.128, 0.62], [cx - 0.124, 0.45], [cx - 0.112, 0.33], [cx - 0.096, 0.4], [cx - 0.09, 0.56], [cx - 0.085, 0.8],
    [cx - 0.092, 0.985], [cx - 0.034, 0.995], [cx - 0.03, 0.76], [cx - 0.014, 0.6], [cx, 0.59]]);
  const col = o.color || 'rgba(4,4,7,0.97)';
  softFill(ctx, () => {
    ctx.save(); ctx.translate(cx, 0.6); ctx.scale(breathe, 1); ctx.translate(-cx, -0.6);
    smoothPath(ctx, body); ell(ctx, cx, 0.112, 0.056, 0.07); ctx.restore();
  }, col, 0.014);
  if (o.eyes !== false) {
    const a = 0.5 + 0.5 * vnoise(t * 0.8, 3);
    if (a > 0.55) {
      ctx.globalAlpha *= (a - 0.55) * 2.2; glow(ctx, 'rgba(255,255,255,0.9)', 0.02); ctx.fillStyle = '#f4f4ff';
      ctx.beginPath(); ell(ctx, cx - 0.02, 0.11, 0.008, 0.004); ell(ctx, cx + 0.02, 0.11, 0.008, 0.004); ctx.fill();
    }
  }
}, { defaults: { eyes: true } });

st('shadow_peek', 'Peeking Shadow', 'figures', 0.75, true, 'Something leaning out from behind a doorframe.', (ctx, W, H, t, r, o) => {
  // dim hallway seen through the doorway
  const hall = ctx.createLinearGradient(0, 0, 0.53, 0);
  hall.addColorStop(0, 'rgba(38,44,58,0)'); hall.addColorStop(0.3, 'rgba(38,44,58,0.8)'); hall.addColorStop(1, 'rgba(62,68,86,0.92)');
  ctx.fillStyle = hall; ctx.fillRect(0, 0, 0.53, 1);
  const lean = smooth(0.5 + 0.6 * Math.sin(t * 0.55 - 0.6)), hx = 0.52 - 0.11 * lean, tilt = -0.32 * lean;
  softFill(ctx, () => {
    ell(ctx, hx, 0.27, 0.07, 0.09, tilt);
    smoothPath(ctx, [[hx + 0.03, 0.33], [hx - 0.005, 0.37], [hx - 0.05, 0.42], [hx - 0.07, 0.52], [hx - 0.06, 1.0], [0.6, 1.0], [0.6, 0.33]]);
  }, o.color || 'rgba(0,0,0,1)', 0.01);
  const bl = 1 - eyeBlink(t, 4.3, 1);
  ctx.save(); glow(ctx, 'rgba(255,255,255,0.9)', 0.03); ctx.fillStyle = '#f2f2f2';
  ctx.beginPath(); ell(ctx, hx - 0.028, 0.26, 0.016, 0.009 * bl + 0.0005, tilt); ctx.fill();
  noGlow(ctx); ctx.fillStyle = '#000'; ctx.beginPath(); circ(ctx, hx - 0.032, 0.26, 0.004 * bl); ctx.fill(); ctx.restore();
  // doorframe trim
  const tg = ctx.createLinearGradient(0.53, 0, 0.63, 0);
  tg.addColorStop(0, '#2a1c12'); tg.addColorStop(0.25, '#5e412a'); tg.addColorStop(0.6, '#3d2a1b'); tg.addColorStop(1, '#1b120b');
  ctx.fillStyle = tg; ctx.fillRect(0.53, 0, 0.1, 1);
  ctx.fillStyle = 'rgba(0,0,0,0.5)'; ctx.fillRect(0.63, 0, 0.012, 1);
  ctx.fillStyle = 'rgba(255,220,180,0.14)'; ctx.fillRect(0.545, 0, 0.006, 1);
  // long fingers curling around the jamb
  const fy = 0.47 + 0.004 * Math.sin(t * 3);
  ctx.strokeStyle = '#050505'; ctx.lineCap = 'round';
  for (let i = 0; i < 4; i++) {
    lw(ctx, 0.02 - i * 0.0018); const y = fy + i * 0.034, reach = (0.035 + (i === 1 || i === 2 ? 0.012 : 0)) * (0.5 + 0.5 * lean);
    ctx.beginPath(); ctx.moveTo(0.525, y); ctx.quadraticCurveTo(0.535 + reach * 0.6, y - 0.014, 0.53 + reach, y + 0.01); ctx.stroke();
  }
});

st('ghost_girl', 'Ghost Girl', 'figures', 0.45, true, 'Pale girl in a white dress, long black hair over her face.', (ctx, W, H, t, r, o) => {
  const cx = W / 2;
  const flick = vnoise(t * 6, 2) > 0.86 ? 0.45 : 1;
  ctx.globalAlpha *= (0.82 + 0.1 * Math.sin(t * 2.1)) * flick;
  if (vnoise(t * 4, 9) > 0.9) ctx.translate((hash1(Math.floor(t * 30)) - 0.5) * 0.03, 0);
  ctx.translate(0, Math.sin(t * 1.1) * 0.006);
  // dress
  const dg = ctx.createLinearGradient(0, 0.22, 0, 1);
  dg.addColorStop(0, 'rgba(236,242,250,1)'); dg.addColorStop(0.6, 'rgba(205,215,230,0.95)'); dg.addColorStop(1, 'rgba(190,205,225,0)');
  ctx.save(); glow(ctx, 'rgba(170,200,255,0.7)', 0.05); ctx.fillStyle = dg; ctx.beginPath();
  const hem = [];
  for (let i = 0; i <= 10; i++) { const x = lerp(cx - 0.19, cx + 0.19, i / 10); hem.push([x, 0.97 + Math.sin(i * 1.9 + t * 2) * 0.02 + (i % 2) * 0.02]); }
  smoothPath(ctx, [[cx - 0.06, 0.24], [cx - 0.095, 0.29], [cx - 0.1, 0.45], [cx - 0.14, 0.7], ...hem, [cx + 0.14, 0.7], [cx + 0.1, 0.45], [cx + 0.095, 0.29], [cx + 0.06, 0.24]]);
  ctx.fill(); ctx.restore();
  // arms
  ctx.strokeStyle = '#dfe6ee'; ctx.lineCap = 'round'; lw(ctx, 0.028);
  for (const s of [-1, 1]) { ctx.beginPath(); ctx.moveTo(cx + s * 0.09, 0.28); ctx.quadraticCurveTo(cx + s * 0.13, 0.42, cx + s * 0.125, 0.6); ctx.stroke(); }
  ctx.fillStyle = '#d6dde6'; ctx.beginPath(); ell(ctx, cx - 0.125, 0.615, 0.016, 0.024); ell(ctx, cx + 0.125, 0.615, 0.016, 0.024); ctx.fill();
  // head (pale) then hair over it
  ctx.fillStyle = '#e4e9ef'; ctx.beginPath(); ell(ctx, cx, 0.15, 0.056, 0.07); ctx.fill();
  ctx.fillStyle = '#060607'; ctx.beginPath();
  smoothPath(ctx, [[cx, 0.07], [cx + 0.07, 0.1], [cx + 0.085, 0.25], [cx + 0.09, 0.46], [cx + 0.05, 0.43], [cx + 0.025, 0.47], [cx, 0.42], [cx - 0.03, 0.48], [cx - 0.055, 0.42], [cx - 0.09, 0.47], [cx - 0.085, 0.25], [cx - 0.07, 0.1]]);
  ctx.fill();
  ctx.strokeStyle = '#060607'; lw(ctx, 0.005);
  for (let i = 0; i < 18; i++) {
    const x0 = cx + (r() - 0.5) * 0.15, x1 = x0 + (r() - 0.5) * 0.04 + Math.sin(t * 1.3 + i) * 0.004, y1 = 0.42 + r() * 0.12;
    ctx.beginPath(); ctx.moveTo(x0, 0.2); ctx.quadraticCurveTo(x0 + (r() - 0.5) * 0.03, 0.35, x1, y1); ctx.stroke();
  }
  // one eye glinting through a gap in the hair
  ctx.fillStyle = '#d9dfe6'; ctx.beginPath(); ell(ctx, cx + 0.017, 0.155, 0.011, 0.02); ctx.fill();
  ctx.fillStyle = '#000'; ctx.beginPath(); circ(ctx, cx + 0.018, 0.157, 0.005); ctx.fill();
});

st('sheet_ghost', 'Sheet Ghost', 'figures', 0.8, true, 'Classic floating bedsheet ghost, bobbing gently.', (ctx, W, H, t, r, o) => {
  const cx = W / 2, bob = Math.sin(t * 2) * 0.03;
  ctx.translate(0, bob + 0.02); ctx.globalAlpha *= 0.94;
  const hem = [];
  for (let i = 0; i <= 8; i++) { const x = lerp(cx + 0.33, cx - 0.33, i / 8); hem.push([x, 0.9 + Math.sin(i * 1.6 + t * 4) * 0.035 + (i % 2 ? 0.04 : 0)]); }
  const pts = [[cx, 0.04], [cx + 0.17, 0.07], [cx + 0.22, 0.3], [cx + 0.25, 0.48], [cx + 0.36, 0.52], [cx + 0.3, 0.6], [cx + 0.31, 0.78], ...hem,
    [cx - 0.31, 0.78], [cx - 0.3, 0.6], [cx - 0.36, 0.52], [cx - 0.25, 0.48], [cx - 0.22, 0.3], [cx - 0.17, 0.07]];
  const g = ctx.createRadialGradient(cx - 0.08, 0.25, 0.02, cx, 0.45, 0.6);
  g.addColorStop(0, o.color || '#ffffff'); g.addColorStop(0.7, '#e3e8f0'); g.addColorStop(1, '#b9c3d3');
  ctx.save(); glow(ctx, 'rgba(255,255,255,0.55)', 0.06); ctx.fillStyle = g; ctx.beginPath(); smoothPath(ctx, pts); ctx.fill(); ctx.restore();
  // fold shading
  ctx.strokeStyle = 'rgba(120,135,160,0.35)'; lw(ctx, 0.012); ctx.lineCap = 'round';
  for (const [x0, x1] of [[-0.1, -0.16], [0.08, 0.14], [0.0, 0.02]]) { ctx.beginPath(); ctx.moveTo(cx + x0, 0.6); ctx.quadraticCurveTo(cx + x0 * 1.4, 0.75, cx + x1, 0.9); ctx.stroke(); }
  // face
  ctx.fillStyle = '#121216';
  ctx.beginPath(); ell(ctx, cx - 0.085, 0.27, 0.042, 0.065, 0.1); ell(ctx, cx + 0.085, 0.27, 0.042, 0.065, -0.1); ctx.fill();
  ctx.beginPath(); ell(ctx, cx, 0.43, 0.04 + Math.sin(t * 3) * 0.005, 0.06); ctx.fill();
});

function eyeShape(ctx, x, y, w, h, tilt, open) {
  ctx.save(); ctx.translate(x, y); ctx.rotate(tilt);
  const hh = h * Math.max(0.03, open);
  ctx.moveTo(-w / 2, 0); ctx.quadraticCurveTo(0, -hh * 1.4, w / 2, 0); ctx.quadraticCurveTo(0, hh * 1.4, -w / 2, 0);
  ctx.restore();
}
st('red_eyes', 'Red Eyes in the Dark', 'figures', 2.2, true, 'Glowing red eyes staring out of the darkness.', (ctx, W, H, t, r, o) => {
  const dark = ctx.createRadialGradient(W / 2, 0.5, 0.05, W / 2, 0.5, 1);
  dark.addColorStop(0, 'rgba(0,0,0,0.85)'); dark.addColorStop(0.6, 'rgba(0,0,0,0.6)'); dark.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.save(); ctx.translate(W / 2, 0.5); ctx.scale(1.05, 0.5); ctx.translate(-W / 2, -0.5); ctx.fillStyle = dark; ctx.fillRect(0, -0.5, W, 2); ctx.restore();
  const open = 1 - eyeBlink(t, 3.7), col = o.color || '#ff2a1a', pulse = 0.85 + 0.15 * Math.sin(t * 2.3);
  for (const s of [-1, 1]) {
    const x = W / 2 + s * 0.36, y = 0.5;
    const g = ctx.createRadialGradient(x, y, 0.005, x, y, 0.17);
    g.addColorStop(0, '#fff3b0'); g.addColorStop(0.25, '#ffb020'); g.addColorStop(0.55, col); g.addColorStop(1, '#5a0000');
    ctx.save(); glow(ctx, col, 0.18 * pulse); ctx.fillStyle = g; ctx.beginPath(); eyeShape(ctx, x, y, 0.34, 0.11, s * 0.16, open); ctx.fill(); ctx.fill(); ctx.restore();
    if (open > 0.3) { ctx.fillStyle = 'rgba(10,0,0,0.9)'; ctx.beginPath(); ell(ctx, x + s * 0.01, y, 0.016, 0.09 * open); ctx.fill(); }
  }
}, { defaults: { color: '#ff2a1a' } });

st('white_eyes', 'Watching Eyes', 'figures', 2.4, true, 'A pair of pale eyes that look around… then at you.', (ctx, W, H, t, r, o) => {
  const dark = ctx.createRadialGradient(W / 2, 0.5, 0.02, W / 2, 0.5, 0.8);
  dark.addColorStop(0, 'rgba(0,0,0,0.6)'); dark.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.save(); ctx.translate(W / 2, 0.5); ctx.scale(1.3, 0.6); ctx.translate(-W / 2, -0.5); ctx.fillStyle = dark; ctx.fillRect(-1, -1, W + 2, 3); ctx.restore();
  const open = 1 - eyeBlink(t, 4.1, 0.5), look = Math.sin(t * 0.7) * 0.5 + (vnoise(t * 0.5, 4) - 0.5) * 0.6;
  for (const s of [-1, 1]) {
    const x = W / 2 + s * 0.4, y = 0.5;
    ctx.save(); glow(ctx, 'rgba(220,235,255,0.8)', 0.08); ctx.fillStyle = o.color || '#eef3ff';
    ctx.beginPath(); eyeShape(ctx, x, y, 0.3, 0.16, s * -0.05, open); ctx.fill(); ctx.restore();
    if (open > 0.25) {
      ctx.save(); ctx.beginPath(); eyeShape(ctx, x, y, 0.3, 0.16, s * -0.05, open); ctx.clip();
      ctx.fillStyle = '#0a0a0a'; ctx.beginPath(); circ(ctx, x + look * 0.08, y, 0.035); ctx.fill(); ctx.restore();
    }
  }
});

st('demon_face', 'Demon Face', 'figures', 0.85, true, 'Horned shadow face with burning eyes and a jagged grin.', (ctx, W, H, t, r, o) => {
  const cx = W / 2, breath = Math.sin(t * 1.4) * 0.008;
  // horns
  for (const s of [-1, 1]) {
    const hg = ctx.createLinearGradient(cx + s * 0.15, 0.3, cx + s * 0.36, 0.0);
    hg.addColorStop(0, '#1a0c08'); hg.addColorStop(0.7, '#4a3020'); hg.addColorStop(1, '#a08060');
    ctx.fillStyle = hg; ctx.beginPath();
    ctx.moveTo(cx + s * 0.1, 0.24); ctx.quadraticCurveTo(cx + s * 0.3, 0.2, cx + s * 0.37, 0.02);
    ctx.quadraticCurveTo(cx + s * 0.33, 0.24, cx + s * 0.2, 0.32); ctx.closePath(); ctx.fill();
  }
  // head
  const head = [[cx, 0.17], [cx + 0.17, 0.2], [cx + 0.25, 0.33], [cx + 0.26, 0.5], [cx + 0.2, 0.7], [cx + 0.1, 0.88], [cx, 0.97], [cx - 0.1, 0.88], [cx - 0.2, 0.7], [cx - 0.26, 0.5], [cx - 0.25, 0.33], [cx - 0.17, 0.2]];
  const fg = ctx.createRadialGradient(cx, 0.45, 0.05, cx, 0.55, 0.5);
  fg.addColorStop(0, '#3a0a0a'); fg.addColorStop(0.6, '#1c0505'); fg.addColorStop(1, '#070101');
  ctx.save(); glow(ctx, 'rgba(255,60,0,0.35)', 0.05); ctx.fillStyle = fg; ctx.beginPath(); smoothPath(ctx, head); ctx.fill(); ctx.restore();
  // brow ridge
  ctx.fillStyle = '#0a0202'; ctx.beginPath();
  ctx.moveTo(cx - 0.22, 0.36); ctx.lineTo(cx - 0.03, 0.44); ctx.lineTo(cx, 0.41); ctx.lineTo(cx + 0.03, 0.44); ctx.lineTo(cx + 0.22, 0.36); ctx.lineTo(cx + 0.2, 0.33); ctx.lineTo(cx, 0.37); ctx.lineTo(cx - 0.2, 0.33); ctx.closePath(); ctx.fill();
  // eyes
  const eg = 0.8 + 0.2 * vnoise(t * 3, 5);
  for (const s of [-1, 1]) {
    ctx.save(); glow(ctx, `rgba(255,170,0,${eg})`, 0.07); ctx.fillStyle = '#ffd23a'; ctx.beginPath();
    ctx.moveTo(cx + s * 0.04, 0.47); ctx.quadraticCurveTo(cx + s * 0.12, 0.42, cx + s * 0.19, 0.4); ctx.quadraticCurveTo(cx + s * 0.13, 0.5, cx + s * 0.04, 0.47); ctx.fill(); ctx.fill(); ctx.restore();
    ctx.fillStyle = '#200'; ctx.beginPath(); ell(ctx, cx + s * 0.115, 0.45, 0.008, 0.025); ctx.fill();
  }
  // nostrils
  ctx.fillStyle = '#000'; ctx.beginPath(); ell(ctx, cx - 0.025, 0.6, 0.01, 0.018, 0.4); ell(ctx, cx + 0.025, 0.6, 0.01, 0.018, -0.4); ctx.fill();
  // grin
  const mo = 0.05 + breath;
  ctx.save(); glow(ctx, 'rgba(255,90,0,0.6)', 0.04);
  ctx.fillStyle = '#2a0500'; ctx.beginPath(); ctx.moveTo(cx - 0.19, 0.68); ctx.quadraticCurveTo(cx, 0.76 + mo, cx + 0.19, 0.68); ctx.quadraticCurveTo(cx, 0.86 + mo, cx - 0.19, 0.68); ctx.fill(); ctx.restore();
  ctx.fillStyle = '#e9e2cf';
  for (let i = 0; i < 9; i++) {
    const u = (i + 0.5) / 9, x = lerp(cx - 0.17, cx + 0.17, u), yTop = 0.68 + Math.sin(u * Math.PI) * (0.08 + mo) * 0.5 + 0.003;
    const yBot = 0.68 + Math.sin(u * Math.PI) * (0.18 + mo) * 0.5 - 0.004;
    ctx.beginPath(); ctx.moveTo(x - 0.016, yTop); ctx.lineTo(x + 0.016, yTop); ctx.lineTo(x, yTop + 0.035); ctx.closePath(); ctx.fill();
    if (i % 2 === 0) { ctx.beginPath(); ctx.moveTo(x - 0.014, yBot); ctx.lineTo(x + 0.014, yBot); ctx.lineTo(x, yBot - 0.03); ctx.closePath(); ctx.fill(); }
  }
});

st('skull', 'Skull', 'figures', 0.85, true, 'Grinning skull that chatters its teeth.', (ctx, W, H, t, r, o) => {
  const cx = W / 2, jaw = Math.max(0, Math.sin(t * 9)) * 0.025 * (fract(t / 3) < 0.4 ? 1 : 0);
  const bone = ctx.createRadialGradient(cx - 0.08, 0.25, 0.03, cx, 0.4, 0.5);
  bone.addColorStop(0, '#fbf6e6'); bone.addColorStop(0.6, '#e2d8bd'); bone.addColorStop(1, '#a89c7c');
  ctx.save(); glow(ctx, 'rgba(0,0,0,0.6)', 0.03);
  ctx.fillStyle = bone; ctx.strokeStyle = '#3a3226'; lw(ctx, 0.008);
  // jaw
  ctx.beginPath(); ctx.moveTo(cx - 0.2, 0.7 + jaw); ctx.quadraticCurveTo(cx - 0.2, 0.92 + jaw, cx, 0.95 + jaw); ctx.quadraticCurveTo(cx + 0.2, 0.92 + jaw, cx + 0.2, 0.7 + jaw); ctx.closePath(); ctx.fill(); ctx.stroke();
  // cranium + cheeks
  ctx.beginPath(); smoothPath(ctx, [[cx, 0.03], [cx + 0.27, 0.08], [cx + 0.36, 0.35], [cx + 0.3, 0.55], [cx + 0.25, 0.7], [cx + 0.12, 0.76], [cx, 0.77], [cx - 0.12, 0.76], [cx - 0.25, 0.7], [cx - 0.3, 0.55], [cx - 0.36, 0.35], [cx - 0.27, 0.08]]);
  ctx.fill(); ctx.stroke(); ctx.restore();
  // eye sockets
  const sg = ctx.createRadialGradient(0, 0, 0, 0, 0, 1);
  ctx.fillStyle = '#16120e';
  for (const s of [-1, 1]) { ctx.beginPath(); smoothPath(ctx, [[cx + s * 0.03, 0.39], [cx + s * 0.05, 0.3], [cx + s * 0.14, 0.29], [cx + s * 0.21, 0.36], [cx + s * 0.19, 0.48], [cx + s * 0.1, 0.5]]); ctx.fill(); }
  ctx.fillStyle = 'rgba(255,60,30,0.75)'; ctx.beginPath(); circ(ctx, cx - 0.12, 0.4, 0.012 + 0.004 * Math.sin(t * 4)); circ(ctx, cx + 0.12, 0.4, 0.012 + 0.004 * Math.sin(t * 4)); ctx.fill();
  // nose
  ctx.fillStyle = '#16120e'; ctx.beginPath(); ctx.moveTo(cx, 0.5); ctx.lineTo(cx - 0.045, 0.62); ctx.quadraticCurveTo(cx, 0.65, cx + 0.045, 0.62); ctx.closePath(); ctx.fill();
  // teeth
  ctx.strokeStyle = '#3a3226'; lw(ctx, 0.006);
  for (const [yy, dy] of [[0.69, 0], [0.76, jaw]]) {
    for (let i = 0; i < 8; i++) {
      const x = lerp(cx - 0.14, cx + 0.14, i / 8);
      ctx.fillStyle = '#f2ebd6'; ctx.beginPath(); ctx.rect(x + 0.003, yy + dy, 0.029, 0.06); ctx.fill(); ctx.stroke();
    }
  }
  ctx.fillStyle = '#16120e'; ctx.fillRect(cx - 0.14, 0.75, 0.28, 0.012 + jaw);
});

st('creepy_doll', 'Creepy Doll', 'figures', 0.55, true, 'Doll silhouette with button eyes; her head tilts… then snaps.', (ctx, W, H, t, r, o) => {
  const cx = W / 2, c = fract(t / 4) * 4, tilt = c < 3 ? 0.32 * smooth(c / 3) : 0.32 * (1 - smooth((c - 3) / 0.12));
  const col = '#0b0a0c';
  ctx.fillStyle = col;
  // body
  ctx.beginPath(); smoothPath(ctx, [[cx, 0.4], [cx + 0.08, 0.42], [cx + 0.11, 0.5], [cx + 0.22, 0.82], [cx + 0.18, 0.85], [cx - 0.18, 0.85], [cx - 0.22, 0.82], [cx - 0.11, 0.5], [cx - 0.08, 0.42]]); ctx.fill();
  ctx.strokeStyle = col; ctx.lineCap = 'round'; lw(ctx, 0.045);
  ctx.beginPath(); ctx.moveTo(cx - 0.09, 0.46); ctx.lineTo(cx - 0.19, 0.62); ctx.moveTo(cx + 0.09, 0.46); ctx.lineTo(cx + 0.17, 0.64); ctx.stroke();
  lw(ctx, 0.05); ctx.beginPath(); ctx.moveTo(cx - 0.06, 0.84); ctx.lineTo(cx - 0.07, 0.95); ctx.moveTo(cx + 0.06, 0.84); ctx.lineTo(cx + 0.07, 0.95); ctx.stroke();
  ctx.beginPath(); ell(ctx, cx - 0.08, 0.965, 0.045, 0.025); ell(ctx, cx + 0.08, 0.965, 0.045, 0.025); ctx.fill();
  // lace hem
  ctx.fillStyle = 'rgba(200,190,200,0.35)'; for (let i = 0; i < 9; i++) { ctx.beginPath(); circ(ctx, lerp(cx - 0.18, cx + 0.18, i / 8), 0.85, 0.022); ctx.fill(); }
  // head
  ctx.save(); ctx.translate(cx, 0.4); ctx.rotate(tilt); ctx.translate(-cx, -0.4);
  ctx.fillStyle = col; ctx.beginPath(); circ(ctx, cx, 0.24, 0.165);
  for (const s of [-1, 1]) { ell(ctx, cx + s * 0.2, 0.3, 0.06, 0.09, s * 0.4); ell(ctx, cx + s * 0.155, 0.13, 0.05, 0.035, s * -0.6); }
  ctx.fill();
  // button eyes
  for (const s of [-1, 1]) {
    ctx.fillStyle = '#d8d2c8'; ctx.beginPath(); circ(ctx, cx + s * 0.065, 0.24, 0.042); ctx.fill();
    ctx.fillStyle = '#0b0a0c'; ctx.beginPath(); for (const [dx, dy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) circ(ctx, cx + s * 0.065 + dx * 0.013, 0.24 + dy * 0.013, 0.007); ctx.fill();
  }
  // stitched smile
  ctx.strokeStyle = '#c9c2b6'; lw(ctx, 0.006); ctx.beginPath(); ctx.moveTo(cx - 0.07, 0.32); ctx.quadraticCurveTo(cx, 0.36, cx + 0.07, 0.32); ctx.stroke();
  for (let i = 0; i < 6; i++) { const x = lerp(cx - 0.06, cx + 0.06, i / 5), y = 0.33 + Math.sin(((i / 5) * Math.PI)) * 0.012; ctx.beginPath(); ctx.moveTo(x, y - 0.015); ctx.lineTo(x, y + 0.015); ctx.stroke(); }
  ctx.restore();
});

st('clown', 'Clown with Balloon', 'figures', 0.6, true, 'A clown silhouette holding a single red balloon.', (ctx, W, H, t, r, o) => {
  const cx = 0.24, sway = Math.sin(t * 1.2) * 0.02;
  const bx = 0.45 + sway, by = 0.14 + Math.sin(t * 1.7) * 0.012;
  // string
  ctx.strokeStyle = 'rgba(230,230,230,0.8)'; lw(ctx, 0.004); ctx.beginPath(); ctx.moveTo(cx + 0.15, 0.36); ctx.quadraticCurveTo(cx + 0.2 + sway * 2, 0.3, bx, by + 0.11); ctx.stroke();
  // balloon
  const bg = ctx.createRadialGradient(bx - 0.03, by - 0.04, 0.005, bx, by, 0.11);
  bg.addColorStop(0, '#ff8080'); bg.addColorStop(0.4, o.color || '#e0101a'); bg.addColorStop(1, '#6a0008');
  ctx.save(); glow(ctx, 'rgba(255,0,0,0.4)', 0.03); ctx.fillStyle = bg; ctx.beginPath(); ell(ctx, bx, by, 0.085, 0.105); ctx.fill(); ctx.restore();
  ctx.fillStyle = '#8a0010'; ctx.beginPath(); ctx.moveTo(bx - 0.012, by + 0.115); ctx.lineTo(bx + 0.012, by + 0.115); ctx.lineTo(bx, by + 0.1); ctx.fill();
  // body silhouette
  const col = '#08080a'; ctx.fillStyle = col;
  ctx.beginPath(); smoothPath(ctx, [[cx, 0.3], [cx + 0.1, 0.32], [cx + 0.15, 0.5], [cx + 0.17, 0.75], [cx + 0.1, 0.9], [cx + 0.06, 0.9], [cx, 0.7], [cx - 0.06, 0.9], [cx - 0.1, 0.9], [cx - 0.17, 0.75], [cx - 0.15, 0.5], [cx - 0.1, 0.32]]); ctx.fill();
  ctx.beginPath(); ell(ctx, cx - 0.1, 0.94, 0.09, 0.04); ell(ctx, cx + 0.1, 0.94, 0.09, 0.04); ctx.fill();
  ctx.strokeStyle = col; ctx.lineCap = 'round'; lw(ctx, 0.04);
  ctx.beginPath(); ctx.moveTo(cx + 0.09, 0.36); ctx.lineTo(cx + 0.15, 0.36); ctx.moveTo(cx - 0.09, 0.36); ctx.quadraticCurveTo(cx - 0.17, 0.48, cx - 0.15, 0.6); ctx.stroke();
  // ruffle collar
  ctx.beginPath(); for (let i = 0; i < 8; i++) { const a = (i / 8) * TAU; circ(ctx, cx + Math.cos(a) * 0.075, 0.3 + Math.sin(a) * 0.025, 0.032); } ctx.fill();
  // head, hair puffs, hat
  ctx.beginPath(); circ(ctx, cx, 0.22, 0.07);
  for (const s of [-1, 1]) { circ(ctx, cx + s * 0.075, 0.18, 0.04); circ(ctx, cx + s * 0.095, 0.23, 0.035); circ(ctx, cx + s * 0.07, 0.27, 0.03); }
  ctx.fill();
  ctx.beginPath(); ctx.moveTo(cx - 0.05, 0.16); ctx.lineTo(cx + 0.01, 0.02); ctx.lineTo(cx + 0.05, 0.16); ctx.fill(); circ(ctx, cx + 0.01, 0.02, 0.018); ctx.fill();
  // painted grin + eyes
  ctx.save(); glow(ctx, 'rgba(255,255,255,0.6)', 0.01);
  ctx.strokeStyle = '#f2f2f2'; lw(ctx, 0.007); ctx.beginPath(); ctx.moveTo(cx - 0.045, 0.235); ctx.quadraticCurveTo(cx, 0.275, cx + 0.045, 0.235); ctx.stroke();
  ctx.fillStyle = '#f2f2f2'; ctx.beginPath(); ell(ctx, cx - 0.025, 0.2, 0.01, 0.006, 0.3); ell(ctx, cx + 0.025, 0.2, 0.01, 0.006, -0.3); ctx.fill(); ctx.restore();
}, { defaults: { color: '#e0101a' } });

st('hand_reach', 'Reaching Hand', 'figures', 0.6, true, 'A grey hand reaching up from below, fingers clawing.', (ctx, W, H, t, r, o) => {
  const rise = 1 - smooth(t / 0.7), cx = W / 2;
  ctx.translate(Math.sin(t * 1.3) * 0.01, rise * 0.65);
  ctx.translate(cx, 0.6); ctx.rotate(Math.sin(t * 0.9) * 0.04); ctx.translate(-cx, -0.6);
  const curl = 0.5 + 0.5 * Math.sin(t * 2.2), skin = o.color || '#a3ad9f', dark = '#2a3029';
  // forearm
  const ag = ctx.createLinearGradient(cx - 0.1, 0, cx + 0.1, 0); ag.addColorStop(0, '#6d776a'); ag.addColorStop(0.5, skin); ag.addColorStop(1, '#5e675b');
  ctx.fillStyle = ag; ctx.strokeStyle = dark; lw(ctx, 0.008);
  ctx.beginPath(); ctx.moveTo(cx - 0.085, 1.05); ctx.lineTo(cx - 0.075, 0.58); ctx.lineTo(cx + 0.075, 0.58); ctx.lineTo(cx + 0.095, 1.05); ctx.closePath(); ctx.fill(); ctx.stroke();
  // fingers (outline pass, then skin pass)
  const fingers = [[-0.085, -0.38, 0.2], [-0.03, -0.12, 0.24], [0.03, 0.1, 0.23], [0.085, 0.33, 0.19]];
  const segs = fingers.map(([dx, a, L]) => {
    const x0 = cx + dx, y0 = 0.44, a1 = a, x1 = x0 + Math.sin(a1) * L * 0.55, y1 = y0 - Math.cos(a1) * L * 0.55;
    const a2 = a1 + (0.25 + curl * 0.9) * Math.sign(a1 || 0.01) * 0.4 + curl * 0.6 * (dx < 0 ? 1 : -1) * 0.3, x2 = x1 + Math.sin(a2 - curl * 0.5 * Math.sign(dx)) * L * 0.45, y2 = y1 - Math.cos(a2 - curl * 0.5 * Math.sign(dx)) * L * 0.45 + curl * 0.04;
    return [x0, y0, x1, y1, x2, y2];
  });
  const thumb = [cx - 0.08, 0.53, cx - 0.17, 0.46 - curl * 0.02, cx - 0.2, 0.38 + curl * 0.03];
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  for (const pass of [0, 1]) {
    ctx.strokeStyle = pass ? skin : dark;
    for (const s of [...segs, thumb]) { lw(ctx, pass ? 0.042 : 0.056); ctx.beginPath(); ctx.moveTo(s[0], s[1]); ctx.lineTo(s[2], s[3]); ctx.lineTo(s[4], s[5]); ctx.stroke(); }
    ctx.fillStyle = pass ? skin : dark; ctx.beginPath(); ell(ctx, cx, 0.5, pass ? 0.105 : 0.113, pass ? 0.1 : 0.108); ctx.fill();
  }
  // knuckle creases + nails
  ctx.strokeStyle = 'rgba(40,45,40,0.5)'; lw(ctx, 0.004);
  for (const s of segs) { ctx.beginPath(); ctx.arc(s[2], s[3], 0.012, 0, Math.PI); ctx.stroke(); }
  ctx.fillStyle = '#1d1f1a'; for (const s of [...segs, thumb]) { ctx.beginPath(); circ(ctx, s[4], s[5], 0.014); ctx.fill(); }
});

st('tentacle', 'Tentacle', 'figures', 0.7, true, 'A slimy tentacle curling up from the corner.', (ctx, W, H, t, r, o) => {
  const N = 44, pts = []; let x = 0.08, y = 1.04, a = -1.35;
  for (let i = 0; i < N; i++) {
    const u = i / (N - 1);
    pts.push([x, y, a, lerp(0.11, 0.008, Math.pow(u, 0.9))]);
    a += 0.012 + Math.pow(u, 2.5) * 0.25 + Math.sin(t * 1.6 - u * 5) * 0.035 * (0.3 + u);
    x += Math.cos(a) * 0.026; y += Math.sin(a) * 0.026;
  }
  const left = pts.map(([x, y, a, w]) => [x + Math.cos(a - Math.PI / 2) * w, y + Math.sin(a - Math.PI / 2) * w]);
  const right = pts.map(([x, y, a, w]) => [x + Math.cos(a + Math.PI / 2) * w, y + Math.sin(a + Math.PI / 2) * w]);
  const g = ctx.createLinearGradient(0, 1, W, 0.2); g.addColorStop(0, '#1d0f26'); g.addColorStop(0.5, o.color || '#4b2a5e'); g.addColorStop(1, '#6d4a7d');
  ctx.save(); glow(ctx, 'rgba(0,0,0,0.6)', 0.03); ctx.fillStyle = g; ctx.strokeStyle = '#140a1a'; lw(ctx, 0.006);
  ctx.beginPath(); ctx.moveTo(left[0][0], left[0][1]); for (const p of left) ctx.lineTo(p[0], p[1]); for (const p of right.slice().reverse()) ctx.lineTo(p[0], p[1]); ctx.closePath(); ctx.fill(); ctx.stroke(); ctx.restore();
  // glossy highlight and suckers on the inner side
  ctx.strokeStyle = 'rgba(255,220,255,0.18)'; lw(ctx, 0.01); ctx.beginPath();
  pts.forEach(([x, y, a, w], i) => { const p = [x + Math.cos(a - Math.PI / 2) * w * 0.5, y + Math.sin(a - Math.PI / 2) * w * 0.5]; i ? ctx.lineTo(...p) : ctx.moveTo(...p); }); ctx.stroke();
  for (let i = 2; i < N - 4; i += 2) {
    const [x, y, a, w] = pts[i], sx = x + Math.cos(a + Math.PI / 2) * w * 0.62, sy = y + Math.sin(a + Math.PI / 2) * w * 0.62;
    ctx.fillStyle = '#d9a6c9'; ctx.beginPath(); ell(ctx, sx, sy, w * 0.32, w * 0.24, a); ctx.fill();
    ctx.fillStyle = '#7a4a6c'; ctx.beginPath(); ell(ctx, sx, sy, w * 0.14, w * 0.1, a); ctx.fill();
  }
}, { clip: true });

/* ================================================================== CRITTERS */

function drawSpider(ctx, x, y, s, t, rot = 0, walk = true) {
  ctx.save(); ctx.translate(x, y); ctx.rotate(rot); ctx.scale(s, s);
  ctx.strokeStyle = '#070707'; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  for (const side of [-1, 1]) {
    for (let i = 0; i < 4; i++) {
      const ph = walk ? Math.sin(t * 9 + i * 1.6 + (side > 0 ? Math.PI : 0)) : 0;
      const base = (-0.9 + i * 0.6) + ph * 0.18, ang = side > 0 ? base : Math.PI - base;
      const hx = side * 0.05, hy = -0.08 + i * 0.035;
      const kx = hx + Math.cos(ang) * 0.32, ky = hy + Math.sin(ang) * 0.32 - 0.14;
      const fx = hx + Math.cos(ang) * 0.6, fy = hy + Math.sin(ang) * 0.6 + 0.04 + (i < 2 ? -0.05 : 0.05);
      lw(ctx, 0.045); ctx.beginPath(); ctx.moveTo(hx, hy); ctx.lineTo(kx, ky); ctx.stroke();
      lw(ctx, 0.03); ctx.beginPath(); ctx.moveTo(kx, ky); ctx.lineTo(fx, fy); ctx.stroke();
    }
  }
  const ab = ctx.createRadialGradient(-0.05, 0.12, 0.01, 0, 0.2, 0.25); ab.addColorStop(0, '#4a4a52'); ab.addColorStop(0.4, '#151517'); ab.addColorStop(1, '#030303');
  ctx.fillStyle = ab; ctx.beginPath(); ell(ctx, 0, 0.22, 0.17, 0.22); ctx.fill();
  ctx.fillStyle = '#9a0c0c'; ctx.beginPath(); ctx.moveTo(-0.04, 0.17); ctx.lineTo(0.04, 0.17); ctx.lineTo(-0.04, 0.29); ctx.lineTo(0.04, 0.29); ctx.closePath(); ctx.fill();
  ctx.fillStyle = '#0b0b0c'; ctx.beginPath(); ell(ctx, 0, -0.06, 0.1, 0.11); ctx.fill();
  ctx.beginPath(); circ(ctx, 0, -0.17, 0.055); ctx.fill();
  ctx.fillStyle = '#ff3030'; ctx.beginPath(); for (const dx of [-0.022, 0.022, -0.04, 0.04]) circ(ctx, dx, -0.19 + Math.abs(dx) * 0.4, 0.009); ctx.fill();
  ctx.restore();
}
st('spider', 'Crawling Spider', 'critters', 1, true, 'Big hairy-legged spider creeping across the screen.', (ctx, W, H, t, r, o) => {
  const x = 0.5 + 0.06 * Math.sin(t * 0.45), y = 0.5 + 0.05 * Math.sin(t * 0.33 + 1);
  const dx = 0.027 * Math.cos(t * 0.45), dy = 0.0165 * Math.cos(t * 0.33 + 1);
  drawSpider(ctx, x, y, 0.62, t, Math.atan2(dy, dx) + Math.PI / 2);
}, { clip: true });

function drawWeb(ctx, ox, oy, sx, sy, R, r, t = 0) {
  // corner web: origin (ox,oy), growing toward (sx,sy) quadrant
  const spokes = 8, rings = [0.12, 0.22, 0.33, 0.45, 0.58, 0.72, 0.86, 1.0];
  const angs = []; for (let i = 0; i < spokes; i++) angs.push((i / (spokes - 1)) * (Math.PI / 2) + (r() - 0.5) * 0.08);
  const pt = (a, d) => [ox + sx * Math.cos(a) * d * R, oy + sy * Math.sin(a) * d * R];
  ctx.strokeStyle = 'rgba(235,238,245,0.75)'; lw(ctx, R * 0.006);
  ctx.beginPath(); for (const a of angs) { const p = pt(a, 1.08); ctx.moveTo(ox, oy); ctx.lineTo(p[0], p[1]); } ctx.stroke();
  lw(ctx, R * 0.004);
  rings.forEach((d, k) => {
    ctx.beginPath();
    for (let i = 0; i < spokes - 1; i++) {
      if (k > 3 && r() < 0.08) continue;
      const dd = d * (1 + (r() - 0.5) * 0.05), p = pt(angs[i], dd), q = pt(angs[i + 1], dd), m = pt((angs[i] + angs[i + 1]) / 2, dd * 0.9);
      ctx.moveTo(p[0], p[1]); ctx.quadraticCurveTo(m[0], m[1], q[0], q[1]);
    }
    ctx.stroke();
  });
  // a loose hanging strand
  const p = pt(angs[5], 0.72), sw = Math.sin(t * 1.5) * R * 0.03;
  ctx.beginPath(); ctx.moveTo(p[0], p[1]); ctx.quadraticCurveTo(p[0] + sw, p[1] + sy * R * 0.15, p[0] + sw * 2, p[1] + sy * R * 0.28); ctx.stroke();
}
st('spider_web', 'Spider Web', 'critters', 1, false, 'Dusty cobweb anchored in a corner.', (ctx, W, H, t, r, o) => {
  ctx.save(); glow(ctx, 'rgba(255,255,255,0.35)', 0.01); drawWeb(ctx, 0, 0, 1, 1, 1, r, t); ctx.restore();
  drawSpider(ctx, 0.47, 0.5, 0.18, t, 0.6, false);
}, { clip: true });

function batShape(ctx, flap) {
  const up = flap; // -1 (down) .. 1 (up)
  const tipY = -0.25 * up, wristY = -0.35 * up - 0.05;
  ctx.beginPath();
  ctx.moveTo(0, -0.08);
  for (const s of [1, -1]) {
    ctx.lineTo(s * 0.12, -0.1); ctx.lineTo(s * 0.38, wristY); ctx.lineTo(s * 0.7, tipY);
    ctx.quadraticCurveTo(s * 0.6, tipY + 0.12, s * 0.55, tipY + 0.2);
    ctx.quadraticCurveTo(s * 0.45, wristY + 0.2, s * 0.38, wristY + 0.32);
    ctx.quadraticCurveTo(s * 0.28, 0.0, s * 0.2, 0.12);
    ctx.quadraticCurveTo(s * 0.12, 0.02, s * 0.05, 0.12);
    ctx.lineTo(0, 0.14); if (s > 0) ctx.moveTo(0, -0.08);
  }
  ctx.closePath();
  ell(ctx, 0, 0.0, 0.07, 0.13);
  ctx.moveTo(-0.05, -0.1); ctx.lineTo(-0.045, -0.2); ctx.lineTo(-0.015, -0.12); ctx.lineTo(0.015, -0.12); ctx.lineTo(0.045, -0.2); ctx.lineTo(0.05, -0.1); ctx.closePath();
}
st('bats', 'Bats', 'critters', 1.6, true, 'A little colony of bats flapping past.', (ctx, W, H, t, r, o) => {
  const n = 6;
  for (let i = 0; i < n; i++) {
    const x0 = (i / n) * (W + 0.5) + r() * 0.15, y0 = 0.2 + r() * 0.6, sp = 0.12 + r() * 0.12, s = 0.24 + r() * 0.2, ph = r() * TAU, fr = 9 + r() * 5;
    const x = ((x0 + t * sp) % (W + 0.5)) - 0.25, y = y0 + Math.sin(t * 2 + ph) * 0.05;
    ctx.save(); ctx.translate(x, y); ctx.scale(s, s); ctx.rotate(Math.sin(t * 2 + ph) * 0.15);
    ctx.fillStyle = o.color || '#09090b'; ctx.strokeStyle = 'rgba(150,150,170,0.45)'; lw(ctx, 0.015);
    batShape(ctx, Math.sin(t * fr + ph)); ctx.fill('nonzero'); ctx.stroke();
    ctx.fillStyle = '#ff4040'; ctx.beginPath(); circ(ctx, -0.02, -0.06, 0.012); circ(ctx, 0.02, -0.06, 0.012); ctx.fill();
    ctx.restore();
  }
}, { clip: true });

const CROW_WING = [[0.1, 0], [0.07, -0.25], [0.01, -0.45], [-0.02, -0.64], [-0.07, -0.5], [-0.11, -0.62], [-0.14, -0.47], [-0.19, -0.56], [-0.21, -0.42],
  [-0.27, -0.47], [-0.27, -0.33], [-0.33, -0.34], [-0.25, -0.2], [-0.2, -0.05], [-0.1, 0.02]];
function crowWing(ctx, flap) {
  ctx.save(); ctx.translate(0.05, -0.04); ctx.scale(1, Math.abs(flap) < 0.08 ? 0.08 * Math.sign(flap || 1) : flap);
  ctx.beginPath(); CROW_WING.forEach(([x, y], i) => ctx[i ? 'lineTo' : 'moveTo'](x, y)); ctx.closePath(); ctx.restore();
}
function crowBody(ctx) {
  ctx.beginPath();
  ell(ctx, 0, 0, 0.3, 0.085, -0.04);
  circ(ctx, 0.29, -0.05, 0.075);
  ctx.moveTo(0.34, -0.08); ctx.lineTo(0.5, -0.03); ctx.lineTo(0.345, -0.01); ctx.closePath();
  ctx.moveTo(-0.22, -0.03); ctx.lineTo(-0.52, -0.09); ctx.lineTo(-0.5, 0.07); ctx.lineTo(-0.22, 0.045); ctx.closePath();
}
st('crows', 'Crows', 'critters', 1.6, true, 'Black crows flapping and gliding across the sky.', (ctx, W, H, t, r, o) => {
  for (let i = 0; i < 3; i++) {
    const x0 = 0.25 + i * 0.55 + r() * 0.1, y0 = 0.4 + r() * 0.3, sp = 0.06 + r() * 0.05, s = 0.6 + r() * 0.15, ph = r() * TAU;
    const x = ((x0 + t * sp) % (W + 0.7)) - 0.35, y = y0 + Math.sin(t * 1.2 + ph) * 0.04;
    const glide = fract((t + ph) / 3.5) > 0.65, flap = glide ? 0.35 : Math.sin(t * 6 + ph);
    ctx.save(); ctx.translate(x, y); ctx.scale(s, s); ctx.rotate(-0.05 + Math.sin(t + ph) * 0.06);
    const col = o.color || '#0a0a0c';
    ctx.fillStyle = '#1c1c22'; crowWing(ctx, flap * 0.8); ctx.fill();
    ctx.fillStyle = col; ctx.strokeStyle = 'rgba(150,150,170,0.45)'; lw(ctx, 0.012);
    crowBody(ctx); ctx.fill(); ctx.stroke();
    crowWing(ctx, flap); ctx.fill(); ctx.stroke();
    ctx.fillStyle = '#d8d8d8'; ctx.beginPath(); circ(ctx, 0.31, -0.06, 0.012); ctx.fill();
    ctx.restore();
  }
}, { clip: true });

st('flies', 'Buzzing Flies', 'critters', 1.2, true, 'A cloud of flies buzzing around something nasty.', (ctx, W, H, t, r, o) => {
  for (let i = 0; i < 8; i++) {
    const a = r() * TAU, b = r() * TAU, fa = 1.1 + r() * 1.6, fb = 0.9 + r() * 1.7, rx = 0.12 + r() * 0.3, ry = 0.1 + r() * 0.24;
    const pos = (tt) => [W / 2 + Math.sin(tt * fa + a) * rx + Math.sin(tt * 7.3 + b) * 0.02, 0.5 + Math.sin(tt * fb + b) * ry + Math.cos(tt * 8.1 + a) * 0.02];
    const [x, y] = pos(t), [px, py] = pos(t - 0.03);
    ctx.strokeStyle = 'rgba(30,30,30,0.25)'; lw(ctx, 0.006); ctx.beginPath(); ctx.moveTo(px, py); ctx.lineTo(x, y); ctx.stroke();
    const ang = Math.atan2(y - py, x - px), s = 0.05 + (i % 3) * 0.01;
    ctx.save(); ctx.translate(x, y); ctx.rotate(ang);
    const wa = 0.35 + 0.35 * Math.abs(Math.sin(t * 90 + i));
    ctx.fillStyle = `rgba(220,230,240,${wa})`; ctx.beginPath(); ell(ctx, -s * 0.2, -s * 0.55, s * 0.6, s * 0.3, -0.5); ell(ctx, -s * 0.2, s * 0.55, s * 0.6, s * 0.3, 0.5); ctx.fill();
    ctx.fillStyle = '#0d0d0d'; ctx.beginPath(); ell(ctx, 0, 0, s * 0.7, s * 0.38); circ(ctx, s * 0.65, 0, s * 0.3); ctx.fill();
    ctx.fillStyle = '#7a1a10'; ctx.beginPath(); circ(ctx, s * 0.75, -s * 0.17, s * 0.13); circ(ctx, s * 0.75, s * 0.17, s * 0.13); ctx.fill();
    ctx.restore();
  }
}, { clip: true });

/* ================================================================== MARKS & MESSAGES */

function handPath(ctx, cx, cy, s, spread = 1) {
  ell(ctx, cx, cy, 0.17 * s, 0.19 * s);
  const f = [[-0.13, -0.34, 0.16, -0.22], [-0.045, -0.4, 0.19, -0.07], [0.05, -0.39, 0.18, 0.07], [0.135, -0.32, 0.14, 0.24]];
  for (const [dx, dy, L, a] of f) {
    const ang = a * spread - Math.PI / 2, x = cx + dx * s * spread, y = cy + dy * s;
    ell(ctx, x, y, L * s, 0.04 * s, ang);
  }
  ell(ctx, cx - 0.22 * s * spread, cy - 0.02 * s, 0.12 * s, 0.045 * s, -2.4);
}
st('handprint', 'Red Handprint', 'marks', 0.8, true, 'A smudged red paint handprint, still dripping.', (ctx, W, H, t, r, o) => {
  const cx = W / 2, cy = 0.55, s = 1.05, col = o.color || '#8e0a0a';
  ctx.fillStyle = col; ctx.beginPath(); handPath(ctx, cx, cy, s); ctx.fill('nonzero');
  // texture inside the print
  ctx.save(); ctx.beginPath(); handPath(ctx, cx, cy, s); ctx.clip('nonzero');
  for (let i = 0; i < 70; i++) { ctx.fillStyle = r() < 0.5 ? 'rgba(50,0,0,0.25)' : 'rgba(200,40,30,0.22)'; ctx.beginPath(); circ(ctx, cx + (r() - 0.5) * 0.6, cy + (r() - 0.7) * 0.8, 0.005 + r() * 0.025); ctx.fill(); }
  ctx.strokeStyle = 'rgba(40,0,0,0.25)'; lw(ctx, 0.004);
  for (let i = 0; i < 6; i++) { ctx.beginPath(); ctx.arc(cx + (r() - 0.5) * 0.1, cy + 0.05, 0.05 + i * 0.02, 3.6, 5.8); ctx.stroke(); }
  ctx.restore();
  // drips
  ctx.fillStyle = col;
  for (let i = 0; i < 4; i++) {
    const x = cx + (r() - 0.5) * 0.26, y0 = cy + 0.14, L = (0.06 + r() * 0.16) * (0.6 + 0.4 * smooth(t / 3 + r() * 0.3)), w = 0.008 + r() * 0.01;
    ctx.beginPath(); ctx.moveTo(x - w, y0); ctx.lineTo(x - w * 0.8, y0 + L); ctx.arc(x, y0 + L, w * 1.15, Math.PI, 0, true); ctx.lineTo(x + w, y0); ctx.fill();
  }
  for (let i = 0; i < 10; i++) { ctx.beginPath(); circ(ctx, cx + (r() - 0.5) * 0.7, cy + (r() - 0.5) * 0.8, 0.004 + r() * 0.01); ctx.fill(); }
}, { defaults: { color: '#8e0a0a' } });

st('handprint_glass', 'Handprint on Glass', 'marks', 0.8, false, 'Greasy handprint smeared down a window.', (ctx, W, H, t, r, o) => {
  const cx = W / 2, cy = 0.42, s = 0.95;
  for (let k = 14; k >= 0; k--) {
    ctx.fillStyle = `rgba(225,232,240,${k === 0 ? 0.28 : 0.035})`;
    ctx.beginPath(); handPath(ctx, cx, cy + k * 0.022, s * (1 - k * 0.004)); ctx.fill();
  }
  ctx.save(); ctx.beginPath(); handPath(ctx, cx, cy, s); ctx.clip();
  ctx.strokeStyle = 'rgba(255,255,255,0.35)'; lw(ctx, 0.003);
  const tips = [[-0.13, -0.47], [-0.045, -0.56], [0.05, -0.55], [0.135, -0.44], [0, 0]];
  for (const [dx, dy] of tips) { for (let i = 1; i < 6; i++) { ctx.beginPath(); ctx.ellipse(cx + dx * s, cy + dy * s, i * 0.008, i * 0.011, 0, 0, TAU); ctx.stroke(); } }
  ctx.restore();
  ctx.strokeStyle = 'rgba(230,236,244,0.18)'; lw(ctx, 0.012); ctx.lineCap = 'round';
  for (const [dx] of tips.slice(0, 4)) { ctx.beginPath(); ctx.moveTo(cx + dx * s, cy - 0.3); ctx.lineTo(cx + dx * s + 0.01, cy + 0.5 + r() * 0.1); ctx.stroke(); }
});

st('blood_drips', 'Dripping Red', 'marks', 2, true, 'Red paint oozing and dripping down from the top edge.', (ctx, w, h, t, r, o) => {
  const col = o.color || '#9a0b0b', u = Math.min(w, h * 2) / 2;
  const g = ctx.createLinearGradient(0, 0, 0, h); g.addColorStop(0, '#5a0303'); g.addColorStop(0.3, col); g.addColorStop(1, '#6d0606');
  ctx.fillStyle = g;
  ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(w, 0);
  const n = 26; for (let i = n; i >= 0; i--) { const x = (i / n) * w; ctx.lineTo(x, h * (0.04 + 0.03 * Math.sin(i * 2.7) + 0.02 * r())); }
  ctx.closePath(); ctx.fill();
  const drips = 15;
  for (let i = 0; i < drips; i++) {
    const x = (i + 0.2 + r() * 0.6) / drips * w, dw = u * (0.012 + r() * 0.018), sp = 0.08 + r() * 0.12, ph = r(), maxL = h * (0.25 + r() * 0.65), base = h * (0.06 + r() * 0.08);
    const c = fract(t * sp + ph), L = c < 0.85 ? lerp(base, maxL, Math.pow(c / 0.85, 0.7)) : lerp(maxL, base * 1.3, smooth((c - 0.85) / 0.15));
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.moveTo(x - dw * 1.6, 0); ctx.quadraticCurveTo(x - dw, h * 0.05, x - dw * 0.75, L - dw);
    ctx.arc(x, L, dw * 1.05, Math.PI, 0, true); ctx.quadraticCurveTo(x + dw, h * 0.05, x + dw * 1.6, 0); ctx.closePath(); ctx.fill();
    ctx.fillStyle = 'rgba(255,190,190,0.25)'; ctx.beginPath(); ell(ctx, x - dw * 0.4, L - dw * 0.3, dw * 0.25, dw * 0.45); ctx.fill();
    if (c >= 0.85) { const fy = maxL + (c - 0.85) / 0.15 * h * 0.8; if (fy < h) { ctx.fillStyle = col; ctx.beginPath(); ell(ctx, x, fy, dw * 0.9, dw * 1.3); ctx.fill(); } }
  }
}, { fit: 'stretch', defaults: { color: '#9a0b0b' } });

st('scratch_marks', 'Claw Scratches', 'marks', 0.9, false, 'Four deep claw marks gouged into the wall.', (ctx, W, H, t, r, o) => {
  for (let i = 0; i < 4; i++) {
    const x0 = 0.12 + i * 0.13, y0 = 0.08 + i * 0.03, x1 = x0 + 0.26, y1 = 0.9 - (3 - i) * 0.04, n = 22;
    const pts = []; for (let k = 0; k <= n; k++) { const u = k / n; pts.push([lerp(x0, x1, u) + Math.sin(u * 3) * 0.03, lerp(y0, y1, u), Math.sin(u * Math.PI) ** 0.7 * (0.045 - i * 0.003)]); }
    const nx = 0.95, ny = -0.3;
    for (const [col, off, sc] of [['rgba(225,210,190,0.75)', 0.008, 1.15], ['#1b0f0a', 0, 1], ['rgba(70,30,20,0.9)', -0.003, 0.45]]) {
      ctx.fillStyle = col; ctx.beginPath();
      pts.forEach(([x, y, w], k) => { const j = (r() - 0.5) * 0.004; ctx[k ? 'lineTo' : 'moveTo'](x + off - nx * w * sc + j, y - ny * w * sc); });
      for (const [x, y, w] of pts.slice().reverse()) ctx.lineTo(x + off + nx * w * sc * 0.6, y + ny * w * sc * 0.6);
      ctx.closePath(); ctx.fill();
    }
  }
});

st('cracked_glass', 'Cracked Glass', 'marks', 1.6, false, 'A spiderweb crack across the lens.', (ctx, w, h, t, r, o) => {
  const cx = w * 0.45, cy = h * 0.42, R = Math.hypot(w, h), n = 15, rays = [];
  for (let i = 0; i < n; i++) {
    let a = (i / n) * TAU + (r() - 0.5) * 0.3, x = cx, y = cy, d = 0; const ray = [[x, y]];
    while (d < R) { const st = R * (0.03 + r() * 0.05); a += (r() - 0.5) * 0.25; x += Math.cos(a) * st; y += Math.sin(a) * st; d += st; ray.push([x, y]); }
    rays.push(ray);
  }
  const lines = [];
  rays.forEach((ray) => lines.push(ray));
  // concentric rings between neighbouring rays
  for (const k of [2, 4, 6, 9]) {
    for (let i = 0; i < n; i++) {
      if (r() < 0.3) continue;
      const a = rays[i][Math.min(k, rays[i].length - 1)], b = rays[(i + 1) % n][Math.min(k + (r() < 0.5 ? 1 : 0), rays[(i + 1) % n].length - 1)];
      const m = [(a[0] + b[0]) / 2 + (r() - 0.5) * R * 0.02, (a[1] + b[1]) / 2 + (r() - 0.5) * R * 0.02]; lines.push([a, m, b]);
    }
  }
  const px = Math.max(1, Math.min(w, h) / 300);
  ctx.lineJoin = 'round';
  ctx.strokeStyle = 'rgba(0,0,0,0.45)'; ctx.lineWidth = px * 1.6; ctx.beginPath();
  for (const L of lines) L.forEach(([x, y], i) => ctx[i ? 'lineTo' : 'moveTo'](x + px, y + px)); ctx.stroke();
  ctx.save(); ctx.shadowColor = 'rgba(255,255,255,0.6)'; ctx.shadowBlur = px * 3;
  ctx.strokeStyle = 'rgba(245,250,255,0.9)'; ctx.lineWidth = px; ctx.beginPath();
  for (const L of lines) L.forEach(([x, y], i) => ctx[i ? 'lineTo' : 'moveTo'](x, y)); ctx.stroke(); ctx.restore();
  // shattered impact point
  ctx.fillStyle = 'rgba(255,255,255,0.25)'; ctx.beginPath(); circ(ctx, cx, cy, Math.min(w, h) * 0.035); ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,0.8)'; ctx.lineWidth = px * 0.8; ctx.beginPath();
  for (let i = 0; i < 30; i++) { const a = r() * TAU, d = r() * Math.min(w, h) * 0.06; ctx.moveTo(cx, cy); ctx.lineTo(cx + Math.cos(a) * d, cy + Math.sin(a) * d); } ctx.stroke();
}, { fit: 'stretch' });

function scrawl(ctx, str, W, H, t, r, col, dripAmt = 1) {
  const size = 0.62, tw = measure(ctx, str, size), sx = Math.min(1, (W * 0.92) / tw), x0 = (W - tw * sx) / 2, y0 = 0.62;
  ctx.save(); ctx.translate(x0, y0); ctx.scale(sx, 1);
  ctx.fillStyle = col;
  // rough brush: many slightly offset passes, letters individually jittered
  let x = 0;
  for (const ch of str) {
    const cw = measure(ctx, ch, size), rot = (r() - 0.5) * 0.12, dy = (r() - 0.5) * 0.05;
    for (let k = 0; k < 5; k++) {
      ctx.save(); ctx.globalAlpha *= k ? 0.35 : 1; ctx.translate(x + cw / 2 + (r() - 0.5) * 0.012, dy + (r() - 0.5) * 0.012); ctx.rotate(rot);
      text(ctx, ch, -cw / 2, 0, size); ctx.restore();
    }
    x += cw;
  }
  ctx.restore();
  // drips under letters
  ctx.fillStyle = col;
  const n = Math.round(str.replace(/ /g, '').length * 1.6);
  for (let i = 0; i < n; i++) {
    const dx = x0 + r() * tw * sx, w = 0.006 + r() * 0.012, L = (0.05 + r() * 0.28) * dripAmt * (0.55 + 0.45 * smooth(t / 2.5 + r() * 0.2)), y = y0 - 0.02;
    ctx.beginPath(); ctx.moveTo(dx - w, y); ctx.lineTo(dx - w * 0.7, y + L); ctx.arc(dx, y + L, w * 1.2, Math.PI, 0, true); ctx.lineTo(dx + w, y); ctx.fill();
  }
}
st('get_out', '"GET OUT" Scrawl', 'marks', 2.4, true, 'GET OUT scrawled in dripping red paint.', (ctx, W, H, t, r, o) => {
  ctx.save(); glow(ctx, 'rgba(0,0,0,0.7)', 0.02); scrawl(ctx, (o.text || 'GET OUT').toUpperCase(), W, H, t, r, o.color || '#a50d0d'); ctx.restore();
}, { defaults: { text: 'GET OUT', color: '#a50d0d' } });

const fogCache = new Map();
st('help_me', '"HELP ME" on Foggy Glass', 'marks', 1.6, true, 'HELP ME finger-written on a fogged-up window.', (ctx, W, H, t, r, o) => {
  // render fog + wiped letters on a private canvas (destination-out never touches the caller's canvas)
  const k = pxScale(ctx), pw = Math.max(16, Math.min(1600, Math.round(W * k))), ph = Math.max(10, Math.min(1000, Math.round(H * k)));
  const str = (o.text || 'HELP ME').toUpperCase(), reveal = clamp(t / 0.75, 0, 1), rv = Math.round(reveal * 40);
  const key = `${pw}x${ph}|${str}|${o.seed || 1}|${rv}`;
  let cv = fogCache.get(key);
  if (!cv) {
    if (fogCache.size > 24) fogCache.clear();
    cv = makeCanvas(pw, ph); const c = cv.getContext('2d'), rr = mulberry32(hashStr(str) + (o.seed || 1));
    c.scale(pw / W, ph / H);
    const fg = c.createRadialGradient(0, 0, 0, 0, 0, 1);
    fg.addColorStop(0, 'rgba(215,225,232,0.8)'); fg.addColorStop(0.65, 'rgba(205,215,225,0.68)'); fg.addColorStop(1, 'rgba(200,210,220,0)');
    c.save(); c.translate(W / 2, 0.5); c.scale(W / 2, 0.5); c.fillStyle = fg; c.fillRect(-1, -1, 2, 2); c.restore();
    for (let i = 0; i < 60; i++) { const an = rr() * TAU, d = Math.sqrt(rr()) * 0.7, br = 0.03 + rr() * 0.08; c.fillStyle = `rgba(235,240,245,${0.05 + rr() * 0.08})`; c.beginPath(); circ(c, W / 2 + Math.cos(an) * d * W / 2, 0.5 + Math.sin(an) * d * 0.5, br * (1 - d)); c.fill(); }
    const size = 0.46, tw = measure(c, str, size, FONT_SERIF, 'italic bold'), sx = Math.min(1, W * 0.88 / tw), x0 = (W - tw * sx) / 2;
    c.save(); c.beginPath(); c.rect(0, 0, x0 + tw * sx * (rv / 40), H); c.clip();
    c.translate(x0, 0.64); c.scale(sx, 1); c.lineJoin = 'round'; c.lineCap = 'round';
    c.strokeStyle = 'rgba(250,252,255,0.75)'; c.lineWidth = 0.075; text(c, str, 0, 0, size, FONT_SERIF, 'stroke', 'italic bold');
    c.globalCompositeOperation = 'destination-out';
    c.strokeStyle = '#000'; c.lineWidth = 0.04; text(c, str, 0, 0, size, FONT_SERIF, 'stroke', 'italic bold'); text(c, str, 0, 0, size, FONT_SERIF, 'fill', 'italic bold');
    c.restore();
    // trickles running down from the letters
    c.globalCompositeOperation = 'destination-out'; c.strokeStyle = '#000'; c.lineCap = 'round';
    for (let i = 0; i < 9; i++) { const x = x0 + rr() * tw * sx * (rv / 40), L = 0.08 + rr() * 0.25; c.lineWidth = 0.008 + rr() * 0.008; c.beginPath(); c.moveTo(x, 0.62); c.lineTo(x + (rr() - 0.5) * 0.01, 0.62 + L); c.stroke(); }
    fogCache.set(key, cv);
  }
  ctx.drawImage(cv, 0, 0, W, H);
});

st('tally_marks', 'Tally Marks', 'marks', 1.4, false, 'Days counted in chalk on the wall… a lot of days.', (ctx, W, H, t, r, o) => {
  ctx.strokeStyle = o.color || 'rgba(235,230,215,0.85)'; ctx.lineCap = 'round';
  const chalk = (x0, y0, x1, y1) => { for (let k = 0; k < 4; k++) { lw(ctx, 0.006 + r() * 0.006); ctx.beginPath(); const j = () => (r() - 0.5) * 0.012; ctx.moveTo(x0 + j(), y0 + j()); ctx.quadraticCurveTo((x0 + x1) / 2 + j() * 2, (y0 + y1) / 2 + j() * 2, x1 + j(), y1 + j()); ctx.stroke(); } };
  const rows = [[0.12, 5], [0.55, 4]];
  for (const [ry, groups] of rows) {
    for (let gI = 0; gI < groups; gI++) {
      const gx = 0.08 + gI * 0.27 + (r() - 0.5) * 0.02, gy = ry + (r() - 0.5) * 0.04, cnt = ry > 0.5 && gI === groups - 1 ? 3 : 4;
      for (let i = 0; i < cnt; i++) chalk(gx + i * 0.045, gy, gx + i * 0.045 + (r() - 0.5) * 0.02, gy + 0.32);
      if (cnt === 4) chalk(gx - 0.03, gy + 0.27, gx + 0.17, gy + 0.05);
    }
  }
  ctx.fillStyle = 'rgba(235,230,215,0.3)'; for (let i = 0; i < 80; i++) { ctx.beginPath(); circ(ctx, r() * W, r(), 0.002 + r() * 0.003); ctx.fill(); }
});

function glyph(ctx, rr, x, y, s, rot) {
  const P = [[-1, -1], [0, -1], [1, -1], [-1, 0], [0, 0], [1, 0], [-1, 1], [0, 1], [1, 1]];
  ctx.save(); ctx.translate(x, y); ctx.rotate(rot); ctx.scale(s, s); ctx.beginPath();
  const n = 2 + Math.floor(rr() * 3);
  for (let i = 0; i < n; i++) { const a = P[Math.floor(rr() * 9)], b = P[Math.floor(rr() * 9)]; ctx.moveTo(a[0], a[1]); if (rr() < 0.3) ctx.arc(0, 0, 0.8, rr() * TAU, rr() * TAU); else ctx.lineTo(b[0], b[1]); }
  if (rr() < 0.4) { ctx.moveTo(0.35, 0); ctx.arc(0, 0, 0.35, 0, TAU); }
  ctx.restore(); ctx.stroke();
}
st('rune_circle', 'Rune Circle', 'marks', 1, true, 'Glowing summoning circle of made-up runes, slowly turning.', (ctx, W, H, t, r, o) => {
  const cx = 0.5, cy = 0.5, col = o.color || '#ff5a1f', pulse = 0.7 + 0.3 * Math.sin(t * 2);
  ctx.save(); glow(ctx, col, 0.04 * pulse); ctx.strokeStyle = col; ctx.globalAlpha *= 0.75 + 0.25 * pulse; ctx.lineCap = 'round';
  ctx.translate(cx, cy); ctx.rotate(t * 0.15);
  lw(ctx, 0.012); ctx.beginPath(); circ(ctx, 0, 0, 0.47); ctx.stroke(); lw(ctx, 0.008); ctx.beginPath(); circ(ctx, 0, 0, 0.36); ctx.stroke();
  const rr = mulberry32(777 + (o.seed || 1));
  for (let i = 0; i < 14; i++) { const a = (i / 14) * TAU; lw(ctx, 0.007); glyph(ctx, rr, Math.cos(a) * 0.415, Math.sin(a) * 0.415, 0.03, a + Math.PI / 2); }
  ctx.rotate(-t * 0.35);
  lw(ctx, 0.008); ctx.beginPath();
  for (let i = 0; i < 3; i++) { const a = (i / 3) * TAU - Math.PI / 2; circ(ctx, Math.cos(a) * 0.12, Math.sin(a) * 0.12, 0.17); }
  ctx.stroke();
  ctx.beginPath(); for (let i = 0; i < 12; i++) { const a = (i / 12) * TAU; ctx.moveTo(Math.cos(a) * 0.3, Math.sin(a) * 0.3); ctx.lineTo(Math.cos(a) * 0.36, Math.sin(a) * 0.36); } ctx.stroke();
  ctx.fillStyle = col; ctx.beginPath(); circ(ctx, 0, 0, 0.035); ctx.fill();
  ctx.beginPath(); ctx.moveTo(0, -0.08); ctx.quadraticCurveTo(0.06, 0, 0, 0.08); ctx.quadraticCurveTo(-0.06, 0, 0, -0.08); ctx.stroke();
  ctx.restore();
}, { defaults: { color: '#ff5a1f' } });

/* ================================================================== OBJECTS */

st('lightbulb', 'Swinging Lightbulb', 'objects', 0.5, true, 'A bare bulb on a cord, swinging and flickering.', (ctx, W, H, t, r, o) => {
  const ang = 0.22 * Math.sin(t * 1.7), on = vnoise(t * 14, 1) > 0.22 ? 1 : 0.15, I = on * (0.85 + 0.15 * vnoise(t * 40, 2));
  ctx.translate(W / 2, 0); ctx.rotate(ang);
  const by = 0.72;
  const halo = ctx.createRadialGradient(0, by, 0.02, 0, by, 0.42); halo.addColorStop(0, `rgba(255,220,140,${0.55 * I})`); halo.addColorStop(1, 'rgba(255,200,120,0)');
  ctx.fillStyle = halo; ctx.fillRect(-0.45, by - 0.45, 0.9, 0.9);
  ctx.strokeStyle = '#151515'; lw(ctx, 0.008); ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(0, 0.57); ctx.stroke();
  const sg = ctx.createLinearGradient(-0.035, 0, 0.035, 0); sg.addColorStop(0, '#2a2a2a'); sg.addColorStop(0.5, '#777'); sg.addColorStop(1, '#222');
  ctx.fillStyle = sg; ctx.fillRect(-0.035, 0.57, 0.07, 0.07);
  ctx.strokeStyle = '#444'; lw(ctx, 0.004); for (let i = 1; i < 4; i++) { ctx.beginPath(); ctx.moveTo(-0.035, 0.57 + i * 0.017); ctx.lineTo(0.035, 0.57 + i * 0.017); ctx.stroke(); }
  const bg = ctx.createRadialGradient(-0.02, by - 0.02, 0.005, 0, by, 0.1);
  bg.addColorStop(0, `rgba(255,255,240,${0.5 + 0.5 * I})`); bg.addColorStop(0.5, `rgba(255,225,150,${0.4 + 0.5 * I})`); bg.addColorStop(1, `rgba(200,160,90,${0.5 + 0.3 * I})`);
  ctx.save(); glow(ctx, `rgba(255,210,120,${I})`, 0.1); ctx.fillStyle = bg;
  ctx.beginPath(); ctx.moveTo(-0.03, 0.64); ctx.quadraticCurveTo(-0.03, 0.67, -0.07, 0.7); ctx.arc(0, by + 0.01, 0.085, Math.PI + 0.6, -0.6, true); ctx.quadraticCurveTo(0.03, 0.67, 0.03, 0.64); ctx.closePath(); ctx.fill(); ctx.restore();
  ctx.strokeStyle = `rgba(255,150,60,${0.6 + 0.4 * I})`; lw(ctx, 0.004); ctx.beginPath(); ctx.moveTo(-0.015, 0.66); ctx.lineTo(-0.012, 0.71); ctx.quadraticCurveTo(0, 0.68, 0.012, 0.71); ctx.lineTo(0.015, 0.66); ctx.stroke();
});

st('candle', 'Flickering Candle', 'objects', 0.4, true, 'A dripping candle with a restless flame.', (ctx, W, H, t, r, o) => {
  const cx = W / 2, top = 0.47, f = vnoise(t * 8, 3), sway = (vnoise(t * 3, 6) - 0.5) * 0.04, fh = 0.17 * (0.85 + 0.3 * f);
  const halo = ctx.createRadialGradient(cx, 0.35, 0.01, cx, 0.35, 0.38); halo.addColorStop(0, `rgba(255,190,90,${0.35 + 0.2 * f})`); halo.addColorStop(1, 'rgba(255,160,60,0)');
  ctx.fillStyle = halo; ctx.fillRect(cx - 0.4, -0.05, 0.8, 0.8);
  const wg = ctx.createLinearGradient(cx - 0.08, 0, cx + 0.08, 0); wg.addColorStop(0, '#b9ab8e'); wg.addColorStop(0.45, '#f4ecd6'); wg.addColorStop(1, '#a89a7c');
  ctx.fillStyle = wg; ctx.beginPath(); ctx.moveTo(cx - 0.08, top); ctx.lineTo(cx - 0.08, 0.9); ctx.lineTo(cx + 0.08, 0.9); ctx.lineTo(cx + 0.08, top); ctx.ellipse(cx, top, 0.08, 0.018, 0, 0, Math.PI, true); ctx.fill();
  for (const [dx, L] of [[-0.075, 0.12], [-0.03, 0.06], [0.05, 0.16], [0.08, 0.08]]) { ctx.beginPath(); ctx.moveTo(cx + dx - 0.014, top); ctx.lineTo(cx + dx - 0.01, top + L); ctx.arc(cx + dx, top + L, 0.012, Math.PI, 0, true); ctx.lineTo(cx + dx + 0.014, top); ctx.fill(); }
  ctx.fillStyle = 'rgba(255,240,200,0.8)'; ctx.beginPath(); ell(ctx, cx, top, 0.07, 0.014); ctx.fill();
  ctx.fillStyle = '#2b2620'; ctx.beginPath(); ell(ctx, cx, 0.92, 0.17, 0.04); ctx.fill(); ctx.fillStyle = '#4a4034'; ctx.beginPath(); ell(ctx, cx, 0.9, 0.15, 0.03); ctx.fill();
  ctx.strokeStyle = '#111'; lw(ctx, 0.008); ctx.beginPath(); ctx.moveTo(cx, top); ctx.lineTo(cx, top - 0.03); ctx.stroke();
  const fy = top - 0.03, fg = ctx.createRadialGradient(cx, fy - fh * 0.25, 0.002, cx, fy - fh * 0.35, fh * 0.7);
  fg.addColorStop(0, '#ffffff'); fg.addColorStop(0.3, '#fff2a0'); fg.addColorStop(0.65, '#ffab2e'); fg.addColorStop(1, 'rgba(255,90,0,0)');
  ctx.save(); glow(ctx, 'rgba(255,170,60,0.9)', 0.06); ctx.fillStyle = fg;
  ctx.beginPath(); ctx.moveTo(cx + sway, fy - fh); ctx.bezierCurveTo(cx + 0.045, fy - fh * 0.5, cx + 0.04, fy, cx, fy + 0.008); ctx.bezierCurveTo(cx - 0.04, fy, cx - 0.045, fy - fh * 0.5, cx + sway, fy - fh); ctx.fill(); ctx.restore();
  ctx.fillStyle = 'rgba(80,120,255,0.5)'; ctx.beginPath(); ell(ctx, cx, fy - 0.005, 0.012, 0.012); ctx.fill();
});

st('planchette', 'Spirit Board Planchette', 'objects', 1.3, true, 'A talking-board pointer sliding from letter to letter.', (ctx, W, H, t, r, o) => {
  const bg = ctx.createLinearGradient(0, 0, W, 1); bg.addColorStop(0, '#d2ad74'); bg.addColorStop(0.5, '#bf955b'); bg.addColorStop(1, '#9a7240');
  ctx.save(); glow(ctx, 'rgba(0,0,0,0.6)', 0.03); ctx.fillStyle = bg; ctx.beginPath(); ctx.moveTo(0.06, 0.04); ctx.lineTo(W - 0.06, 0.04); ctx.quadraticCurveTo(W - 0.01, 0.04, W - 0.01, 0.09); ctx.lineTo(W - 0.01, 0.91); ctx.quadraticCurveTo(W - 0.01, 0.96, W - 0.06, 0.96); ctx.lineTo(0.06, 0.96); ctx.quadraticCurveTo(0.01, 0.96, 0.01, 0.91); ctx.lineTo(0.01, 0.09); ctx.quadraticCurveTo(0.01, 0.04, 0.06, 0.04); ctx.fill(); ctx.restore();
  ctx.strokeStyle = 'rgba(60,35,15,0.6)'; lw(ctx, 0.006); ctx.strokeRect(0.04, 0.07, W - 0.08, 0.86);
  ctx.fillStyle = '#2b1a0c'; ctx.textAlign = 'center';
  const pos = {};
  const arc = (letters, R, cy) => [...letters].forEach((ch, i) => { const a = Math.PI + 0.35 + (i / (letters.length - 1)) * (Math.PI - 0.7); const x = W / 2 + Math.cos(a) * R, y = cy + Math.sin(a) * R * 0.55; pos[ch] = [x, y]; ctx.save(); ctx.translate(x, y); ctx.rotate(a + Math.PI / 2); text(ctx, ch, 0, 0.03, 0.09, FONT_SERIF); ctx.restore(); });
  arc('ABCDEFGHIJKLM', 0.55, 0.62); arc('NOPQRSTUVWXYZ', 0.45, 0.76);
  text(ctx, 'YES', 0.17, 0.17, 0.07, FONT_SERIF); text(ctx, 'NO', W - 0.15, 0.17, 0.07, FONT_SERIF);
  text(ctx, '1 2 3 4 5 6 7 8 9 0', W / 2, 0.84, 0.055, FONT_SERIF); text(ctx, 'GOOD BYE', W / 2, 0.93, 0.055, FONT_SERIF);
  ctx.textAlign = 'start';
  ctx.strokeStyle = '#2b1a0c'; lw(ctx, 0.005); ctx.beginPath(); circ(ctx, 0.12, 0.27, 0.035); ctx.stroke();
  // planchette moves between letters spelling a word
  const word = ('HELLO').split('').map((c) => pos[c] || [W / 2, 0.5]);
  const seg = 1.1, k = Math.floor(t / seg) % word.length, u = smooth((t % seg) / (seg * 0.7));
  const a = word[(k + word.length - 1) % word.length], b = word[k];
  const px = lerp(a[0], b[0], u), py = lerp(a[1], b[1], u) + 0.15;
  ctx.save(); ctx.translate(px, py); ctx.rotate(Math.sin(t * 0.8) * 0.12);
  const pg = ctx.createLinearGradient(-0.15, -0.2, 0.15, 0.2); pg.addColorStop(0, '#f1e3c4'); pg.addColorStop(1, '#bfa478');
  ctx.save(); glow(ctx, 'rgba(0,0,0,0.6)', 0.04); ctx.fillStyle = pg; ctx.beginPath();
  ctx.moveTo(0, -0.17); ctx.bezierCurveTo(0.08, -0.12, 0.16, 0.0, 0.14, 0.09); ctx.quadraticCurveTo(0.1, 0.17, 0, 0.12); ctx.quadraticCurveTo(-0.1, 0.17, -0.14, 0.09); ctx.bezierCurveTo(-0.16, 0.0, -0.08, -0.12, 0, -0.17); ctx.fill(); ctx.restore();
  ctx.strokeStyle = '#4a3218'; lw(ctx, 0.006); ctx.stroke();
  ctx.fillStyle = 'rgba(190,220,235,0.35)'; ctx.beginPath(); circ(ctx, 0, -0.04, 0.045); ctx.fill(); ctx.stroke();
  ctx.fillStyle = 'rgba(255,255,255,0.6)'; ctx.beginPath(); ell(ctx, -0.015, -0.055, 0.012, 0.007, -0.6); ctx.fill();
  ctx.restore();
});

st('rotary_phone', 'Rotary Phone', 'objects', 1.2, true, 'An old black rotary phone that rings by itself.', (ctx, W, H, t, r, o) => {
  const ringing = fract(t / 2.4) < 0.55, shake = ringing ? Math.sin(t * 70) * 0.012 : 0;
  ctx.translate(shake, 0);
  // cord
  ctx.strokeStyle = '#0e0e10'; lw(ctx, 0.012); ctx.beginPath();
  for (let i = 0; i <= 60; i++) { const u = i / 60, x = 0.12 - u * 0.1 + Math.cos(u * 40) * 0.025, y = 0.75 + u * 0.22 + Math.sin(u * 40) * 0.02; i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); } ctx.stroke();
  const bg = ctx.createLinearGradient(0, 0.4, 0, 0.95); bg.addColorStop(0, '#3a3a40'); bg.addColorStop(0.3, '#141416'); bg.addColorStop(1, '#050506');
  ctx.save(); glow(ctx, 'rgba(0,0,0,0.6)', 0.03); ctx.fillStyle = bg; ctx.beginPath();
  smoothPath(ctx, [[0.3, 0.42], [0.9, 0.42], [1.02, 0.6], [1.1, 0.9], [1.05, 0.95], [0.15, 0.95], [0.1, 0.9], [0.18, 0.6]]); ctx.fill(); ctx.restore();
  ctx.strokeStyle = 'rgba(255,255,255,0.18)'; lw(ctx, 0.008); ctx.beginPath(); ctx.moveTo(0.32, 0.45); ctx.quadraticCurveTo(0.6, 0.43, 0.88, 0.45); ctx.stroke();
  // dial
  const dx = W / 2, dy = 0.7;
  ctx.fillStyle = '#e9e4d6'; ctx.beginPath(); circ(ctx, dx, dy, 0.17); ctx.fill();
  ctx.fillStyle = '#0c0c0e'; ctx.beginPath(); circ(ctx, dx, dy, 0.155); ctx.fill();
  for (let i = 0; i < 10; i++) { const a = -Math.PI / 3 - (i / 10) * (Math.PI * 1.6); ctx.fillStyle = '#e9e4d6'; ctx.beginPath(); circ(ctx, dx + Math.cos(a) * 0.112, dy + Math.sin(a) * 0.112, 0.03); ctx.fill(); ctx.fillStyle = '#222'; ctx.beginPath(); circ(ctx, dx + Math.cos(a) * 0.112, dy + Math.sin(a) * 0.112, 0.022); ctx.fill(); }
  ctx.fillStyle = '#e9e4d6'; ctx.beginPath(); circ(ctx, dx, dy, 0.055); ctx.fill(); ctx.fillStyle = '#b00'; ctx.beginPath(); circ(ctx, dx, dy, 0.02); ctx.fill();
  // cradle + handset
  ctx.fillStyle = '#0c0c0e'; ctx.fillRect(0.28, 0.33, 0.06, 0.1); ctx.fillRect(W - 0.34, 0.33, 0.06, 0.1);
  ctx.save(); ctx.translate(W / 2, 0.3); ctx.rotate(ringing ? Math.sin(t * 55) * 0.03 : 0); ctx.translate(-W / 2, ringing ? -Math.abs(Math.sin(t * 35)) * 0.015 : 0);
  const hg = ctx.createLinearGradient(0, 0.15, 0, 0.36); hg.addColorStop(0, '#45454c'); hg.addColorStop(0.4, '#161618'); hg.addColorStop(1, '#050506');
  ctx.fillStyle = hg; ctx.beginPath();
  ctx.moveTo(0.1, 0.32); ctx.quadraticCurveTo(0.08, 0.2, 0.2, 0.2); ctx.quadraticCurveTo(0.6, 0.12, W - 0.2, 0.2); ctx.quadraticCurveTo(W - 0.08, 0.2, W - 0.1, 0.32);
  ctx.lineTo(W - 0.3, 0.32); ctx.quadraticCurveTo(W - 0.32, 0.27, W - 0.36, 0.26); ctx.quadraticCurveTo(0.6, 0.22, 0.36, 0.26); ctx.quadraticCurveTo(0.32, 0.27, 0.3, 0.32); ctx.closePath(); ctx.fill();
  ctx.restore();
  if (ringing) {
    ctx.strokeStyle = 'rgba(255,255,255,0.7)'; lw(ctx, 0.01); ctx.lineCap = 'round';
    for (const s of [-1, 1]) for (let i = 0; i < 3; i++) { const x = W / 2 + s * (0.56 + i * 0.03); ctx.beginPath(); ctx.moveTo(x, 0.15 + i * 0.01); ctx.lineTo(x + s * 0.05, 0.09 + i * 0.05); ctx.stroke(); }
  }
});

st('old_tv', 'Old TV Static', 'objects', 1.25, true, 'Wood-cabinet TV hissing with snow.', (ctx, W, H, t, r, o) => {
  ctx.strokeStyle = '#1a1a1a'; lw(ctx, 0.012);
  ctx.beginPath(); ctx.moveTo(0.55, 0.2); ctx.lineTo(0.38, 0.0); ctx.moveTo(0.6, 0.2); ctx.lineTo(0.8, 0.02); ctx.stroke();
  ctx.fillStyle = '#888'; ctx.beginPath(); circ(ctx, 0.38, 0.0 + 0.012, 0.012); circ(ctx, 0.8, 0.02, 0.012); ctx.fill();
  const cab = ctx.createLinearGradient(0, 0.2, 0, 0.95); cab.addColorStop(0, '#6b4528'); cab.addColorStop(1, '#3a2312');
  ctx.save(); glow(ctx, 'rgba(0,0,0,0.6)', 0.03); ctx.fillStyle = cab; ctx.beginPath(); smoothPath(ctx, [[0.04, 0.2], [W - 0.04, 0.2], [W - 0.04, 0.9], [0.04, 0.9]]); ctx.fill(); ctx.restore();
  ctx.fillStyle = '#2a1a0d'; ctx.fillRect(0.12, 0.9, 0.06, 0.07); ctx.fillRect(W - 0.18, 0.9, 0.06, 0.07);
  // screen
  const sx = 0.1, sy = 0.27, sw = 0.75, sh = 0.56;
  ctx.fillStyle = '#111'; ctx.beginPath(); smoothPath(ctx, [[sx - 0.02, sy - 0.02], [sx + sw + 0.02, sy - 0.02], [sx + sw + 0.02, sy + sh + 0.02], [sx - 0.02, sy + sh + 0.02]]); ctx.fill();
  ctx.save(); ctx.beginPath(); smoothPath(ctx, [[sx, sy], [sx + sw, sy], [sx + sw, sy + sh], [sx, sy + sh]]); ctx.clip();
  const fr = mulberry32(Math.floor(t * 24) * 7 + 1), cols = 44, rows = 32, cw = sw / cols, ch = sh / rows;
  ctx.fillStyle = '#777'; ctx.fillRect(sx, sy, sw, sh);
  for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) { const v = Math.floor(fr() * 255); ctx.fillStyle = `rgb(${v},${v},${v})`; ctx.fillRect(sx + i * cw, sy + j * ch, cw + 0.001, ch + 0.001); }
  const bar = sy + fract(t * 0.3) * (sh + 0.1) - 0.05; ctx.fillStyle = 'rgba(255,255,255,0.18)'; ctx.fillRect(sx, bar, sw, 0.05);
  const vg = ctx.createRadialGradient(sx + sw / 2, sy + sh / 2, 0.1, sx + sw / 2, sy + sh / 2, 0.5); vg.addColorStop(0, 'rgba(0,0,0,0)'); vg.addColorStop(1, 'rgba(0,0,0,0.6)');
  ctx.fillStyle = vg; ctx.fillRect(sx, sy, sw, sh); ctx.restore();
  // side panel
  for (const ky of [0.38, 0.55]) { ctx.fillStyle = '#1b1b1b'; ctx.beginPath(); circ(ctx, 1.03, ky, 0.045); ctx.fill(); ctx.fillStyle = '#999'; ctx.fillRect(1.025, ky - 0.04, 0.01, 0.035); }
  ctx.strokeStyle = '#2a1a0d'; lw(ctx, 0.008); for (let i = 0; i < 6; i++) { ctx.beginPath(); ctx.moveTo(0.96, 0.66 + i * 0.03); ctx.lineTo(1.12, 0.66 + i * 0.03); ctx.stroke(); }
});

st('door_ajar', 'Door Ajar', 'objects', 0.55, true, 'A dark door left open a crack, light flickering inside.', (ctx, W, H, t, r, o) => {
  const c = fract(t / 6) * 6, pass = c > 4 && c < 4.8 ? Math.sin(((c - 4) / 0.8) * Math.PI) : 0, I = (0.85 + 0.15 * vnoise(t * 10, 2)) * (1 - 0.85 * pass);
  // frame
  ctx.fillStyle = '#1d140d'; ctx.fillRect(0.02, 0.02, W - 0.04, 0.9);
  ctx.fillStyle = '#060404'; ctx.fillRect(0.06, 0.06, W - 0.12, 0.86);
  // light in the gap
  const gx = W - 0.06 - 0.06, gw = 0.05;
  const lg = ctx.createLinearGradient(gx, 0, gx + gw, 0); lg.addColorStop(0, `rgba(255,214,140,${I})`); lg.addColorStop(1, `rgba(255,180,90,${0.7 * I})`);
  ctx.save(); glow(ctx, `rgba(255,200,110,${I})`, 0.05); ctx.fillStyle = lg; ctx.fillRect(gx, 0.06, gw, 0.86); ctx.restore();
  // spill on the floor
  const fl = ctx.createLinearGradient(0, 0.92, 0, 1); fl.addColorStop(0, `rgba(255,200,120,${0.6 * I})`); fl.addColorStop(1, 'rgba(255,200,120,0)');
  ctx.fillStyle = fl; ctx.beginPath(); ctx.moveTo(gx, 0.92); ctx.lineTo(gx + gw, 0.92); ctx.lineTo(gx + gw + 0.12, 1); ctx.lineTo(gx - 0.08, 1); ctx.closePath(); ctx.fill();
  // the door itself, slightly turned
  const dg = ctx.createLinearGradient(0.06, 0, gx, 0); dg.addColorStop(0, '#2e2016'); dg.addColorStop(1, '#3b291b');
  ctx.fillStyle = dg; ctx.beginPath(); ctx.moveTo(0.06, 0.06); ctx.lineTo(gx, 0.075); ctx.lineTo(gx, 0.905); ctx.lineTo(0.06, 0.92); ctx.closePath(); ctx.fill();
  ctx.strokeStyle = 'rgba(0,0,0,0.6)'; lw(ctx, 0.008);
  for (const [y0, y1] of [[0.12, 0.42], [0.5, 0.86]]) ctx.strokeRect(0.11, y0, gx - 0.17, y1 - y0);
  ctx.fillStyle = `rgba(255,210,130,${0.15 * I})`; ctx.fillRect(gx - 0.012, 0.075, 0.012, 0.83);
  ctx.fillStyle = '#b08d4a'; ctx.beginPath(); circ(ctx, gx - 0.04, 0.5, 0.016); ctx.fill();
  if (pass > 0) { ctx.fillStyle = `rgba(0,0,0,${0.6 * pass})`; ctx.fillRect(gx, 0.2, gw, 0.72); }
});

st('jack_o_lantern', 'Jack-o\'-Lantern', 'objects', 1.15, true, 'Carved pumpkin glowing from the inside.', (ctx, W, H, t, r, o) => {
  const cx = W / 2, cy = 0.58, f = 0.75 + 0.25 * vnoise(t * 7, 8);
  const halo = ctx.createRadialGradient(cx, cy, 0.1, cx, cy, 0.6); halo.addColorStop(0, `rgba(255,140,30,${0.25 * f})`); halo.addColorStop(1, 'rgba(255,120,0,0)');
  ctx.fillStyle = halo; ctx.fillRect(0, 0, W, 1);
  ctx.fillStyle = '#3e5a1a'; ctx.beginPath(); ctx.moveTo(cx - 0.03, 0.22); ctx.quadraticCurveTo(cx - 0.02, 0.1, cx + 0.06, 0.05); ctx.lineTo(cx + 0.08, 0.08); ctx.quadraticCurveTo(cx + 0.02, 0.13, cx + 0.03, 0.22); ctx.fill();
  for (const [dx, rx, sh] of [[-0.3, 0.17, 0.75], [0.3, 0.17, 0.75], [-0.15, 0.2, 0.9], [0.15, 0.2, 0.9], [0, 0.2, 1]]) {
    const g = ctx.createRadialGradient(cx + dx - 0.05, cy - 0.12, 0.02, cx + dx, cy, 0.38);
    g.addColorStop(0, '#ffb347'); g.addColorStop(0.5, `rgb(${Math.round(230 * sh)},${Math.round(110 * sh)},10)`); g.addColorStop(1, '#7a3200');
    ctx.fillStyle = g; ctx.strokeStyle = 'rgba(90,35,0,0.6)'; lw(ctx, 0.008);
    ctx.beginPath(); ell(ctx, cx + dx, cy, rx, 0.37); ctx.fill(); ctx.stroke();
  }
  const face = () => {
    for (const s of [-1, 1]) { ctx.moveTo(cx + s * 0.22, cy - 0.04); ctx.lineTo(cx + s * 0.08, cy - 0.04); ctx.lineTo(cx + s * 0.15, cy - 0.17); ctx.closePath(); }
    ctx.moveTo(cx - 0.035, cy + 0.04); ctx.lineTo(cx + 0.035, cy + 0.04); ctx.lineTo(cx, cy - 0.02); ctx.closePath();
    ctx.moveTo(cx - 0.27, cy + 0.08);
    const pts = [[-0.2, 0.15], [-0.15, 0.12], [-0.12, 0.17], [-0.05, 0.16], [0, 0.2], [0.05, 0.16], [0.12, 0.17], [0.15, 0.12], [0.2, 0.15], [0.27, 0.08], [0.18, 0.26], [0.1, 0.23], [0.06, 0.28], [-0.06, 0.28], [-0.1, 0.23], [-0.18, 0.26]];
    for (const [x, y] of pts) ctx.lineTo(cx + x, cy + y); ctx.closePath();
  };
  ctx.save(); glow(ctx, `rgba(255,200,40,${f})`, 0.05);
  const ig = ctx.createRadialGradient(cx, cy + 0.05, 0.02, cx, cy + 0.05, 0.3); ig.addColorStop(0, '#fffbd0'); ig.addColorStop(0.5, '#ffd23a'); ig.addColorStop(1, '#ff8a00');
  ctx.fillStyle = ig; ctx.globalAlpha *= 0.7 + 0.3 * f; ctx.beginPath(); face(); ctx.fill(); ctx.restore();
  ctx.strokeStyle = 'rgba(80,30,0,0.8)'; lw(ctx, 0.008); ctx.beginPath(); face(); ctx.stroke();
});

/* ================================================================== ATMOSPHERE & FRAMES */

const fogCanvases = new Map();
st('fog', 'Fog Bank', 'atmos', 3, true, 'Low rolling fog drifting across the ground.', (ctx, w, h, t, r, o) => {
  const col = rgbStr(o.color, '200,208,215'), k = pxScale(ctx);
  const pw = Math.max(8, Math.min(1280, Math.round(w * k))), ph = Math.max(4, Math.min(720, Math.round(h * k)));
  let cv = fogCanvases.get(pw + 'x' + ph);
  if (!cv) { if (fogCanvases.size > 6) fogCanvases.clear(); cv = makeCanvas(pw, ph); fogCanvases.set(pw + 'x' + ph, cv); }
  const c = cv.getContext('2d'); c.setTransform(1, 0, 0, 1, 0, 0); c.globalCompositeOperation = 'source-over'; c.clearRect(0, 0, pw, ph);
  c.scale(pw / w, ph / h);
  const base = c.createLinearGradient(0, h * 0.3, 0, h); base.addColorStop(0, `rgba(${col},0)`); base.addColorStop(1, `rgba(${col},0.5)`);
  c.fillStyle = base; c.fillRect(0, 0, w, h);
  for (let i = 0; i < 16; i++) {
    const ry = h * (0.15 + r() * 0.2), rx = Math.max(ry * 1.5, w * (0.12 + r() * 0.2)), sp = (0.01 + r() * 0.03) * w * (r() < 0.5 ? 1 : 0.6), x0 = r() * (w + rx * 2);
    const x = ((x0 + t * sp) % (w + rx * 2)) - rx, y = h * (0.55 + r() * 0.45), a = 0.14 + r() * 0.16;
    c.save(); c.translate(x, y); c.scale(rx / ry, 1);
    const g = c.createRadialGradient(0, 0, 0, 0, 0, ry); g.addColorStop(0, `rgba(${col},${a})`); g.addColorStop(1, `rgba(${col},0)`);
    c.fillStyle = g; c.fillRect(-ry, -ry, ry * 2, ry * 2); c.restore();
  }
  // soft edges: fade left/right and top
  c.globalCompositeOperation = 'destination-in';
  const mx = c.createLinearGradient(0, 0, w, 0); mx.addColorStop(0, 'rgba(0,0,0,0)'); mx.addColorStop(0.15, '#000'); mx.addColorStop(0.85, '#000'); mx.addColorStop(1, 'rgba(0,0,0,0)');
  c.fillStyle = mx; c.fillRect(0, 0, w, h);
  const my = c.createLinearGradient(0, 0, 0, h); my.addColorStop(0, 'rgba(0,0,0,0)'); my.addColorStop(0.45, '#000'); my.addColorStop(1, '#000');
  c.fillStyle = my; c.fillRect(0, 0, w, h);
  ctx.drawImage(cv, 0, 0, w, h);
}, { fit: 'stretch' });

st('orbs', 'Spirit Orbs', 'atmos', 1.4, true, 'Dusty glowing orbs floating through the air.', (ctx, w, h, t, r, o) => {
  const col = rgbStr(o.color, '190,230,255'), u = Math.min(w, h);
  for (let i = 0; i < 9; i++) {
    const x = w * (0.1 + 0.8 * r()) + Math.sin(t * (0.2 + r() * 0.3) + r() * 6) * w * 0.08, y = h * (0.1 + 0.8 * r()) + Math.sin(t * (0.15 + r() * 0.3) + r() * 6) * h * 0.1;
    const rad = u * (0.04 + r() * 0.08), a = 0.35 + 0.45 * (0.5 + 0.5 * Math.sin(t * (0.8 + r()) + r() * 6));
    const g = ctx.createRadialGradient(x, y, 0, x, y, rad); g.addColorStop(0, `rgba(255,255,255,${a})`); g.addColorStop(0.35, `rgba(${col},${a * 0.6})`); g.addColorStop(0.75, `rgba(${col},${a * 0.25})`); g.addColorStop(1, `rgba(${col},0)`);
    ctx.fillStyle = g; ctx.beginPath(); circ(ctx, x, y, rad); ctx.fill();
    ctx.strokeStyle = `rgba(${col},${a * 0.35})`; ctx.lineWidth = Math.max(1, u * 0.003); ctx.beginPath(); circ(ctx, x, y, rad * 0.8); ctx.stroke();
  }
}, { fit: 'stretch' });

st('moon', 'Full Moon & Clouds', 'atmos', 1.2, true, 'A big pale moon with dark clouds drifting past.', (ctx, W, H, t, r, o) => {
  const mx = W / 2, my = 0.5, R = 0.33;
  ctx.save(); glow(ctx, 'rgba(255,250,220,0.7)', 0.12);
  const mg = ctx.createRadialGradient(mx - 0.08, my - 0.08, 0.05, mx, my, R); mg.addColorStop(0, '#fffdf0'); mg.addColorStop(0.7, '#ece6c8'); mg.addColorStop(1, '#cfc7a2');
  ctx.fillStyle = mg; ctx.beginPath(); circ(ctx, mx, my, R); ctx.fill(); ctx.restore();
  ctx.fillStyle = 'rgba(150,140,110,0.22)';
  for (const [dx, dy, cr] of [[-0.1, -0.08, 0.07], [0.09, 0.05, 0.05], [-0.02, 0.14, 0.04], [0.14, -0.12, 0.035], [-0.16, 0.08, 0.03], [0.02, -0.02, 0.025]]) { ctx.beginPath(); circ(ctx, mx + dx, my + dy, cr); ctx.fill(); }
  for (let i = 0; i < 3; i++) {
    const cy = 0.3 + i * 0.22 + r() * 0.05, sp = 0.03 + r() * 0.03, x0 = r() * (W + 0.8);
    const x = ((x0 + t * sp) % (W + 0.8)) - 0.4, s = 0.6 + r() * 0.5;
    ctx.save(); ctx.translate(x, cy); ctx.scale(s, s);
    const cg = ctx.createLinearGradient(0, -0.1, 0, 0.08); cg.addColorStop(0, 'rgba(90,95,115,0.95)'); cg.addColorStop(1, 'rgba(25,27,35,0.95)');
    ctx.fillStyle = cg; ctx.beginPath(); for (const [dx, dy, cr] of [[-0.18, 0.02, 0.07], [-0.08, -0.04, 0.1], [0.05, -0.06, 0.11], [0.17, -0.01, 0.08], [0.26, 0.03, 0.05], [0, 0.03, 0.08]]) circ(ctx, dx, dy, cr); ctx.fill();
    ctx.restore();
  }
}, { clip: true });

function branch(ctx, x, y, a, len, wdt, depth, r, t) {
  if (depth <= 0 || len < 0.008) return;
  const sway = Math.sin(t * 0.9 + depth * 0.7) * 0.012 * (6 - depth);
  const steps = 3; let cx = x, cy = y, ca = a + sway;
  ctx.lineWidth = Math.max(wdt, 0.0015); ctx.beginPath(); ctx.moveTo(cx, cy);
  for (let i = 0; i < steps; i++) { ca += (r() - 0.5) * 0.35; cx += Math.cos(ca) * len / steps; cy += Math.sin(ca) * len / steps; ctx.lineTo(cx, cy); }
  ctx.stroke();
  const kids = depth > 3 ? 2 + (r() < 0.5 ? 1 : 0) : 2;
  for (let k = 0; k < kids; k++) branch(ctx, cx, cy, ca + (r() - 0.5) * 1.2, len * (0.62 + r() * 0.2), wdt * 0.62, depth - 1, r, t);
}
st('branches_frame', 'Dead Branches Frame', 'atmos', 16 / 9, true, 'Bare twisted branches creeping in from the corners.', (ctx, w, h, t, r, o) => {
  ctx.save(); ctx.scale(h, h); const W = w / h;
  ctx.strokeStyle = o.color || '#070708'; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  branch(ctx, -0.02, 0.05, 0.25, 0.33, 0.045, 6, r, t);
  branch(ctx, -0.02, 0.6, -0.35, 0.22, 0.03, 5, r, t);
  branch(ctx, W + 0.02, 0.02, Math.PI - 0.3, 0.32, 0.045, 6, r, t);
  branch(ctx, W + 0.02, 0.75, Math.PI + 0.45, 0.2, 0.03, 5, r, t);
  ctx.restore();
}, { fit: 'stretch' });

st('cobweb_frame', 'Cobweb Corners', 'atmos', 16 / 9, false, 'Dusty cobwebs in the top corners of the frame.', (ctx, w, h, t, r, o) => {
  const R = Math.min(w, h) * 0.55;
  ctx.save(); ctx.shadowColor = 'rgba(255,255,255,0.3)'; ctx.shadowBlur = R * 0.01;
  drawWeb(ctx, 0, 0, 1, 1, R, r, t); drawWeb(ctx, w, 0, -1, 1, R * 0.85, r, t); drawWeb(ctx, w, h, -1, -1, R * 0.45, r, t);
  ctx.restore();
}, { fit: 'stretch' });

/* ------------------------------------------------------------------ public API */

export const STICKERS = DEFS.map(({ id, name, cat, desc, aspect, anim, defaults }) => ({ id, name, cat, desc, aspect, anim, defaults: { ...defaults } }));
const MAP = new Map(DEFS.map((d) => [d.id, d]));

export function drawSticker(ctx, id, x, y, w, h, t, opts = {}) {
  const d = MAP.get(id);
  if (!d || !(w > 0) || !(h > 0)) return;
  const o = { ...d.defaults, ...opts };
  const opacity = clamp(o.opacity == null ? 1 : +o.opacity, 0, 1);
  if (opacity <= 0) return;
  const seed = o.seed == null ? 1 : o.seed;
  ctx.save();
  try {
    let bx = x, by = y, bw = w, bh = h;
    if (d.fit === 'contain') {
      if (w / h > d.aspect) { bw = h * d.aspect; bx = x + (w - bw) / 2; } else { bh = w / d.aspect; by = y + (h - bh) / 2; }
    }
    ctx.translate(bx, by);
    if (o.flip) { ctx.translate(bw, 0); ctx.scale(-1, 1); }
    ctx.globalAlpha *= opacity;
    ctx.globalCompositeOperation = 'source-over';
    ctx.lineCap = 'butt'; ctx.lineJoin = 'miter'; ctx.setLineDash?.([]);
    noGlow(ctx);
    if ('filter' in ctx) ctx.filter = 'none';
    ctx.beginPath();
    if (d.clip) { ctx.rect(0, 0, bw, bh); ctx.clip(); ctx.beginPath(); }
    const rng = mulberry32(hashStr(id) ^ Math.imul(seed | 0, 2654435761));
    t = Math.max(0, +t || 0);
    if (d.fit === 'contain') { ctx.scale(bh, bh); d.draw(ctx, d.aspect, 1, t, rng, o); }
    else d.draw(ctx, bw, bh, t, rng, o);
  } finally {
    ctx.restore();
  }
}

export function stickerThumb(id, size = 96) {
  const c = document.createElement('canvas'); c.width = size; c.height = size;
  const g = c.getContext('2d');
  g.fillStyle = '#16161b'; g.fillRect(0, 0, size, size);
  const d = MAP.get(id);
  if (d) {
    const pad = size * 0.06, a = d.fit === 'contain' ? d.aspect : Math.min(2, d.aspect);
    let w = size - pad * 2, h = w / a; if (h > size - pad * 2) { h = size - pad * 2; w = h * a; }
    drawSticker(g, id, (size - w) / 2, (size - h) / 2, w, h, 0.8);
  }
  return c;
}
