import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import {
  authorizationUrl,
  createFeishuOAuthService,
  decryptToken,
  encryptToken,
  openDatabase,
  readConfig,
  stateHash,
} from "./server.mjs";

const encryptionKey = Buffer.alloc(32, 7);
const config = {
  appId: "test-app",
  appSecret: "test-secret",
  redirectUri:
    "http://183.230.226.81:5082/api/integrations/feishu/oauth/callback",
  encryptionKey,
  host: "127.0.0.1",
  port: 8787,
  databasePath: ":memory:",
};

test("document routes isolate users, paginate, append and guard edits", async () => {
  const database = openDatabase(":memory:");
  for (const employee of ["alice", "bob"]) {
    database
      .prepare(
        `INSERT INTO feishu_connections (employee_user_id, access_token_encrypted, access_expires_at, scopes, connection_token_hash, status, created_at, updated_at) VALUES (?, ?, ?, 'drive:drive docx:document', ?, 'connected', 1, 1)`,
      )
      .run(
        employee,
        encryptToken(`${employee}-access`, encryptionKey),
        10_000_000,
        stateHash(`${employee}-connection`),
      );
  }
  const calls = [];
  let richText = false;
  let failure = false;
  const fetchImpl = async (input, options) => {
    const url = new URL(input);
    calls.push({ url, options });
    if (failure)
      return Response.json({
        code: 99991672,
        msg: "sensitive upstream message",
      });
    assert.ok(
      ["Bearer alice-access", "Bearer bob-access"].includes(
        options.headers.Authorization,
      ),
    );
    if (url.pathname.endsWith("/raw_content"))
      return Response.json({ code: 0, data: { content: "测试文档正文" } });
    if (url.pathname.endsWith("/children")) {
      assert.equal(options.method, "POST");
      assert.deepEqual(JSON.parse(options.body), {
        index: -1,
        children: [
          {
            block_type: 2,
            text: { elements: [{ text_run: { content: "追加" } }] },
          },
        ],
      });
      return Response.json({
        code: 0,
        data: { children: [{ block_id: "newblock" }] },
      });
    }
    if (url.pathname.endsWith("/blocks/b1")) {
      assert.equal(url.searchParams.get("document_revision_id"), "7");
      if (options.method === "PATCH") {
        assert.deepEqual(JSON.parse(options.body), {
          update_text_elements: {
            elements: [{ text_run: { content: "新内容" } }],
          },
        });
        return Response.json({ code: 0, data: { document_revision_id: 8 } });
      }
      return Response.json({
        code: 0,
        data: {
          block: {
            block_type: 2,
            text: {
              elements: richText
                ? [{ mention_user: { user_id: "other" } }]
                : [{ text_run: { content: "旧内容" } }],
            },
          },
        },
      });
    }
    if (url.pathname.endsWith("/blocks")) {
      assert.equal(url.searchParams.get("page_size"), "50");
      assert.equal(url.searchParams.get("page_token"), "next");
      return Response.json({
        code: 0,
        data: {
          items: [{ block_id: "b1" }],
          has_more: true,
          page_token: "page2",
        },
      });
    }
    assert.equal(url.pathname, "/open-apis/docx/v1/documents/doc1");
    return Response.json({ code: 0, data: { document: { revision_id: 7 } } });
  };
  const service = createFeishuOAuthService({
    config,
    database,
    fetchImpl,
    now: () => 1000,
  });
  const server = createServer(service.handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}/api/integrations/feishu/drive/documents/doc1`;
  const request = (suffix, method = "GET", body, employee = "alice") =>
    fetch(base + suffix, {
      method,
      headers: {
        Authorization: `Bearer ${employee}-connection`,
        "Content-Type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  try {
    assert.equal((await fetch(base + "/content")).status, 401);
    assert.equal(calls.length, 0);
    for (const employee of ["alice", "bob"]) {
      const response = await request(
        "/content?offset=1&limit=2",
        "GET",
        undefined,
        employee,
      );
      assert.deepEqual(await response.json(), {
        document_id: "doc1",
        content: "试文",
        total_chars: 6,
        next_offset: 3,
      });
      assert.equal(
        calls.at(-1).options.headers.Authorization,
        `Bearer ${employee}-access`,
      );
    }
    assert.equal((await request("/content?offset=-1")).status, 400);
    assert.equal(
      (await (await request("/blocks?page_token=next")).json()).page_token,
      "page2",
    );
    assert.equal(
      (await request("/append", "POST", { text: "追加" })).status,
      200,
    );
    assert.equal(
      (await request("/append", "POST", { text: "x".repeat(2001) })).status,
      400,
    );
    assert.equal(
      (await request("/blocks/b1", "PATCH", { text: "新内容" })).status,
      400,
    );
    assert.equal(
      (
        await request("/blocks/b1", "PATCH", {
          text: "新内容",
          expected_text: "不匹配",
        })
      ).status,
      409,
    );
    assert.equal(
      calls.filter((call) => call.options.method === "PATCH").length,
      0,
    );
    richText = true;
    assert.equal(
      (
        await request("/blocks/b1", "PATCH", {
          text: "新内容",
          expected_text: "旧内容",
        })
      ).status,
      400,
    );
    richText = false;
    assert.equal(
      (
        await request("/blocks/b1", "PATCH", {
          text: "新内容",
          expected_text: "旧内容",
        })
      ).status,
      200,
    );
    assert.equal(
      calls.filter((call) => call.options.method === "PATCH").length,
      1,
    );
    failure = true;
    const denied = await request("/content");
    assert.equal(denied.status, 502);
    assert.deepEqual(await denied.json(), {
      error: "document_permission_denied_or_scope_missing_reauthorize",
      upstream_code: 99991672,
    });
  } finally {
    await new Promise((resolve) => server.close(resolve));
    database.close();
  }
});

test("tokens round-trip through AES-GCM encryption", () => {
  const encrypted = encryptToken("token-value", encryptionKey);
  assert.notEqual(encrypted, "token-value");
  assert.equal(decryptToken(encrypted, encryptionKey), "token-value");
});

test("authorization URL requests user Drive and refresh scopes", () => {
  const url = new URL(
    authorizationUrl({
      appId: config.appId,
      redirectUri: config.redirectUri,
      state: "random-state",
    }),
  );
  assert.equal(url.searchParams.get("client_id"), config.appId);
  assert.equal(url.searchParams.get("redirect_uri"), config.redirectUri);
  assert.equal(
    url.searchParams.get("scope"),
    "drive:drive drive:file:download drive:file:upload docx:document sheets:spreadsheet bitable:app offline_access",
  );
  assert.equal(url.searchParams.get("state"), "random-state");
});

test("state hashes are stable without storing the raw OAuth state", () => {
  assert.equal(stateHash("value"), stateHash("value"));
  assert.notEqual(stateHash("value"), "value");
});

test("server configuration accepts HTTP callbacks but rejects other protocols", () => {
  const env = {
    FEISHU_APP_ID: "test-app",
    FEISHU_APP_SECRET: "test-secret",
    FEISHU_TOKEN_ENCRYPTION_KEY: encryptionKey.toString("base64"),
    FEISHU_REDIRECT_URI:
      "http://183.230.226.81:5082/api/integrations/feishu/oauth/callback",
  };
  assert.equal(readConfig(env).redirectUri, env.FEISHU_REDIRECT_URI);
  assert.throws(
    () => readConfig({ ...env, FEISHU_REDIRECT_URI: "file:///tmp/callback" }),
    /HTTP or HTTPS/,
  );
});

test("service initializes the required SQLite tables", () => {
  const database = openDatabase(":memory:");
  const service = createFeishuOAuthService({ config, database });
  const tables = service.database
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
    )
    .all()
    .map((row) => row.name);
  assert.deepEqual(tables, ["feishu_connections", "feishu_oauth_requests"]);
  database.close();
});

test("start, callback, and status complete one employee authorization", async () => {
  const database = openDatabase(":memory:");
  const fetchImpl = async (url) => {
    if (String(url).endsWith("/oauth/token")) {
      return Response.json({
        access_token: "user-access-token",
        refresh_token: "user-refresh-token",
        expires_in: 7200,
        refresh_token_expires_in: 604800,
        scope: "drive:drive offline_access",
      });
    }
    if (String(url).endsWith("/user_info")) {
      return Response.json({
        code: 0,
        data: {
          open_id: "ou_test",
          union_id: "on_test",
          tenant_key: "tenant_test",
        },
      });
    }
    throw new Error(`unexpected fetch: ${url}`);
  };
  const service = createFeishuOAuthService({
    config,
    database,
    fetchImpl,
    now: () => 1_000_000,
  });
  const server = createServer(service.handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.equal(typeof address, "object");
  const origin = `http://127.0.0.1:${address.port}`;

  try {
    const startResponse = await fetch(
      `${origin}/api/integrations/feishu/oauth/start`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ employee_user_id: "employee-1" }),
      },
    );
    assert.equal(startResponse.status, 200);
    const started = await startResponse.json();
    const state = new URL(started.authorization_url).searchParams.get("state");
    assert.ok(state);

    const callbackResponse = await fetch(
      `${origin}/api/integrations/feishu/oauth/callback?code=test-code&state=${encodeURIComponent(state)}`,
    );
    assert.equal(callbackResponse.status, 200);

    const statusResponse = await fetch(
      `${origin}/api/integrations/feishu/oauth/status?request_id=${encodeURIComponent(started.request_id)}`,
    );
    const connected = await statusResponse.json();
    assert.equal(connected.status, "connected");
    assert.match(connected.connection_token, /^[A-Za-z0-9_-]{40,}$/);

    const stored = database
      .prepare(
        `SELECT employee_user_id, access_token_encrypted, connection_token_hash
         FROM feishu_connections`,
      )
      .get();
    assert.equal(stored.employee_user_id, "employee-1");
    assert.notEqual(stored.access_token_encrypted, "user-access-token");
    assert.equal(
      decryptToken(stored.access_token_encrypted, encryptionKey),
      "user-access-token",
    );
    assert.equal(
      stored.connection_token_hash,
      stateHash(connected.connection_token),
    );
  } finally {
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    database.close();
  }
});

