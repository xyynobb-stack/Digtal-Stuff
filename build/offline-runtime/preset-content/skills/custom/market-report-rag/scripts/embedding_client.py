"""Stateless client for the remote OpenAI-compatible embedding endpoint."""

from __future__ import annotations

import json
import math
import os
import time
from dataclasses import dataclass
from typing import Any, Callable, Mapping, Sequence
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen


DEFAULT_EMBEDDING_API_URL = "http://183.230.227.10:8003/v1/embeddings"
DEFAULT_EMBEDDING_MODEL = "bge-m3"
DEFAULT_EMBEDDING_DIMENSION = 1024


class EmbeddingError(RuntimeError):
    """Raised when the remote embedding service cannot return valid vectors."""

    def __init__(self, code: str, message: str, *, retryable: bool = False):
        super().__init__(message)
        self.code = code
        self.retryable = retryable


@dataclass(frozen=True)
class EmbeddingConfig:
    url: str
    model: str
    api_key: str | None
    timeout_seconds: float
    retries: int
    dimension: int | None = DEFAULT_EMBEDDING_DIMENSION


def load_embedding_config(env: Mapping[str, str] | None = None) -> EmbeddingConfig:
    """Build immutable per-invocation embedding configuration from the environment."""

    values = os.environ if env is None else env
    url = values.get("EMBEDDING_API_URL", DEFAULT_EMBEDDING_API_URL).strip()
    model = values.get("EMBEDDING_MODEL", DEFAULT_EMBEDDING_MODEL).strip()
    if not url:
        raise EmbeddingError("CONFIGURATION_ERROR", "EMBEDDING_API_URL cannot be empty.")
    if not model:
        raise EmbeddingError("CONFIGURATION_ERROR", "EMBEDDING_MODEL cannot be empty.")
    try:
        timeout_seconds = float(values.get("RAG_REQUEST_TIMEOUT_SECONDS", "30"))
        retries = int(values.get("RAG_EMBEDDING_RETRIES", "2"))
        dimension = int(
            values.get("EMBEDDING_DIMENSION", str(DEFAULT_EMBEDDING_DIMENSION))
        )
    except ValueError as exc:
        raise EmbeddingError(
            "CONFIGURATION_ERROR",
            "Timeout, retry count, and EMBEDDING_DIMENSION must be numeric.",
        ) from exc
    if timeout_seconds <= 0 or retries < 0 or retries > 5 or dimension <= 0:
        raise EmbeddingError(
            "CONFIGURATION_ERROR",
            "Timeout and dimension must be positive; retries must be between 0 and 5.",
        )
    api_key = values.get("EMBEDDING_API_KEY", "").strip() or None
    return EmbeddingConfig(url, model, api_key, timeout_seconds, retries, dimension)


def _default_post_json(
    url: str,
    payload: dict[str, Any],
    headers: dict[str, str],
    timeout_seconds: float,
) -> Any:
    request = Request(
        url,
        data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
        headers=headers,
        method="POST",
    )
    try:
        with urlopen(request, timeout=timeout_seconds) as response:
            raw = response.read().decode("utf-8")
    except HTTPError as exc:
        retryable = exc.code in {408, 429} or 500 <= exc.code < 600
        raise EmbeddingError(
            "EMBEDDING_HTTP_ERROR",
            f"Embedding service returned HTTP {exc.code}.",
            retryable=retryable,
        ) from exc
    except (URLError, TimeoutError, OSError) as exc:
        raise EmbeddingError(
            "EMBEDDING_UNAVAILABLE",
            f"Embedding service is unavailable: {exc.reason if isinstance(exc, URLError) else exc}",
            retryable=True,
        ) from exc
    try:
        return json.loads(raw)
    except json.JSONDecodeError as exc:
        raise EmbeddingError(
            "EMBEDDING_RESPONSE_ERROR", "Embedding service returned invalid JSON."
        ) from exc


def _parse_vectors(
    response: Any, expected_count: int, expected_dimension: int | None
) -> list[list[float]]:
    if not isinstance(response, dict):
        raise EmbeddingError(
            "EMBEDDING_RESPONSE_ERROR", "Embedding response must be a JSON object."
        )

    vectors: Any
    if isinstance(response.get("data"), list):
        items = response["data"]
        if all(isinstance(item, dict) and "index" in item for item in items):
            items = sorted(items, key=lambda item: int(item["index"]))
        vectors = [item.get("embedding") if isinstance(item, dict) else None for item in items]
    else:
        vectors = response.get("embeddings")

    if not isinstance(vectors, list) or len(vectors) != expected_count:
        raise EmbeddingError(
            "EMBEDDING_RESPONSE_ERROR",
            f"Expected {expected_count} embedding vectors, received an incompatible response.",
        )

    normalized: list[list[float]] = []
    dimension: int | None = None
    for vector in vectors:
        if not isinstance(vector, list) or not vector:
            raise EmbeddingError(
                "EMBEDDING_RESPONSE_ERROR", "Embedding vectors must be non-empty arrays."
            )
        try:
            values = [float(value) for value in vector]
        except (TypeError, ValueError) as exc:
            raise EmbeddingError(
                "EMBEDDING_RESPONSE_ERROR", "Embedding vector contains a non-numeric value."
            ) from exc
        if not all(math.isfinite(value) for value in values):
            raise EmbeddingError(
                "EMBEDDING_RESPONSE_ERROR", "Embedding vector contains a non-finite value."
            )
        if dimension is None:
            dimension = len(values)
        elif len(values) != dimension:
            raise EmbeddingError(
                "EMBEDDING_RESPONSE_ERROR", "Embedding vectors have inconsistent dimensions."
            )
        if expected_dimension is not None and len(values) != expected_dimension:
            raise EmbeddingError(
                "EMBEDDING_DIMENSION_ERROR",
                f"Expected {expected_dimension}-dimensional embeddings, received {len(values)}.",
            )
        normalized.append(values)
    return normalized


# @lat: [[lat.md/rag-mvp#Runtime flow#Embedding request]]
def embed_texts(
    texts: Sequence[str],
    *,
    config: EmbeddingConfig | None = None,
    post_json: Callable[[str, dict[str, Any], dict[str, str], float], Any] = _default_post_json,
    sleep: Callable[[float], None] = time.sleep,
) -> list[list[float]]:
    """Embed a non-empty text batch in one remote request with bounded retries."""

    cleaned = [text.strip() for text in texts]
    if not cleaned or any(not text for text in cleaned):
        raise EmbeddingError("INPUT_ERROR", "Embedding input must contain non-empty text.")
    resolved = config or load_embedding_config()
    headers = {"Content-Type": "application/json", "Accept": "application/json"}
    if resolved.api_key:
        headers["Authorization"] = f"Bearer {resolved.api_key}"
    payload = {"model": resolved.model, "input": cleaned}

    for attempt in range(resolved.retries + 1):
        try:
            response = post_json(resolved.url, payload, headers, resolved.timeout_seconds)
            return _parse_vectors(response, len(cleaned), resolved.dimension)
        except EmbeddingError as exc:
            if not exc.retryable or attempt >= resolved.retries:
                raise
            sleep(min(0.5 * (2**attempt), 2.0))
    raise AssertionError("Embedding retry loop exited unexpectedly.")
