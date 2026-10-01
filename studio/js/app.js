// FrightCut Studio: the editor UI. Library on the left, preview in the middle, inspector on the right,
// timeline along the bottom.
import { newProject, layout, duration, clipLen, splitAt, findItem, History, DB, uid, fmtTime, FPS, outputSize } from "./project.js";
import { media, MediaItem, kindOf, probe } from "./media.js";
import { Player } from "./player.js";
import { EFFECTS, CATEGORIES, TRANSITIONS, LOOKS, effectById, transitionById, lookById, defaultParams } from "./effects.js";
import { SFX, SFX_CATEGORIES, BEDS, renderSfx, renderBed } from "./sfx.js";
import { STICKERS, STICKER_CATEGORIES, stickerThumb } from "./stickers.js";
import { TEXT_STYLES, HUDS, MOVES, loadFonts } from "./overlays.js";
import { SCARES } from "./scares.js";
import { exportMovie, pickCodecs, pickSaveFile } from "./export.js";

const $ = s => document.querySelector(s);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const h = (html) => { const t = document.createElement("template"); t.innerHTML = html.trim(); return t.content.firstElementChild; };

export const app = {
  project: newProject(),
  media,
  history: new History(),
  sel: null,              // selected item id
  tab: "media",
  pps: 60,                // timeline pixels per second
  filters: { effects: "all", sounds: "all", stickers: "all", q: "" },
};
window.__frightcut = app;   // handy for debugging and tests

const player = new Player($("#viewer"), app);
app.player = player;

// --------------------------------------------------------------------------------------------
// change + persistence
let saveTimer = null;
function changed({ keepFrame = false } = {}) {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => DB.set("kv", "project", app.project).catch(e => console.warn("save failed", e)), 400);
  renderTimeline(); renderInspector(); updateChrome();
  if (!keepFrame) { player._lay = layout(app.project); if (!player.playing) player.seek(player.t); }
}
function commit(fn, opts) { app.history.push(app.project); fn(app.project); changed(opts); }

// live edits (sliders): snapshot once when the gesture starts, then mutate freely
let liveSnap = null;
function liveStart() { if (!liveSnap) liveSnap = JSON.stringify(app.project); }
function liveEnd() { if (liveSnap && liveSnap !== JSON.stringify(app.project)) { app.history.past.push(liveSnap); app.history.future = []; } liveSnap = null; }
function liveChange() { clearTimeout(saveTimer); saveTimer = setTimeout(() => DB.set("kv", "project", app.project), 600); player._lay = layout(app.project); if (!player.playing) player.render(); renderTimeline(); }
window.addEventListener("pointerup", () => setTimeout(liveEnd, 0));
window.addEventListener("keyup", () => setTimeout(liveEnd, 0));

function toast(msg, ms = 2200) { const t = $("#toast"); t.textContent = msg; t.classList.add("on"); clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove("on"), ms); }

function updateChrome() {
  $("#dropHint").classList.toggle("hide", app.project.clips.length > 0 || app.project.overlays.length > 0);
  $("#projName").value = app.project.name;
  $("#aspect").value = app.project.aspect; $("#fit").value = app.project.fit;
  $("#undo").disabled = !app.history.past.length; $("#redo").disabled = !app.history.future.length;
  fitViewer();
}

function fitViewer() {
  const { w, h: hh } = outputSize(app.project, media);
  const wrap = $("#viewerWrap"), r = wrap.getBoundingClientRect();
  const s = Math.min((r.width - 20) / w, (r.height - 20) / hh);
  $("#viewer").style.width = Math.max(10, w * s) + "px"; $("#viewer").style.height = Math.max(10, hh * s) + "px";
}
window.addEventListener("resize", () => { fitViewer(); renderTimeline(); });

// --------------------------------------------------------------------------------------------
// importing
async function addFiles(files, { toTimeline = true } = {}) {
  files = [...files].filter(f => kindOf(f));
  if (!files.length) { toast("Those files aren't videos, photos or audio."); return; }
  const added = [];
  for (const f of files) {
    const item = new MediaItem(uid(), f);
    media.set(item.id, item);
    item.pending = true; renderLibrary();
    try {
      await probe(item);
      item.pending = false;
      await DB.set("media", item.id, { meta: item.toJSON(), file: f });
      added.push(item);
    } catch (e) {
      media.delete(item.id);
      toast(`${f.name}: ${e.message}`, 5000);
    }
    renderLibrary();
  }
  if (toTimeline) {
    const vids = added.filter(m => m.kind !== "audio").sort((a, b) => (a.created || a.name).localeCompare(b.created || b.name));
    if (vids.length) commit(p => { for (const m of vids) p.clips.push(newClip(m)); });
    const auds = added.filter(m => m.kind === "audio");
    if (auds.length && (!app.project.bed || app.project.bed.type === "none")) commit(p => { p.bed = { type: "file", mediaId: auds[0].id, gain: 0.6 }; });
  }
  if (added.length) toast(`Added ${added.length} file${added.length > 1 ? "s" : ""}`);
}

function newClip(m) {
  return { id: uid(), mediaId: m.id, in: 0, out: m.kind === "image" ? 4 : m.duration, speed: 1, volume: 1, mute: false, effects: [], look: null, transition: null, push: m.kind === "image" ? 0.12 : 0 };
}

$("#fileIn").addEventListener("change", e => { addFiles(e.target.files); e.target.value = ""; });
$("#importBtn2").addEventListener("click", () => $("#fileIn").click());
const vw = $("#viewerWrap");
["dragenter", "dragover"].forEach(ev => document.addEventListener(ev, e => { if (e.dataTransfer?.types?.includes("Files")) { e.preventDefault(); vw.classList.add("over"); } }));
["dragleave", "drop"].forEach(ev => document.addEventListener(ev, e => { if (ev === "dragleave" && e.relatedTarget) return; vw.classList.remove("over"); }));
document.addEventListener("drop", e => { if (e.dataTransfer?.files?.length) { e.preventDefault(); addFiles(e.dataTransfer.files); } });

// --------------------------------------------------------------------------------------------
// library panels
document.querySelectorAll("#tabs button").forEach(b => b.addEventListener("click", () => {
  app.tab = b.dataset.tab; document.querySelectorAll("#tabs button").forEach(x => x.classList.toggle("on", x === b)); renderLibrary();
}));

function selectedClip() {
  const f = app.sel && findItem(app.project, app.sel);
  if (f && f.list === "clips") return f.item;
  const lay = layout(app.project);
  const l = lay.find(l => player.t >= l.start && player.t < l.end) || lay[lay.length - 1];
  return l ? l.clip : null;
}

function renderLibrary() {
  const P = $("#panel"); P.innerHTML = "";
  const tab = app.tab;
  if (tab === "media") return mediaPanel(P);
  if (tab === "looks") return looksPanel(P);
  if (tab === "effects") return effectsPanel(P);
  if (tab === "scares") return scaresPanel(P);
  if (tab === "text") return textPanel(P);
  if (tab === "stickers") return stickersPanel(P);
  if (tab === "sounds") return soundsPanel(P);
  if (tab === "transitions") return transitionsPanel(P);
}

