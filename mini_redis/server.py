import json
import re
from http.server import ThreadingHTTPServer
from urllib.parse import unquote

from .http import JsonHandler
from .store import Store


_KEY_PREFIX = "/v1/keys/"
_BAD_ESCAPE = re.compile(r"%(?![0-9a-fA-F]{2})")
_MAX_BODY_BYTES = 1024 * 1024


def _reject_constant(token: str) -> None:
    raise ValueError(f"invalid JSON constant: {token}")


class KeyHandler(JsonHandler):
    def _key(self) -> str | None:
        if not self.path.startswith(_KEY_PREFIX):
            self.send_json(404, {"error": "route not found"})
            return None

        encoded = self.path[len(_KEY_PREFIX):]
        try:
            if (
                not encoded or not encoded.isascii()
                or any(char in encoded for char in "/?#") or _BAD_ESCAPE.search(encoded)
            ):
                raise ValueError
            return unquote(encoded, encoding="utf-8", errors="strict")
        except ValueError:
            self.send_json(400, {"error": "key must be one nonempty URL-encoded UTF-8 segment"})
            return None

    def do_GET(self) -> None:
        key = self._key()
        if key is None:
            return
        try:
            value = self.server.store.get(key)
        except KeyError:
            self.send_json(404, {"error": "key not found"})
            return
        self.send_json(200, {"value": value})

    def do_PUT(self) -> None:
        key = self._key()
        if key is None:
            return
        if self.headers.get("Transfer-Encoding") is not None:
            self.send_json(400, {"error": "Transfer-Encoding is unsupported"})
            return
        lengths = self.headers.get_all("Content-Length", [])
        if not lengths:
            self.send_json(411, {"error": "Content-Length is required"})
            return
        try:
            length_header = lengths[0]
            if len(lengths) != 1 or not length_header.isascii() or not length_header.isdecimal():
                raise ValueError
            length = int(length_header)
        except ValueError:
            self.send_json(400, {"error": "invalid Content-Length"})
            return
        if length > _MAX_BODY_BYTES:
            self.send_json(413, {"error": "JSON body exceeds 1 MiB"})
            return
        if self.headers.get_content_type() != "application/json":
            self.send_json(415, {"error": "Content-Type must be application/json"})
            return

        try:
            body = self.rfile.read(length)
            if len(body) != length:
                raise ValueError
            payload = json.loads(body.decode("utf-8"), parse_constant=_reject_constant)
            if not isinstance(payload, dict) or "value" not in payload:
                raise ValueError
            # Validate the exact shape GET will serialize, including nested numbers.
            json.dumps({"value": payload["value"]}, allow_nan=False)
        except (ValueError, RecursionError):
            self.send_json(400, {"error": "body must be a valid JSON object containing value"})
            return

        try:
            created = self.server.store.set(key, payload["value"], payload.get("ttl_seconds"))
        except ValueError as exc:
            self.send_json(400, {"error": str(exc)})
            return
        self.send_empty(201 if created else 204)

    def do_DELETE(self) -> None:
        key = self._key()
        if key is None:
            return
        if self.server.store.delete(key):
            self.send_empty(204)
        else:
            self.send_json(404, {"error": "key not found"})


class MiniRedisServer(ThreadingHTTPServer):
    def __init__(self, address: tuple[str, int], store: Store | None = None) -> None:
        self.store = Store() if store is None else store
        super().__init__(address, KeyHandler)
