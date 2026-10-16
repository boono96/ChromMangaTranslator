# Mock LibreTranslate for E2E testing. Mirrors the real endpoint's
# contract: POST /translate with {q, source, target, format, api_key},
# 403 without a key, 400 on unsupported languages.
import json
from http.server import BaseHTTPRequestHandler, HTTPServer

SOURCES = {'auto', 'ja', 'en', 'zh', 'zt'}
TARGETS = {'en', 'ja', 'zh', 'zt'}
API_KEY = 'testkey'


class Handler(BaseHTTPRequestHandler):
    def _send(self, code, payload):
        body = json.dumps(payload).encode()
        self.send_response(code)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == '/languages':
            langs = [{'code': c, 'name': c} for c in sorted(SOURCES | TARGETS - {'auto'})]
            self._send(200, langs)
        else:
            self._send(404, {'error': 'not found'})

    def do_POST(self):
        if self.path != '/translate':
            self._send(404, {'error': 'not found'})
            return
        length = int(self.headers.get('Content-Length', 0))
        try:
            data = json.loads(self.rfile.read(length) or b'{}')
        except Exception:
            self._send(400, {'error': 'invalid json'})
            return

        if data.get('api_key') != API_KEY:
            self._send(
                403,
                {'error': 'Visit https://portal.libretranslate.com to get an API key'},
            )
            return

        source = data.get('source', 'auto')
        target = data.get('target', 'en')
        if target not in TARGETS:
            self._send(400, {'error': f'{target} is not supported'})
            return
        if source != 'auto' and source not in SOURCES:
            self._send(400, {'error': f'{source} is not supported'})
            return

        q = data.get('q', '')
        self._send(200, {'translatedText': f'[{source}>{target}] {q}', 'detectedLanguage': {'confidence': 1.0, 'language': 'ja'}})

    def log_message(self, fmt, *args):
        print('[mock-lt]', fmt % args)


if __name__ == '__main__':
    print('[mock-lt] listening on 127.0.0.1:8124')
    HTTPServer(('127.0.0.1', 8124), Handler).serve_forever()
