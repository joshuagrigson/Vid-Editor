"""End-to-end check of FrightCut Studio in headless Chromium.

Imports two clips, uses every library panel, plays, exports, and verifies the exported file with ffprobe.
Run from anywhere:  python3 studio/test/e2e.py [--out DIR]
Test clips are generated with ffmpeg (VP9/Opus: the test Chromium has no H.264).
"""
import asyncio, base64, json, os, subprocess, sys, threading, http.server, functools, time
from playwright.async_api import async_playwright

HERE = os.path.dirname(os.path.abspath(__file__))
STUDIO = os.path.dirname(HERE)
OUT = sys.argv[sys.argv.index("--out") + 1] if "--out" in sys.argv else os.path.join(HERE, "out")
os.makedirs(OUT, exist_ok=True)
PORT = 8791
CHROME = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome"


def make_clips():
    clips = []
    specs = [("portrait.webm", "testsrc2=s=720x1280:r=30:d=6", "sine=f=330:d=6"),
             ("landscape.webm", "mandelbrot=s=960x540:r=30", "anoisesrc=d=5:a=0.2")]
    for name, v, a in specs:
        p = os.path.join(OUT, name)
        if not os.path.exists(p):
            subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", v, "-f", "lavfi", "-i", a,
                            "-t", "6" if "portrait" in name else "5", "-c:v", "libvpx-vp9", "-b:v", "1.5M", "-deadline", "realtime",
                            "-cpu-used", "8", "-c:a", "libopus", "-shortest", "-y", p], check=True)
        clips.append(p)
    return clips


def serve():
    h = functools.partial(http.server.SimpleHTTPRequestHandler, directory=STUDIO)
    http.server.ThreadingHTTPServer.allow_reuse_address = True
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", PORT), h)
    srv.RequestHandlerClass.log_message = lambda *a: None
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv


