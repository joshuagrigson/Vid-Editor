// Getting clips out of GhostCut and other browser tabs.
//
// Browsers never hand a page a video from another site's tab: a drag from GhostCut carries only a clip id (or a
// blob: link to the finished movie), and the file itself sits in GhostCut's own storage. When FrightCut runs on
// GhostCut's site (ghostcut.onrender.com/studio/) it can read that storage and those links directly.

export const GHOSTCUT_HOME = "https://ghostcut.onrender.com";
export const STUDIO_ON_GHOSTCUT = GHOSTCUT_HOME + "/studio/";
export const onGhostCutSite = () => location.origin === GHOSTCUT_HOME;

// GhostCut keeps its clip list in IndexedDB "ghostcut", store "kv", key "clips": [{id, name, file, ...}].
// Opens without creating anything: if the database isn't there, this origin has no GhostCut clips.
export function ghostcutClips() {
  return new Promise(res => {
    let r;
    try { r = indexedDB.open("ghostcut"); } catch (_) { return res([]); }
    r.onupgradeneeded = () => { r.transaction.abort(); };   // didn't exist: don't create it
    r.onerror = () => res([]);
    r.onsuccess = () => {
      const db = r.result;
      if (!db.objectStoreNames.contains("kv")) { db.close(); return res([]); }
      const q = db.transaction("kv", "readonly").objectStore("kv").get("clips");
      q.onsuccess = () => { db.close(); res((q.result || []).filter(c => c && c.file instanceof Blob)); };
      q.onerror = () => { db.close(); res([]); };
    };
  });
}

const asFile = (blob, name) => blob instanceof File ? blob : new File([blob], name, { type: blob.type || "video/mp4" });

// Everything a drop could carry, turned into Files where possible.
// Returns { files, unresolved } where unresolved says what came in that couldn't be used.
export async function filesFromDrop(dt) {
  const files = [...(dt.files || [])];
  if (files.length) return { files, unresolved: null };
  const types = [...(dt.types || [])];
  const text = types.includes("text/plain") ? dt.getData("text/plain").trim() : "";
  const uris = (types.includes("text/uri-list") ? dt.getData("text/uri-list") : "").split(/\r?\n/).filter(u => u && !u.startsWith("#"));
  const html = types.includes("text/html") ? dt.getData("text/html") : "";
  const htmlSrc = [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map(m => m[1]);
  const out = [];

  // a GhostCut clip card: the drag carries the clip's id
  if (/^[a-z0-9]{6,12}$/i.test(text)) {
    const hit = (await ghostcutClips()).find(c => c.id === text);
    if (hit) out.push(asFile(hit.file, hit.name || "ghostcut-clip.mp4"));
  }
  // a video element or a link (GhostCut's finished movie, or any video link the browser lets us fetch)
  for (const u of [...uris, ...htmlSrc, ...(/^(blob:|https?:)/.test(text) ? [text] : [])]) {
    if (out.length) break;
    try {
      const r = await fetch(u);
      if (!r.ok) continue;
      const b = await r.blob();
      if (!/^(video|audio|image)\//.test(b.type) && !/\.(mp4|mov|webm|m4v|mkv|mp3|m4a|wav|png|jpe?g)(\?|$)/i.test(u)) continue;
      const name = decodeURIComponent((u.split(/[?#]/)[0].split("/").pop() || "").replace(/^[0-9a-f-]{36}$/i, "")) || "dropped-video." + (b.type.split("/")[1] || "mp4");
      out.push(asFile(b, name));
    } catch (_) { /* cross-site or revoked: can't be read from here */ }
  }
  if (out.length) return { files: out, unresolved: null };
  const fromGhostCut = (/^[a-z0-9]{6,12}$/i.test(text) && !uris.length) || [...uris, ...htmlSrc].some(u => u.includes("ghostcut"));
  return { files: [], unresolved: types.length ? { fromGhostCut, blob: [...uris, ...htmlSrc].some(u => u.startsWith("blob:")) } : null };
}