function mediaPanel(P) {
  const dz = h(`<div class="dropzone"><b>+ Add clips, photos or music</b><div class="note">Drop files here or click. Clips go on the timeline in the order the phone recorded them.</div></div>`);
  dz.addEventListener("click", () => $("#fileIn").click());
  dz.addEventListener("dragover", e => { e.preventDefault(); dz.classList.add("over"); });
  dz.addEventListener("dragleave", () => dz.classList.remove("over"));
  P.append(dz);
  const g = h(`<div class="grid"></div>`); P.append(g);
  for (const m of media.values()) {
    const it = h(`<div class="item media" title="${esc(m.name)}">
      ${m.kind === "audio" ? `<div class="thumb" style="display:flex;align-items:center;justify-content:center;font-size:30px;background:#0f0e12;border-radius:5px">🎵</div>` : `<img class="thumb" src="${m.thumbs[0] || ""}">`}
      ${m.kind === "video" ? `<span class="dur">${fmtTime(m.duration, false)}</span>` : ""}
      <div class="nm" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(m.pending ? "Reading…" : m.name)}</div>
      <div class="acts">${m.kind === "audio" ? `<button data-a="bed">As music</button><button data-a="snd">At playhead</button>` : `<button data-a="add">+ Timeline</button>`}</div></div>`);
    it.querySelector('[data-a="add"]')?.addEventListener("click", () => commit(p => p.clips.push(newClip(m))));
    it.querySelector('[data-a="bed"]')?.addEventListener("click", () => commit(p => { p.bed = { type: "file", mediaId: m.id, gain: 0.6 }; }));
    it.querySelector('[data-a="snd"]')?.addEventListener("click", () => addSound({ kind: "file", ref: m.id, dur: m.duration, name: m.name }));
    g.append(it);
  }
  if (!media.size) P.append(h(`<div class="note">Tip: AirDrop or cable the clips over from the phone. Sending through Messages shrinks them a lot.</div>`));
}

function chips(P, cats, key, onPick) {
  const c = h(`<div class="chips"></div>`);
  for (const cat of [{ id: "all", name: "All", icon: "" }, ...cats]) {
    const b = h(`<button class="chip ${app.filters[key] === cat.id ? "on" : ""}">${cat.icon || ""} ${esc(cat.name)}</button>`);
    b.addEventListener("click", () => { app.filters[key] = cat.id; onPick(); });
    c.append(b);
  }
  P.append(c);
}
function search(P, onInput) {
  const s = h(`<input class="search" type="text" placeholder="Search…" value="${esc(app.filters.q)}">`);
  s.addEventListener("input", () => { app.filters.q = s.value; onInput(); });
  P.append(s);
  return s;
}
const matches = (x, q) => !q || (x.name + " " + (x.desc || "") + " " + x.id).toLowerCase().includes(q.toLowerCase());

function looksPanel(P) {
  P.append(h(`<h3>Looks</h3>`), h(`<div class="note">A look is a finished style built from several effects. Put it on the whole movie or just one clip. Hover to preview.</div>`));
  const cur = h(`<div class="item wide"><div class="nm">Whole movie: ${esc(lookById(app.project.look)?.name || "none")}</div><div class="acts"><button>Remove movie look</button></div></div>`);
  cur.querySelector("button").addEventListener("click", () => commit(p => { p.look = null; }));
  P.append(cur);
  const g = h(`<div class="grid" style="margin-top:8px"></div>`); P.append(g);
  for (const L of LOOKS) {
    const it = h(`<div class="item"><div class="nm">${esc(L.name)}</div><div class="ds">${esc(L.desc)}</div>
      <div class="acts"><button data-a="movie">Movie</button><button data-a="clip">Clip</button></div></div>`);
    hoverPreview(it, () => ({ look: L.id }));
    it.querySelector('[data-a="movie"]').addEventListener("click", () => { commit(p => { p.look = L.id; }); toast(`${L.name} on the whole movie`); });
    it.querySelector('[data-a="clip"]').addEventListener("click", () => {
      const c = selectedClip(); if (!c) return toast("Add a clip first.");
      commit(p => { findItem(p, c.id).item.look = L.id; }); app.sel = c.id; renderTimeline(); renderInspector(); toast(`${L.name} on this clip`);
    });
    g.append(it);
  }
}

function hoverPreview(el, spec) {
  el.addEventListener("mouseenter", () => player.startHover(spec()));
  el.addEventListener("mouseleave", () => player.stopHover());
}

function effectsPanel(P) {
  P.append(h(`<h3>Effects · ${EFFECTS.length}</h3>`));
  const s = search(P, () => draw());
  chips(P, CATEGORIES, "effects", () => renderLibrary());
  const g = h(`<div class="grid"></div>`); P.append(g);
  const draw = () => {
    g.innerHTML = "";
    for (const def of EFFECTS) {
      if (app.filters.effects !== "all" && def.cat !== app.filters.effects) continue;
      if (!matches(def, app.filters.q)) continue;
      const it = h(`<div class="item"><div class="nm">${esc(def.name)}</div><div class="ds">${esc(def.desc || "")}</div>
        <div class="acts"><button data-a="clip" title="Apply to the selected clip">+ Clip</button><button data-a="tl" title="Add as a timed effect at the playhead">+ Here</button></div></div>`);
      hoverPreview(it, () => ({ fx: { type: def.id, params: defaultParams(def), seed: 0.5 } }));
      it.querySelector('[data-a="clip"]').addEventListener("click", () => addClipEffect(def));
      it.querySelector('[data-a="tl"]').addEventListener("click", () => addTimedFx(def));
      g.append(it);
    }
    if (!g.children.length) g.append(h(`<div class="note wide">Nothing matches.</div>`));
  };
  draw();
  if (app.filters.q) { s.focus(); s.setSelectionRange(s.value.length, s.value.length); }
}

function addClipEffect(def) {
  const c = selectedClip(); if (!c) return toast("Add a clip first.");
  commit(p => { findItem(p, c.id).item.effects.push({ id: uid(), type: def.id, params: defaultParams(def), seed: Math.random() }); });
  app.sel = c.id; renderTimeline(); renderInspector(); toast(`${def.name} added to the clip`);
}
function addTimedFx(def, dur) {
  const d = dur || (def.cat === "scare" ? 0.9 : 2.5);
  const id = uid();
  commit(p => { p.fx.push({ id, type: def.id, start: player.t, dur: d, params: defaultParams(def), seed: Math.random() }); });
  app.sel = id; renderTimeline(); renderInspector(); toast(`${def.name} at ${fmtTime(player.t)}`);
}

function scaresPanel(P) {
  P.append(h(`<h3>Scares</h3>`), h(`<div class="note">One click drops a whole scare at the playhead: picture effects, sounds and spooks, timed together. Each piece shows up on the timeline so you can move or tweak it.</div>`));
  const g = h(`<div class="grid"></div>`); P.append(g);
  for (const sc of SCARES) {
    const it = h(`<div class="item"><div class="nm">${sc.icon || ""} ${esc(sc.name)}</div><div class="ds">${esc(sc.desc)}</div><div class="acts"><button>Drop it here</button></div></div>`);
    it.querySelector("button").addEventListener("click", () => dropScare(sc));
    g.append(it);
  }
}
function dropScare(sc) {
  const t = player.t;
  const built = sc.build(t);
  commit(p => {
    for (const f of built.fx || []) if (effectById(f.type)) p.fx.push({ id: uid(), params: defaultParams(effectById(f.type)), seed: Math.random(), ...f, params: { ...defaultParams(effectById(f.type)), ...(f.params || {}) } });
    for (const o of built.overlays || []) p.overlays.push({ id: uid(), ...o });
    for (const s of built.sounds || []) if (SFX.find(x => x.id === s.ref)) p.sounds.push({ id: uid(), kind: "sfx", gain: 1, seed: Math.floor(Math.random() * 1000), ...s });
  });
  toast(`${sc.name} dropped at ${fmtTime(t)}. Press play.`);
}

