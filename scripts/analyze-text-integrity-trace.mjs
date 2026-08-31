import fs from "fs";
import os from "os";
import path from "path";

const tracePath =
  process.argv[2] ||
  path.join(
    process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"),
    "hermes-desktop",
    "text-integrity-trace.log",
  );

if (!fs.existsSync(tracePath)) {
  throw new Error(`Text integrity trace not found: ${tracePath}`);
}

const records = fs
  .readFileSync(tracePath, "utf8")
  .split(/\r?\n/)
  .filter(Boolean)
  .flatMap((line, index) => {
    try {
      return [{ ...JSON.parse(line), _line: index + 1 }];
    } catch {
      return [];
    }
  });

const turns = new Map();
for (const record of records) {
  const key = record.backendTurnKey || record.turnId;
  if (!key) continue;
  const group = turns.get(key) || [];
  group.push(record);
  turns.set(key, group);
}

function signature(record) {
  return `${record?.textLength ?? 0}:${record?.textSha256 || ""}`;
}

function describe(record) {
  return `${record.stage}/${record.eventType || "-"} seq=${record.sequence ?? "-"} len=${record.textLength ?? 0} sha=${String(record.textSha256 || "").slice(0, 12)}`;
}

function last(recordsForTurn, stage, eventType) {
  return recordsForTurn
    .filter(
      (record) =>
        record.stage === stage && (!eventType || record.eventType === eventType),
    )
    .at(-1);
}

for (const [turnKey, turnRecords] of turns) {
  turnRecords.sort((a, b) => (a.atMs || 0) - (b.atMs || 0) || a._line - b._line);
  const backend = turnRecords.filter((record) => record.stage === "backend.emit");
  const websocket = turnRecords.filter(
    (record) => record.stage === "websocket.received",
  );
  const websocketBySequence = new Map(
    websocket.map((record) => [record.sequence, record]),
  );
  let firstMismatch = null;

  for (const sent of backend) {
    const received = websocketBySequence.get(sent.sequence);
    if (!received) {
      firstMismatch = `WebSocket 未收到后端事件：${describe(sent)}`;
      break;
    }
    if (signature(sent) !== signature(received)) {
      firstMismatch = `后端发送与 WebSocket 接收文本不同：${describe(sent)} -> ${describe(received)}`;
      break;
    }
  }

  const frontendFinal = last(turnRecords, "frontend.state", "message.complete");
  const databaseRows = turnRecords
    .filter((record) => record.stage === "database.snapshot")
    .sort((a, b) => (a.sequence || 0) - (b.sequence || 0));
  const databaseText = databaseRows.map((record) => record.text || "").join(
    "\n\n<assistant-segment>\n\n",
  );

  if (!firstMismatch && frontendFinal && databaseRows.length > 0) {
    if ((frontendFinal.text || "") !== databaseText) {
      firstMismatch =
        "WebSocket 事件完整到达，但 message.complete 后的前端状态与数据库文本不同";
    }
  }

  const backendFinal = last(turnRecords, "backend.emit", "message.complete");
  console.log(`\n=== ${turnKey} ===`);
  console.log(`记录数: ${turnRecords.length}`);
  console.log(`后端事件: ${backend.length}; WebSocket事件: ${websocket.length}`);
  if (backendFinal) console.log(`后端 complete: ${describe(backendFinal)}`);
  if (frontendFinal) console.log(`前端最终状态: ${describe(frontendFinal)}`);
  if (databaseRows.length > 0) {
    console.log(
      `数据库片段: ${databaseRows.length}; 总长度: ${databaseText.length}`,
    );
  }
  console.log(
    firstMismatch
      ? `首次不一致: ${firstMismatch}`
      : "结论: 已记录的四层文本一致，当前回合未复现缺字。",
  );
}

if (turns.size === 0) {
  console.log("日志中没有可关联的文本回合。请确认以 JINGYU_TEXT_TRACE=1 启动开发版。");
}
