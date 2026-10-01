#!/usr/bin/env python3
"""Headless test for studio/js/effects.js.

Usage (from anywhere):
    python3 studio/test/run-effects-test.py [--sheets] [--timing] [--port N]

Serves studio/ over http, opens test/effects-test.html in headless Chromium
(SwiftShader WebGL2), runs every effect / transition / look at 360x640 and
640x360, and writes test/effects-sheet.png (contact sheet). Exit code 1 on failure.
"""
import argparse, base64, http.server, json, os, sys, threading, functools
from playwright.sync_api import sync_playwright

HERE = os.path.dirname(os.path.abspath(__file__))
STUDIO = os.path.dirname(HERE)
CHROME = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome'
ARGS = ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist',
        '--autoplay-policy=no-user-gesture-required']


def serve(port):
    class Quiet(http.server.SimpleHTTPRequestHandler):
        def log_message(self, *a, **k):
            pass
    handler = functools.partial(Quiet, directory=STUDIO)
    srv = http.server.ThreadingHTTPServer(('127.0.0.1', port), handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv


def save(dataurl, path):
    with open(path, 'wb') as f:
        f.write(base64.b64decode(dataurl.split(',', 1)[1]))
    print('wrote', path)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--port', type=int, default=0, help='0 = pick a free port')
    ap.add_argument('--sheets', action='store_true', help='also write extra sheets (video frames, transitions, looks)')
    ap.add_argument('--timing', action='store_true')
    ap.add_argument('--outdir', default=HERE)
    a = ap.parse_args()
    srv = serve(a.port)
    a.port = srv.server_address[1]
    failures = []
    with sync_playwright() as p:
        b = p.chromium.launch(executable_path=CHROME, args=ARGS)
        pg = b.new_page()
        pg.on('console', lambda m: print('[console]', m.text) if m.type in ('error', 'warning') and 'favicon' not in m.text and '404' not in m.text else None)
        pg.on('pageerror', lambda e: print('[pageerror]', e))
        pg.goto(f'http://127.0.0.1:{a.port}/test/effects-test.html')
        pg.wait_for_function('window.FXTestReady === true', timeout=60000)
        for W, H in [(360, 640), (640, 360)]:
            r = pg.evaluate(f'FXTest.runAll({W},{H})', )
            print(f"{W}x{H}: float={r['floatOK']} effects={len(r['effects'])} transitions={len(r['transitions'])} "
                  f"looks={len(r['looks'])} failures={len(r['failures'])}")
            for f in r['failures']:
                print('  FAIL', f)
            failures += r['failures']
            weak = sorted(r['effects'], key=lambda e: e.get('meanDiff', 0))[:6]
            print('  least-changing effects:', ', '.join(f"{e['id']}={e.get('meanDiff')}" for e in weak))
        save(pg.evaluate("FXTest.sheet({W:360,H:640,cols:12,thumb:0.4,title:'FrightCut effects (default params, 360x640 procedural)'})"),
             os.path.join(HERE, 'effects-sheet.png'))
        if a.sheets:
            save(pg.evaluate("FXTest.sheet({W:640,H:360,source:'proc',cols:8,thumb:0.4,title:'landscape'})"),
                 os.path.join(a.outdir, 'sheet-landscape.png'))
            save(pg.evaluate("FXTest.sheet({W:640,H:360,source:'proc',kind:'transitions',cols:8,thumb:0.3,title:'transitions'})"),
                 os.path.join(a.outdir, 'sheet-transitions.png'))
            save(pg.evaluate("FXTest.sheet({W:360,H:640,source:'proc',kind:'looks',cols:6,thumb:0.6,title:'looks'})"),
                 os.path.join(a.outdir, 'sheet-looks.png'))
        if a.timing:
            t = pg.evaluate('FXTest.timeAll(540,960,3)')
            res = sorted(t['res'], key=lambda x: -x['ms'])
            print(f"timing @540x960 (SwiftShader, CPU): passthrough {t['passthroughMs']} ms; slowest:",
                  ', '.join(f"{x['id']} {x['ms']}" for x in res[:10]))
            print('  median', sorted(x['ms'] for x in res)[len(res) // 2], 'ms')
        b.close()
    srv.shutdown()
    print('RESULT:', 'PASS' if not failures else f'FAIL ({len(failures)} failures)')
    sys.exit(1 if failures else 0)


if __name__ == '__main__':
    main()