function textPanel(P) {
  P.append(h(`<h3>Text</h3>`));
  const g = h(`<div class="grid"></div>`); P.append(g);
  for (const [k, st] of Object.entries(TEXT_STYLES)) {
    const it = h(`<div class="item"><div class="nm">${esc(st.name)}</div><div class="ds">${esc(st.desc)}</div><div class="acts"><button>Add</button></div></div>`);
    hoverPreview(it, () => ({ overlay: { kind: "text", props: textDefaults(k) } }));
    it.querySelector("button").addEventListener("click", () => addOverlay({ kind: "text", dur: k === "nightcard" ? 3 : 3.5, props: textDefaults(k) }));
    g.append(it);
  }
  P.append(h(`<h3 style="margin-top:14px">Camera HUDs</h3>`), h(`<div class="note">On-screen camera displays. They run for the whole movie unless you shorten them; the clock uses the date and time in the movie settings.</div>`));
  const g2 = h(`<div class="grid"></div>`); P.append(g2);
  for (const [k, hd] of Object.entries(HUDS)) {
    const it = h(`<div class="item"><div class="nm">${esc(hd.name)}</div><div class="ds">${esc(hd.desc)}</div><div class="acts"><button data-a="all">Whole movie</button><button data-a="here">Here</button></div></div>`);
    hoverPreview(it, () => ({ overlay: { kind: "hud", props: { style: k } } }));
    it.querySelector('[data-a="all"]').addEventListener("click", () => addOverlay({ kind: "hud", start: 0, dur: Math.max(5, duration(app.project)), props: { style: k } }));
    it.querySelector('[data-a="here"]').addEventListener("click", () => addOverlay({ kind: "hud", dur: 6, props: { style: k } }));
    g2.append(it);
  }
}
function textDefaults(style) {
  const n = app.project.name || "UNTITLED";
  const text = { title: n, creepy: "Something is here", drip: n, typewriter: "The following footage was recovered from the house.\nIt has not been altered.", subtitle: "Did you hear that?",
    glitch: "SIGNAL LOST", slam: "THIS OCTOBER", whisper: "it's behind you", evidence: "Tape recovered 10/31", scrawl: "GET OUT", nightcard: "Night #1" }[style] || "Text";
  return { style, text, seed: Math.random() };
}
function addOverlay(o) {
  const id = uid();
  commit(p => { p.overlays.push({ id, start: player.t, dur: 3, ...o }); });
  app.sel = id; renderTimeline(); renderInspector();
}

function stickersPanel(P) {
  P.append(h(`<h3>Spooks · ${STICKERS.length}</h3>`), h(`<div class="note">Ghosts, figures and creepy things to put in a shot. Pick how they move after adding. Hover to preview.</div>`));
  chips(P, STICKER_CATEGORIES, "stickers", () => renderLibrary());
  const g = h(`<div class="grid"></div>`); P.append(g);
  for (const s of STICKERS) {
    if (app.filters.stickers !== "all" && s.cat !== app.filters.stickers) continue;
    const it = h(`<div class="item"><div class="nm">${esc(s.name)}</div><div class="acts"><button>Add</button></div></div>`);
    try { const th = stickerThumb(s.id, 120); th.style.width = "100%"; th.style.borderRadius = "5px"; it.prepend(th); } catch (_) {}
    hoverPreview(it, () => ({ overlay: { kind: "sticker", props: stickerDefaults(s) } }));
    it.querySelector("button").addEventListener("click", () => addOverlay({ kind: "sticker", dur: 3, props: stickerDefaults(s) }));
    g.append(it);
  }
}
function stickerDefaults(s) {
  return { sticker: s.id, x: 0.5, y: 0.5, scale: 0.45, opacity: s.defaults?.opacity ?? 0.92, move: "fade-flicker", aspect: s.aspect || 1, flip: false, seed: Math.random() };
}

let auditionNode = null, auditionCtx = null;
async function audition(buf) {
  auditionCtx ||= new AudioContext();
  if (auditionCtx.state === "suspended") await auditionCtx.resume();
  try { auditionNode?.stop(); } catch (_) {}
  const n = auditionCtx.createBufferSource(); n.buffer = buf;
  const g = auditionCtx.createGain(); g.gain.value = player.master; n.connect(g).connect(auditionCtx.destination);
  n.start(); auditionNode = n;
  setTimeout(() => { if (auditionNode === n) try { n.stop(); } catch (_) {} }, 8000);
}

function soundsPanel(P) {
  P.append(h(`<h3>Background music</h3>`));
  const bedRow = h(`<div class="item wide"><div class="row"><label>Bed</label><select id="bedSel"><option value="none">None</option>${BEDS.map(b => `<option value="${b.id}">${esc(b.name)}</option>`).join("")}<option value="file">Your own music…</option></select><button id="bedPlay" title="Listen">▶</button></div>
    <div class="row"><label>Volume</label><input id="bedGain" type="range" min="0" max="1" step="0.01"><span class="val" id="bedGainV"></span></div><div class="ds" id="bedDesc"></div></div>`);
  P.append(bedRow);
  const bs = bedRow.querySelector("#bedSel"), bg = bedRow.querySelector("#bedGain");
  const sync = () => {
    bs.value = app.project.bed.type; bg.value = app.project.bed.gain ?? 0.45; bedRow.querySelector("#bedGainV").textContent = Math.round(bg.value * 100) + "%";
    const b = BEDS.find(x => x.id === app.project.bed.type);
    bedRow.querySelector("#bedDesc").textContent = app.project.bed.type === "file" ? (media.get(app.project.bed.mediaId)?.name || "") : (b?.desc || "");
  };
  sync();
  bs.addEventListener("change", () => {
    if (bs.value === "file") { $("#audioIn").onchange = async e => { const f = e.target.files[0]; e.target.value = ""; if (f) { await addFiles([f], { toTimeline: false }); const m = [...media.values()].reverse().find(x => x.kind === "audio"); if (m) commit(p => { p.bed = { type: "file", mediaId: m.id, gain: 0.6 }; }); renderLibrary(); } }; $("#audioIn").click(); sync(); return; }
    commit(p => { p.bed = { ...p.bed, type: bs.value }; }); sync();
  });
  bg.addEventListener("input", () => { liveStart(); app.project.bed.gain = +bg.value; sync(); liveChange(); });
  bedRow.querySelector("#bedPlay").addEventListener("click", async () => {
    const b = app.project.bed;
    if (b.type === "none") return;
    const buf = b.type === "file" ? media.get(b.mediaId)?.audioBuffer : await renderBed(b.type, { seconds: 30 });
    if (buf) audition(buf);
  });

  P.append(h(`<h3 style="margin-top:14px">Sound effects · ${SFX.length}</h3>`));
  chips(P, SFX_CATEGORIES, "sounds", () => renderLibrary());
  const g = h(`<div class="grid"></div>`); P.append(g);
  for (const s of SFX) {
    if (app.filters.sounds !== "all" && s.cat !== app.filters.sounds) continue;
    const it = h(`<div class="item"><div class="nm">${esc(s.name)}</div><div class="ds">${esc(s.desc || "")}</div><div class="acts"><button data-a="play">▶</button><button data-a="add">+ Here</button></div></div>`);
    it.querySelector('[data-a="play"]').addEventListener("click", async () => audition(await renderSfx(s.id, { seed: 1 })));
    it.querySelector('[data-a="add"]').addEventListener("click", () => addSound({ kind: "sfx", ref: s.id, dur: s.dur }));
    g.append(it);
  }
  const imp = h(`<button style="width:100%;margin-top:10px">Import a sound file…</button>`);
  imp.addEventListener("click", () => { $("#audioIn").onchange = async e => { const f = e.target.files[0]; e.target.value = ""; if (!f) return; await addFiles([f], { toTimeline: false }); const m = [...media.values()].reverse().find(x => x.kind === "audio"); if (m) addSound({ kind: "file", ref: m.id, dur: m.duration }); }; $("#audioIn").click(); });
  P.append(imp);
}
function addSound(s) {
  const id = uid();
  commit(p => { p.sounds.push({ id, start: player.t, gain: 1, seed: 1, ...s }); });
  app.sel = id; renderTimeline(); renderInspector();
}

