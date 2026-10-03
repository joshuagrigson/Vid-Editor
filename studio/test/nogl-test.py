"""FrightCut must still start, import clips and explain itself when the browser has no WebGL2."""
import asyncio, functools, http.server, os, sys, threading
from playwright.async_api import async_playwright
HERE = os.path.dirname(os.path.abspath(__file__)); STUDIO = os.path.dirname(HERE); OUT = os.path.join(HERE, "out")
PORT = 8793
h = functools.partial(http.server.SimpleHTTPRequestHandler, directory=STUDIO); h.log_message = lambda *a: None
srv = http.server.ThreadingHTTPServer(("127.0.0.1", PORT), h); threading.Thread(target=srv.serve_forever, daemon=True).start()
async def main():
    ok = True
    def check(c, m):
        nonlocal ok; print(("PASS " if c else "FAIL ") + m); ok = ok and bool(c)
    async with async_playwright() as p:
        b = await p.chromium.launch(executable_path="/opt/pw-browsers/chromium-1194/chrome-linux/chrome")
        page = await b.new_page(viewport={"width": 1500, "height": 900})
        await page.add_init_script("const g = HTMLCanvasElement.prototype.getContext; HTMLCanvasElement.prototype.getContext = function (t, o) { return t === 'webgl2' ? null : g.call(this, t, o); };")
        await page.goto(f"http://127.0.0.1:{PORT}/index.html")
        await page.wait_for_function("window.__frightcut", timeout=20000)
        await page.wait_for_timeout(800)
        check(await page.is_visible("#noGL"), "no-WebGL message shown in the preview")
        check(await page.evaluate("document.querySelectorAll('#panel .dropzone').length") == 1, "media panel drawn")
        check(await page.evaluate("document.querySelectorAll('#ruler .tick').length") > 0, "timeline ruler drawn")
        check(not await page.is_visible("#bootErr"), "no startup error box")
        await page.set_input_files("#fileIn", [os.path.join(OUT, "portrait.webm")])
        await page.wait_for_function("window.__frightcut.project.clips.length === 1", timeout=30000)
        check(True, "clip imported without WebGL")
        await page.screenshot(path=os.path.join(OUT, "nogl.png"))
        await page.evaluate("setTimeout(() => Promise.reject(new Error('test failure')), 0)")
        await page.wait_for_timeout(300)
        check("test failure" in (await page.inner_text("#bootErr")), "errors show on screen")
        await b.close()
    srv.shutdown(); print("RESULT:", "ALL PASS" if ok else "FAILURES"); return 0 if ok else 1
sys.exit(asyncio.run(main()))