test("personal Drive proxy requires a connection token and uses the user token", async () => {
  const database = openDatabase(":memory:");
  const connectionToken = "desktop-connection-token";
  database
    .prepare(
      `INSERT INTO feishu_connections (
        employee_user_id, access_token_encrypted, access_expires_at, scopes,
        connection_token_hash, status, created_at, updated_at
      ) VALUES (?, ?, ?, 'drive:drive', ?, 'connected', ?, ?)`,
    )
    .run(
      "employee-1",
      encryptToken("user-access-token", encryptionKey),
      10_000_000,
      stateHash(connectionToken),
      1_000_000,
      1_000_000,
    );
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    assert.equal(options.headers.Authorization, "Bearer user-access-token");
    if (String(url).endsWith("/root_folder/meta")) {
      return Response.json({ code: 0, data: { token: "root-token" } });
    }
    if (String(url).includes("/files/create_folder")) {
      assert.deepEqual(JSON.parse(options.body), {
        name: "资料",
        folder_token: "root-token",
      });
      return Response.json({ code: 0, data: { token: "folder-token" } });
    }
    if (String(url).endsWith("/files/upload_all")) {
      assert.equal(options.body.get("parent_node"), "root-token");
      assert.equal(options.body.get("file_name"), "hello.txt");
      return Response.json({ code: 0, data: { file_token: "uploaded" } });
    }
    if (String(url).endsWith("/drive/v1/files/file-token/download")) {
      return new Response(Buffer.from("# 飞书 Markdown", "utf8"), {
        headers: {
          "content-type": "text/markdown; charset=utf-8",
          "content-length": String(Buffer.byteLength("# 飞书 Markdown")),
        },
      });
    }
    if (options.method === "DELETE") {
      assert.match(String(url), /\/files\/file-token\?type=file$/);
      return Response.json({ code: 0, data: {} });
    }
    if (String(url).includes("/drive/v1/files")) {
      assert.match(String(url), /folder_token=root-token/);
      return Response.json({
        code: 0,
        data: { files: [{ token: "file-token", type: "file" }] },
      });
    }
    throw new Error(`unexpected fetch: ${url}`);
  };
  const service = createFeishuOAuthService({
    config,
    database,
    fetchImpl,
    now: () => 1_000_000,
  });
  const server = createServer(service.handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.equal(typeof address, "object");
  const origin = `http://127.0.0.1:${address.port}`;
  const headers = { Authorization: `Bearer ${connectionToken}` };

  try {
    const unauthorized = await fetch(
      `${origin}/api/integrations/feishu/drive/root`,
    );
    assert.equal(unauthorized.status, 401);

    const root = await fetch(`${origin}/api/integrations/feishu/drive/root`, {
      headers,
    });
    assert.deepEqual(await root.json(), { token: "root-token" });

    const list = await fetch(
      `${origin}/api/integrations/feishu/drive/files?folder_token=root-token&page_size=20`,
      { headers },
    );
    assert.equal((await list.json()).files[0].token, "file-token");

    const folder = await fetch(
      `${origin}/api/integrations/feishu/drive/folders`,
      {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ name: "资料", folder_token: "root-token" }),
      },
    );
    assert.equal((await folder.json()).token, "folder-token");

    const upload = await fetch(
      `${origin}/api/integrations/feishu/drive/files/upload`,
      {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({
          file_name: "hello.txt",
          parent_node: "root-token",
          content_base64: Buffer.from("hello").toString("base64"),
        }),
      },
    );
    assert.equal((await upload.json()).file_token, "uploaded");

    const downloaded = await fetch(
      `${origin}/api/integrations/feishu/drive/files/file-token/content`,
      { headers },
    );
    const downloadedBody = await downloaded.json();
    assert.equal(downloaded.status, 200);
    assert.equal(downloadedBody.content_type, "text/markdown; charset=utf-8");
    assert.equal(
      Buffer.from(downloadedBody.content_base64, "base64").toString("utf8"),
      "# 飞书 Markdown",
    );

    const deleted = await fetch(
      `${origin}/api/integrations/feishu/drive/files/file-token?type=file`,
      { method: "DELETE", headers },
    );
    assert.equal(deleted.status, 200);
    assert.equal(calls.length, 6);
  } finally {
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    database.close();
  }
});

