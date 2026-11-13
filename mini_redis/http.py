import json
import logging
from http.server import BaseHTTPRequestHandler


class JsonHandler(BaseHTTPRequestHandler):
    timeout = 5

    def send_json(self, status: int, data: object) -> None:
        body = json.dumps(data, allow_nan=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def send_empty(self, status: int) -> None:
        self.send_response(status)
        if status != 204:
            self.send_header("Content-Length", "0")
        self.send_header("Cache-Control", "no-store")
        self.end_headers()

    def log_message(self, format: str, *args: object) -> None:
        logging.getLogger(__name__).info(format, *args)
