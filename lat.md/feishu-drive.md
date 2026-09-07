# User-authorized Feishu Drive

Each employee operates files in their own Feishu Drive after connecting their Feishu account; the desktop no longer creates or exposes an application-owned shared area.

## Connection boundary

The profile stores a random JingYuAI connection token, while the Feishu app secret and user access and refresh tokens remain only on the OAuth server.

[[src/main/ipc/register.ts#registerIpcHandlers]] saves `FEISHU_OAUTH_CONNECTION_TOKEN` and the service URL only after the OAuth request is bound to the same employee profile. [[build/offline-runtime/hermes-agent/tools/feishu_drive_files_tool.py#_service_config]] gates all file tools on that connection token, so an unconnected profile cannot expose the tools.

The connection token is hashed in the server database. Its plaintext is returned once through the short-lived OAuth status request and is never accepted as a model-visible tool argument.

## Personal Drive operations

The server converts authenticated JingYuAI requests into Feishu Drive API calls made with the connected employee's current `user_access_token`.

[[build/offline-runtime/hermes-agent/tools/feishu_drive_files_tool.py#_handle_list_files]] lists the user root or a selected folder. [[build/offline-runtime/hermes-agent/tools/feishu_drive_files_tool.py#_handle_search_files]] recursively searches names with pagination and traversal limits. Folder creation, file upload, and file deletion target tokens in the same user's Drive authorization context.

There is no initialization tool, managed root, application-owned shared folder, or desktop-side App ID and App Secret path.

## Shared document discovery

Shared folders become reusable Profile locations after the employee successfully opens an explicit `/drive/folder/` link.

Feishu exposes the personal root but not the client's virtual “Shared folders” root as one Drive token. `feishu_drive_list_files` therefore saves each successfully accessed explicit folder under the current `get_hermes_home()` and omits unrelated personal-root metadata from that response. `feishu_drive_list_locations` returns the personal root plus those saved Profile-local tokens so an “all files” request can enumerate every known location. Supplying a folder token to search keeps bounded recursive traversal for that location; keyword search alone is not treated as a complete shared-directory index.

Global keyword search labels results with current-user ownership and membership in the recursively enumerated “My files” tree. A result satisfying both conditions becomes `preferred_match`; all other same-name results remain in `alternative_matches` so the Agent uses the employee's own file without silently discarding shared candidates.

## 飞书电子表格

五个 Sheet 工具读取表格结构和单元格、覆盖指定范围、追加数据行及清空范围；三个 Bitable 工具读取嵌入 Sheet 的字段和记录，并按真实 `record_id` 更新一条记录。上传的 `.xlsx` 附件仍不属于在线表格接口。

表格工具接受 `/sheets/` 链接或 token，以显式 A1 范围限制普通 Sheet 读写。每次操作读取实时元信息并解析工作表名称或 `sheetId`；元信息标记为 `BITABLE_BLOCK` 时拆分 `blockToken`，通过字段、记录和单记录更新接口操作。更新只转发调用方提供的原始字段值，不执行人员姓名到用户 ID 的解析。普通 Sheet 单次写入最多 5000 个单元格；清空要求严格确认串。

## Local upload safety

Uploads read an existing task-accessible local file, reject protected credential paths, and limit complete uploads to 20 MiB before sending base64 data to the server proxy.

[[build/offline-runtime/hermes-agent/tools/feishu_drive_files_tool.py#_resolve_upload_path]] reuses the Agent's path resolution and read-deny policy. The server decodes the content and submits multipart form data to Feishu without disclosing the Feishu user token to the desktop.

## Markdown 与 PDF 只读内容

两个内置工具下载当前员工有权访问的普通附件，并分别读取 UTF-8 Markdown 正文和 PDF 文本层；它们不提供修改、覆盖或回传文件的能力。

`feishu_markdown_read` 以字符偏移分页，拒绝非 UTF-8 内容。`feishu_pdf_read` 使用随桌面运行时固定安装的轻量 PyMuPDF 解析器，默认读取 20 页、单次最多 25 页；若页面只有扫描图像而没有文本层，则明确提示需要另行 OCR。两类正文均作为不可信外部数据返回，不能被解释为模型指令。

## Destructive operation guard

Single-file deletion requires the exact confirmation string `DELETE:<file_token>` and folder deletion is deliberately unsupported.

[[build/offline-runtime/hermes-agent/tools/feishu_drive_files_tool.py#_handle_delete_file]] enforces both checks before contacting the server, while the server independently rejects a folder type.

## Runtime delivery

Development and packaged Agents share one OAuth-proxy implementation and expose Drive, Profile-location, attachment-reading, document, and spreadsheet tools on every Agent surface.

`scripts/apply-offline-runtime-overlays.mjs#patchFeishuDriveToolsetSource` removes the obsolete initialization tool, assigns the five OAuth actions to the dedicated `feishu_user_drive` toolset, adds them to the API-server and ACP composites, and adds them to the shared core inherited by CLI and cron. Keeping this toolset separate from legacy app-credential comment actions lets platform resolution expose it in direct desktop conversations. `scripts/prepare-dev-agent.mjs#syncDevFeishuDriveTools` copies the canonical overlay into an installed development Agent.

### Built-in discovery

All twenty actions use top-level `registry.register(...)` calls so Hermes' AST-based built-in scanner recognizes and imports the module automatically from the system `tools/` directory; the model never needs Tool Search to discover them.

## 新版在线文档读写

四个内置工具沿用当前会话的员工授权，读取正文和段落块、追加纯文本、修改指定普通段落或标题；不支持普通附件、知识库链接、多维表格或整篇覆盖。

`feishu_docx_read` 接受文档 ID 或可信飞书 `/docx/` 链接，正文每次最多返回 12000 字符并给出 `next_offset`。`feishu_docx_list_blocks` 每页读取 50 个块并返回飞书分页游标。文档内容属于外部数据，不是模型指令。

`feishu_docx_append_text` 每次在文档末尾追加一个最多 2000 字符的纯文本段落，不解释 Markdown。超时后需读取确认，不自动重试写操作。`feishu_docx_update_block` 要求完整旧文本 `expected_text`；服务器读取文档版本与对应块，拒绝旧文本不一致、富文本、非文本块，并将相同版本传给更新请求，避免并发覆盖。

开发同步与 Release overlay 都从 `resources/hermes-agent-overlays/tools/feishu_drive_files_tool.py` 复制工具；注册补丁对原有五工具快照做幂等升级，将新增四工具纳入同一授权工具集及各平台内置集合。无需安装 SDK 或依赖 SKILL 文件。

## Verification

Tests mock the service boundary and Feishu upstream so no real credentials or user files are touched.

[[tests/test_feishu_drive_files_tool.py#UserAuthorizedFeishuDriveTests]] covers connection gating, Profile-local shared-folder persistence, preferred same-name search selection, file operations, attachment reading, ordinary Sheet ranges, and embedded Bitable field/record/update dispatch. `services/feishu-oauth/server.test.mjs` covers authenticated Drive requests, ownership enrichment, structured permission errors, and Bitable proxy methods made with the stored user token.
