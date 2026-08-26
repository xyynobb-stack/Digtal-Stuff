"""One-shot Agent-side MVP retrieval: embed queries, then search Milvus."""

from __future__ import annotations

import argparse
import json
import os
import sys
from dataclasses import dataclass
from typing import Any, Callable, Mapping, Sequence

from embedding_client import EmbeddingError, embed_texts, load_embedding_config


DEFAULT_MILVUS_URI = "http://183.230.227.10:19530"
DEFAULT_MILVUS_DATABASE = "default"
REQUIRED_MILVUS_COLLECTION = "my_skill_kb"
DEFAULT_MILVUS_COLLECTION = REQUIRED_MILVUS_COLLECTION
DEFAULT_MILVUS_VECTOR_FIELD = "embedding"
DEFAULT_MILVUS_TEXT_FIELD = "text"
DEFAULT_MILVUS_SOURCE_FIELD = "source"
DEFAULT_MILVUS_METRIC_TYPE = "IP"


class RagClientError(RuntimeError):
    """Expected configuration, dependency, or retrieval failure."""

    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


@dataclass(frozen=True)
class MilvusConfig:
    uri: str
    token: str
    database: str
    collection: str
    vector_field: str | None
    output_fields: tuple[str, ...]
    text_field: str | None
    source_field: str | None
    filter_expression: str
    metric_type: str | None
    timeout_seconds: float
    default_top_k: int


# @lat: [[lat.md/rag-mvp#Configuration boundary]]
def load_milvus_config(env: Mapping[str, str] | None = None) -> MilvusConfig:
    """Resolve the MVP schema and reject any alternate evidence collection."""

    values = os.environ if env is None else env
    uri = values.get("MILVUS_URI", DEFAULT_MILVUS_URI).strip()
    token = values.get("MILVUS_TOKEN", "").strip()
    database = values.get("MILVUS_DATABASE", DEFAULT_MILVUS_DATABASE).strip()
    configured_collection = values.get(
        "MILVUS_COLLECTION", REQUIRED_MILVUS_COLLECTION
    ).strip()
    collection = REQUIRED_MILVUS_COLLECTION
    if not uri or not database or not configured_collection:
        raise RagClientError(
            "CONFIGURATION_ERROR",
            "MILVUS_URI, MILVUS_DATABASE, and MILVUS_COLLECTION cannot be empty.",
        )
    if configured_collection != REQUIRED_MILVUS_COLLECTION:
        raise RagClientError(
            "COLLECTION_MISMATCH",
            "MILVUS_COLLECTION must be my_skill_kb for this Skill; alternate "
            f"collection {configured_collection!r} is not allowed.",
        )
    try:
        timeout_seconds = float(values.get("RAG_REQUEST_TIMEOUT_SECONDS", "30"))
        default_top_k = int(values.get("RAG_TOP_K", "6"))
    except ValueError as exc:
        raise RagClientError(
            "CONFIGURATION_ERROR",
            "RAG_REQUEST_TIMEOUT_SECONDS and RAG_TOP_K must be numeric.",
        ) from exc
    if timeout_seconds <= 0 or not 1 <= default_top_k <= 50:
        raise RagClientError(
            "CONFIGURATION_ERROR",
            "Timeout must be positive and RAG_TOP_K must be between 1 and 50.",
        )
    output_fields = tuple(
        field.strip()
        for field in values.get("MILVUS_OUTPUT_FIELDS", "text,source").split(",")
        if field.strip()
    )
    return MilvusConfig(
        uri=uri,
        token=token,
        database=database,
        collection=collection,
        vector_field=(
            values.get("MILVUS_VECTOR_FIELD", DEFAULT_MILVUS_VECTOR_FIELD).strip()
            or None
        ),
        output_fields=output_fields,
        text_field=(
            values.get("MILVUS_TEXT_FIELD", DEFAULT_MILVUS_TEXT_FIELD).strip()
            or None
        ),
        source_field=(
            values.get("MILVUS_SOURCE_FIELD", DEFAULT_MILVUS_SOURCE_FIELD).strip()
            or None
        ),
        filter_expression=values.get("MILVUS_FILTER", "").strip(),
        metric_type=(
            values.get("MILVUS_METRIC_TYPE", DEFAULT_MILVUS_METRIC_TYPE).strip()
            or None
        ),
        timeout_seconds=timeout_seconds,
        default_top_k=default_top_k,
    )


def _load_milvus_client_factory() -> Callable[..., Any]:
    try:
        from pymilvus import MilvusClient
    except ImportError as exc:
        raise RagClientError(
            "DEPENDENCY_ERROR",
            "pymilvus is not installed in the Hermes Python environment.",
        ) from exc
    return MilvusClient


