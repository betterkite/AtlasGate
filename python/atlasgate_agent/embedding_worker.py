"""Local ONNX embedding service (RAG phase 1, Q2/Q6).

Serves an OpenAI-compatible POST /v1/embeddings so AtlasGate's existing
`semantic-index.js` embed() can use it unchanged via
ATLASGATE_EMBEDDING_BASE_URL=http://127.0.0.1:8031/v1.

Model: BAAI/bge-small-zh-v1.5 exported to ONNX (512 dims, ~50-100 MB).
Download the ONNX model once, e.g. from ModelScope:
  https://modelscope.cn/models/AI-ModelScope/bge-small-zh-v1.5
  (or convert with `optimum-cli export onnx --task feature-extraction ...`)

Runtime dependency: onnxruntime (the only new pip dependency; ADR-010 only
constrains JS). When onnxruntime or the model file is missing, the service
still starts but returns 503 so AtlasGate degrades to pure lexical retrieval.

Usage:
  python3 python/atlasgate_agent/embedding_worker.py \
    --model /path/to/bge-small-zh-v1.5/onnx/model.onnx \
    --tokenizer /path/to/bge-small-zh-v1.5 \
    --host 127.0.0.1 --port 8031
"""

from __future__ import annotations

import argparse
import base64
import gzip
import json
import os
import re
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

MODEL_FILE = "model.onnx"  # tokenizer files live next to it (tokenizer.json / vocab.txt)


class EmbeddingRuntime:
    """Lazy ONNX runtime: loads model + tokenizer on first request."""

    def __init__(self, model_dir: str) -> None:
        self.model_dir = model_dir
        self._session: Any = None
        self._tokenizer: Any = None
        self._lock = threading.Lock()
        self.dims = 512
        self.error: str | None = None

    def _load(self) -> None:
        with self._lock:
            if self._session is not None:
                return
            try:
                import onnxruntime as ort  # type: ignore
            except Exception as exc:  # pragma: no cover - env dependent
                self.error = f"onnxruntime not installed: {exc}"
                return
            model_path = os.path.join(self.model_dir, MODEL_FILE)
            if not os.path.exists(model_path):
                self.error = f"model file not found: {model_path}"
                return
            sess_options = ort.SessionOptions()
            sess_options.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
            self._session = ort.InferenceSession(
                model_path, sess_options, providers=["CPUExecutionProvider"]
            )
            try:
                from transformers import AutoTokenizer  # type: ignore

                self._tokenizer = AutoTokenizer.from_pretrained(self.model_dir)
            except Exception:
                # Fallback minimal tokenizer is not implemented; refuse clearly.
                self.error = "AutoTokenizer unavailable (pip install transformers) or tokenizer files missing"
                self._session = None
            if self._session is not None:
                self.dims = self._session.get_outputs()[0].shape[-1] or 512

    def encode(self, texts: list[str]) -> list[list[float]] | None:
        self._load()
        if self._session is None or self._tokenizer is None:
            return None
        # bge-small-zh: mean-pooled last_hidden_state + normalization.
        enc = self._tokenizer(texts, padding=True, truncation=True, max_length=512, return_tensors="np")
        input_names = [i.name for i in self._session.get_inputs()]
        inputs = {name: enc[name] for name in input_names if name in enc}
        outputs = self._session.run(None, inputs)[0]
        attention = enc["attention_mask"][:, :, None]
        pooled = (outputs * attention).sum(axis=1) / attention.sum(axis=1)
        norms = ((pooled ** 2).sum(axis=1, keepdims=True)) ** 0.5
        return (pooled / norms).tolist()


class EmbeddingHandler(BaseHTTPRequestHandler):
    runtime: EmbeddingRuntime = None  # type: ignore[assignment]  # set by main

    def log_message(self, fmt: str, *args: Any) -> None:  # keep stdout clean
        sys.stderr.write(f"[embedding-worker] {fmt % args}\n")

    def _read_body(self) -> dict[str, Any]:
        length = int(self.headers.get("content-length") or 0)
        raw = self.rfile.read(length) if length else b""
        if self.headers.get("content-encoding") == "gzip":
            raw = gzip.decompress(raw)
        return json.loads(raw or b"{}")

    def _json(self, status: int, payload: dict[str, Any]) -> None:
        body = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:
        if self.path.rstrip("/") == "/health":
            ok = self.runtime._session is not None  # noqa: SLF001
            self._json(200, {"status": "ok" if ok else "unavailable", "dims": self.runtime.dims, "error": self.runtime.error})
        else:
            self._json(404, {"error": {"message": "not found"}})

    def do_POST(self) -> None:
        if not self.path.rstrip("/").endswith("/embeddings"):
            self._json(404, {"error": {"message": "not found"}})
            return
        try:
            body = self._read_body()
        except Exception:
            self._json(400, {"error": {"message": "invalid JSON body"}})
            return
        texts = body.get("input", [])
        if isinstance(texts, str):
            texts = [texts]
        if not isinstance(texts, list) or not texts:
            self._json(400, {"error": {"message": "input must be a non-empty string or array"}})
            return
        vectors = self.runtime.encode([str(t) for t in texts])
        if vectors is None:
            self._json(503, {"error": {"message": f"embedding unavailable: {self.runtime.error}"}})
            return
        data = [{"object": "embedding", "index": i, "embedding": vec} for i, vec in enumerate(vectors)]
        self._json(200, {
            "object": "list",
            "model": body.get("model", "bge-small-zh-v1.5"),
            "data": data,
            "usage": {"prompt_tokens": 0, "total_tokens": 0},
        })


def main() -> None:
    parser = argparse.ArgumentParser(description="Local ONNX embedding service (OpenAI-compatible /v1/embeddings)")
    parser.add_argument("--model", required=True, help="directory containing model.onnx + tokenizer files")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8031)
    args = parser.parse_args()

    EmbeddingHandler.runtime = EmbeddingRuntime(args.model)
    server = ThreadingHTTPServer((args.host, args.port), EmbeddingHandler)
    print(f"embedding worker listening on http://{args.host}:{args.port}/v1/embeddings (model={args.model})", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        server.shutdown()


if __name__ == "__main__":
    main()
