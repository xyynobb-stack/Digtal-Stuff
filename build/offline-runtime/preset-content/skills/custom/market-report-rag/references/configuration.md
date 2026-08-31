# 检索配置

此配置固定了 MVP 的证据边界和真实 Milvus Schema；仅地址、凭据和超时允许通过环境变量调整。

```dotenv
EMBEDDING_API_URL=http://183.230.227.10:8003/v1/embeddings
EMBEDDING_MODEL=bge-m3
EMBEDDING_DIMENSION=1024
MILVUS_URI=http://183.230.227.10:19530
MILVUS_DATABASE=default
MILVUS_COLLECTION=my_skill_kb
MILVUS_VECTOR_FIELD=embedding
MILVUS_VECTOR_DTYPE=float16
MILVUS_TEXT_FIELD=text
MILVUS_SOURCE_FIELD=source
MILVUS_OUTPUT_FIELDS=text,source
MILVUS_METRIC_TYPE=COSINE
RAG_TOP_K=6
RAG_REQUEST_TIMEOUT_SECONDS=30
```

`my_skill_kb` 当前字段为 `id VarChar(64)`、`text VarChar(8192)`、`embedding Float16Vector(1024)`、`source VarChar(512)`；`embedding` 使用 AUTOINDEX 与 COSINE。管理页端口 `9867` 只用于查看 Schema，不是 pymilvus 连接地址。
