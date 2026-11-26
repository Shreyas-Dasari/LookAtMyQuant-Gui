#!/usr/bin/env python
"""OpenAI + Anthropic-compatible server for LookAtMyQuant packed models.

`lamq serve` only accepts `inkling2-packed` (Inkling-2-Mini). This server
wraps `runtime_mlx.Runtime` so `opgraph-packed-1` models (Qwen3.5-4B,
Qwen3.8-27B, with or without a DSpine drafter) as well as `inkling2-packed`
can be served behind `/v1/chat/completions`, `/v1/completions`, and `/v1/messages`.

Standard library only (no FastAPI). MLX streams are local to the thread
that creates them, so the model is loaded and all generation runs on one
dedicated worker thread; HTTP handler threads submit jobs to it and block.
"""
from __future__ import annotations

import argparse
import json
import signal
import sys
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


def log(msg: str, level: str = "INFO") -> None:
    ts = datetime.now().strftime("%H:%M:%S")
    print(f"{ts} {level} {msg}", file=sys.stderr, flush=True)


class RequestError(Exception):
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status
        self.message = message


def _flatten_content(content) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = []
        for block in content:
            if isinstance(block, str):
                parts.append(block)
            elif isinstance(block, dict):
                if block.get("type") == "text" and "text" in block:
                    parts.append(str(block["text"]))
        return "".join(parts)
    return str(content or "")


