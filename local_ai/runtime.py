"""Bounded offline inference. Importing this module does not load PyTorch."""

from dataclasses import dataclass
import hashlib
import os
from pathlib import Path
import re
import sys
import threading
import time


MODEL_ID = "Qwen2.5-1.5B-Instruct"


class RequestError(Exception):
    def __init__(self, status, code, message):
        super().__init__(message)
        self.status, self.code, self.message = status, code, message


@dataclass(frozen=True)
class ChatRequest:
    messages: list
    max_tokens: int
    json_mode: bool


def validate_request(body, model_id=MODEL_ID):
    allowed = {"model", "messages", "max_tokens", "temperature", "stream", "response_format"}
    if not isinstance(body, dict) or set(body) - allowed:
        raise RequestError(400, "invalid_request", "请求包含不支持的字段。")
    if body.get("model") != model_id:
        raise RequestError(404, "model_not_found", "模型名称不匹配，请获取本机模型列表。")
    if body.get("stream", False) is not False:
        raise RequestError(400, "stream_unsupported", "本地服务目前只支持非流式文字生成。")
    count = body.get("max_tokens", 256)
    if type(count) is not int or not 1 <= count <= 512:
        raise RequestError(400, "invalid_tokens", "输出额度应为 1 到 512。")
    temperature = body.get("temperature", 0)
    if type(temperature) not in (int, float) or not 0 <= temperature <= 2:
        raise RequestError(400, "invalid_temperature", "温度参数无效。")
    fmt = body.get("response_format")
    if fmt is not None and fmt != {"type": "json_object"}:
        raise RequestError(400, "invalid_format", "仅支持 json_object 输出提示。")
    messages = body.get("messages")
    if not isinstance(messages, list) or not 1 <= len(messages) <= 32:
        raise RequestError(400, "invalid_messages", "消息数量应为 1 到 32。")
    cleaned = []
    for item in messages:
        if not isinstance(item, dict) or set(item) != {"role", "content"}:
            raise RequestError(400, "invalid_messages", "仅支持纯文本消息。")
        role, content = item["role"], item["content"]
        if role not in ("system", "user", "assistant") or not isinstance(content, str) or not content.strip():
            raise RequestError(400, "invalid_messages", "消息角色或正文无效。")
        cleaned.append({"role": role, "content": content})
    if sum(len(item["content"]) for item in cleaned) > 6000:
        raise RequestError(413, "input_too_long", "输入过长，请仅发送必要摘要。")
    return ChatRequest(cleaned, count, fmt is not None)


def prepare_environment(runtime_dir):
    root = Path(runtime_dir).resolve()
    root.mkdir(parents=True, exist_ok=True)
    for key, suffix in {"HF_HOME": "cache/huggingface", "HF_HUB_CACHE": "cache/huggingface/hub", "HUGGINGFACE_HUB_CACHE": "cache/huggingface/hub", "TRANSFORMERS_CACHE": "cache/huggingface/hub", "TORCH_HOME": "cache/torch", "CUDA_CACHE_PATH": "cache/cuda", "TEMP": "tmp", "TMP": "tmp", "TMPDIR": "tmp", "XDG_CACHE_HOME": "cache"}.items():
        path = root / suffix
        path.mkdir(parents=True, exist_ok=True)
        os.environ[key] = str(path)
    for key in ("HF_HUB_OFFLINE", "TRANSFORMERS_OFFLINE", "HF_HUB_DISABLE_TELEMETRY", "DO_NOT_TRACK"):
        os.environ[key] = "1"
    os.environ["TOKENIZERS_PARALLELISM"] = "false"
    os.environ["PYTHONDONTWRITEBYTECODE"] = "1"
    sys.dont_write_bytecode = True


class ModelLease:
    """One Windows-session owner per canonical model directory, even across ports."""

    def __init__(self, model_path):
        self.handle = None
        if os.name == "nt":
            import ctypes
            self.kernel = ctypes.WinDLL("kernel32", use_last_error=True)
            self.kernel.CreateMutexW.argtypes = [ctypes.c_void_p, ctypes.c_int, ctypes.c_wchar_p]
            self.kernel.CreateMutexW.restype = ctypes.c_void_p
            self.kernel.CloseHandle.argtypes = [ctypes.c_void_p]
            self.kernel.CloseHandle.restype = ctypes.c_int
            digest = hashlib.sha256(os.path.normcase(str(Path(model_path).resolve())).encode()).hexdigest()
            handle = self.kernel.CreateMutexW(None, False, "Local\\DayMateModel_" + digest)
            if not handle:
                raise RuntimeError("model_lease_unavailable")
            if ctypes.get_last_error() == 183:
                self.kernel.CloseHandle(handle)
                raise RuntimeError("model_already_loaded")
            self.handle = handle

    def close(self):
        if self.handle:
            self.kernel.CloseHandle(self.handle)
            self.handle = None