function transitionsPanel(P) {
  P.append(h(`<h3>Cuts between clips</h3>`), h(`<div class="note">Pick a clip, then a cut: it plays going INTO that clip. Or put the same cut on every join.</div>`));
  const g = h(`<div class="grid"></div>`); P.append(g);
  const none = h(`<div class="item"><div class="nm">Hard cut</div><div class="ds">No transition.</div><div class="acts"><button data-a="clip">Clip</button><button data-a="all">All</button></div></div>`);
  g.append(none);
  const apply = (type, dur, all) => {
    if (all) return commit(p => p.clips.forEach((c, i) => { if (i > 0) c.transition = type ? { type, dur } : null; }));
    const c = selectedClip(); if (!c) return toast("Add a clip first.");
    const i = app.project.clips.findIndex(x => x.id === c.id);
    if (i === 0) return toast("The first clip has nothing before it. Pick a later clip.");
    commit(p => { p.clips[i].transition = type ? { type, dur } : null; });
  };
  none.querySelector('[data-a="clip"]').addEventListener("click", () => apply(null, 0, false));
  none.querySelector('[data-a="all"]').addEventListener("click", () => apply(null, 0, true));
  for (const T of TRANSITIONS) {
    const it = h(`<div class="item"><div class="nm">${esc(T.name)}</div><div class="ds">${esc(T.desc || "")}</div><div class="acts"><button data-a="clip">Clip</button><button data-a="all">All</button></div></div>`);
    it.querySelector('[data-a="clip"]').addEventListener("click", () => apply(T.id, T.dur || 0.6, false));
    it.querySelector('[data-a="all"]').addEventListener("click", () => apply(T.id, T.dur || 0.6, true));
    g.append(it);
  }
}

// --------------------------------------------------------------------------------------------
// inspector
function row(label, control, val = "") { return `<div class="row"><label>${esc(label)}</label>${control}<span class="val">${val}</span></div>`; }
function bindInputs(root, item, onLive) {
  root.querySelectorAll("[data-k]").forEach(el => {
    const k = el.dataset.k, num = el.type === "range" || el.type === "number";
    const set = () => {
      liveStart();
      let v = el.type === "checkbox" ? el.checked : num ? +el.value : el.value;
      setPath(item, k, v);
      const vEl = el.closest(".row")?.querySelector(".val"); if (vEl && el.type === "range") vEl.textContent = fmtVal(v, el.dataset.fmt);
      onLive?.(k, v);
      liveChange();
    };
    el.addEventListener("input", set);
    if (el.tagName === "SELECT" || el.type === "checkbox") el.addEventListener("change", () => { set(); liveEnd(); renderInspector(); });
    else el.addEventListener("change", () => liveEnd());
  });
}
const setPath = (o, path, v) => { const ks = path.split("."); let x = o; for (const k of ks.slice(0, -1)) x = x[k] ||= {}; x[ks[ks.length - 1]] = v; };
const fmtVal = (v, f) => f === "pct" ? Math.round(v * 100) + "%" : f === "x" ? v + "×" : f === "s" ? (+v).toFixed(2) + "s" : (+v).toFixed(2).replace(/\.?0+$/, "");

function paramRows(def, params, prefix) {
  return (def.params || []).map(pr => row(pr.label, `<input type="range" data-k="${prefix}.${pr.k}" min="${pr.min}" max="${pr.max}" step="${pr.step || 0.01}" value="${params[pr.k] ?? pr.def}">`, fmtVal(params[pr.k] ?? pr.def))).join("");
}

