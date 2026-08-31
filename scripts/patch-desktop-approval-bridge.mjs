function normalized(source) {
  return source.replace(/\r\n/g, "\n");
}

function required(source, anchor, replacement, label) {
  if (!source.includes(anchor)) {
    throw new Error(`Desktop approval marker not found: ${label}`);
  }
  return source.replace(anchor, replacement);
}

export function patchApprovalCoreSource(source) {
  let next = normalized(source);
  if (next.includes('data["request_id"] = self.request_id')) return next;
  next = required(
    next,
    "import unicodedata\n",
    "import unicodedata\nimport uuid\n",
    "uuid import",
  );
  next = required(
    next,
    '    __slots__ = ("event", "data", "result", "reason")\n',
    '    __slots__ = ("event", "data", "result", "reason", "request_id")\n',
    "approval entry slots",
  );
  next = required(
    next,
    "    def __init__(self, data: dict):\n        self.event = threading.Event()\n",
    '    def __init__(self, data: dict):\n        self.request_id = uuid.uuid4().hex\n        data["request_id"] = self.request_id\n        self.event = threading.Event()\n',
    "approval request identity",
  );
  next = required(
    next,
    "def resolve_gateway_approval(session_key: str, choice: str,\n                             resolve_all: bool = False,\n                             reason: Optional[str] = None) -> int:\n",
    "def resolve_gateway_approval(session_key: str, choice: str,\n                             resolve_all: bool = False,\n                             reason: Optional[str] = None,\n                             request_id: Optional[str] = None) -> int:\n",
    "approval resolver signature",
  );
  next = required(
    next,
    "        if resolve_all:\n            targets = list(queue)\n            queue.clear()\n        else:\n            targets = [queue.pop(0)]\n",
    "        if resolve_all:\n            targets = list(queue)\n            queue.clear()\n        elif request_id:\n            target = next(\n                (entry for entry in queue if entry.request_id == request_id),\n                None,\n            )\n            if target is None:\n                return 0\n            queue.remove(target)\n            targets = [target]\n        else:\n            targets = [queue.pop(0)]\n",
    "request-scoped approval resolution",
  );
  return next;
}

export function patchApprovalPromptSource(source) {
  let next = normalized(source);
  if (next.includes('request_id=params.get("request_id")')) return next;
  return required(
    next,
    '                    resolve_all=params.get("all", False),\n',
    '                    resolve_all=params.get("all", False),\n                    request_id=params.get("request_id"),\n',
    "prompt approval request identity",
  );
}

export function patchApprovalApiServerSource(source) {
  let next = normalized(source);
  if (next.includes('request_id=body.get("request_id")')) return next;
  const handlerAt = next.indexOf("async def _handle_run_approval");
  if (handlerAt < 0)
    throw new Error("Desktop approval marker not found: run approval handler");
  const before = next.slice(0, handlerAt);
  const handler = next.slice(handlerAt);
  const patched = required(
    handler,
    "                resolve_all=resolve_all,\n",
    '                resolve_all=resolve_all,\n                request_id=body.get("request_id"),\n',
    "run approval request identity",
  );
  return before + patched;
}
