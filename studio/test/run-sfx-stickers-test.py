import sys, base64, os, subprocess, time
from playwright.sync_api import sync_playwright
STUDIO = '/home/user/vid-editor/studio'
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'out')
PORT = 8791
which = sys.argv[1:] or ['sfx', 'stickers']
srv = subprocess.Popen([sys.executable, '-m', 'http.server', str(PORT)], cwd=STUDIO, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(1)
rc = 0
try:
    with sync_playwright() as p:
        b = p.chromium.launch(executable_path='/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args=['--autoplay-policy=no-user-gesture-required'])
        for name in which:
            pg = b.new_page()
            pg.on('console', lambda m: print('console:', m.text) if m.type in ('error', 'warning') else None)
            pg.on('pageerror', lambda e: print('pageerror:', e))
            pg.goto(f'http://localhost:{PORT}/test/{name}-test.html')
            pg.wait_for_function('window.__done === true', timeout=600000)
            rep = pg.evaluate('window.__report')
            print('\n'.join(rep['lines']))
            for k, v in rep.get('exports', {}).items():
                for ext, data in v.items():
                    raw = base64.b64decode(data.split(',', 1)[1] if data.startswith('data:') else data)
                    path = (k if k.startswith('/') else os.path.join(OUT, k)) + '.' + ext
                    open(path, 'wb').write(raw); print('wrote', path)
            if rep['fails']: rc = 1
        b.close()
finally:
    srv.terminate()
sys.exit(rc)