function renderInspector() {
  const B = $("#inspectorBody");
  const f = app.sel && findItem(app.project, app.sel);
  if (!f) return projectInspector(B);
  const it = f.item;
  if (f.list === "clips") return clipInspector(B, it);
  B.innerHTML = "";
  const timing = row("Starts at", `<input type="number" data-k="start" min="0" step="0.05" value="${it.start.toFixed(2)}">`, "s") +
    (f.list !== "sounds" || true ? row("Lasts", `<input type="number" data-k="dur" min="0.05" step="0.05" value="${(+it.dur).toFixed(2)}">`, "s") : "");
  if (f.list === "fx") {
    const def = effectById(it.type);
    B.innerHTML = `<h2>${esc(def?.name || it.type)}</h2><div class="kind">Timed effect</div>
      ${row("Effect", `<select data-k="type">${EFFECTS.map(e => `<option value="${e.id}" ${e.id === it.type ? "selected" : ""}>${esc(e.name)}</option>`).join("")}</select>`)}
      ${timing}${def ? paramRows(def, it.params, "params") : ""}
      <div class="btnrow"><button data-act="here">Move to playhead</button><button data-act="dup">Duplicate</button><button data-act="del">Delete</button></div>`;
  } else if (f.list === "overlays" && it.kind === "text") {
    const p = it.props, st = TEXT_STYLES[p.style] || TEXT_STYLES.title;
    B.innerHTML = `<h2>Text</h2><div class="kind">${esc(st.name)}</div>
      <div class="row full"><textarea data-k="props.text" rows="3">${esc(p.text)}</textarea></div>
      ${row("Style", `<select data-k="props.style">${Object.entries(TEXT_STYLES).map(([k, s]) => `<option value="${k}" ${k === p.style ? "selected" : ""}>${esc(s.name)}</option>`).join("")}</select>`)}
      ${row("Position", `<select data-k="props.pos"><option value="">Style default</option>${["center", "top", "bottom", "custom"].map(x => `<option ${p.pos === x ? "selected" : ""}>${x}</option>`).join("")}</select>`)}
      ${p.pos === "custom" ? row("Across", `<input type="range" data-k="props.x" min="0" max="1" step="0.01" value="${p.x ?? 0.5}">`) + row("Down", `<input type="range" data-k="props.y" min="0" max="1" step="0.01" value="${p.y ?? 0.5}">`) : ""}
      ${row("Size", `<input type="range" data-k="props.size" min="0.02" max="0.2" step="0.005" value="${p.size ?? st.size}">`)}
      ${row("Color", `<input type="color" data-k="props.color" value="${p.color || st.color}">`)}
      ${row("Background", `<select data-k="props.bg"><option value="">Style default</option><option value="none" ${p.bg === "none" ? "selected" : ""}>None</option><option value="dim" ${p.bg === "dim" ? "selected" : ""}>Dim the video</option><option value="black" ${p.bg === "black" ? "selected" : ""}>Black card</option></select>`)}
      ${row("Animation", `<select data-k="props.anim"><option value="">Style default</option>${["fade", "type", "flicker", "glitch", "slam", "shake", "breathe", "none"].map(x => `<option ${p.anim === x ? "selected" : ""}>${x}</option>`).join("")}</select>`)}
      ${timing}<div class="btnrow"><button data-act="here">Move to playhead</button><button data-act="dup">Duplicate</button><button data-act="del">Delete</button></div>`;
  } else if (f.list === "overlays" && it.kind === "hud") {
    const p = it.props;
    B.innerHTML = `<h2>${esc(HUDS[p.style]?.name || "HUD")}</h2><div class="kind">Camera HUD</div>
      ${row("Style", `<select data-k="props.style">${Object.entries(HUDS).map(([k, s]) => `<option value="${k}" ${k === p.style ? "selected" : ""}>${esc(s.name)}</option>`).join("")}</select>`)}
      ${row("Label", `<input type="text" data-k="props.label" value="${esc(p.label || "")}" placeholder="optional">`)}
      ${["camcorder", "nightvision"].includes(p.style) ? row("Battery", `<input type="range" data-k="props.battery" min="0" max="1" step="0.05" value="${p.battery ?? 0.35}">`) : ""}
      ${row("Clock starts", `<input type="datetime-local" data-proj="clockStart" value="${esc(app.project.clockStart)}">`)}
      ${timing}<div class="btnrow"><button data-act="whole">Whole movie</button><button data-act="dup">Duplicate</button><button data-act="del">Delete</button></div>`;
  } else if (f.list === "overlays" && it.kind === "sticker") {
    const p = it.props, s = STICKERS.find(x => x.id === p.sticker);
    B.innerHTML = `<h2>${esc(s?.name || "Spook")}</h2><div class="kind">Spook</div>
      ${row("Spook", `<select data-k="props.sticker">${STICKERS.map(x => `<option value="${x.id}" ${x.id === p.sticker ? "selected" : ""}>${esc(x.name)}</option>`).join("")}</select>`)}
      ${row("Moves", `<select data-k="props.move">${Object.entries(MOVES).map(([k, v]) => `<option value="${k}" ${k === p.move ? "selected" : ""}>${esc(v)}</option>`).join("")}</select>`)}
      ${row("Across", `<input type="range" data-k="props.x" min="-0.2" max="1.2" step="0.01" value="${p.x}">`)}
      ${row("Down", `<input type="range" data-k="props.y" min="-0.2" max="1.2" step="0.01" value="${p.y}">`)}
      ${row("Size", `<input type="range" data-k="props.scale" min="0.05" max="1.5" step="0.01" value="${p.scale}">`)}
      ${row("See-through", `<input type="range" data-k="props.opacity" min="0.05" max="1" step="0.01" value="${p.opacity}">`)}
      ${row("Mirror", `<input type="checkbox" data-k="props.flip" ${p.flip ? "checked" : ""}>`)}
      ${timing}<div class="btnrow"><button data-act="here">Move to playhead</button><button data-act="dup">Duplicate</button><button data-act="del">Delete</button></div>`;
  } else if (f.list === "sounds") {
    const s = it.kind === "sfx" ? SFX.find(x => x.id === it.ref) : null;
    B.innerHTML = `<h2>${esc(s?.name || media.get(it.ref)?.name || "Sound")}</h2><div class="kind">Sound</div>
      ${it.kind === "sfx" ? row("Sound", `<select data-k="ref">${SFX.map(x => `<option value="${x.id}" ${x.id === it.ref ? "selected" : ""}>${esc(x.name)}</option>`).join("")}</select>`) : ""}
      ${row("Volume", `<input type="range" data-k="gain" min="0" max="2" step="0.01" value="${it.gain ?? 1}">`, fmtVal(it.gain ?? 1))}
      ${it.kind === "sfx" ? row("Variation", `<input type="number" data-k="seed" min="1" max="999" step="1" value="${it.seed || 1}">`) : ""}
      ${timing}<div class="btnrow"><button data-act="listen">▶ Listen</button><button data-act="here">Move to playhead</button><button data-act="dup">Duplicate</button><button data-act="del">Delete</button></div>`;
  }
  bindInputs(B, it, (k) => { if (k === "type") { const d = effectById(it.type); it.params = defaultParams(d); renderInspector(); } if (k === "props.sticker") { const s = STICKERS.find(x => x.id === it.props.sticker); it.props.aspect = s?.aspect || 1; } if (k === "ref") { const s = SFX.find(x => x.id === it.ref); if (s) it.dur = s.dur; } });
  B.querySelectorAll("[data-proj]").forEach(el => el.addEventListener("change", () => commit(p => { p[el.dataset.proj] = el.value; })));
  B.querySelectorAll("[data-act]").forEach(b => b.addEventListener("click", async () => {
    const a = b.dataset.act;
    if (a === "del") return deleteSel();
    if (a === "here") return commit(() => { findItem(app.project, it.id).item.start = player.t; });
    if (a === "whole") return commit(() => { const x = findItem(app.project, it.id).item; x.start = 0; x.dur = Math.max(5, duration(app.project)); });
    if (a === "dup") { const id = uid(); commit(p => { const x = structuredClone(it); x.id = id; x.start = it.start + it.dur; p[f.list].push(x); }); app.sel = id; renderTimeline(); renderInspector(); return; }
    if (a === "listen") { const buf = it.kind === "sfx" ? await renderSfx(it.ref, { seed: it.seed || 1 }) : media.get(it.ref)?.audioBuffer; if (buf) audition(buf); }
  }));
}

