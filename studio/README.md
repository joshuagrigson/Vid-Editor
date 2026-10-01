# FrightCut Studio

A horror-movie video editor that runs in the browser. Drop in phone clips, cut them on a timeline, pile on
effects, scares, text, camera HUDs, spooks and sound, and export an MP4. Nothing is uploaded: every frame is
decoded, composited and encoded on your own computer.

## What's in it

- **Timeline**: video, effects, overlays and sounds tracks. Drag to reorder, drag edges to trim, `S` splits,
  `Delete` removes, `Ctrl+Z` / `Ctrl+Shift+Z` undo and redo, `Space` plays, arrows step a frame.
- **103 effects** in 10 groups (camera, glitch, distort, colour, supernatural, light, film, blur and motion,
  frames, scares). Put them on a clip or drop them on the timeline for a set stretch. Hover any card to see it
  on the current frame.
- **17 looks**: finished styles built from several effects, for the whole movie or a single clip.
- **14 one-click scares**: a jump scare, "something behind you", lights out, possession, a ghost walking past
  and more. Each lands as separate pieces you can move.
- **16 cuts between clips**: static burst, blood wipe, eye blink, TV off/on, film burn and others.
- **Text**: 11 styles, from dripping blood to typewriter to trailer slams. **8 camera HUDs**: camcorder,
  night shot, security cam, VHS, ghost hunter, body cam, phone, evidence tape. The clock runs from a date
  you set.
- **38 spooks**: shadow figures, ghosts, eyes, spiders, handprints, "GET OUT" and more, each with a choice of
  movements.
- **52 sound effects and 10 music beds**, all synthesised in the browser, so nothing is licensed. You can also
  use your own music.
- **Per clip**: speed and slow motion, volume and mute, a creeping zoom, zoom/move/tilt.
- **Export**: H.264 MP4 using the computer's hardware encoder where the browser has one (VP9 WebM where it
  doesn't), 1080p or 720p. In Chrome and Edge it writes straight to the file you pick as it renders, so long
  movies don't fill memory.
- The project and its clips are kept in the browser, so a reload or a closed tab loses nothing.

Use a recent Chrome or Edge on a laptop or desktop.

## How it works

`js/media.js` reads files with [mediabunny](https://mediabunny.dev) (vendored in `vendor/`, MPL-2.0) and
WebCodecs. `js/compositor.js` is a WebGL2 pipeline: fit the frame, run the clip's effects, lay over text,
HUDs and spooks, run timed effects, then the cut. The preview (`js/player.js`) and the exporter
(`js/export.js`) both use it, so the export matches what you see. Effects are GLSL in `js/effects.js`, sounds
are Web Audio in `js/sfx.js`, spooks are Canvas 2D in `js/stickers.js`, and one-click scares are recipes in
`js/scares.js`.

## Tests

```
python3 studio/test/e2e.py              # import, every panel, play, reload, export, then ffprobe the result
python3 studio/test/run-effects-test.py # every effect/transition/look compiles, is identity at 0, no NaN
python3 studio/test/run-sfx-stickers-test.py
```
They need Playwright and the sandbox Chromium. That Chromium has no H.264, so the tests use VP9/WebM clips and
export VP9/Opus.