class Engine:
    """Loads the model once on a worker thread and serves one request at a time."""

    def __init__(self, args: argparse.Namespace):
        self.args = args
        self._executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="lamq-mlx")
        try:
            self._executor.submit(self._load, args).result()
        except BaseException:
            self.close()
            raise
        self._lock = threading.Lock()

    def close(self) -> None:
        self._executor.shutdown(wait=True, cancel_futures=True)

    def _load(self, args: argparse.Namespace) -> None:
        import mlx.core as mx
        from runtime_mlx.runtime import Runtime, detect_format

        t = time.perf_counter()
        fmt = detect_format(args.model)
        model_label = str(args.model).rstrip("/").split("/")[-1]
        log(f"Loading model: {model_label} ({fmt})")
        if args.drafter:
            drafter_label = str(args.drafter).rstrip("/").split("/")[-1]
            log(f"Loading drafter: {drafter_label}")
        self.rt = Runtime.load(args.model, drafter=args.drafter, verify=not args.no_verify)
        self.format = self.rt.format
        self.drafter = self.rt.drafter is not None
        self.model_name = args.model_id or model_label
        what = "Model and drafter loaded" if self.drafter else "Model loaded"
        log(f"{what} in {time.perf_counter() - t:.1f}s ({mx.get_active_memory() / 1e9:.2f} GB active RAM).")

    # -- request preparation ------------------------------------------------

    def _prepare_chat(self, req: dict) -> dict:
        messages = req.get("messages")
        if not isinstance(messages, list) or not messages:
            raise RequestError(400, "`messages` must be a non-empty list")
        norm = []
        for m in messages:
            if not isinstance(m, dict) or "role" not in m or "content" not in m:
                raise RequestError(400, "each message needs `role` and `content`")
            norm.append({"role": str(m["role"]), "content": _flatten_content(m["content"])})
        ctx = self.args.context
        max_tokens = _opt_int(req, "max_completion_tokens")
        if max_tokens is None:
            max_tokens = _opt_int(req, "max_tokens")
        if max_tokens is None:
            max_tokens = self.args.max_tokens
        if max_tokens <= 0:
            raise RequestError(400, "`max_tokens` must be positive")
        max_tokens = min(max_tokens, ctx)
        temp = _opt_float(req, "temperature")
        if temp is None:
            temp = 0.0
        top_p = _opt_float(req, "top_p")
        if top_p is None:
            top_p = 1.0
        thinking = bool(req.get("thinking", False))
        return {
            "messages": norm,
            "max_tokens": max_tokens,
            "temp": temp,
            "top_p": top_p,
            "thinking": thinking,
            "stream": bool(req.get("stream", False)),
        }

    def _prepare_anthropic(self, req: dict) -> dict:
        messages = req.get("messages")
        if not isinstance(messages, list) or not messages:
            raise RequestError(400, "`messages` must be a non-empty list")
        norm = []
        system = req.get("system")
        if system:
            norm.append({"role": "system", "content": _flatten_content(system)})
        for m in messages:
            if not isinstance(m, dict) or "role" not in m or "content" not in m:
                raise RequestError(400, "each message needs `role` and `content`")
            norm.append({"role": str(m["role"]), "content": _flatten_content(m["content"])})
        ctx = self.args.context
        max_tokens = _opt_int(req, "max_tokens")
        if max_tokens is None:
            max_tokens = self.args.max_tokens
        if max_tokens <= 0:
            raise RequestError(400, "`max_tokens` must be positive")
        max_tokens = min(max_tokens, ctx)
        temp = _opt_float(req, "temperature")
        if temp is None:
            temp = 0.0
        top_p = _opt_float(req, "top_p")
        if top_p is None:
            top_p = 1.0
        return {
            "messages": norm,
            "max_tokens": max_tokens,
            "temp": temp,
            "top_p": top_p,
            "thinking": False,
            "stream": bool(req.get("stream", False)),
        }

    def _prepare_completions(self, req: dict) -> dict:
        prompt = req.get("prompt")
        if not isinstance(prompt, (str, list)) or not prompt:
            raise RequestError(400, "`prompt` is required")
        if isinstance(prompt, list):
            prompt = prompt[0]
        max_tokens = _opt_int(req, "max_tokens")
        if max_tokens is None:
            max_tokens = self.args.max_tokens
        if max_tokens <= 0:
            raise RequestError(400, "`max_tokens` must be positive")
        temp = _opt_float(req, "temperature")
        if temp is None:
            temp = 0.0
        top_p = _opt_float(req, "top_p")
        if top_p is None:
            top_p = 1.0
        return {
            "prompt": prompt,
            "max_tokens": max_tokens,
            "temp": temp,
            "top_p": top_p,
            "stream": bool(req.get("stream", False)),
        }

    # -- generation runners -------------------------------------------------

    def run_chat(self, job: dict, emit, gone) -> dict:
        return self._executor.submit(self._run_chat, job, emit, gone).result()

    def _run_chat(self, job: dict, emit, gone) -> dict:
        parts: list[str] = []
        prompt_tokens = 0
        completion_tokens = 0
        finish_reason = "stop"
        gen = self.rt.stream_chat(
            job["messages"],
            max_tokens=job["max_tokens"],
            thinking=job["thinking"],
            temp=job["temp"],
            top_p=job["top_p"],
        )
        try:
            for chunk in gen:
                if gone():
                    break
                if chunk.text:
                    parts.append(chunk.text)
                if chunk.token_ids:
                    completion_tokens += len(chunk.token_ids)
                if chunk.prompt_tokens:
                    prompt_tokens = chunk.prompt_tokens
                if chunk.finish_reason:
                    finish_reason = chunk.finish_reason
                if job["stream"]:
                    emit(chunk.text, None)
        finally:
            try:
                gen.close()
            except Exception:
                pass
        text = "".join(parts)
        if job["stream"]:
            emit("", finish_reason)
        usage = {
            "prompt_tokens": prompt_tokens,
            "completion_tokens": completion_tokens,
            "total_tokens": prompt_tokens + completion_tokens,
        }
        return {"text": text, "finish_reason": finish_reason, "usage": usage}

    def run_completions(self, job: dict, emit, gone) -> dict:
        return self._executor.submit(self._run_completions, job, emit, gone).result()

    def _run_completions(self, job: dict, emit, gone) -> dict:
        parts: list[str] = []
        prompt_tokens = 0
        completion_tokens = 0
        finish_reason = "stop"
        gen = self.rt.stream(
            job["prompt"],
            chat=False,
            max_tokens=job["max_tokens"],
            temp=job["temp"],
            top_p=job["top_p"],
        )
        try:
            for chunk in gen:
                if gone():
                    break
                if chunk.text:
                    parts.append(chunk.text)
                if chunk.token_ids:
                    completion_tokens += len(chunk.token_ids)
                if chunk.prompt_tokens:
                    prompt_tokens = chunk.prompt_tokens
                if chunk.finish_reason:
                    finish_reason = chunk.finish_reason
                if job["stream"]:
                    emit(self._completions_chunk(chunk.text, None))
        finally:
            try:
                gen.close()
            except Exception:
                pass
        text = "".join(parts)
        if job["stream"]:
            emit(self._completions_chunk("", finish_reason))
        usage = {
            "prompt_tokens": prompt_tokens,
            "completion_tokens": completion_tokens,
            "total_tokens": prompt_tokens + completion_tokens,
        }
        return {"text": text, "finish_reason": finish_reason, "usage": usage}

    # -- SSE helpers --------------------------------------------------------

    def _base(self, obj: str) -> dict:
        return {
            "id": f"chatcmpl-{uuid.uuid4().hex[:24]}",
            "object": obj,
            "created": int(time.time()),
            "model": self.model_name,
        }

    def _chat_chunk(self, text: str, finish_reason) -> str:
        base = self._base("chat.completion.chunk")
        delta = {}
        if text:
            delta["content"] = text
        base["choices"] = [{"index": 0, "delta": delta, "finish_reason": finish_reason}]
        return f"data: {json.dumps(base)}\n\n"

    def _completions_chunk(self, text: str, finish_reason) -> str:
        base = self._base("text_completion")
        choice: dict = {"index": 0, "finish_reason": finish_reason}
        if text:
            choice["text"] = text
        base["choices"] = [choice]
        return f"data: {json.dumps(base)}\n\n"

    def models_payload(self) -> dict:
        return {"object": "list", "data": [{"id": self.model_name, "object": "model"}]}