function clipInspector(B, c) {
  const m = media.get(c.mediaId);
  const idx = app.project.clips.findIndex(x => x.id === c.id);
  B.innerHTML = `<h2 style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(m?.name || "Missing clip")}</h2><div class="kind">Clip ${idx + 1} · ${fmtTime(clipLen(c))}</div>
    ${row("Starts at", `<input type="number" data-k="in" min="0" step="0.05" value="${c.in.toFixed(2)}">`, "s")}
    ${row("Ends at", `<input type="number" data-k="out" min="0.1" step="0.05" value="${c.out.toFixed(2)}">`, "s")}
    ${row("Speed", `<select data-k="speed">${[0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4].map(s => `<option value="${s}" ${+c.speed === s ? "selected" : ""}>${s}×${s < 1 ? " slow-mo" : ""}</option>`).join("")}</select>`)}
    ${m?.kind === "video" ? row("Volume", `<input type="range" data-k="volume" min="0" max="2" step="0.01" value="${c.volume ?? 1}">`, fmtVal(c.volume ?? 1)) + row("Mute", `<input type="checkbox" data-k="mute" ${c.mute ? "checked" : ""}>`) : ""}
    ${row("Creep zoom", `<input type="range" data-k="push" min="0" max="0.6" step="0.01" value="${c.push || 0}">`, fmtVal(c.push || 0))}
    ${row("Zoom", `<input type="range" data-k="zoom" min="1" max="3" step="0.01" value="${c.zoom || 1}">`, fmtVal(c.zoom || 1))}
    ${row("Move ↔", `<input type="range" data-k="panX" min="-0.5" max="0.5" step="0.01" value="${c.panX || 0}">`)}
    ${row("Move ↕", `<input type="range" data-k="panY" min="-0.5" max="0.5" step="0.01" value="${c.panY || 0}">`)}
    ${row("Tilt", `<input type="range" data-k="rot" min="-25" max="25" step="0.5" value="${c.rot || 0}">`, (c.rot || 0) + "°")}
    ${row("Look", `<select data-k="look"><option value="">None</option>${LOOKS.map(L => `<option value="${L.id}" ${L.id === c.look ? "selected" : ""}>${esc(L.name)}</option>`).join("")}</select>`)}
    ${idx > 0 ? row("Cut in", `<select data-tr="type"><option value="">Hard cut</option>${TRANSITIONS.map(T => `<option value="${T.id}" ${T.id === c.transition?.type ? "selected" : ""}>${esc(T.name)}</option>`).join("")}</select>`) +
      (c.transition?.type ? row("Cut length", `<input type="range" data-tr="dur" min="0.2" max="2.5" step="0.05" value="${c.transition.dur}">`, c.transition.dur + "s") : "") : ""}
    <div class="sect"><div class="hd">Effects on this clip <span class="note" style="margin:0">${c.effects.length}</span></div>
      <div id="fxList"></div>
      <select id="addFx" style="width:100%;margin-top:6px"><option value="">+ Add an effect…</option>${CATEGORIES.map(cat => `<optgroup label="${esc(cat.name)}">${EFFECTS.filter(e => e.cat === cat.id).map(e => `<option value="${e.id}">${esc(e.name)}</option>`).join("")}</optgroup>`).join("")}</select>
    </div>
    <div class="btnrow"><button data-act="split">✂ Split here</button><button data-act="dup">Duplicate</button><button data-act="del">Delete</button></div>`;
  bindInputs(B, c, (k, v) => {
    if (k === "look") c.look = v || null;
    if (k === "speed") c.speed = +v;
    if (k === "in" || k === "out") { const max = m?.kind === "image" ? 3600 : (m?.duration || c.out); c.in = Math.max(0, Math.min(c.in, max - 0.1)); c.out = Math.max(c.in + 0.1, Math.min(c.out, max)); }
  });
  B.querySelectorAll("[data-tr]").forEach(el => el.addEventListener(el.tagName === "SELECT" ? "change" : "input", () => {
    liveStart();
    if (el.dataset.tr === "type") { c.transition = el.value ? { type: el.value, dur: c.transition?.dur || transitionById(el.value)?.dur || 0.6 } : null; liveChange(); liveEnd(); renderInspector(); }
    else { c.transition.dur = +el.value; el.closest(".row").querySelector(".val").textContent = c.transition.dur + "s"; liveChange(); }
  }));
  const L = B.querySelector("#fxList");
  c.effects.forEach((e, i) => {
    const def = effectById(e.type);
    const card = h(`<div class="fxcard"><div class="top"><b>${esc(def?.name || e.type)}</b><button data-m="up" title="Earlier in the stack">↑</button><button data-m="down" title="Later in the stack">↓</button><button data-m="x" title="Remove">✕</button></div>${def ? paramRows(def, e.params, "params") : ""}</div>`);
    bindInputs(card, e);
    card.querySelectorAll("[data-m]").forEach(b => b.addEventListener("click", () => commit(() => {
      const arr = findItem(app.project, c.id).item.effects;
      if (b.dataset.m === "x") arr.splice(i, 1);
      if (b.dataset.m === "up" && i > 0) [arr[i - 1], arr[i]] = [arr[i], arr[i - 1]];
      if (b.dataset.m === "down" && i < arr.length - 1) [arr[i + 1], arr[i]] = [arr[i], arr[i + 1]];
    })));
    L.append(card);
  });
  B.querySelector("#addFx").addEventListener("change", e => { const d = effectById(e.target.value); if (d) addClipEffect(d); });
  B.querySelectorAll("[data-act]").forEach(b => b.addEventListener("click", () => {
    const a = b.dataset.act;
    if (a === "del") return deleteSel();
    if (a === "split") return doSplit();
    if (a === "dup") { const id = uid(); commit(p => { const i = p.clips.findIndex(x => x.id === c.id); const x = structuredClone(c); x.id = id; x.effects.forEach(e => e.id = uid()); p.clips.splice(i + 1, 0, x); }); app.sel = id; renderTimeline(); renderInspector(); }
  }));
}

function projectInspector(B) {
  const p = app.project, total = duration(p), { w, h: hh, aspect } = outputSize(p, media);
  B.innerHTML = `<h2>Movie settings</h2><div class="kind">${fmtTime(total)} · ${w}×${hh} (${aspect})</div>
    ${row("Whole-movie look", `<select data-k="look"><option value="">None</option>${LOOKS.map(L => `<option value="${L.id}" ${L.id === p.look ? "selected" : ""}>${esc(L.name)}</option>`).join("")}</select>`)}
    ${row("Clock starts", `<input type="datetime-local" data-k="clockStart" value="${esc(p.clockStart)}">`)}
    <div class="note">The clock is what camcorder and security-cam HUDs show. It runs forward from here as the movie plays.</div>
    <div class="sect"><div class="hd">On the timeline</div>
      <div class="note">${p.clips.length} clips · ${p.fx.length} timed effects · ${p.overlays.length} overlays · ${p.sounds.length} sounds</div></div>
    <div class="sect"><div class="hd">Quick start</div>
      <div class="note">1. Drop clips in. 2. Pick a Look. 3. Hit Scares and drop a jump scare where it should land. 4. Add a title from Text &amp; HUD. 5. Export.</div></div>`;
  bindInputs(B, p, (k, v) => { if (k === "look") p.look = v || null; });
}

// --------------------------------------------------------------------------------------------
// timeline
const tl = { scroll: $("#tlScroll"), inner: $("#tlInner"), ruler: $("#ruler"), ph: $("#playhead"), tracks: {} };
document.querySelectorAll(".track").forEach(t => tl.tracks[t.dataset.track] = t);

function lanes(items) {
  const sorted = [...items].sort((a, b) => a.start - b.start), ends = [];
  const lane = new Map();
  for (const it of sorted) {
    let i = ends.findIndex(e => e <= it.start + 1e-6);
    if (i < 0) { i = ends.length; ends.push(0); }
    ends[i] = it.start + it.dur; lane.set(it.id, i);
  }
  return { lane, n: Math.max(1, ends.length) };
}

function renderTimeline() {
  const p = app.project, pps = app.pps, total = duration(p);
  const width = Math.max(tl.scroll.clientWidth, (total + 8) * pps);
  tl.inner.style.width = width + "px";
  // ruler
  tl.ruler.innerHTML = "";
  const step = pps > 120 ? 1 : pps > 50 ? 2 : pps > 20 ? 5 : pps > 8 ? 10 : 30;
  for (let s = 0; s * pps < width; s += step) {
    tl.ruler.append(h(`<div class="tick" style="left:${s * pps}px">${fmtTime(s, false)}</div>`));
    if (step >= 2) for (let k = 1; k < 4; k++) { const x = (s + k * step / 4) * pps; if (x < width) tl.ruler.append(h(`<div class="tick minor" style="left:${x}px"></div>`)); }
  }
  // video
  const V = tl.tracks.video; V.innerHTML = "";
  for (const l of layout(p)) {
    const c = l.clip, m = media.get(c.mediaId);
    const b = h(`<div class="blk video ${app.sel === c.id ? "sel" : ""}" data-id="${c.id}" style="left:${l.start * pps}px;width:${Math.max(4, (l.end - l.start) * pps - 1)}px">
      <div class="edge l"></div><div class="edge r"></div>${esc(m?.name || "missing")}
      <div class="tag">${c.speed !== 1 ? `<span>${c.speed}×</span>` : ""}${c.look ? `<span>🎨 ${esc(lookById(c.look)?.name || "")}</span>` : ""}${c.effects.length ? `<span>✨${c.effects.length}</span>` : ""}${c.mute ? "<span>🔇</span>" : ""}</div>
      ${c.transition?.type ? `<div class="tr" title="${esc(transitionById(c.transition.type)?.name || "")}">⚡</div>` : ""}</div>`);
    if (m?.thumbs?.length) b.style.backgroundImage = m.thumbs.map(u => `url(${u})`).slice(0, 1).join(",");
    V.append(b);
  }
  const lanesFor = (track, items, cls, label) => {
    const T = tl.tracks[track]; T.innerHTML = "";
    const { lane, n } = lanes(items);
    const H = T.clientHeight - 8, lh = H / n;
    for (const it of items) {
      const b = h(`<div class="blk ${cls} ${app.sel === it.id ? "sel" : ""}" data-id="${it.id}" style="left:${it.start * pps}px;width:${Math.max(6, it.dur * pps - 1)}px;top:${4 + lane.get(it.id) * lh}px;height:${lh - 2}px;bottom:auto"><div class="edge l"></div><div class="edge r"></div>${esc(label(it))}</div>`);
      T.append(b);
    }
  };
  lanesFor("fx", p.fx, "fx", f => "✨ " + (effectById(f.type)?.name || f.type));
  lanesFor("overlay", p.overlays, "overlay", o => o.kind === "text" ? "🔤 " + o.props.text : o.kind === "hud" ? "📹 " + (HUDS[o.props.style]?.name || "HUD") : "👻 " + (STICKERS.find(s => s.id === o.props.sticker)?.name || "Spook"));
  lanesFor("sound", p.sounds, "sound", s => "🔊 " + (s.kind === "sfx" ? SFX.find(x => x.id === s.ref)?.name || s.ref : media.get(s.ref)?.name || "audio"));
  placePlayhead();
}

