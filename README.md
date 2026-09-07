# GhostCut

Splice a pile of short iPhone clips into one long, polished, *Paranormal
Activity*-style found-footage horror movie. Made for a kid's home-movie
project: she shoots the scary bits around the house, sends them over, you drop
them into GhostCut, press Render, and out comes a movie with titles, night
cards, a camcorder look, sound design and a jump scare.

## Two ways to run it

**In the browser, nothing to install:** <https://ghostcut.onrender.com>

The page does all the video work inside your browser with ffmpeg compiled to
WebAssembly (`index.html` + `app.js`). Clips never leave the computer. It
builds the movie the same way the desktop version does, just slower: budget
roughly a minute of rendering per 20 seconds of iPhone footage on a laptop,
more for 4K or HDR. Use a laptop or desktop with Chrome, Edge or Safari, keep
the tab open while it renders, and press *Save the movie* when it finishes.
(Render redeploys the site from `main` on every push; the GitHub Pages
workflow in `.github/workflows` serves the same files at
<https://joshuagrigson.github.io/Vid-Editor/> once Pages is switched on in
the repo settings.)

The browser edition saves your clips and every finished piece of the render in
the browser's storage, so if the engine stalls (it occasionally deadlocks in
WebAssembly) the page reloads itself and carries on from the last finished
piece. Long clips are rendered in one-minute pieces for the same reason. A
closed tab is also fine: reopen the page and it resumes.

**On your computer, fastest:** download the ZIP
(<https://github.com/joshuagrigson/Vid-Editor/archive/refs/heads/main.zip>),
unzip it, then double-click **Start GhostCut.bat** (Windows) or **Start
GhostCut.command** (Mac). The first run installs two helper packages (a
bundled ffmpeg and Pillow) and takes a minute; after that it opens
<http://localhost:4322>. Needs Python 3.9 or newer. Renders several times
faster than the browser version, never deadlocks, and keeps your project
between sessions. For a movie with more than ten minutes of footage this is
the one to use.

> Mac: if double-clicking the `.command` file complains about permissions,
> run `chmod +x "Start GhostCut.command"` once in Terminal.

## Use it

1. **Drop the clips in** (or type a folder path such as your Downloads and
   click *Import folder*). Clips are copied into `workspace/clips`; the
   originals are never touched. iPhone `.MOV`, `.MP4`, portrait, landscape,
   4K, 60 fps and HDR/Dolby Vision are all fine; HDR is tone-mapped so it
   doesn't come out washed out.
2. **Put them in order** by dragging, or with the arrows. Imports are sorted
   by the time the phone recorded them.
3. **Pick the look.** Night Vision, Security Cam, VHS, Cinematic Dark, or
   Clean. Any single clip can override the movie look.
4. **Optional per clip:** trim start/end, and tick *Jump scare at* to drop a
   zoom-shake-strobe hit with a bass stinger at that second. *Preview* renders
   six seconds of that clip with the current look so you can tune it.
5. **Fill in the movie:** title, whose residence the footage was "recovered"
   from, closing text, credits. Choose whether every clip is its own
   "NIGHT #n" (classic), one long night, or mark nights yourself.
6. **Render.** Progress shows in the bar; the finished `.mp4` plays right in
   the page and lands in `workspace/output/`.

## Sound

The **Sound** panel picks the bed that plays under the whole movie or
trailer. Six are synthesized on the spot, so nothing is licensed or
downloaded: Dread Drone, Heartbeat, Wind & Whispers, Music Box, Electrical
Hum, Silence. **Your own sound** takes an mp3, m4a or wav and loops or trims
it to fit, faded in and out. The volume slider applies to whichever bed is
chosen, and **Listen to 6 seconds** auditions it before a render.

## Create trailer

The **Create trailer** button (both editions) cuts a 45, 60 or 90 second
trailer from the same clips. It listens to every clip for the loudest and
most sudden sounds, screams, bangs, doors, and builds around them: black,
tagline slam, a few quiet setup shots fading through black, a second tagline,
escalating hits separated by TV static with a sub-bass boom on each, a third
tagline, a fast montage of sub-second shots with white flashes under a rising
shriek, silence, the single scariest moment in slow motion with the jump-scare
treatment, static, and the title slamming in with a boom, then "COMING SOON",
then one last inverted frame of the scare. Trailers render in a fraction of
the movie's time because only the chosen moments are processed.

Controls in the Trailer panel:

- **Pace**: Slow burn, Classic or Relentless. Changes shot lengths and how
  many shots the montage gets.
- **Which moments**: Auto, or "My jump-scare marks first" so a moment you
  marked on a clip becomes the finale and other marks feed the escalation.
- **In trailer** on each clip leaves footage out of the trailer without
  removing it from the movie.
- Toggles: sub-bass booms, TV static, white flashes, camera shake on hits,
  slow-motion finale, post-title jump, black & white.
- **Taglines** (four, in order), a **date line** under the title, and
  **flash words** that strobe for a few frames between montage shots.
- **Title font** (in the Look panel) applies to every card: Classic serif,
  Typewriter, or Bold poster.

## What it does to the footage

- Opening: black, typewriter disclaimer with key clicks, title card with slow
  fade and flicker, hard cut to black.
- Night cards ("NIGHT #3 — September 7, 2026") with a fake camcorder clock
  that advances realistically through the night.
- Looks: green IR night vision with blinking REC and clock; cold 15 fps
  security cam with scanlines and CAM 01 overlay; warm VHS with colour bleed,
  jitter, PLAY/SP overlay; teal-shadow cinematic grade with widescreen bars.
- Transitions: TV-static bursts with white-noise hits, fade through black, or
  hard cuts.
- Sound: every clip gets a subtle compressor so room noise and footsteps come
  forward, and the whole movie sits on a low synthesized dread drone (volume
  is a slider). No downloaded audio, everything is generated.
- Jump scare: audio ducks for 0.8 s, then a sub-bass hit, a rising shriek,
  a noise burst, and a sudden zoom with shake, negative flashes and grain.
- Output: 1080p (or 1080×1920 if most clips are portrait), H.264 at up to
  14 Mb/s, AAC stereo, `faststart` so it streams and AirDrops cleanly.

## Command line

```bash
python ghostcut.py render ~/Downloads/scary-clips --title "PARANORMAL ACTIVITY" \
    --family "the Grigson" --style night --scare 3:4.5 \
    --credits "Directed by Scarlet" "Camera by Scarlet" --out movie.mp4
```

`--scare 3:4.5` puts the jump scare 4.5 seconds into clip 3. `--style` is one
of `night`, `seccam`, `vhs`, `cinematic`, `clean`. `--nights` is `per_clip`,
`single` or `manual`. `--no-clock` and `--no-title` switch those off.

## Where things live

```
vid-editor/
├── index.html + app.js     browser edition (ffmpeg.wasm), deployed to GitHub Pages
├── core/ vendor/           ffmpeg.wasm multi-core build and the @ffmpeg client, vendored
├── coi-serviceworker.min.js  gives the page cross-origin isolation so the multi-core engine can run
├── ghostcut.py             desktop edition: engine + local web server (one file)
├── ui.html                 the browser UI
├── Start GhostCut.bat      Windows launcher
├── Start GhostCut.command  Mac launcher
└── workspace/              created on first run, ignored by git
    ├── clips/              your imported footage
    ├── thumbs/  previews/  what the UI shows
    ├── build/              per-segment renders + ffmpeg logs (debugging)
    ├── output/             finished movies
    └── archive/            old projects after "Start fresh"
```

If a render fails, the exact ffmpeg command and its error are shown in the
page and saved in `workspace/build/<segment>.log`.
