// One-click scares: each drops several timed pieces (picture effects, sounds, spooks, text) at the playhead.
// Pieces are looked up by keyword so the recipes survive renamed effects; anything missing is skipped.
import { EFFECTS } from "./effects.js";
import { SFX } from "./sfx.js";
import { STICKERS } from "./stickers.js";

const find = (list, keys) => {
  for (const k of keys) { const hit = list.find(x => x.id === k); if (hit) return hit.id; }
  for (const k of keys) { const hit = list.find(x => x.id.includes(k) || x.name.toLowerCase().includes(k)); if (hit) return hit.id; }
  return null;
};
const fx = (keys, start, dur, params) => { const type = find(EFFECTS, keys); return type ? [{ type, start, dur, ...(params ? { params } : {}) }] : []; };
const snd = (keys, start, gain = 1, dur) => { const s = find(SFX, keys); const def = SFX.find(x => x.id === s); return s ? [{ ref: s, start, gain, dur: dur ?? def?.dur ?? 2 }] : []; };
const spook = (keys, start, dur, props) => { const id = find(STICKERS, keys); const def = STICKERS.find(x => x.id === id); return id ? [{ kind: "sticker", start, dur, props: { sticker: id, x: 0.5, y: 0.5, scale: 0.5, opacity: 0.95, move: "none", aspect: def?.aspect || 1, flip: false, seed: Math.random(), ...props } }] : []; };
const text = (t, style, start, dur, extra = {}) => [{ kind: "text", start, dur, props: { text: t, style, seed: Math.random(), ...extra } }];