function placePlayhead() {
  tl.ph.style.left = player.t * app.pps + "px";
  const x = player.t * app.pps, sl = tl.scroll.scrollLeft, w = tl.scroll.clientWidth;
  if (player.playing && (x < sl || x > sl + w - 40)) tl.scroll.scrollLeft = x - 60;
}

player.onTime = t => {
  $("#timecode").textContent = `${fmtTime(t)} / ${fmtTime(duration(app.project))}`;
  $("#play").textContent = player.playing ? "❚❚" : "▶";
  placePlayhead();
};

const tlX = e => e.clientX - tl.inner.getBoundingClientRect().left;
function seekFromEvent(e) { player.seek(Math.max(0, tlX(e) / app.pps)); }

tl.ruler.addEventListener("pointerdown", e => {
  seekFromEvent(e); tl.ruler.setPointerCapture(e.pointerId);
  const mv = ev => seekFromEvent(ev);
  tl.ruler.addEventListener("pointermove", mv);
  tl.ruler.addEventListener("pointerup", () => tl.ruler.removeEventListener("pointermove", mv), { once: true });
});

tl.inner.addEventListener("pointerdown", e => {
  const blk = e.target.closest(".blk");
  if (!blk) { if (e.target.closest(".track")) { app.sel = null; seekFromEvent(e); renderTimeline(); renderInspector(); } return; }
  const id = blk.dataset.id, f = findItem(app.project, id);
  if (!f) return;
  app.sel = id;
  const edge = e.target.classList.contains("edge") ? (e.target.classList.contains("l") ? "l" : "r") : null;
  const snap = JSON.stringify(app.project);
  const x0 = e.clientX, pps = app.pps, it = f.item;
  const orig = structuredClone(it);
  let moved = false, dropIdx = null, mark = null;
  blk.setPointerCapture(e.pointerId);
  blk.classList.add("dragging");
  document.querySelectorAll(".blk.sel").forEach(b => b.classList.remove("sel")); blk.classList.add("sel");
  renderInspector();
  const snapPts = () => [player.t, ...layout(app.project).flatMap(l => [l.start, l.end])];
  const snapT = t => { for (const s of snapPts()) if (Math.abs(s - t) * pps < 7) return s; return t; };
  const onMove = ev => {
    const dt = (ev.clientX - x0) / pps;
    if (Math.abs(ev.clientX - x0) > 3) moved = true;
    if (!moved) return;
    if (f.list === "clips") {
      const m = media.get(it.mediaId), max = m?.kind === "image" ? 3600 : m?.duration || orig.out, sp = it.speed || 1;
      if (edge === "l") { it.in = Math.max(0, Math.min(orig.out - 0.1, orig.in + dt * sp)); liveChange(); }
      else if (edge === "r") { it.out = Math.min(max, Math.max(orig.in + 0.1, orig.out + dt * sp)); liveChange(); }
      else {
        const x = tlX(ev) / pps, lay = layout(app.project);
        dropIdx = lay.findIndex(l => x < (l.start + l.end) / 2); if (dropIdx < 0) dropIdx = lay.length;
        const mx = dropIdx < lay.length ? lay[dropIdx].start : lay[lay.length - 1].end;
        if (!mark) { mark = h(`<div class="dropMark"></div>`); tl.tracks.video.append(mark); }
        mark.style.left = mx * pps - 1 + "px";
        blk.style.transform = `translateX(${ev.clientX - x0}px)`;
      }
    } else {
      if (edge === "l") { const s = snapT(Math.max(0, Math.min(orig.start + orig.dur - 0.05, orig.start + dt))); it.dur = orig.dur + (orig.start - s); it.start = s; }
      else if (edge === "r") it.dur = Math.max(0.05, snapT(orig.start + orig.dur + dt) - orig.start);
      else it.start = snapT(Math.max(0, orig.start + dt));
      liveChange();
    }
  };
  const onUp = () => {
    blk.removeEventListener("pointermove", onMove);
    mark?.remove();
    if (f.list === "clips" && !edge && moved && dropIdx != null) {
      const arr = app.project.clips, from = arr.findIndex(c => c.id === id);
      let to = dropIdx > from ? dropIdx - 1 : dropIdx;
      if (to !== from) { const [c] = arr.splice(from, 1); arr.splice(to, 0, c); }
    }
    if (moved && JSON.stringify(app.project) !== snap) { app.history.past.push(snap); app.history.future = []; }
    if (!moved && f.list !== "clips") player.seek(player.t);
    if (!moved && f.list === "clips") { const l = layout(app.project).find(l => l.clip.id === id); if (l && (player.t < l.start || player.t >= l.end)) player.seek(l.start); }
    changed();
  };
  blk.addEventListener("pointermove", onMove);
  blk.addEventListener("pointerup", onUp, { once: true });
});

tl.scroll.addEventListener("wheel", e => {
  if (e.ctrlKey || e.metaKey) { e.preventDefault(); zoom(e.deltaY < 0 ? 1.25 : 0.8, e); }
  else if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) { tl.scroll.scrollLeft += e.deltaY; e.preventDefault(); }
}, { passive: false });
function zoom(f, e) {
  const anchorT = e ? tlX(e) / app.pps : player.t;
  const sx = e ? e.clientX - tl.scroll.getBoundingClientRect().left : tl.scroll.clientWidth / 2;
  app.pps = Math.max(2, Math.min(400, app.pps * f));
  renderTimeline();
  tl.scroll.scrollLeft = anchorT * app.pps - sx;
}
$("#zoomIn").addEventListener("click", () => zoom(1.4));
$("#zoomOut").addEventListener("click", () => zoom(1 / 1.4));
$("#zoomFit").addEventListener("click", () => { const d = duration(app.project) || 10; app.pps = Math.max(2, Math.min(400, (tl.scroll.clientWidth - 30) / d)); renderTimeline(); tl.scroll.scrollLeft = 0; });

