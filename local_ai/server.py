"""Loopback-only companion, not an Internet-facing web server."""

import argparse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import socket
import threading

from local_ai.runtime import MODEL_ID, ModelLease, RequestError, Runtime, TransformersBackend, prepare_environment


MAX_BODY = 16_384


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate key")
        result[key] = value
    return result


class Server(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = False
    request_queue_size = 4

    def __init__(self, port, runtime):
        self.runtime = runtime
        self.slots = threading.BoundedSemaphore(4)
        super().__init__(("127.0.0.1", port), Handler)

    def process_request(self, request, client_address):
        if not self.slots.acquire(blocking=False):
            self.shutdown_request(request)
            return
        try:
            super().process_request(request, client_address)
        except Exception:
            self.slots.release()
            raise

    def process_request_thread(self, request, client_address):
        try:
            super().process_request_thread(request, client_address)
        finally:
            self.slots.release()

    def handle_error(self, request, client_address):
        pass  # No request bodies, stack traces or local paths in server logs.


class Handler(BaseHTTPRequestHandler):
    server_version = "DayMateLocal/1"
    sys_version = ""
    protocol_version = "HTTP/1.0"

    def setup(self):
        self.request.settimeout(5)
        super().setup()

    def log_message(self, format, *args):
        pass

    def send_error(self, code, message=None, explain=None):
        self.respond(code, {"error": {"code": "invalid_request", "message": "不支持的本机请求。"}})

    def respond(self, status, body):
        payload = json.dumps(body, ensure_ascii=False, allow_nan=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Connection", "close")
        self.end_headers()
        self.close_connection = True
        self.wfile.write(payload)

    def trusted(self):
        port = self.server.server_port
        if self.headers.get_all("Host") not in ([f"127.0.0.1:{port}"], [f"localhost:{port}"]):
            raise RequestError(403, "invalid_host", "只接受本机地址。")
        if self.headers.get("Origin") is not None or self.headers.get_all("X-DayMate-Local") != ["1"]:
            raise RequestError(403, "invalid_client", "只接受显式本机客户端请求。")
        if self.headers.get("Transfer-Encoding") is not None:
            raise RequestError(400, "invalid_encoding", "不支持分块请求。")

    def route(self):
        self.trusted()
        if self.command == "GET":
            if self.path == "/v1/health":
                return self.respond(200, self.server.runtime.status())
            if self.path == "/v1/models":
                return self.respond(200, {"object": "list", "data": [{"id": self.server.runtime.model_id, "object": "model", "owned_by": "local", "output_modalities": ["text"]}]})
            raise RequestError(404, "not_found", "本机接口不存在。")
        if self.command != "POST" or self.path != "/v1/chat/completions":
            raise RequestError(404, "not_found", "本机接口不存在。")
        if self.headers.get_content_type() != "application/json":
            raise RequestError(415, "invalid_content_type", "只接受 JSON 请求。")
        lengths = self.headers.get_all("Content-Length", [])
        if len(lengths) != 1 or not lengths[0].isascii() or not lengths[0].isdigit():
            raise RequestError(411, "invalid_length", "请提供有效请求长度。")
        size = int(lengths[0])
        if not 1 <= size <= MAX_BODY:
            raise RequestError(413, "request_too_large", "请求超出本机大小限制。")
        raw = self.rfile.read(size)
        if len(raw) != size:
            raise RequestError(400, "incomplete_request", "请求不完整。")
        try:
            body = json.loads(raw.decode("utf-8"), parse_constant=lambda _: None, object_pairs_hook=unique_object)
        except (ValueError, UnicodeError):
            raise RequestError(400, "invalid_json", "请求不是有效 JSON。") from None
        self.respond(200, self.server.runtime.chat(body))

    def dispatch(self):
        try:
            self.route()
        except RequestError as error:
            self.respond(error.status, {"error": {"code": error.code, "message": error.message}})
        except (BrokenPipeError, ConnectionResetError, socket.timeout):
            self.close_connection = True
        except Exception:
            self.respond(500, {"error": {"code": "internal_error", "message": "本机请求处理失败。"}})

    do_GET = dispatch
    do_POST = dispatch
    do_OPTIONS = dispatch


def main():
    parser = argparse.ArgumentParser(description="DayMate offline text model companion")
    parser.add_argument("--model-path", required=True)
    parser.add_argument("--runtime-dir", required=True)
    parser.add_argument("--port", type=int, default=8765)
    args = parser.parse_args()
    if not 1024 <= args.port <= 65535:
        parser.error("port must be between 1024 and 65535")
    root = Path(args.model_path).resolve()
    if not root.is_dir():
        parser.error("an existing local model directory is required")
    prepare_environment(args.runtime_dir)
    lease = ModelLease(root)
    runtime = Runtime(lambda: TransformersBackend(root), MODEL_ID)
    try:
        with Server(args.port, runtime) as server:
            runtime.start()
            print("DayMate local model service listening on loopback; loading.", flush=True)
            server.serve_forever(poll_interval=0.25)
    finally:
        lease.close()


if __name__ == "__main__":
    try:
        main()
    except Exception:
        raise SystemExit("Local service could not start. Check model ownership, port, files and runtime configuration.") from None