async def main():
    clips = make_clips()
    srv = serve()
    errors, logs = [], []
    ok = True

    def check(cond, msg):
        nonlocal ok
        print(("PASS " if cond else "FAIL ") + msg)
        ok = ok and bool(cond)

    async with async_playwright() as p:
        b = await p.chromium.launch(executable_path=CHROME, args=["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader",
                                                                  "--ignore-gpu-blocklist", "--autoplay-policy=no-user-gesture-required"])
        ctx = await b.new_context(viewport={"width": 1500, "height": 950})
        page = await ctx.new_page()
        page.on("console", lambda m: (errors if m.type == "error" else logs).append(m.text))
        page.on("pageerror", lambda e: errors.append("pageerror: " + str(e)))
        await page.goto(f"http://127.0.0.1:{PORT}/index.html")
        await page.wait_for_function("window.__frightcut && document.fonts.status === 'loaded'", timeout=30000)
        # fresh state
        await page.evaluate("indexedDB.deleteDatabase('frightcut')")
        await page.reload()
        await page.wait_for_function("window.__frightcut", timeout=30000)
        await page.screenshot(path=os.path.join(OUT, "01-empty.png"))

        await page.set_input_files("#fileIn", clips)
        await page.wait_for_function("window.__frightcut.project.clips.length === 2", timeout=60000)
        await page.wait_for_timeout(800)
        info = await page.evaluate("[...window.__frightcut.media.values()].map(m => ({name: m.name, w: m.width, h: m.height, d: m.duration, dec: m.canDecode, aud: m.hasAudio, thumbs: m.thumbs.length}))")
        print(json.dumps(info))
        check(all(m["w"] > 0 and m["d"] > 4 and m["thumbs"] > 0 for m in info), "clips probed with size, duration, thumbnails")
        await page.screenshot(path=os.path.join(OUT, "02-imported.png"))

        # Looks: put the first look on the whole movie
        await page.click('#tabs button[data-tab="looks"]')
        await page.click('#panel .grid .item >> nth=0 >> [data-a="movie"]')
        # Effects: add one to the clip, one timed
        await page.click('#tabs button[data-tab="effects"]')
        n_fx = await page.evaluate("document.querySelectorAll('#panel .grid .item').length")
        check(n_fx >= 40, f"effects panel lists {n_fx} effects")
        await page.hover('#panel .grid .item >> nth=3')
        await page.wait_for_timeout(400)
        await page.screenshot(path=os.path.join(OUT, "03-hover-effect.png"))
        await page.click('#panel .grid .item >> nth=0 >> [data-a="clip"]')
        await page.click('#panel .grid .item >> nth=5 >> [data-a="tl"]')
        # Scares: drop every scare at different times
        await page.click('#tabs button[data-tab="scares"]')
        n_sc = await page.evaluate("document.querySelectorAll('#panel .grid .item').length")
        for i in range(n_sc):
            await page.evaluate(f"window.__frightcut.player.seek({0.4 + i * 0.7})")
            await page.click(f'#panel .grid .item >> nth={i} >> button')
        counts = await page.evaluate("(p => ({fx: p.fx.length, ov: p.overlays.length, snd: p.sounds.length}))(window.__frightcut.project)")
        print("after scares", counts)
        check(counts["fx"] >= n_sc and counts["snd"] >= n_sc, f"{n_sc} scares dropped pieces on the timeline")
        # Text + HUD + sticker + sound + transition
        await page.click('#tabs button[data-tab="text"]')
        await page.evaluate("window.__frightcut.player.seek(0.2)")
        await page.click('#panel .grid >> nth=0 >> .item >> nth=0 >> button')
        await page.click('#panel .grid >> nth=1 >> .item >> nth=0 >> [data-a="all"]')
        await page.click('#tabs button[data-tab="stickers"]')
        await page.click('#panel .grid .item >> nth=0 >> button')
        await page.click('#tabs button[data-tab="sounds"]')
        await page.select_option('#bedSel', index=1)
        await page.click('#panel .grid .item >> nth=0 >> [data-a="add"]')
        await page.click('#tabs button[data-tab="transitions"]')
        await page.click('#panel .grid .item >> nth=1 >> [data-a="all"]')
        tr = await page.evaluate("window.__frightcut.project.clips[1].transition")
        check(tr and tr.get("type"), f"transition set: {tr}")
        # select clip 1 and split it
        await page.evaluate("window.__frightcut.player.seek(2.0)")
        await page.keyboard.press("s")
        nclips = await page.evaluate("window.__frightcut.project.clips.length")
        check(nclips == 3, "split made 3 clips")
        await page.keyboard.press("Control+z")
        nclips = await page.evaluate("window.__frightcut.project.clips.length")
        check(nclips == 2, "undo restored 2 clips")
        await page.click("#zoomFit")
        await page.screenshot(path=os.path.join(OUT, "04-loaded-timeline.png"))

        # play 2.5 s
        await page.evaluate("window.__frightcut.player.seek(0)")
        await page.click("#play")
        await page.wait_for_timeout(2500)
        t = await page.evaluate("window.__frightcut.player.t")
        check(t > 1.0, f"playback advanced to {t:.2f}s")
        await page.screenshot(path=os.path.join(OUT, "05-playing.png"))
        await page.click("#play")
        for i, tt in enumerate([0.5, 1.6, 3.1, 4.4, 6.2, 8.5]):
            await page.evaluate(f"window.__frightcut.player.seek({tt})")
            await page.wait_for_timeout(500)
            await page.locator("#viewer").screenshot(path=os.path.join(OUT, f"06-frame-{i}.png"))

        # persistence: reload and confirm the project comes back
        before = await page.evaluate("JSON.stringify(window.__frightcut.project)")
        await page.wait_for_timeout(900)
        await page.reload()
        await page.wait_for_function("window.__frightcut && window.__frightcut.project.clips.length === 2", timeout=30000)
        after = await page.evaluate("JSON.stringify(window.__frightcut.project)")
        check(before == after, "project restored after reload")
        await page.wait_for_timeout(1500)

        # export (BufferTarget path: hide the save picker), 720p for speed
        await page.evaluate("window.showSaveFilePicker = undefined")
        await page.click("#exportBtn")
        await page.wait_for_selector("#exGo", timeout=10000)
        await page.select_option("#exQ", value="0.6667")
        t0 = time.time()
        await page.click("#exGo")
        await page.wait_for_function("document.querySelector('#modalCard h2') && /alive|failed|Stopped/i.test(document.querySelector('#modalCard h2').textContent)", timeout=600000)
        head = await page.inner_text("#modalCard h2")
        print("export:", head, await page.inner_text("#modalCard .note"), f"{time.time() - t0:.1f}s")
        check("alive" in head, "export finished")
        if "alive" in head:
            data = await page.evaluate("""async () => { const v = document.querySelector('#modalCard video'); const b = await (await fetch(v.src)).blob();
              const buf = new Uint8Array(await b.arrayBuffer()); let s = ''; for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000)); return btoa(s); }""")
            path = os.path.join(OUT, "export.webm")
            open(path, "wb").write(base64.b64decode(data))
            pr = json.loads(subprocess.run(["ffprobe", "-v", "error", "-show_entries", "stream=codec_type,codec_name,width,height,nb_read_frames:format=duration",
                                            "-count_frames", "-of", "json", path], capture_output=True, text=True).stdout)
            print(json.dumps(pr))
            streams = {s["codec_type"]: s for s in pr["streams"]}
            dur = float(pr["format"]["duration"])
            proj_dur = await page.evaluate("(() => { const p = window.__frightcut.project; let d = 0; for (const c of p.clips) d += (c.out - c.in) / (c.speed || 1); for (const x of [...p.fx, ...p.overlays]) d = Math.max(d, x.start + x.dur); return d; })()")
            check("video" in streams and "audio" in streams, "export has video and audio")
            check(abs(dur - proj_dur) < 0.6 or dur >= proj_dur - 0.6, f"export duration {dur:.2f}s vs timeline {proj_dur:.2f}s")
            vf = int(streams["video"].get("nb_read_frames", 0))
            check(abs(vf - round(proj_dur * 30)) <= 3, f"{vf} video frames for {proj_dur:.2f}s at 30fps")
            # grab a few frames for eyeballing
            for i, ss in enumerate([0.5, 2.0, 4.0, 6.5]):
                subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-ss", str(ss), "-i", path, "-frames:v", "1", "-y", os.path.join(OUT, f"07-export-{i}.png")])
            vol = subprocess.run(["ffmpeg", "-hide_banner", "-i", path, "-af", "volumedetect", "-vn", "-f", "null", "-"], capture_output=True, text=True).stderr
            mv = [l for l in vol.splitlines() if "mean_volume" in l or "max_volume" in l]
            print("\n".join(mv))
            check(mv and "-inf" not in mv[0], "export audio is not silent")
        await page.screenshot(path=os.path.join(OUT, "08-export-done.png"))
        await b.close()
    srv.shutdown()
    # Google Fonts is unreachable through the sandbox proxy (cert); fonts fall back, so ignore that noise
    real_errors = [e for e in errors if "favicon" not in e and "ERR_CERT_AUTHORITY_INVALID" not in e]
    print("console errors:", len(real_errors))
    for e in real_errors[:20]: print("  ", e[:300])
    check(not real_errors, "no console errors")
    print("RESULT:", "ALL PASS" if ok else "FAILURES")
    return 0 if ok else 1

sys.exit(asyncio.run(main()))