def _opt_int(req: dict, key: str):
    v = req.get(key)
    if v is None:
        return None
    return int(v)


def _opt_float(req: dict, key: str):
    v = req.get(key)
    if v is None:
        return None
    return float(v)


_STATUS_TEXT = {
    200: "200 OK",
    400: "400 Bad Request",
    404: "404 Not Found",
    413: "413 Payload Too Large",
    500: "500 Internal Server Error",
}


def build_handler(engine: Engine):
    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"
        server_version = "LAMQGui/1.0"

        def log_message(self, fmt, *args):
            return

        def _log_http(self, status: int):
            path = self.path.split("?")[0]
            if path in ("/", "/health"):
                return
            log(f"{self.command} {path}  {_STATUS_TEXT.get(status, str(status))}", level="HTTP")

        # -- low-level ------------------------------------------------------
        def _send_json(self, status: int, payload: dict):
            self._log_http(status)
            body = json.dumps(payload).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def _send_sse_open(self):
            self._log_http(200)
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Cache-Control", "no-cache")
            self.send_header("Connection", "close")
            self.send_header("X-Accel-Buffering", "no")
            self.end_headers()
            self.close_connection = True

        def _read_body(self) -> dict:
            length = int(self.headers.get("Content-Length", 0))
            if length > 1_000_000:
                raise RequestError(413, "request body too large (max 1 MiB)")
            raw = self.rfile.read(length) if length else b"{}"
            return json.loads(raw.decode() or "{}")

        def _gone(self) -> bool:
            return getattr(self, "_client_gone", False)

        def _emit_sse(self, data: str):
            try:
                self.wfile.write(data.encode())
                self.wfile.flush()
            except Exception:
                self._client_gone = True
                raise

        # -- routes ---------------------------------------------------------
        def do_GET(self):
            path = self.path.split("?")[0]
            try:
                if path in ("/", "/health"):
                    return self._send_json(
                        200,
                        {
                            "status": "ok",
                            "model": engine.model_name,
                            "format": engine.format,
                            "drafter": engine.drafter,
                        },
                    )
                if path == "/v1/models":
                    return self._send_json(200, engine.models_payload())
                return self._send_json(404, {"error": {"message": "not found", "type": "invalid_request"}})
            except RequestError as e:
                return self._send_json(e.status, {"error": {"message": e.message, "type": "invalid_request"}})
            except Exception as e:  # noqa: BLE001
                log(f"GET {path} error: {e!r}")
                return self._send_json(500, {"error": {"message": str(e), "type": "server"}})

        def do_POST(self):
            path = self.path.split("?")[0]
            try:
                req = self._read_body()
            except RequestError as e:
                return self._send_json(e.status, {"error": {"message": e.message, "type": "invalid_request"}})
            except Exception as e:  # noqa: BLE001
                return self._send_json(400, {"error": {"message": f"bad json: {e}", "type": "invalid_request"}})

            try:
                if path == "/v1/chat/completions":
                    return self._chat(req)
                if path == "/v1/completions":
                    return self._completions(req)
                if path == "/v1/messages":
                    return self._anthropic_messages(req)
                return self._send_json(404, {"error": {"message": "not found", "type": "invalid_request"}})
            except (BrokenPipeError, ConnectionResetError):
                self._client_gone = True
                self.close_connection = True
                log(f"POST {path}: client disconnected")
                return
            except RequestError as e:
                return self._send_json(e.status, {"error": {"message": e.message, "type": "invalid_request"}})
            except Exception as e:  # noqa: BLE001
                log(f"POST {path} error: {e!r}")
                return self._send_json(500, {"error": {"message": str(e), "type": "server"}})

        def _chat(self, req: dict):
            job = engine._prepare_chat(req)
            if job["stream"]:
                self._send_sse_open()

                def emit(text: str, finish_reason):
                    self._emit_sse(engine._chat_chunk(text, finish_reason))

                engine.run_chat(job, emit, self._gone)
                self._emit_sse("data: [DONE]\n\n")
            else:
                def emit(_t: str, _f):
                    pass

                result = engine.run_chat(job, emit, self._gone)
                base = engine._base("chat.completion")
                base["choices"] = [
                    {
                        "index": 0,
                        "message": {"role": "assistant", "content": result["text"]},
                        "finish_reason": result["finish_reason"],
                    }
                ]
                base["usage"] = result["usage"]
                self._send_json(200, base)

        def _anthropic_messages(self, req: dict):
            job = engine._prepare_anthropic(req)
            msg_id = f"msg_{uuid.uuid4().hex[:24]}"
            if job["stream"]:
                self._send_sse_open()
                start_ev = {
                    "type": "message_start",
                    "message": {
                        "id": msg_id,
                        "type": "message",
                        "role": "assistant",
                        "content": [],
                        "model": engine.model_name,
                        "stop_reason": None,
                        "stop_sequence": None,
                        "usage": {"input_tokens": 0, "output_tokens": 0},
                    },
                }
                self._emit_sse(f"event: message_start\ndata: {json.dumps(start_ev)}\n\n")
                self._emit_sse(
                    f"event: content_block_start\ndata: {json.dumps({'type': 'content_block_start', 'index': 0, 'content_block': {'type': 'text', 'text': ''}})}\n\n"
                )

                def emit(text: str, finish_reason):
                    if text:
                        delta_ev = {
                            "type": "content_block_delta",
                            "index": 0,
                            "delta": {"type": "text_delta", "text": text},
                        }
                        self._emit_sse(f"event: content_block_delta\ndata: {json.dumps(delta_ev)}\n\n")

                result = engine.run_chat(job, emit, self._gone)
                self._emit_sse(
                    f"event: content_block_stop\ndata: {json.dumps({'type': 'content_block_stop', 'index': 0})}\n\n"
                )
                stop_reason = "max_tokens" if result["finish_reason"] == "length" else "end_turn"
                msg_delta = {
                    "type": "message_delta",
                    "delta": {"stop_reason": stop_reason, "stop_sequence": None},
                    "usage": {"output_tokens": result["usage"]["completion_tokens"]},
                }
                self._emit_sse(f"event: message_delta\ndata: {json.dumps(msg_delta)}\n\n")
                self._emit_sse(f"event: message_stop\ndata: {json.dumps({'type': 'message_stop'})}\n\n")
            else:
                def emit(_t: str, _f):
                    pass

                result = engine.run_chat(job, emit, self._gone)
                stop_reason = "max_tokens" if result["finish_reason"] == "length" else "end_turn"
                self._send_json(
                    200,
                    {
                        "id": msg_id,
                        "type": "message",
                        "role": "assistant",
                        "model": engine.model_name,
                        "content": [{"type": "text", "text": result["text"]}],
                        "stop_reason": stop_reason,
                        "stop_sequence": None,
                        "usage": {
                            "input_tokens": result["usage"]["prompt_tokens"],
                            "output_tokens": result["usage"]["completion_tokens"],
                        },
                    },
                )

        def _completions(self, req: dict):
            job = engine._prepare_completions(req)
            if job["stream"]:
                self._send_sse_open()

                def emit(s: str):
                    self._emit_sse(s)

                engine.run_completions(job, emit, self._gone)
                self._emit_sse("data: [DONE]\n\n")
            else:
                def emit(_s: str):
                    pass

                result = engine.run_completions(job, emit, self._gone)
                base = engine._base("text_completion")
                base["choices"] = [
                    {
                        "index": 0,
                        "text": result["text"],
                        "finish_reason": result["finish_reason"],
                    }
                ]
                base["usage"] = result["usage"]
                self._send_json(200, base)

    return Handler


