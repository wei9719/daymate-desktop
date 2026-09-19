import http.client
import json
import threading
import unittest

from local_ai.runtime import MODEL_ID, Runtime
from local_ai.server import MAX_BODY, Server


class Backend:
    device = "cpu"

    def generate(self, _):
        return '{"text":"先从一小步开始。"}', "stop", 3, 12


class ServerTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.runtime = Runtime(Backend)
        cls.runtime.load()
        cls.server = Server(0, cls.runtime)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join(3)

    def call(self, method="GET", path="/v1/health", body=None, headers=None):
        connection = http.client.HTTPConnection("127.0.0.1", self.server.server_port, timeout=3)
        defaults = {"X-DayMate-Local": "1", "Content-Type": "application/json"}
        if headers:
            defaults.update(headers)
        try:
            connection.request(method, path, body, defaults)
            response = connection.getresponse()
            return response.status, json.loads(response.read()), dict(response.getheaders())
        finally:
            connection.close()

    def test_health_and_models(self):
        status, body, headers = self.call()
        self.assertEqual(status, 200)
        self.assertEqual(body["state"], "ready")
        self.assertEqual(body["model"], MODEL_ID)
        self.assertEqual(headers["Cache-Control"], "no-store")
        self.assertNotIn("Access-Control-Allow-Origin", headers)
        self.assertEqual(self.call(path="/v1/models")[1]["data"][0]["id"], MODEL_ID)

    def test_chat_response(self):
        payload = json.dumps({"model": MODEL_ID, "messages": [{"role": "user", "content": "hello"}], "max_tokens": 64})
        status, body, _ = self.call("POST", "/v1/chat/completions", payload)
        self.assertEqual(status, 200)
        self.assertEqual(body["choices"][0]["finish_reason"], "stop")

    def test_rejects_web_origins_host_and_missing_marker(self):
        for header in [{"Origin": "https://example.com"}, {"Origin": "null"}, {"Host": "attacker.test"}, {"X-DayMate-Local": "wrong"}]:
            with self.subTest(header=header):
                self.assertEqual(self.call(headers=header)[0], 403)

    def test_body_limits_and_content_type(self):
        self.assertEqual(self.call("POST", "/v1/chat/completions", "x" * (MAX_BODY + 1))[0], 413)
        self.assertEqual(self.call("POST", "/v1/chat/completions", "{}", {"Content-Type": "text/plain"})[0], 415)
        self.assertEqual(self.call("POST", "/v1/chat/completions", "{broken")[0], 400)
        self.assertEqual(self.call("POST", "/v1/chat/completions", '{"model":"a","model":"b"}')[0], 400)
        self.assertEqual(self.call("POST", "/v1/chat/completions", "{}", {"Transfer-Encoding": "chunked"})[0], 400)

    def test_no_files_or_alternative_routes(self):
        for route in ["/", "/v1/health?x=1", "/../config.json", "/v1/shutdown"]:
            self.assertEqual(self.call(path=route)[0], 404)
        self.assertEqual(self.call("OPTIONS")[0], 404)

    def test_loading_is_visible_and_chat_fails_safely(self):
        previous = self.runtime.state
        self.runtime.state = "loading"
        try:
            self.assertEqual(self.call()[1]["state"], "loading")
            payload = json.dumps({"model": MODEL_ID, "messages": [{"role": "user", "content": "hello"}]})
            self.assertEqual(self.call("POST", "/v1/chat/completions", payload)[0], 503)
        finally:
            self.runtime.state = previous


if __name__ == "__main__":
    unittest.main()
