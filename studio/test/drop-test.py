"""Drops from GhostCut into FrightCut, the way Joshua tried it.

Serves the whole repo, so GhostCut (/) and FrightCut (/studio/) share an origin, like ghostcut.onrender.com/studio/.
Seeds GhostCut's IndexedDB exactly as GhostCut saves clips, then fires the drops a drag from the GhostCut tab
produces: a clip card (text/plain = clip id), the finished movie (text/uri-list = blob: URL), and junk.
"""
import asyncio, functools, http.server, os, subprocess, sys, threading
from playwright.async_api import async_playwright

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(HERE))
OUT = os.path.join(HERE, "out"); os.makedirs(OUT, exist_ok=True)
PORT = 8792
CLIP = os.path.join(OUT, "gc-clip.webm")
if not os.path.exists(CLIP):
    subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc2=s=540x960:r=30:d=3", "-f", "lavfi", "-i", "sine=d=3",
                    "-c:v", "libvpx-vp9", "-deadline", "realtime", "-cpu-used", "8", "-c:a", "libopus", "-shortest", "-y", CLIP], check=True)
os.makedirs(os.path.join(REPO, "studio/test/out"), exist_ok=True)

h = functools.partial(http.server.SimpleHTTPRequestHandler, directory=REPO)
h.log_message = lambda *a: None
srv = http.server.ThreadingHTTPServer(("127.0.0.1", PORT), h)
threading.Thread(target=srv.serve_forever, daemon=True).start()

DROP = """async ({types}) => {
  const dt = new DataTransfer();
  for (const [k, v] of Object.entries(types)) dt.setData(k, v);
  document.querySelector('#viewer').dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
}"""

async def main():
    ok = True
    def check(c, m):
        nonlocal ok; print(("PASS " if c else "FAIL ") + m); ok = ok and bool(c)
    async with async_playwright() as p:
        b = await p.chromium.launch(executable_path="/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
                                    args=["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"])
        page = await b.new_page()
        errs = []
        page.on("pageerror", lambda e: errs.append(str(e)))
        await page.goto(f"http://127.0.0.1:{PORT}/studio/index.html")
        await page.wait_for_function("window.__frightcut")
        await page.evaluate("indexedDB.deleteDatabase('frightcut')")
        # seed GhostCut's storage the way GhostCut writes it
        await page.evaluate("""async () => {
          const blob = await (await fetch('/studio/test/out/gc-clip.webm')).blob();
          const file = new File([blob], 'IMG_0420.webm', { type: 'video/webm' });
          await new Promise((res, rej) => { const r = indexedDB.open('ghostcut', 1);
            r.onupgradeneeded = () => { r.result.createObjectStore('kv'); r.result.createObjectStore('seg'); };
            r.onsuccess = () => { const tx = r.result.transaction('kv', 'readwrite');
              tx.objectStore('kv').put([{ id: 'k3j9x2ab', file, name: file.name, meta: {}, start: 0, end: 0 }], 'clips');
              tx.oncomplete = () => { r.result.close(); res(); }; tx.onerror = rej; }; r.onerror = rej; });
        }""")
        await page.reload(); await page.wait_for_function("window.__frightcut")

        # 1. a clip card dragged from the GhostCut tab
        await page.evaluate(DROP, {"types": {"text/plain": "k3j9x2ab"}})
        await page.wait_for_function("window.__frightcut.project.clips.length === 1", timeout=30000)
        name = await page.evaluate("[...window.__frightcut.media.values()][0].name")
        check(name == "IMG_0420.webm", f"GhostCut clip card drop imported {name}")

        # 2. the finished movie (video element / Save link) dragged from the GhostCut tab: a blob: URL
        await page.evaluate("""() => fetch('/studio/test/out/gc-clip.webm').then(r => r.blob()).then(b => { window.__movieUrl = URL.createObjectURL(new Blob([b], {type: 'video/webm'})); })""")
        url = await page.evaluate("window.__movieUrl")
        await page.evaluate(DROP, {"types": {"text/uri-list": url, "text/html": f'<video src="{url}"></video>'}})
        await page.wait_for_function("window.__frightcut.project.clips.length === 2", timeout=30000)
        check(True, "GhostCut movie (blob: link) drop imported")

        # 3. something unusable: explained, not ignored
        await page.evaluate(DROP, {"types": {"text/plain": "zz99zz99"}})
        await page.wait_for_selector("#modal.on", timeout=5000)
        head = await page.inner_text("#modalCard h2")
        check("grab" in head.lower(), f"unusable drop explains itself: '{head}'")
        await page.screenshot(path=os.path.join(OUT, "drop-help.png"))
        await page.click("#dhClose")

        # 4. the GhostCut button (everything already imported)
        await page.click('#tabs button[data-tab="media"]')
        await page.click("text=Bring in my GhostCut clips")
        await page.wait_for_timeout(500)
        t = await page.inner_text("#toast")
        check("already here" in t, f"GhostCut button: '{t}'")

        # 5. drag-over shows the overlay
        await page.evaluate("""() => { const dt = new DataTransfer(); dt.setData('text/plain', 'x'); document.body.dispatchEvent(new DragEvent('dragenter', { dataTransfer: dt, bubbles: true, cancelable: true })); }""")
        vis = await page.evaluate("getComputedStyle(document.querySelector('#dropOverlay')).display")
        check(vis == "flex", "drop overlay shows while dragging")
        await page.screenshot(path=os.path.join(OUT, "drop-overlay.png"))
        check(not errs, f"no page errors {errs[:3]}")
        await b.close()
    srv.shutdown()
    print("RESULT:", "ALL PASS" if ok else "FAILURES")
    return 0 if ok else 1

sys.exit(asyncio.run(main()))