def main():
    p = argparse.ArgumentParser(description="OpenAI/Anthropic-compatible server for LookAtMyQuant models")
    p.add_argument("model", help="local model directory or Hugging Face repo ID")
    p.add_argument("--drafter", default=None, help="optional drafter directory or Hugging Face repo ID")
    p.add_argument("--host", default="127.0.0.1")
    p.add_argument("--port", type=int, default=8080)
    p.add_argument("--context", type=int, default=32768, help="prompt+completion token limit")
    p.add_argument("--max-tokens", type=int, default=2048, help="completion tokens when request sets none")
    p.add_argument("--model-id", default=None, help="model id reported by /v1/models")
    p.add_argument("--no-verify", action="store_true", help="skip local checksum verification")
    args = p.parse_args()

    log("Starting local server...")
    engine = Engine(args)
    handler = build_handler(engine)
    httpd = ThreadingHTTPServer((args.host, args.port), handler)

    def _shutdown_handler(_signum, _frame):
        log("Stop requested.")
        threading.Thread(target=httpd.shutdown, daemon=True).start()

    signal.signal(signal.SIGTERM, _shutdown_handler)
    signal.signal(signal.SIGINT, _shutdown_handler)

    log(f"Listening on http://{args.host}:{args.port}")
    try:
        httpd.serve_forever()
    finally:
        log("Shutting down server...")
        httpd.server_close()
        engine.close()
        log("Server stopped.")


if __name__ == "__main__":
    main()