// --------------------------------------------------------------------------------------------
// actions
function doSplit() {
  let newId = null;
  commit(p => { newId = splitAt(p, player.t); });
  if (!newId) toast("Put the playhead inside a clip (not right at its edge) to split it.");
  else { app.sel = newId; renderTimeline(); renderInspector(); }
}
function deleteSel() {
  if (!app.sel) return;
  const f = findItem(app.project, app.sel); if (!f) return;
  commit(p => { p[f.list].splice(f.index, 1); });
  app.sel = null; renderTimeline(); renderInspector();
}
$("#splitBtn").addEventListener("click", doSplit);
$("#delBtn").addEventListener("click", deleteSel);
$("#play").addEventListener("click", () => player.toggle());
$("#toStart").addEventListener("click", () => player.seek(0));
$("#prevFrame").addEventListener("click", () => player.step(-1));
$("#nextFrame").addEventListener("click", () => player.step(1));
$("#masterVol").addEventListener("input", e => player.setMaster(+e.target.value));
$("#undo").addEventListener("click", () => undoRedo("undo"));
$("#redo").addEventListener("click", () => undoRedo("redo"));
function undoRedo(which) {
  const p = app.history[which](app.project);
  if (!p) return;
  app.project = p; if (app.sel && !findItem(p, app.sel)) app.sel = null;
  changed();
}
$("#projName").addEventListener("change", e => commit(p => { p.name = e.target.value.trim() || "Untitled Nightmare"; }, { keepFrame: true }));
$("#aspect").addEventListener("change", e => commit(p => { p.aspect = e.target.value; }));
$("#fit").addEventListener("change", e => commit(p => { p.fit = e.target.value; }));
$("#newProj").addEventListener("click", async () => {
  if (!confirm("Start a new, empty project? The current one is cleared (its clips stay on your computer).")) return;
  player.pause();
  app.history.push(app.project);
  app.project = newProject(); app.sel = null;
  for (const m of media.values()) if (m._url) URL.revokeObjectURL(m._url);
  media.clear(); await DB.clear("media");
  changed(); renderLibrary(); player.seek(0);
});

document.addEventListener("keydown", e => {
  if (e.target.matches("input, textarea, select")) return;
  const k = e.key.toLowerCase();
  if (k === " ") { e.preventDefault(); player.toggle(); }
  else if ((e.ctrlKey || e.metaKey) && k === "z") { e.preventDefault(); undoRedo(e.shiftKey ? "redo" : "undo"); }
  else if ((e.ctrlKey || e.metaKey) && k === "y") { e.preventDefault(); undoRedo("redo"); }
  else if (k === "s" && !e.ctrlKey && !e.metaKey) doSplit();
  else if (k === "delete" || k === "backspace") { e.preventDefault(); deleteSel(); }
  else if (k === "arrowleft") player.step(e.shiftKey ? -FPS : -1);
  else if (k === "arrowright") player.step(e.shiftKey ? FPS : 1);
  else if (k === "home") player.seek(0);
  else if (k === "end") player.seek(duration(app.project));
  else if (k === "escape") { app.sel = null; renderTimeline(); renderInspector(); }
});

// --------------------------------------------------------------------------------------------
// export
const modal = { el: $("#modal"), card: $("#modalCard"), open(html) { this.card.innerHTML = html; this.el.classList.add("on"); }, close() { this.el.classList.remove("on"); } };
modal.el.addEventListener("click", e => { if (e.target === modal.el && !exporting) modal.close(); });
let exporting = null;

$("#exportBtn").addEventListener("click", async () => {
  player.pause();
  const total = duration(app.project);
  if (!app.project.clips.length || total <= 0) return toast("Add some clips first.");
  const { w, h: hh } = outputSize(app.project, media);
  const codecs = await pickCodecs(w, hh);
  if (!codecs) return modal.open(`<h2>Can't export here</h2><p>This browser can't encode video. Use a recent Chrome or Edge on a computer.</p><div class="btnrow"><button onclick="document.getElementById('modal').classList.remove('on')">Close</button></div>`);
  const safe = (app.project.name || "frightcut").replace(/[^A-Za-z0-9 ._-]+/g, "").trim() || "frightcut";
  modal.open(`<h2>Export</h2>
    <div class="row"><label>Quality</label><select id="exQ"><option value="1">Full HD (${w}×${hh})</option><option value="0.6667">720p (faster, smaller)</option></select><span></span></div>
    <div class="note">${fmtTime(total)} long · ${codecs.video === "avc" ? "MP4 (H.264)" : codecs.ext.toUpperCase() + " (" + codecs.video.toUpperCase() + ")"} ${codecs.audio ? "with " + codecs.audio.toUpperCase() + " sound" : "(no sound encoder in this browser)"}.
    ${window.showSaveFilePicker ? "You'll pick where to save it, and it's written straight to disk as it renders." : "When it finishes you'll get a download button."}
    Keep this tab open while it works.</div>
    <div class="btnrow"><button id="exCancel">Cancel</button><button id="exGo" class="primary">Export</button></div>`);
  $("#exCancel").onclick = () => modal.close();
  $("#exGo").onclick = async () => {
    let handle = null;
    try { handle = await pickSaveFile(safe, codecs.ext); } catch (e) { return; }   // user cancelled the save dialog
    runExport(+$("#exQ").value, codecs, handle, safe);
  };
});

async function runExport(scale, codecs, handle, name) {
  const signal = { cancelled: false };
  exporting = signal;
  modal.open(`<h2>Rendering…</h2><div class="bar"><div id="exBar"></div></div><div class="note" id="exMsg">Starting the encoder…</div><div class="btnrow"><button id="exStop">Stop</button></div>`);
  $("#exStop").onclick = () => { signal.cancelled = true; $("#exMsg").textContent = "Stopping…"; };
  try {
    const res = await exportMovie(app, { scale, codecs, fileHandle: handle, signal, onProgress: p => {
      $("#exBar").style.width = (p.frac * 100).toFixed(1) + "%";
      $("#exMsg").textContent = `${Math.round(p.frac * 100)}% · frame ${p.frame} of ${p.frames} · ${p.speed.toFixed(2)}× real time · about ${fmtTime(p.eta, false)} left`;
    } });
    const url = URL.createObjectURL(res.saved ? res.file : res.blob);
    const sizeMb = ((res.saved ? res.file.size : res.blob.size) / 1048576).toFixed(1);
    modal.open(`<h2>It's alive</h2><div class="note">${res.w}×${res.h} · ${sizeMb} MB${res.saved ? " · saved to the file you picked" : ""}</div>
      <video src="${url}" controls playsinline></video>
      <div class="btnrow">${res.saved ? "" : `<a class="primary" href="${url}" download="${esc(name)}.${codecs.ext}" style="flex:1"><button class="primary" style="width:100%">⬇ Download</button></a>`}<button id="exDone">Close</button></div>`);
    $("#exDone").onclick = () => { modal.close(); };
  } catch (e) {
    console.error(e);
    modal.open(`<h2>${e.cancelled ? "Stopped" : "Export failed"}</h2><div class="note">${esc(e.cancelled ? "Nothing was saved." : e.message)}</div><div class="btnrow"><button onclick="document.getElementById('modal').classList.remove('on')">Close</button></div>`);
  } finally { exporting = null; }
}
window.addEventListener("beforeunload", e => { if (exporting) { e.preventDefault(); e.returnValue = ""; } });

// --------------------------------------------------------------------------------------------
// boot
async function boot() {
  await loadFonts();
  try {
    const saved = await DB.get("kv", "project");
    const rows = await DB.all("media");
    for (const r of rows || []) {
      const m = new MediaItem(r.meta.id, r.file);
      Object.assign(m, r.meta);
      media.set(m.id, m);
    }
    // re-read each file's decoder support in the background (thumbnails are already saved)
    for (const m of media.values()) probe(m, { thumbs: false }).then(() => { if (!player.playing) player.render(); }).catch(e => console.warn("re-probe failed", m.name, e));
    if (saved && saved.version === 1) app.project = Object.assign(newProject(), saved);
  } catch (e) { console.warn("restore failed", e); }
  renderLibrary(); changed({ keepFrame: true });
  const d = duration(app.project);
  if (d > 0) $("#zoomFit").click();
  player.seek(0);
}
boot();
