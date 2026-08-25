"""Offline tests for the Desktop-managed market report RAG skill."""

from __future__ import annotations

import importlib
import io
import sys
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from unittest.mock import patch


SKILL_SCRIPTS = (
    Path(__file__).resolve().parents[2]
    / "resources"
    / "hermes-agent-overlays"
    / "skills"
    / "research"
    / "market-report-rag"
    / "scripts"
)
sys.path.insert(0, str(SKILL_SCRIPTS))
embedding_client = importlib.import_module("embedding_client")
rag_client = importlib.import_module("rag_client")


VALID_ENV = {
    "MILVUS_URI": "http://milvus.example:19530",
    "MILVUS_TOKEN": "test-token",
    "MILVUS_COLLECTION": "knowledge_chunks",
    "MILVUS_TEXT_FIELD": "content",
    "MILVUS_SOURCE_FIELD": "document_id",
    "EMBEDDING_API_URL": "http://embedding.example/v1/embeddings",
    "EMBEDDING_MODEL": "bge-m3",
}


class FakeMilvusClient:
    def __init__(self, **kwargs):
        self.init_kwargs = kwargs
        self.search_calls = []
        self.closed = False

    def search(self, **kwargs):
        self.search_calls.append(kwargs)
        return [
            [
                {
                    "id": index + 10,
                    "distance": 0.9 - index * 0.1,
                    "entity": {
                        "content": f"evidence-{index}",
                        "document_id": f"doc-{index}",
                    },
                }
            ]
            for index in range(len(kwargs["data"]))
        ]

    def close(self):
        self.closed = True


class EmbeddingClientTests(unittest.TestCase):
    # @lat: [[lat.md/rag-mvp#Tests#Embedding batching and validation]]
    def test_embedding_batch_is_one_request_and_restores_index_order(self):
        calls = []

        def post_json(url, payload, headers, timeout):
            calls.append((url, payload, headers, timeout))
            return {
                "data": [
                    {"index": 1, "embedding": [3, 4]},
                    {"index": 0, "embedding": [1, 2]},
                ]
            }

        config = embedding_client.EmbeddingConfig(
            "http://embedding.example/v1/embeddings", "bge-m3", None, 5, 0, 2
        )
        vectors = embedding_client.embed_texts(
            ["first", "second"], config=config, post_json=post_json
        )

        self.assertEqual(vectors, [[1.0, 2.0], [3.0, 4.0]])
        self.assertEqual(len(calls), 1)
        self.assertEqual(calls[0][1], {"model": "bge-m3", "input": ["first", "second"]})

    def test_embedding_retries_only_retryable_errors(self):
        attempts = []
        sleeps = []

        def post_json(*_args):
            attempts.append(1)
            if len(attempts) == 1:
                raise embedding_client.EmbeddingError(
                    "EMBEDDING_UNAVAILABLE", "temporary", retryable=True
                )
            return {"data": [{"index": 0, "embedding": [1]}]}

        config = embedding_client.EmbeddingConfig("url", "model", None, 5, 1, 1)
        vectors = embedding_client.embed_texts(
            ["query"], config=config, post_json=post_json, sleep=sleeps.append
        )

        self.assertEqual(vectors, [[1.0]])
        self.assertEqual(len(attempts), 2)
        self.assertEqual(sleeps, [0.5])

    def test_embedding_rejects_vector_that_does_not_match_collection_dimension(self):
        config = embedding_client.EmbeddingConfig("url", "model", None, 5, 0, 1024)
        with self.assertRaisesRegex(
            embedding_client.EmbeddingError, "Expected 1024-dimensional"
        ):
            embedding_client.embed_texts(
                ["query"],
                config=config,
                post_json=lambda *_args: {
                    "data": [{"index": 0, "embedding": [1.0, 2.0]}]
                },
            )


