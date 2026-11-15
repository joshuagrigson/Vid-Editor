// FrightCut — photoreal apparitions.
// Rendered locally on MARK-1 (Z-Image Turbo in ComfyUI, $0), cut out to transparent PNGs in
// assets/apparitions/. Ghosts were shot on black and keyed from brightness plus a segmentation matte;
// shadow figures were shot on white and keyed from darkness, so each one sits on footage the way it
// looked in the render. They read best on dim footage, like the real thing.

export const APPARITIONS = [
  { id: "real_face",    name: "Screaming Ghost",    aspect: 1.0,    still: true,  desc: "A corpse-pale face screaming at the lens. Made for jump scares." },
  { id: "real_girl",    name: "The Girl",           aspect: 0.3289, desc: "A girl in a white nightgown, wet hair hanging over her face." },
  { id: "real_widow",   name: "The Widow",          aspect: 0.3511, desc: "An old woman in black mourning dress, hands folded, staring." },
  { id: "real_shroud",  name: "The Shrouded Man",   aspect: 0.3333, desc: "A tall, starved figure wrapped in a grave shroud." },
  { id: "real_crawler", name: "The Crawler",        aspect: 1.4209, desc: "Something pale crawling along the floor toward the camera." },
  { id: "real_hand",    name: "Reaching Hand",      aspect: 0.695,  still: true, desc: "A grey hand reaching out of the dark at the lens." },
  { id: "real_eyes",    name: "Eyes in the Dark",   aspect: 0.8595, still: true, desc: "A face you can barely see, eyes catching the light. Best on dark footage." },
  { id: "real_mist",    name: "Ectoplasm",          aspect: 0.5622, desc: "A column of pale smoke that's almost a person." },
  { id: "real_hatman", light: true,  name: "The Hat Man",        aspect: 0.3478, desc: "A tall man-shaped shadow in a hat and long coat." },
  { id: "real_child", light: true,   name: "Shadow Child",       aspect: 0.4678, desc: "The shadow of a small child holding a teddy bear." },
  { id: "real_claw", light: true,    name: "Shadow Claw",        aspect: 2.1792, desc: "A long clawed hand's shadow reaching in from the side." },
];
export const APPARITION_IDS = new Set(APPARITIONS.map((a) => a.id));

const cache = new Map();   // id -> { img, ready, promise }

function entry(id) {
  let e = cache.get(id);
  if (e) return e;
  const img = new Image();
  img.decoding = "async";
  e = { img, ready: false };
  e.promise = new Promise((res) => {
    img.onload = () => { e.ready = true; res(img); };
    img.onerror = () => { console.warn("apparition failed to load", id); res(null); };
  });
  img.src = new URL(`../assets/apparitions/${id}.png`, import.meta.url).href;
  cache.set(id, e);
  return e;
}

/** the loaded image, or null while it's still loading (starts the load) */
export function apparitionImage(id) {
  if (!APPARITION_IDS.has(id)) return null;
  const e = entry(id);
  return e.ready ? e.img : null;
}

/** resolves when every listed apparition (default: all) is decoded */
export function loadApparitions(ids = [...APPARITION_IDS]) {
  return Promise.all(ids.filter((id) => APPARITION_IDS.has(id)).map((id) => entry(id).promise.then(async (img) => {
    try { await img?.decode?.(); } catch (_) {}
    return img;
  })));
}

/** apparition ids used by a project's overlays */
export function apparitionsIn(project) {
  return [...new Set((project.overlays || []).filter((o) => o.kind === "sticker" && APPARITION_IDS.has(o.props?.sticker)).map((o) => o.props.sticker))];
}
