#!/usr/bin/env python3
"""
マイトレードダッシュボード用のサーバー

- このフォルダ内の index.html / style.css / app.js を配信します（Safariのfile://制限を回避）
- 日本株・チャート用データの取得（Yahoo Financeの中継）を /api/jp-chart で行います
  （ブラウザから直接Yahoo Financeを呼ぶとCORSでブロックされるため、ここで代わりに取得します）
- 環境変数 APP_PASSWORD を設定すると、簡易的な合言葉ログインが有効になります
  （自宅のパソコンで使うだけなら設定不要。インターネットに公開するときに設定してください）

使い方（自分のパソコンで使う場合）:
  このファイルと同じフォルダにある start.command をダブルクリックしてください。
  （手動で実行する場合は、ターミナルで `python3 server.py` を実行）

同じWi-Fi内のスマホからアクセスする場合:
  パソコンとスマホを同じWi-Fiに繋いだ状態で、起動時にターミナルへ表示される
  「同じWi-Fi内のスマホからは」の行に出るアドレスをスマホのブラウザで開いてください。

クラウド（Renderなど）にデプロイする場合:
  環境変数 PORT はホスティング側が自動的に設定します。
  環境変数 APP_PASSWORD に好きな合言葉を設定してください。
"""

import json
import os
import socket
import urllib.request
import urllib.parse
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

PORT = int(os.environ.get('PORT', 8765))
HOST = '0.0.0.0'  # 同じWi-Fi内の他の端末や、クラウド上からもアクセスできるようにする
APP_PASSWORD = os.environ.get('APP_PASSWORD', '').strip()
IS_CLOUD = 'PORT' in os.environ  # Render等のホスティングサービスはPORTを自動設定する
DIRECTORY = os.path.dirname(os.path.abspath(__file__))


def get_lan_ip():
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(('8.8.8.8', 80))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except Exception:
        return None


LOGIN_PAGE = """<!DOCTYPE html>
<html lang="ja"><head><meta charset="UTF-8"><title>ログイン</title></head>
<body style="background:#0b1220;color:#e6edf3;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;">
  <form method="GET" action="/" style="background:#111a2c;border:1px solid #1f2b42;border-radius:12px;padding:28px;max-width:320px;width:100%;">
    <h2 style="margin-top:0;">マイトレードダッシュボード</h2>
    <p style="font-size:13px;color:rgba(230,237,243,0.6);">合言葉を入力してください</p>
    {error}
    <input type="password" name="pw" placeholder="合言葉" style="width:100%;padding:10px;border-radius:8px;border:1px solid #1f2b42;background:#0d1526;color:#e6edf3;box-sizing:border-box;">
    <button type="submit" style="width:100%;margin-top:12px;padding:10px;border:none;border-radius:8px;background:#2f6feb;color:#fff;font-weight:600;cursor:pointer;">入る</button>
  </form>
</body></html>"""


class Handler(BaseHTTPRequestHandler):
    def _send_json(self, obj, status=200):
        body = json.dumps(obj).encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _send_html(self, html, status=200, set_cookie=None):
        body = html.encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', 'text/html; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        if set_cookie:
            self.send_header('Set-Cookie', set_cookie)
        self.end_headers()
        self.wfile.write(body)

    def _is_authed(self):
        if not APP_PASSWORD:
            return True
        cookie = self.headers.get('Cookie', '')
        encoded = urllib.parse.quote(APP_PASSWORD, safe='')
        return f'auth={encoded}' in cookie

    def _serve_static(self, path):
        if path == '/':
            path = '/index.html'
        # 簡易的なパストラバーサル対策
        safe_path = os.path.normpath(path).lstrip('/').lstrip('.')
        file_path = os.path.join(DIRECTORY, safe_path)
        if not os.path.isfile(file_path):
            self.send_error(404, 'Not Found')
            return
        ctype = 'application/octet-stream'
        if path.endswith('.html'):
            ctype = 'text/html'
        elif path.endswith('.css'):
            ctype = 'text/css'
        elif path.endswith('.js'):
            ctype = 'application/javascript'
        with open(file_path, 'rb') as f:
            body = f.read()
        self.send_response(200)
        self.send_header('Content-Type', ctype + '; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        parsed = urlparse(self.path)

        # ---- 合言葉ログイン（APP_PASSWORDが設定されているときだけ有効） ----
        if not self._is_authed():
            qs = parse_qs(parsed.query)
            given = qs.get('pw', [''])[0]
            if given and given == APP_PASSWORD:
                # 302リダイレクトでcookieをセットしてトップへ
                # 日本語などの合言葉でもHTTPヘッダーに安全に載せられるようURLエンコードする
                encoded = urllib.parse.quote(APP_PASSWORD, safe='')
                self.send_response(302)
                self.send_header('Set-Cookie', f'auth={encoded}; Path=/; Max-Age=2592000; HttpOnly')
                self.send_header('Location', '/')
                self.end_headers()
                return
            error = '<p style="color:#f0616b;font-size:13px;">合言葉が違います</p>' if given else ''
            self._send_html(LOGIN_PAGE.format(error=error))
            return

        if parsed.path == '/api/jp-chart':
            qs = parse_qs(parsed.query)
            symbol = qs.get('symbol', [''])[0]
            rng = qs.get('range', ['3mo'])[0]
            interval = qs.get('interval', ['1d'])[0]
            if not symbol:
                self._send_json({'error': 'symbol is required'}, 400)
                return
            url = (
                'https://query1.finance.yahoo.com/v8/finance/chart/'
                f'{urllib.parse.quote(symbol)}?range={rng}&interval={interval}'
            )
            req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
            try:
                with urllib.request.urlopen(req, timeout=10) as resp:
                    data = resp.read()
                self.send_response(200)
                self.send_header('Content-Type', 'application/json; charset=utf-8')
                self.send_header('Content-Length', str(len(data)))
                self.end_headers()
                self.wfile.write(data)
            except Exception as e:
                self._send_json({'error': f'{e}'}, 502)
            return

        self._serve_static(parsed.path)

    def log_message(self, format, *args):
        pass  # ターミナルへのログ出力を抑制


if __name__ == '__main__':
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    local_url = f'http://localhost:{PORT}'
    lan_ip = get_lan_ip()
    print('=================================================')
    print(' マイトレードダッシュボード サーバーを起動しました')
    print(f' このパソコンでは {local_url} を開いてください')
    if lan_ip:
        print(f' 同じWi-Fi内のスマホからは http://{lan_ip}:{PORT} を開いてください')
    if APP_PASSWORD:
        print(' 合言葉ログインが有効になっています')
    print(' 終了するにはこのウィンドウで Ctrl + C を押してください')
    print('=================================================')
    if not IS_CLOUD:
        try:
            webbrowser.open(local_url)
        except Exception:
            pass
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print('\nサーバーを終了しました。')