export const SCARES = [
  {
    id: "jump", icon: "😱", name: "Jump scare", desc: "Silence, then a face, a flash, a shaking zoom and a screaming stinger.",
    build: t => ({
      fx: [...fx(["jump-scare", "punch", "scare"], t, 1.0), ...fx(["whiteout", "flash"], t, 0.12)],
      sounds: [...snd(["jumpscare"], t), ...snd(["scream_f"], t + 0.05, 0.7), ...snd(["tinnitus"], t + 0.9, 0.5)],
      overlays: [...spook(["demon_face", "skull"], t, 0.45, { scale: 0.95, move: "flash" })],
    }),
  },
  {
    id: "behind", icon: "👤", name: "Something behind you", desc: "A shadow figure flickers in the background for two seconds, with a low hum and a whisper.",
    build: t => ({
      fx: [...fx(["dark-presence", "vignette"], t, 2.4)],
      sounds: [...snd(["whisper"], t + 0.3, 0.8), ...snd(["drone_swell"], t, 0.7)],
      overlays: [...spook(["shadow_figure"], t, 2.2, { x: 0.78, y: 0.55, scale: 0.7, opacity: 0.75, move: "fade-flicker" })],
    }),
  },
  {
    id: "lightsout", icon: "💡", name: "Lights out", desc: "Lights flicker, the power dies to black, and something knocks in the dark.",
    build: t => ({
      fx: [...fx(["flicker-lights", "flicker"], t, 1.2), ...fx(["blackout"], t + 1.2, 1.6)],
      sounds: [...snd(["power_cut", "elec_buzz"], t + 1.0), ...snd(["knock"], t + 1.7)],
    }),
  },
  {
    id: "poltergeist", icon: "🪑", name: "Poltergeist", desc: "The camera gets shoved around while chains rattle and a door slams.",
    build: t => ({
      fx: [...fx(["poltergeist", "shake"], t, 2.2)],
      sounds: [...snd(["chain"], t), ...snd(["door-slam", "slam"], t + 1.4)],
    }),
  },
  {
    id: "possession", icon: "😈", name: "Possession", desc: "The picture turns red and inverted in pulses under a demonic growl.",
    build: t => ({
      fx: [...fx(["possessed"], t, 3), ...fx(["demon-glow"], t, 3)],
      sounds: [...snd(["growl"], t), ...snd(["demon_laugh"], t + 1.6, 0.8)],
      overlays: [...text("LET ME IN", "glitch", t + 1.4, 0.8)],
    }),
  },
  {
    id: "ghostpass", icon: "👻", name: "Ghost walks past", desc: "A pale figure drifts across the frame with an echo trail and a moan.",
    build: t => ({
      fx: [...fx(["spirit-trails", "trails", "ghost-echo", "echo"], t, 3)],
      sounds: [...snd(["ghost-moan", "moan"], t, 0.8)],
      overlays: [...spook(["ghost_girl", "sheet_ghost"], t, 3, { y: 0.55, scale: 0.7, opacity: 0.55, move: "drift-left" })],
    }),
  },
  {
    id: "glitch", icon: "📺", name: "Signal attack", desc: "The tape tears apart into glitches and static, then snaps back.",
    build: t => ({
      fx: [...fx(["datamosh", "block-glitch", "digital-glitch", "glitch"], t, 1.4), ...fx(["rgb-split"], t, 1.4), ...fx(["no-signal", "tv-static"], t + 1.4, 0.5)],
      sounds: [...snd(["glitch"], t), ...snd(["tv_static"], t + 1.4)],
    }),
  },
  {
    id: "lightning", icon: "⚡", name: "Lightning strike", desc: "A blue-white flash, a silhouette in the window for one frame, then thunder.",
    build: t => ({
      fx: [...fx(["lightning"], t, 0.8)],
      sounds: [...snd(["thunder"], t + 0.35)],
      overlays: [...spook(["shadow_figure"], t + 0.05, 0.12, { x: 0.3, scale: 0.6, opacity: 0.9, move: "none" })],
    }),
  },
  {
    id: "evp", icon: "📻", name: "EVP moment", desc: "Spirit-box sweep, a ghostly voice, and \"Did you hear that?\" on screen.",
    build: t => ({
      fx: [...fx(["spirit-box", "static"], t, 2.2, null)],
      sounds: [...snd(["spirit-box", "radio"], t, 0.8), ...snd(["evp"], t + 0.8)],
      overlays: [...text("Did you hear that?", "subtitle", t + 2.2, 2.2)],
    }),
  },
  {
    id: "run", icon: "🏃", name: "RUN!", desc: "Heartbeat speeds up, the camera shakes and blurs, footsteps pound.",
    build: t => ({
      fx: [...fx(["handheld-shake", "shake"], t, 3, { amt: 1 }), ...fx(["radial-zoom-blur", "zoom-blur", "motion-blur"], t, 3)],
      sounds: [...snd(["heartbeat"], t), ...snd(["footsteps"], t + 0.4)],
      overlays: [...text("RUN", "scrawl", t + 0.2, 1.2)],
    }),
  },
  {
    id: "mirror", icon: "🪞", name: "Wrong reflection", desc: "The world flips, freezes for a beat, and a figure is standing there.",
    build: t => ({
      fx: [...fx(["mirror"], t, 2), ...fx(["freeze-stutter", "time-slip"], t + 0.6, 0.6)],
      sounds: [...snd(["string_stab"], t + 0.6)],
      overlays: [...spook(["ghost_girl", "shadow_figure"], t + 0.6, 0.6, { x: 0.65, scale: 0.6, opacity: 0.8, move: "none" })],
    }),
  },
  {
    id: "crawl", icon: "🕷️", name: "Crawlers", desc: "Spiders scuttle across the lens while the picture blurs.",
    build: t => ({
      fx: [...fx(["dream-blur", "blur"], t, 2.5, { amt: 0.4 })],
      sounds: [...snd(["hiss"], t, 0.7)],
      overlays: [...spook(["spider"], t, 2.5, { x: 0.3, y: 0.3, scale: 0.25, move: "drift-right" }), ...spook(["spider"], t + 0.4, 2.1, { x: 0.7, y: 0.7, scale: 0.18, move: "drift-left" })],
    }),
  },
  {
    id: "redalert", icon: "🚨", name: "Blood moon", desc: "Everything turns blood red and the walls start to breathe.",
    build: t => ({
      fx: [...fx(["red-keep"], t, 4), ...fx(["breathing-walls", "breathe", "bulge"], t, 4)],
      sounds: [...snd(["heartbeat"], t, 0.8), ...snd(["riser"], t + 1)],
    }),
  },
  {
    id: "tapeend", icon: "📼", name: "Tape ends", desc: "The camera powers off to a line, static, then \"FOOTAGE ENDS\".",
    build: t => ({
      fx: [...fx(["no-signal"], t, 0.8), ...fx(["blackout"], t + 0.8, 3)],
      sounds: [...snd(["vhs_eject"], t), ...snd(["tv_static"], t + 0.6, 0.6)],
      overlays: [...text("FOOTAGE ENDS", "typewriter", t + 1.2, 2.6)],
    }),
  },
];
