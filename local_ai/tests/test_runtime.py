import os
from pathlib import Path
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch

from local_ai.runtime import MODEL_ID, ModelLease, RequestError, Runtime, prepare_environment, validate_request


def request(**extra):
    return {"model": MODEL_ID, "messages": [{"role": "user", "content": "测试"}], **extra}


class Backend:
    device = "cpu"

    def generate(self, value):
        return "连接成功", "stop", 3, 2


class RuntimeTests(unittest.TestCase):
    def test_runtime_redirects_caches_and_disables_downloads(self):
        previous = sys.dont_write_bytecode
        try:
            with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ):
                prepare_environment(directory)
                root = Path(directory).resolve()
                for key in ("HF_HOME", "HF_HUB_CACHE", "HUGGINGFACE_HUB_CACHE", "TRANSFORMERS_CACHE", "TORCH_HOME", "CUDA_CACHE_PATH", "TEMP", "TMP", "TMPDIR", "XDG_CACHE_HOME"):
                    self.assertTrue(Path(os.environ[key]).is_relative_to(root))
                for key in ("HF_HUB_OFFLINE", "TRANSFORMERS_OFFLINE", "HF_HUB_DISABLE_TELEMETRY", "DO_NOT_TRACK"):
                    self.assertEqual(os.environ[key], "1")
                self.assertTrue(sys.dont_write_bytecode)
        finally:
            sys.dont_write_bytecode = previous

    @unittest.skipUnless(os.name == "nt", "Windows model ownership guard")
    def test_model_lease_rejects_duplicate_and_releases(self):
        with tempfile.TemporaryDirectory() as directory:
            first = ModelLease(directory)
            try:
                with self.assertRaisesRegex(RuntimeError, "model_already_loaded"):
                    ModelLease(str(Path(directory) / "."))
            finally:
                first.close()
            second = ModelLease(directory)
            second.close()
            second.close()

    def test_valid_request(self):
        result = validate_request(request(response_format={"type": "json_object"}, max_tokens=64, temperature=0.5))
        self.assertTrue(result.json_mode)
        self.assertEqual(result.max_tokens, 64)

    def test_rejects_invalid_contracts(self):
        cases = [request(model="wrong"), request(max_tokens=True), request(max_tokens=513), request(temperature=float("nan")), request(stream=True), request(extra="value"), request(response_format={"type": "json_schema"}), request(messages=[]), request(messages=[{"role": "tool", "content": "x"}]), request(messages=[{"role": "user", "content": []}]), request(messages=[{"role": "user", "content": "x", "name": "x"}]), request(messages=[{"role": "user", "content": "x" * 6001}])]
        for body in cases:
            with self.subTest(body=body):
                with self.assertRaises(RequestError):
                    validate_request(body)

    def test_loading_and_failed_load_are_not_success(self):
        def fail():
            raise RuntimeError("private path and user content must not escape")
        runtime = Runtime(fail)
        with self.assertRaises(RequestError) as error:
            runtime.chat(request())
        self.assertEqual(error.exception.status, 503)
        runtime.load()
        self.assertEqual(runtime.status()["state"], "error")
        self.assertNotIn("private", str(runtime.status()))
        with self.assertRaises(RequestError):
            runtime.chat(request())

    def test_load_once_and_completion_contract(self):
        calls = []
        done = threading.Event()
        def loader():
            calls.append(1)
            done.set()
            return Backend()
        runtime = Runtime(loader)
        runtime.start()
        runtime.start()
        self.assertTrue(done.wait(2))
        # Synchronize completion of the loader rather than relying on GPU work.
        for thread in threading.enumerate():
            if thread.name == "local-model-load":
                thread.join(2)
        self.assertEqual(calls, [1])
        result = runtime.chat(request())
        self.assertEqual(result["choices"][0]["message"]["content"], "连接成功")
        self.assertEqual(result["choices"][0]["finish_reason"], "stop")
        self.assertEqual(result["usage"]["total_tokens"], 5)
        self.assertEqual(runtime.status()["state"], "ready")

    def test_busy_does_not_queue_duplicate_generation(self):
        runtime = Runtime(Backend)
        runtime.load()
        runtime.lock.acquire()
        try:
            with self.assertRaises(RequestError) as error:
                runtime.chat(request())
            self.assertEqual(error.exception.status, 429)
        finally:
            runtime.lock.release()

    def test_generation_error_redacted_and_lock_released(self):
        class Failing(Backend):
            def generate(self, _):
                raise RuntimeError("secret prompt")
        runtime = Runtime(Failing)
        runtime.load()
        with self.assertRaises(RequestError) as error:
            runtime.chat(request())
        self.assertNotIn("secret", str(error.exception))
        self.assertEqual(runtime.state, "ready")
        self.assertFalse(runtime.lock.locked())

    def test_length_is_not_reported_as_stop(self):
        class Limited(Backend):
            def generate(self, _):
                return "partial", "length", 10, 64
        runtime = Runtime(Limited)
        runtime.load()
        self.assertEqual(runtime.chat(request())["choices"][0]["finish_reason"], "length")

    def test_invalid_model_alias(self):
        for value in ["", "sk-secret", "C:\\private", "../model"]:
            with self.assertRaises(ValueError):
                Runtime(Backend, value)


if __name__ == "__main__":
    unittest.main()
