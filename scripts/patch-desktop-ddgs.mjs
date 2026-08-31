/* eslint-disable @typescript-eslint/explicit-function-return-type -- build-time source patcher */

/**
 * Tune the bundled DDGS provider for Chinese desktop users.
 *
 * DDGS remains lazy: this patch does not import it or touch the network while
 * the Agent is starting. Searches run in the upstream disposable worker, with
 * a shorter hard deadline, a small process-wide concurrency gate, and a short
 * successful-result cache.
 */
export function patchDesktopDdgsSource(source) {
  const normalized = source.replace(/\r\n/g, "\n");
  const marker = "HERMES_DESKTOP_DDGS_DEFAULTS";
  if (normalized.includes(marker)) return normalized;

  const importsAnchor = `import time
from typing import Any, Dict, Optional
`;
  const timeoutAnchor = `_SEARCH_TIMEOUT_SECS = 30
`;
  const graceAnchor = `_TERMINATE_GRACE_SECS = 1.0
`;
  const interruptedAnchor = `class _SearchInterrupted(Exception):
    """Raised when tools.interrupt.is_interrupted() trips during a search wait."""
`;
  const clientAnchor = `    with DDGS(timeout=10) as client:
        for i, hit in enumerate(client.text(query, max_results=safe_limit)):
`;
  const boundedAnchor = `def _run_ddgs_search_bounded(query: str, safe_limit: int) -> list[dict[str, Any]]:
`;
  const windowsAnchor = `        extra_kwargs["creationflags"] = subprocess.CREATE_NEW_PROCESS_GROUP
`;
  const providerAnchor = `class DDGSWebSearchProvider(WebSearchProvider):
`;

  for (const [label, anchor] of [
    ["imports", importsAnchor],
    ["timeout", timeoutAnchor],
    ["grace", graceAnchor],
    ["interrupted exception", interruptedAnchor],
    ["client call", clientAnchor],
    ["bounded worker", boundedAnchor],
    ["Windows process flags", windowsAnchor],
    ["provider class", providerAnchor],
  ]) {
    if (!normalized.includes(anchor)) {
      throw new Error(`Desktop DDGS patch marker not found: ${label}`);
    }
  }

  const cacheHelpers = `${graceAnchor}
# ${marker}: keep startup side-effect-free and bound only actual searches.
_SEARCH_REGION = "cn-zh"
_SEARCH_REQUEST_TIMEOUT_SECS = 6
_SEARCH_TIMEOUT_SECS = 12
_SEARCH_CACHE_TTL_SECS = 300.0
_SEARCH_CACHE_MAX_ENTRIES = 128
_SEARCH_MAX_CONCURRENCY = 2
_search_cache: "OrderedDict[tuple[str, int], tuple[float, list[dict[str, Any]]]]" = OrderedDict()
_search_cache_lock = threading.Lock()
_search_concurrency = threading.BoundedSemaphore(_SEARCH_MAX_CONCURRENCY)


def _copy_results(results: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [dict(item) for item in results]


def _get_cached_results(query: str, safe_limit: int) -> Optional[list[dict[str, Any]]]:
    key = (query.strip().casefold(), safe_limit)
    now = time.monotonic()
    with _search_cache_lock:
        cached = _search_cache.get(key)
        if cached is None:
            return None
        timestamp, results = cached
        if now - timestamp > _SEARCH_CACHE_TTL_SECS:
            _search_cache.pop(key, None)
            return None
        _search_cache.move_to_end(key)
        return _copy_results(results)


def _store_cached_results(
    query: str,
    safe_limit: int,
    results: list[dict[str, Any]],
) -> None:
    if not results:
        return
    key = (query.strip().casefold(), safe_limit)
    with _search_cache_lock:
        _search_cache[key] = (time.monotonic(), _copy_results(results))
        _search_cache.move_to_end(key)
        while len(_search_cache) > _SEARCH_CACHE_MAX_ENTRIES:
            _search_cache.popitem(last=False)
`;

  const concurrencyWrapper = `def _run_ddgs_search_bounded(query: str, safe_limit: int) -> list[dict[str, Any]]:
    """Use cached results and cap concurrent DDGS worker processes."""
    cached = _get_cached_results(query, safe_limit)
    if cached is not None:
        return cached

    if not _search_concurrency.acquire(timeout=_SEARCH_TIMEOUT_SECS):
        raise TimeoutError("DDGS search concurrency queue timed out")
    try:
        # A peer may have populated the cache while this request was queued.
        cached = _get_cached_results(query, safe_limit)
        if cached is not None:
            return cached
        results = _run_ddgs_search_isolated(query, safe_limit)
        _store_cached_results(query, safe_limit, results)
        return _copy_results(results)
    finally:
        _search_concurrency.release()


`;

  return normalized
    .replace(
      importsAnchor,
      `import time
import threading
from collections import OrderedDict
from typing import Any, Dict, Optional
`,
    )
    .replace(timeoutAnchor, "")
    .replace(graceAnchor, cacheHelpers)
    .replace(
      clientAnchor,
      `    with DDGS(timeout=_SEARCH_REQUEST_TIMEOUT_SECS) as client:
        for i, hit in enumerate(
            client.text(
                query,
                region=_SEARCH_REGION,
                safesearch="moderate",
                max_results=safe_limit,
            )
        ):
`,
    )
    .replace(
      boundedAnchor,
      `def _run_ddgs_search_isolated(query: str, safe_limit: int) -> list[dict[str, Any]]:
`,
    )
    .replace(
      windowsAnchor,
      `        extra_kwargs["creationflags"] = (
            subprocess.CREATE_NEW_PROCESS_GROUP | subprocess.CREATE_NO_WINDOW
        )
`,
    )
    .replace(providerAnchor, concurrencyWrapper + providerAnchor);
}
