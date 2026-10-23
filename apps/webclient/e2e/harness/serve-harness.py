"""Serve this checkout's browser fixtures on an owned loopback listener."""

from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


directory = Path(__file__).resolve().parent
handler = partial(SimpleHTTPRequestHandler, directory=str(directory))
with ThreadingHTTPServer(("127.0.0.1", 0), handler) as server:
    print(f"RECUED_HARNESS_READY http://127.0.0.1:{server.server_port}", flush=True)
    server.serve_forever()