def _json_safe(value: Any) -> Any:
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    if isinstance(value, Mapping):
        return {str(key): _json_safe(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [_json_safe(item) for item in value]
    if hasattr(value, "to_dict"):
        try:
            return _json_safe(value.to_dict())
        except Exception:
            pass
    return str(value)


def _hit_value(hit: Any, key: str, default: Any = None) -> Any:
    if isinstance(hit, Mapping):
        return hit.get(key, default)
    return getattr(hit, key, default)


def _normalize_hit(hit: Any, config: MilvusConfig) -> dict[str, Any]:
    entity = _hit_value(hit, "entity", {})
    safe_entity = _json_safe(entity)
    result = {
        "id": _json_safe(_hit_value(hit, "id")),
        "distance": _json_safe(
            _hit_value(hit, "distance", _hit_value(hit, "score"))
        ),
        "entity": safe_entity,
    }
    if isinstance(safe_entity, Mapping):
        if config.text_field and config.text_field in safe_entity:
            result["text"] = safe_entity[config.text_field]
        if config.source_field and config.source_field in safe_entity:
            result["source"] = safe_entity[config.source_field]
    return result


# @lat: [[lat.md/rag-mvp#Runtime flow#Milvus search]]
def retrieve(
    queries: Sequence[str],
    *,
    top_k: int | None = None,
    env: Mapping[str, str] | None = None,
    embedder: Callable[..., list[list[float]]] = embed_texts,
    client_factory: Callable[..., Any] | None = None,
) -> dict[str, Any]:
    """Embed all queries once and search them in one short-lived Milvus client."""

    cleaned = [query.strip() for query in queries]
    if not cleaned or any(not query for query in cleaned):
        raise RagClientError("INPUT_ERROR", "At least one non-empty query is required.")
    config = load_milvus_config(env)
    resolved_top_k = config.default_top_k if top_k is None else top_k
    if not 1 <= resolved_top_k <= 50:
        raise RagClientError("INPUT_ERROR", "top-k must be between 1 and 50.")

    embedding_config = load_embedding_config(env)
    factory = client_factory or _load_milvus_client_factory()
    vectors = embedder(cleaned, config=embedding_config)
    client = None
    try:
        client_kwargs: dict[str, Any] = {
            "uri": config.uri,
            "db_name": config.database,
            "timeout": config.timeout_seconds,
        }
        if config.token:
            client_kwargs["token"] = config.token
        client = factory(
            **client_kwargs,
        )
        search_kwargs: dict[str, Any] = {
            "collection_name": config.collection,
            "data": vectors,
            "limit": resolved_top_k,
            "timeout": config.timeout_seconds,
        }
        if config.vector_field:
            search_kwargs["anns_field"] = config.vector_field
        if config.output_fields:
            search_kwargs["output_fields"] = list(config.output_fields)
        if config.filter_expression:
            search_kwargs["filter"] = config.filter_expression
        if config.metric_type:
            search_kwargs["search_params"] = {"metric_type": config.metric_type}
        raw_results = client.search(**search_kwargs)
    except RagClientError:
        raise
    except Exception as exc:
        safe_message = str(exc)
        if config.token:
            safe_message = safe_message.replace(config.token, "***")
        raise RagClientError(
            "MILVUS_SEARCH_ERROR", f"Milvus search failed: {safe_message}"
        ) from exc
    finally:
        if client is not None:
            try:
                client.close()
            except Exception:
                pass

    if not isinstance(raw_results, list) or len(raw_results) != len(cleaned):
        raise RagClientError(
            "MILVUS_RESPONSE_ERROR",
            "Milvus returned a result shape that does not match the query batch.",
        )
    groups = []
    for query, hits in zip(cleaned, raw_results):
        if not isinstance(hits, (list, tuple)):
            raise RagClientError(
                "MILVUS_RESPONSE_ERROR", "Milvus hit group must be an array."
            )
        groups.append(
            {"query": query, "hits": [_normalize_hit(hit, config) for hit in hits]}
        )
    return {
        "ok": True,
        "database": config.database,
        "collection": config.collection,
        "embedding_model": embedding_config.model,
        "top_k": resolved_top_k,
        "results": groups,
    }


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Embed text with bge-m3 and search the configured Milvus collection."
    )
    parser.add_argument(
        "--query", action="append", default=[], help="Search query; repeat for batching."
    )
    parser.add_argument("--top-k", type=int, default=None)
    parser.add_argument(
        "--check-config",
        action="store_true",
        help="Validate required configuration without contacting remote services.",
    )
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    try:
        milvus_config = load_milvus_config()
        embedding_config = load_embedding_config()
        if args.check_config:
            payload = {
                "ok": True,
                "configuration": {
                    "collection": milvus_config.collection,
                    "database": milvus_config.database,
                    "milvus_uri": milvus_config.uri,
                    "embedding_api_url": embedding_config.url,
                    "embedding_model": embedding_config.model,
                    "embedding_dimension": embedding_config.dimension,
                    "vector_field": milvus_config.vector_field,
                    "output_fields": list(milvus_config.output_fields),
                    "text_field": milvus_config.text_field,
                    "source_field": milvus_config.source_field,
                    "metric_type": milvus_config.metric_type,
                    "token_configured": bool(milvus_config.token),
                },
            }
        else:
            payload = retrieve(args.query, top_k=args.top_k)
        print(json.dumps(payload, ensure_ascii=False))
        return 0
    except EmbeddingError as exc:
        payload = {"ok": False, "error": {"code": exc.code, "message": str(exc)}}
    except RagClientError as exc:
        payload = {"ok": False, "error": {"code": exc.code, "message": str(exc)}}
    except Exception as exc:
        payload = {
            "ok": False,
            "error": {"code": "UNEXPECTED_ERROR", "message": str(exc)},
        }
    print(json.dumps(payload, ensure_ascii=False), file=sys.stderr)
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
