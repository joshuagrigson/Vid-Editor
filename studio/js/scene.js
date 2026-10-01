// What is on screen at timeline time t. Shared by the preview player and the exporter.
import { layout, clipAt, transitionAt, clipLen } from "./project.js";
import { lookById } from "./effects.js";

function lookFx(lookId, local, seedBase) {
  const look = lookId ? lookById(lookId) : null;
  if (!look) return [];
  return look.effects.map((e, i) => ({ type: e.type, params: e.params || {}, local, dur: 0, seed: (seedBase + i * 0.137) % 1 }));
}

// -> { l: layout entry | null, srcTime, pre, post, transition, xf }
export function sceneAt(project, t, lay = layout(project), extraFx = null) {
  const l = clipAt(project, t, lay);
  const pre = [], post = [];
  let srcTime = 0, xf = null;
  if (l) {
    const c = l.clip, local = t - l.start;
    srcTime = c.in + local * (c.speed || 1);
    pre.push(...lookFx(c.look, local, 0.21));
    for (const e of c.effects || []) pre.push({ type: e.type, params: e.params, local, dur: 0, seed: e.seed ?? 0.5 });
    const k = local / clipLen(c);
    const push = c.push || 0;   // slow creep zoom across the clip
    xf = { zoom: (c.zoom || 1) * (1 + push * k), x: c.panX || 0, y: c.panY || 0, rot: (c.rot || 0) * Math.PI / 180 };
  }
  pre.push(...lookFx(project.look, t, 0.63));
  const active = project.fx.filter(f => t >= f.start && t < f.start + f.dur).sort((a, b) => a.start - b.start);
  for (const f of active) post.push({ type: f.type, params: f.params, local: t - f.start, dur: f.dur, seed: f.seed ?? 0.5 });
  for (const x of extraFx || []) post.push({ dur: 0, ...x });
  const transition = transitionAt(project, t, lay);
  return { l, srcTime, pre, post, transition, xf };
}
