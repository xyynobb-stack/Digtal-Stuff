# MVP Configuration

Configure the retrieval client through environment variables so credentials and the unfinished collection schema are not committed to the Desktop repository.

## Optional credential

```dotenv
MILVUS_TOKEN=replace_with_runtime_secret
```

The token remains outside the repository. The current test server was reachable without authentication during MVP verification, so the client omits the token when this value is absent. Configure it when Milvus authentication is enabled.

## Endpoint defaults

```dotenv
EMBEDDING_API_URL=http://183.230.227.10:8003/v1/embeddings
EMBEDDING_MODEL=bge-m3
MILVUS_URI=http://183.230.227.10:19530
MILVUS_DATABASE=default
MILVUS_COLLECTION=my_skill_kb
MILVUS_VECTOR_FIELD=embedding
MILVUS_OUTPUT_FIELDS=text,source
MILVUS_TEXT_FIELD=text
MILVUS_SOURCE_FIELD=source
MILVUS_METRIC_TYPE=IP
EMBEDDING_DIMENSION=1024
```

The Milvus administration page is `http://183.230.227.10:9867/#/databases/default/my_skill_kb/schema`; it is for inspection, not the Python client connection. Override the values above when services or the collection move. `EMBEDDING_API_KEY` is optional and, when set, is sent as a bearer token.

## Collection schema values

The current test schema is:

| Field       | Milvus type         | Use                                           |
| ----------- | ------------------- | --------------------------------------------- |
| `id`        | `VarChar(128)`      | Primary key, returned as hit id               |
| `text`      | `VarChar(8192)`     | Evidence text injected into the model context |
| `embedding` | `FloatVector(1024)` | Query search vector field                     |
| `source`    | `VarChar(512)`      | Evidence source identifier                    |

The `embedding` index is `IVF_FLAT` with metric `IP`. `MILVUS_OUTPUT_FIELDS` deliberately defaults to `text,source` instead of `*`, so the 1024-dimensional stored vector is not returned to the Agent. `MILVUS_FILTER` remains optional.

## Runtime controls

```dotenv
RAG_TOP_K=6
RAG_REQUEST_TIMEOUT_SECONDS=30
RAG_EMBEDDING_RETRIES=2
```

The MVP uses whole stored chunks and does not truncate their text. Keep chunks reasonably sized during indexing and keep `RAG_TOP_K` small enough for the model's evidence budget.

Install the only additional Python dependency into the same Python environment that runs Hermes:

```bash
python -m pip install -r "${HERMES_SKILL_DIR}/requirements.txt"
```

Do this during Desktop runtime packaging or administrator setup, not automatically during a user query.
