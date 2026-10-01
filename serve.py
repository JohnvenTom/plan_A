# serve.py — dev server that makes stale ES-module caches structurally
# impossible: every module URL gets a version query (?v=<mtime-hash>)
# injected on the fly — into the entry <script src> in index.html AND into
# every relative `from '...'` import of every served .js module. When any
# module file changes, the version changes, every URL changes, and the
# browser cannot reuse a single old cache entry.
# Rewritten responses carry a corrected Content-Length (the injected version
# strings grow the body; a stale length truncates the tail and would cut off
# the very script tag that boots the game).
#   usage:  python serve.py [port]      (default port 8421)
import functools
import hashlib
import http.server
import os
import re
import sys

IMPORT_RE = re.compile(r"(from\s+['\"])(\.\.?/[^'\"]+?\.js)(\?v=[0-9a-f]+)?(['\"])")
SCRIPT_RE = re.compile(r"(src=[\"'])(\.{0,2}/?js/[^\"']+?\.js)(\?v=[0-9a-f]+)?([\"'])")


def module_version():
    """Hash of every module file's mtime — the whole graph's version."""
    h = hashlib.sha1()
    for root, _, files in os.walk('.'):
        if 'node_modules' in root or '.git' in root:
            continue
        for f in files:
            if f.endswith(('.js', '.html', '.glb')):
                p = os.path.join(root, f)
                h.update(f'{p}:{int(os.path.getmtime(p))}'.encode())
    return h.hexdigest()[:10]


_VERSION = module_version()   # per server run; restart re-derives it

CTYPES = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
}


class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    # ---- version-injecting pipeline ----
    def _inject(self, text, is_html):
        v = _VERSION
        if is_html:
            return SCRIPT_RE.sub(lambda m: f'{m.group(1)}{m.group(2)}?v={v}{m.group(4)}', text)
        return IMPORT_RE.sub(lambda m: f'{m.group(1)}{m.group(2)}?v={v}{m.group(4)}', text)

    def do_GET(self):
        path = self.translate_path(self.path)
        if os.path.isdir(path):
            path = os.path.join(path, 'index.html')   # '/' → index.html, injected too
        if os.path.isfile(path) and path.endswith(('.js', '.html', '.mjs')):
            with open(path, 'rb') as f:
                text = f.read().decode('utf-8')
            is_html = path.endswith('.html')
            body = self._inject(text, is_html).encode('utf-8')
            self.send_response(200)
            self.send_header('Content-Type', CTYPES.get(path[path.rfind('.'):], 'application/octet-stream'))
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        super().do_GET()

    def end_headers(self):
        self.send_header('Cache-Control', 'no-cache, no-store, must-revalidate')
        self.send_header('Pragma', 'no-cache')
        self.send_header('Expires', '0')
        # belt & braces for anything cached before this server existed: an
        # HTML response tells the browser to drop the origin's whole cache
        base = self.path.split('?')[0].split('/')[-1]
        if base == '' or base.endswith('.html'):
            self.send_header('Clear-Site-Data', '"cache"')
        super().end_headers()

    def translate_path(self, path):
        path = path.split('?')[0]          # strip our own ?v= before serving
        return super().translate_path(path)

    def log_message(self, fmt, *args):
        sys.stderr.write('[%s] %s\n' % (self.address_string(), fmt % args))


if __name__ == '__main__':
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8421
    handler = functools.partial(NoCacheHandler, directory='.')
    server = http.server.HTTPServer(('', port), handler)
    print(f'Serving . at http://127.0.0.1:{port}  (graph version {_VERSION})')
    server.serve_forever()