test("shared document search and spreadsheet value routes use the connected user token", async () => {
  const database = openDatabase(":memory:");
  const connectionToken = "sheet-connection-token";
  database
    .prepare(
      `INSERT INTO feishu_connections (
        employee_user_id, feishu_open_id, access_token_encrypted, access_expires_at, scopes,
        connection_token_hash, status, created_at, updated_at
      ) VALUES (?, 'ou-current', ?, ?, 'drive:drive sheets:spreadsheet', ?, 'connected', ?, ?)`,
    )
    .run(
      "employee-sheet",
      encryptToken("sheet-user-access-token", encryptionKey),
      10_000_000,
      stateHash(connectionToken),
      1_000_000,
      1_000_000,
    );
  const calls = [];
  const fetchImpl = async (input, options = {}) => {
    const url = new URL(input);
    calls.push({ url, options });
    assert.equal(
      options.headers.Authorization,
      "Bearer sheet-user-access-token",
    );
    if (url.pathname.endsWith("/suite/docs-api/search/object")) {
      assert.equal(options.method, "POST");
      assert.deepEqual(JSON.parse(options.body), {
        search_key: "共享报告",
        count: 20,
        offset: 0,
        docs_types: ["sheet", "docx"],
      });
      return Response.json({
        code: 0,
        data: {
          docs_entities: [
            {
              docs_token: "shared-sheet",
              docs_type: "sheet",
              owner_id: "ou-current",
            },
          ],
        },
      });
    }
    if (url.pathname.includes("/spreadsheets/denied/metainfo")) {
      return Response.json(
        { code: 99991679, msg: "missing bitable scope" },
        { status: 403 },
      );
    }
    if (url.pathname.endsWith("/metainfo")) {
      return Response.json({
        code: 0,
        data: { properties: { title: "共享表" } },
      });
    }
    if (
      url.pathname.endsWith(
        "/bitable/v1/apps/base-token/tables/tblCalendar/records",
      )
    ) {
      assert.equal(url.searchParams.get("page_size"), "50");
      assert.equal(url.searchParams.get("page_token"), "next-page");
      assert.equal(url.searchParams.get("user_id_type"), "open_id");
      return Response.json({
        code: 0,
        data: { items: [{ record_id: "rec-1", fields: { 标题: "例会" } }] },
      });
    }
    if (
      url.pathname.endsWith(
        "/bitable/v1/apps/base-token/tables/tblCalendar/fields",
      )
    ) {
      assert.equal(url.searchParams.get("page_size"), "100");
      return Response.json({
        code: 0,
        data: { items: [{ field_id: "fld-1", field_name: "标题" }] },
      });
    }
    if (
      url.pathname.endsWith(
        "/bitable/v1/apps/base-token/tables/tblCalendar/records/rec-1",
      )
    ) {
      assert.equal(options.method, "PUT");
      assert.equal(url.searchParams.get("user_id_type"), "open_id");
      assert.deepEqual(JSON.parse(options.body), { fields: { 状态: "完成" } });
      return Response.json({
        code: 0,
        data: { record: { record_id: "rec-1", fields: { 状态: "完成" } } },
      });
    }
    if (decodeURIComponent(url.pathname).endsWith("/values/数据!A1:B2")) {
      return Response.json({
        code: 0,
        data: { valueRange: { values: [[1, 2]] } },
      });
    }
    if (url.pathname.endsWith("/values_append")) {
      assert.equal(options.method, "POST");
      assert.deepEqual(JSON.parse(options.body), {
        valueRange: { range: "数据!A:B", values: [["新增", 3]] },
      });
      return Response.json({ code: 0, data: { updates: { updatedRows: 1 } } });
    }
    if (url.pathname.endsWith("/values_clear")) {
      assert.equal(options.method, "POST");
      assert.deepEqual(JSON.parse(options.body), { ranges: ["数据!A2:B2"] });
      return Response.json({
        code: 0,
        data: { clearedRanges: ["数据!A2:B2"] },
      });
    }
    if (url.pathname.endsWith("/values")) {
      assert.equal(options.method, "PUT");
      assert.deepEqual(JSON.parse(options.body), {
        valueRange: { range: "数据!A1:B1", values: [["名称", "数量"]] },
      });
      return Response.json({ code: 0, data: { updatedCells: 2 } });
    }
    throw new Error(`unexpected fetch: ${url}`);
  };
  const service = createFeishuOAuthService({
    config,
    database,
    fetchImpl,
    now: () => 1_000_000,
  });
  const server = createServer(service.handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const headers = {
    Authorization: `Bearer ${connectionToken}`,
    "Content-Type": "application/json",
  };
  const sheetBase = `${origin}/api/integrations/feishu/drive/spreadsheets/sheet-token`;
  try {
    const search = await fetch(
      `${origin}/api/integrations/feishu/drive/search`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          query: "共享报告",
          count: 20,
          offset: 0,
          docs_types: ["sheet", "docx"],
        }),
      },
    );
    const searchBody = await search.json();
    assert.equal(searchBody.docs_entities[0].docs_token, "shared-sheet");
    assert.equal(searchBody.docs_entities[0].owned_by_current_user, true);

    const meta = await fetch(`${sheetBase}/meta`, { headers });
    assert.equal((await meta.json()).properties.title, "共享表");
    const read = await fetch(
      `${sheetBase}/values?range=${encodeURIComponent("数据!A1:B2")}`,
      { headers },
    );
    assert.deepEqual((await read.json()).valueRange.values, [[1, 2]]);
    const records = await fetch(
      `${origin}/api/integrations/feishu/drive/bitables/base-token/tables/tblCalendar/records?page_size=50&page_token=next-page`,
      { headers },
    );
    assert.equal((await records.json()).items[0].record_id, "rec-1");
    const fields = await fetch(
      `${origin}/api/integrations/feishu/drive/bitables/base-token/tables/tblCalendar/fields?page_size=100`,
      { headers },
    );
    assert.equal((await fields.json()).items[0].field_id, "fld-1");
    const updated = await fetch(
      `${origin}/api/integrations/feishu/drive/bitables/base-token/tables/tblCalendar/records/rec-1`,
      {
        method: "PUT",
        headers,
        body: JSON.stringify({ fields: { 状态: "完成" } }),
      },
    );
    assert.equal((await updated.json()).record.record_id, "rec-1");
    const denied = await fetch(
      `${origin}/api/integrations/feishu/drive/spreadsheets/denied/meta`,
      { headers },
    );
    assert.equal(denied.status, 403);
    assert.deepEqual(await denied.json(), {
      error: "feishu_permission_denied_or_scope_missing",
      upstream_code: 99991679,
    });
    for (const [action, body] of [
      ["values", { range: "数据!A1:B1", values: [["名称", "数量"]] }],
      ["append", { range: "数据!A:B", values: [["新增", 3]] }],
      ["clear", { range: "数据!A2:B2" }],
    ]) {
      const response = await fetch(`${sheetBase}/${action}`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      });
      assert.equal(response.status, 200);
    }
    assert.equal(calls.length, 10);
  } finally {
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    database.close();
  }
});