class RagClientTests(unittest.TestCase):
    # @lat: [[lat.md/rag-mvp#Tests#Connection configuration fails before network access]]
    def test_empty_uri_fails_before_embedding_or_client_creation(self):
        called = {"embedder": False, "factory": False}

        def embedder(*_args, **_kwargs):
            called["embedder"] = True
            return [[1.0]]

        def factory(**_kwargs):
            called["factory"] = True
            return FakeMilvusClient()

        env = dict(VALID_ENV)
        env["MILVUS_URI"] = ""
        with self.assertRaisesRegex(rag_client.RagClientError, "MILVUS_URI"):
            rag_client.retrieve(
                ["query"], env=env, embedder=embedder, client_factory=factory
            )

        self.assertEqual(called, {"embedder": False, "factory": False})

    def test_known_test_schema_is_the_default(self):
        config = rag_client.load_milvus_config({})

        self.assertEqual(config.database, "default")
        self.assertEqual(config.collection, "my_skill_kb")
        self.assertEqual(config.vector_field, "embedding")
        self.assertEqual(config.output_fields, ("text", "source"))
        self.assertEqual(config.text_field, "text")
        self.assertEqual(config.source_field, "source")
        self.assertEqual(config.metric_type, "IP")
        self.assertEqual(config.token, "")

    def test_empty_token_is_not_passed_to_client(self):
        instances = []

        def factory(**kwargs):
            instance = FakeMilvusClient(**kwargs)
            instances.append(instance)
            return instance

        rag_client.retrieve(
            ["query"],
            env={},
            embedder=lambda *_args, **_kwargs: [[1.0] * 1024],
            client_factory=factory,
        )

        self.assertNotIn("token", instances[0].init_kwargs)

    def test_missing_dependency_fails_before_embedding(self):
        called = {"embedder": False}

        def embedder(*_args, **_kwargs):
            called["embedder"] = True
            return [[1.0]]

        with patch.object(
            rag_client,
            "_load_milvus_client_factory",
            side_effect=rag_client.RagClientError("DEPENDENCY_ERROR", "missing"),
        ):
            with self.assertRaisesRegex(rag_client.RagClientError, "missing"):
                rag_client.retrieve(["query"], env=VALID_ENV, embedder=embedder)
        self.assertFalse(called["embedder"])

    # @lat: [[lat.md/rag-mvp#Tests#One-shot retrieval has no shared client state]]
    def test_retrieve_batches_queries_and_closes_one_client(self):
        instances = []
        embed_calls = []

        def embedder(texts, **_kwargs):
            embed_calls.append(list(texts))
            return [[1.0, 2.0], [3.0, 4.0]]

        def factory(**kwargs):
            instance = FakeMilvusClient(**kwargs)
            instances.append(instance)
            return instance

        result = rag_client.retrieve(
            ["rules", "quality"],
            top_k=4,
            env=VALID_ENV,
            embedder=embedder,
            client_factory=factory,
        )

        self.assertTrue(result["ok"])
        self.assertEqual(embed_calls, [["rules", "quality"]])
        self.assertEqual(len(instances), 1)
        self.assertTrue(instances[0].closed)
        self.assertEqual(len(instances[0].search_calls), 1)
        search_call = instances[0].search_calls[0]
        self.assertEqual(search_call["limit"], 4)
        self.assertEqual(search_call["anns_field"], "embedding")
        self.assertEqual(search_call["output_fields"], ["text", "source"])
        self.assertEqual(search_call["search_params"], {"metric_type": "IP"})
        self.assertEqual(instances[0].init_kwargs["db_name"], "default")
        self.assertEqual(result["results"][0]["hits"][0]["text"], "evidence-0")
        self.assertEqual(result["results"][1]["hits"][0]["source"], "doc-1")
        self.assertNotIn("test-token", str(result))

    def test_client_closes_when_search_fails(self):
        class FailingClient(FakeMilvusClient):
            def search(self, **kwargs):
                raise RuntimeError("boom")

        instance = FailingClient()
        with self.assertRaisesRegex(rag_client.RagClientError, "Milvus search failed"):
            rag_client.retrieve(
                ["query"],
                env=VALID_ENV,
                embedder=lambda *_args, **_kwargs: [[1.0]],
                client_factory=lambda **_kwargs: instance,
            )
        self.assertTrue(instance.closed)

    def test_search_error_redacts_token(self):
        class SecretEchoClient(FakeMilvusClient):
            def search(self, **kwargs):
                raise RuntimeError(f"authorization failed for {VALID_ENV['MILVUS_TOKEN']}")

        with self.assertRaises(rag_client.RagClientError) as raised:
            rag_client.retrieve(
                ["query"],
                env=VALID_ENV,
                embedder=lambda *_args, **_kwargs: [[1.0]],
                client_factory=lambda **_kwargs: SecretEchoClient(),
            )
        self.assertNotIn(VALID_ENV["MILVUS_TOKEN"], str(raised.exception))
        self.assertIn("***", str(raised.exception))

    def test_config_check_never_imports_or_connects_to_milvus(self):
        with patch.dict(rag_client.os.environ, VALID_ENV, clear=True), patch.object(
            rag_client, "_load_milvus_client_factory"
        ) as factory, redirect_stdout(io.StringIO()) as stdout:
            exit_code = rag_client.main(["--check-config"])
        self.assertEqual(exit_code, 0)
        self.assertIn('"token_configured": true', stdout.getvalue())
        factory.assert_not_called()


if __name__ == "__main__":
    unittest.main()