class TransformersBackend:
    def __init__(self, model_path):
        import json
        import torch
        from transformers import AutoModelForCausalLM, AutoTokenizer
        from transformers.utils import logging

        logging.set_verbosity_error()
        root = Path(model_path).resolve(strict=True)
        config = json.loads((root / "config.json").read_text(encoding="utf-8"))
        if config.get("model_type") != "qwen2" or not list(root.glob("*.safetensors")):
            raise RuntimeError("unsupported_model")
        if config.get("auto_map"):
            raise RuntimeError("custom_code_not_allowed")
        self.torch = torch
        self.device = "cuda:0" if torch.cuda.is_available() else "cpu"
        if self.device.startswith("cuda"):
            free, _ = torch.cuda.mem_get_info(0)
            if free < 4 * 1024**3:
                raise RuntimeError("insufficient_gpu_memory")
        torch.set_num_threads(2)
        self.tokenizer = AutoTokenizer.from_pretrained(root, local_files_only=True, trust_remote_code=False)
        self.model = AutoModelForCausalLM.from_pretrained(
            root, local_files_only=True, trust_remote_code=False, use_safetensors=True,
            torch_dtype=torch.float16 if self.device.startswith("cuda") else torch.float32,
            device_map={"": self.device}, attn_implementation="sdpa", sliding_window=None,
        )
        self.model.eval()

    def generate(self, request):
        messages = list(request.messages)
        if request.json_mode:
            messages = [{"role": "system", "content": "只返回一个有效 JSON 对象，不要 Markdown、解释或额外字段。"}] + messages
        prompt = self.tokenizer.apply_chat_template(messages, tokenize=False, add_generation_prompt=True)
        inputs = self.tokenizer(prompt, return_tensors="pt")
        input_count = inputs.input_ids.shape[1]
        if input_count > 2048:
            raise RequestError(413, "input_too_long", "输入超过本机 2048 token 上限，请缩短摘要。")
        inputs = inputs.to(self.device)
        with self.torch.inference_mode():
            output = self.model.generate(
                **inputs, max_new_tokens=request.max_tokens, max_time=100,
                do_sample=False, temperature=None, top_p=None, top_k=None,
                repetition_penalty=1.08, pad_token_id=self.tokenizer.eos_token_id,
            )
        tokens = output[0, input_count:]
        text = self.tokenizer.decode(tokens, skip_special_tokens=True).strip()
        eos_ids = self.model.generation_config.eos_token_id
        eos_ids = eos_ids if isinstance(eos_ids, list) else [eos_ids]
        ended = len(tokens) > 0 and int(tokens[-1]) in eos_ids
        return text, "stop" if ended else "length", input_count, len(tokens)


class Runtime:
    def __init__(self, loader, model_id=MODEL_ID):
        if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._/-]{0,199}", model_id) or model_id.startswith("sk-"):
            raise ValueError("Invalid model identifier")
        self.model_id = model_id
        self.loader = loader
        self.backend = None
        self.state = "loading"
        self.device = None
        self.lock = threading.Lock()
        self.started = False

    def load(self):
        try:
            self.backend = self.loader()
            self.device = self.backend.device
            self.state = "ready"
        except Exception:
            self.state = "error"
        # Never print exception text: model libraries may include paths or input.

    def start(self):
        if not self.started:
            self.started = True
            threading.Thread(target=self.load, daemon=True, name="local-model-load").start()

    def status(self):
        messages = {
            "loading": "正在加载本机模型，请稍后检查。",
            "ready": "本机模型已就绪，数据仅在本机处理。",
            "busy": "本机模型正在生成，请等待当前请求完成。",
            "error": "模型加载失败，请检查文件、依赖和可用显存后重启服务。",
        }
        return {"state": self.state, "model": self.model_id, "device": self.device, "message": messages[self.state]}

    def chat(self, body):
        request = validate_request(body, self.model_id)
        if self.state == "loading":
            raise RequestError(503, "model_loading", "模型仍在加载，请稍后检查状态。")
        if self.state == "error" or self.backend is None:
            raise RequestError(503, "model_unavailable", "本机模型不可用，请检查状态后重启服务。")
        if not self.lock.acquire(blocking=False):
            raise RequestError(429, "model_busy", "本机模型正在处理另一条请求。")
        self.state = "busy"
        try:
            text, finish, prompt_tokens, completion_tokens = self.backend.generate(request)
            if not text or len(text.encode("utf-8")) > 32_768:
                raise RequestError(500, "invalid_output", "本机模型未生成有效文本。")
            return {
                "id": "local-" + str(time.monotonic_ns()), "object": "chat.completion", "created": int(time.time()),
                "model": self.model_id,
                "choices": [{"index": 0, "message": {"role": "assistant", "content": text}, "finish_reason": finish}],
                "usage": {"prompt_tokens": prompt_tokens, "completion_tokens": completion_tokens, "total_tokens": prompt_tokens + completion_tokens},
            }
        except RequestError:
            raise
        except Exception:
            raise RequestError(500, "generation_failed", "本机生成失败，可缩短输入后重试或继续使用规则推荐。") from None
        finally:
            self.state = "ready"
            self.lock.release()
