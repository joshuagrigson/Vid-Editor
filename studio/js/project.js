// The project: what's on the timeline, plus helpers that turn it into "what is visible at time t".
// Clips sit back to back on the video track; everything else (effects, overlays, sounds) is placed at
// absolute timeline times and floats above them.

export const FPS = 30;

export const uid = () => Math.random().toString(36).slice(2, 10);

export function newProject() {
  return {
    version: 1,
    name: "Untitled Nightmare",
    aspect: "auto",          // auto | 9:16 | 16:9 | 1:1
    fit: "blur",             // blur | cover | contain
    clips: [],               // [{id, mediaId, in, out, speed, volume, mute, effects:[{id,type,params,seed}], look, transition:{type,dur}|null}]
    fx: [],                  // [{id, type, start, dur, params, seed}]
    overlays: [],            // [{id, kind:'text'|'hud'|'sticker', start, dur, props}]
    sounds: [],              // [{id, kind:'sfx'|'file', ref, start, dur, gain}]
    bed: { type: "none", gain: 0.45, mediaId: null },
    look: null,              // look applied to the whole movie
    clockStart: defaultClockStart(),   // for camcorder clocks: ISO local datetime
  };
}

function defaultClockStart() {
  const d = new Date(); d.setDate(d.getDate() - 3); d.setHours(2, 13, 0, 0);
  const p = n => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

export const clipLen = c => Math.max(0.05, (c.out - c.in) / (c.speed || 1));

// [{clip, index, start, end}]
export function layout(project) {
  let t = 0;
  return project.clips.map((clip, index) => { const s = t; t += clipLen(clip); return { clip, index, start: s, end: t }; });
}

export function duration(project) {
  let d = layout(project).reduce((a, l) => Math.max(a, l.end), 0);
  for (const f of project.fx) d = Math.max(d, f.start + f.dur);
  for (const o of project.overlays) d = Math.max(d, o.start + o.dur);
  for (const s of project.sounds) d = Math.max(d, s.start + Math.min(s.dur, 4));
  return d;
}

export function clipAt(project, t, lay = layout(project)) {
  for (const l of lay) if (t >= l.start && t < l.end) return l;
  return null;
}

export function outputSize(project, media, scale = 1) {
  let a = project.aspect;
  if (a === "auto") {
    let portrait = 0, land = 0;
    for (const c of project.clips) {
      const m = media.get(c.mediaId); if (!m) continue;
      if (m.height > m.width) portrait += clipLen(c); else land += clipLen(c);
    }
    a = portrait > land ? "9:16" : land > 0 ? "16:9" : "9:16";
  }
  const [w, h] = a === "9:16" ? [1080, 1920] : a === "16:9" ? [1920, 1080] : [1080, 1080];
  const ev = x => Math.max(2, Math.round(x * scale / 2) * 2);
  return { w: ev(w), h: ev(h), aspect: a };
}

// Transition state at time t: {def id, prog, side} or null. A transition belongs to the clip it leads INTO and
// is centred on the cut: the last dur/2 of the previous clip and the first dur/2 of this one.
export function transitionAt(project, t, lay = layout(project)) {
  for (let i = 1; i < lay.length; i++) {
    const tr = lay[i].clip.transition;
    if (!tr || !tr.type) continue;
    const cut = lay[i].start, half = Math.min(tr.dur / 2, clipLen(lay[i - 1].clip) / 2, clipLen(lay[i].clip) / 2);
    if (t >= cut - half && t < cut + half) {
      return { type: tr.type, prog: (t - (cut - half)) / (2 * half), side: t < cut ? 0 : 1, half };
    }
  }
  return null;
}

// Split the clip under t into two. Returns the new clip id or null.
export function splitAt(project, t) {
  const lay = layout(project);
  const l = clipAt(project, t, lay);
  if (!l) return null;
  const local = (t - l.start) * (l.clip.speed || 1);
  if (local < 0.1 || l.clip.out - l.clip.in - local < 0.1) return null;
  const a = l.clip, b = structuredClone(a);
  b.id = uid(); b.in = a.in + local; b.transition = null;
  b.effects = b.effects.map(e => ({ ...e, id: uid() }));
  a.out = a.in + local;
  project.clips.splice(l.index + 1, 0, b);
  return b.id;
}

export function findItem(project, id) {
  for (const k of ["clips", "fx", "overlays", "sounds"]) {
    const i = project[k].findIndex(x => x.id === id);
    if (i >= 0) return { list: k, index: i, item: project[k][i] };
  }
  return null;
}

// ---------- undo / redo (whole-project snapshots: small JSON, simple and safe) ----------
export class History {
  constructor(limit = 120) { this.past = []; this.future = []; this.limit = limit; }
  push(project) {
    const s = JSON.stringify(project);
    if (this.past[this.past.length - 1] === s) return;
    this.past.push(s); if (this.past.length > this.limit) this.past.shift();
    this.future = [];
  }
  undo(current) {
    if (!this.past.length) return null;
    this.future.push(JSON.stringify(current));
    return JSON.parse(this.past.pop());
  }
  redo(current) {
    if (!this.future.length) return null;
    this.past.push(JSON.stringify(current));
    return JSON.parse(this.future.pop());
  }
}

// ---------- storage: the project and the media files live in IndexedDB so a reload loses nothing ----------
export const DB = {
  db: null,
  open() {
    if (this.db) return Promise.resolve(this.db);
    return new Promise((res, rej) => {
      const r = indexedDB.open("frightcut", 1);
      r.onupgradeneeded = () => { r.result.createObjectStore("kv"); r.result.createObjectStore("media"); };
      r.onsuccess = () => { this.db = r.result; res(this.db); };
      r.onerror = () => rej(r.error);
    });
  },
  async op(store, mode, fn) {
    const db = await this.open();
    return new Promise((res, rej) => {
      const tx = db.transaction(store, mode); const req = fn(tx.objectStore(store));
      tx.oncomplete = () => res(req?.result); tx.onerror = () => rej(tx.error); tx.onabort = () => rej(tx.error);
    });
  },
  get(store, key) { return this.op(store, "readonly", s => s.get(key)); },
  set(store, key, val) { return this.op(store, "readwrite", s => s.put(val, key)); },
  del(store, key) { return this.op(store, "readwrite", s => s.delete(key)); },
  all(store) { return this.op(store, "readonly", s => s.getAll()); },
  clear(store) { return this.op(store, "readwrite", s => s.clear()); },
};

export const fmtTime = (s, frames = true) => {
  s = Math.max(0, s);
  const m = Math.floor(s / 60), r = s - m * 60;
  return frames ? `${m}:${r.toFixed(2).padStart(5, "0")}` : `${m}:${String(Math.floor(r)).padStart(2, "0")}`;
};
