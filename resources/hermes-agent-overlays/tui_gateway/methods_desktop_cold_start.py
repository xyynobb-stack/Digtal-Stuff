"""JingYuAI desktop cold-start RPCs installed into the packaged gateway."""

import functools
import hashlib
import json
import threading
import time

from .method_ctx import HandlerRegistry

_registry = HandlerRegistry()
method = _registry.method


def _configured_models(value):
    if isinstance(value, dict):
        return [str(item).strip() for item in value if str(item).strip()]
    if not isinstance(value, list):
        return []
    result = []
    for item in value:
        if isinstance(item, str) and item.strip():
            result.append(item.strip())
        elif isinstance(item, dict):
            model = str(item.get("id") or item.get("model") or "").strip()
            if model:
                result.append(model)
    return result


def _route_identity(route):
    """Attach an opaque, stable identity to one resolved runtime route."""
    provider = str(route.get("provider") or "").strip()
    model = str(route.get("model") or "").strip()
    base_url = str(route.get("base_url") or "").strip().rstrip("/").lower()
    endpoint_scope = (
        base_url
        if provider.lower() == "custom"
        or provider.lower().startswith("custom:")
        else ""
    )
    canonical = json.dumps(
        {
            "version": 1,
            "provider": provider.lower(),
            "model": model,
            "endpoint": endpoint_scope,
        },
        ensure_ascii=False,
        separators=(",", ":"),
        sort_keys=True,
    )
    identity = dict(route)
    identity["route_id"] = "route:v1:" + hashlib.sha256(
        canonical.encode("utf-8")
    ).hexdigest()
    return identity


def _remove_model_switch_markers(session):
    """Keep runtime identity out of ordinary conversation history.

    The Agent's rebuilt system prompt is the authoritative identity. Historical
    user-role markers can survive a resume and contradict that prompt, making a
    correctly routed model claim to be the previously selected model.
    """
    if not session:
        return
    predicate = globals().get("_is_model_switch_marker")
    if not callable(predicate):
        return

    def remove():
        history = session.setdefault("history", [])
        filtered = [entry for entry in history if not predicate(entry)]
        if len(filtered) != len(history):
            history[:] = filtered
            session["history_version"] = int(session.get("history_version", 0)) + 1

    lock = session.get("history_lock")
    if lock is not None:
        with lock:
            remove()
    else:
        remove()


def _discard_model_switch_marker(session, *, model, provider):
    """Replace legacy marker persistence with in-memory history sanitation."""
    del model, provider
    _remove_model_switch_markers(session)


def _local_snapshot(ctx):
    """Build a provider/model snapshot without auth, network, or metadata I/O."""
    rows = []
    seen = set()

    def add(slug, config=None):
        slug = str(slug or "").strip()
        if not slug or slug.lower() in seen:
            return
        config = config if isinstance(config, dict) else {}
        models = _configured_models(config.get("models"))
        if slug.lower() == str(ctx.current_provider or "").strip().lower():
            current = str(ctx.current_model or "").strip()
            if current and current not in models:
                models.insert(0, current)
        base_url = str(
            config.get("base_url")
            or config.get("api_url")
            or (ctx.current_base_url if slug == ctx.current_provider else "")
            or ""
        ).strip()
        rows.append(
            {
                "slug": slug,
                "name": str(config.get("name") or slug),
                "models": models,
                "base_url": base_url,
                "api_url": base_url,
                "is_current": slug.lower()
                == str(ctx.current_provider or "").strip().lower(),
                "is_user_defined": slug in ctx.user_providers,
            }
        )
        seen.add(slug.lower())

    add(ctx.current_provider, ctx.user_providers.get(ctx.current_provider, {}))
    for slug, config in ctx.user_providers.items():
        add(slug, config)
    for index, config in enumerate(ctx.custom_providers):
        if isinstance(config, dict):
            name = str(config.get("name") or f"provider-{index + 1}").strip()
            add(f"custom:{name}", config)
    return {
        "providers": rows,
        "model": ctx.current_model,
        "provider": ctx.current_provider,
        "refreshing": True,
    }


def _resolve_model_route(ctx, requested, model, base_url):
    """Resolve a user selection to one concrete, catalog-independent route."""
    requested = str(requested or "").strip()
    model = str(model or "").strip()
    normalized_url = str(base_url or "").strip().rstrip("/").lower()
    if requested.lower() != "custom":
        config = ctx.user_providers.get(requested, {})
        config = config if isinstance(config, dict) else {}
        return _route_identity(
            {
                "model": model,
                "provider": requested,
                "requested_provider": requested,
                "base_url": str(
                    base_url
                    or config.get("base_url")
                    or config.get("api_url")
                    or ""
                ).strip(),
                "api_mode": str(config.get("api_mode") or "").strip(),
            }
        )

    candidates = [
        (str(slug), config)
        for slug, config in ctx.user_providers.items()
        if isinstance(config, dict)
    ]
    candidates.extend(
        (f"custom:{str(config.get('name')).strip()}", config)
        for config in ctx.custom_providers
        if isinstance(config, dict) and str(config.get("name") or "").strip()
    )
    resolved = requested
    resolved_url = str(base_url or "").strip()
    model_matches = []
    resolved_api_mode = ""
    for slug, config in candidates:
        configured_url = str(
            config.get("base_url") or config.get("api_url") or ""
        ).strip()
        models = _configured_models(config.get("models"))
        if model and model in models:
            model_matches.append(
                (slug, configured_url, str(config.get("api_mode") or "").strip())
            )
        if (
            normalized_url
            and configured_url.rstrip("/").lower() == normalized_url
        ):
            resolved = slug
            resolved_url = configured_url or resolved_url
            resolved_api_mode = str(config.get("api_mode") or "").strip()
            break
    if resolved == requested and not normalized_url and len(model_matches) == 1:
        resolved, resolved_url, resolved_api_mode = model_matches[0]
    return _route_identity(
        {
            "model": model,
            "provider": resolved,
            "requested_provider": requested,
            "base_url": resolved_url,
            "api_mode": resolved_api_mode,
        }
    )


# @lat: [[chat-commands#Layered desktop readiness]]
def _session_readiness_payload(sid, session):
    """Return authoritative, monotonic readiness for one live session."""
    if not session:
        return {
            "session_id": str(sid or ""),
            "generation": 0,
            "phase": "missing",
            "agent_ready": False,
            "error": "session not found",
        }
    ready = session.get("agent_ready")
    error = str(session.get("agent_error") or "").strip()
    if error:
        phase = "failed"
    elif ready is not None and ready.is_set() and session.get("agent") is not None:
        phase = "ready"
    elif session.get("agent_build_started"):
        phase = "building_agent"
    else:
        phase = "creating_session"
    return {
        "session_id": str(sid or ""),
        "generation": int(session.get("model_selection_generation", 0)),
        "phase": phase,
        "agent_ready": phase == "ready",
        "started_at_ms": int(
            session.get("_desktop_agent_build_started_at_ms")
            or float(session.get("created_at") or time.time()) * 1000
        ),
        "updated_at_ms": int(time.time() * 1000),
        "error": error or None,
    }


# @lat: [[main-process#Cold-start timing diagnostics]]
def _install_desktop_runtime_timing(server) -> None:
    """Publish cold Agent/API boundaries without changing the chat path.

    ``session.create`` deliberately returns a lightweight session before its
    deferred ``AIAgent`` exists. The desktop therefore cannot infer Agent
    readiness from the RPC response. These wrappers observe the existing build
    and provider calls and emit metadata-only events over the session's
    already-open transport. They never wait, retry, or alter a return value.
    """
    namespace = vars(server)
    if namespace.get("_desktop_runtime_timing_installed"):
        return
    namespace["_desktop_runtime_timing_installed"] = True

    emit = namespace["_emit"]
    phase_context = threading.local()

    def emit_timing(sid, stage, *, at_ms=None, detail=""):
        payload = {
            "stage": stage,
            "at_ms": int(at_ms if at_ms is not None else time.time() * 1000),
        }
        if detail:
            payload["detail"] = str(detail)[:500]
        try:
            emit("desktop.timing", sid, payload)
        except Exception:
            # Diagnostics must never change Agent construction or inference.
            pass

    def emit_readiness(sid, session):
        try:
            emit(
                "session.readiness.changed",
                sid,
                _session_readiness_payload(sid, session),
            )
        except Exception:
            # Readiness notifications are resumable through session.readiness.
            pass

    def current_timing_sid():
        return getattr(phase_context, "sid", None)

    def timed_callable(owner, attribute, phase, *, detail_factory=None):
        """Wrap one synchronous cold-start boundary with metadata-only events."""
        original = getattr(owner, attribute, None)
        if not callable(original) or getattr(original, "_desktop_phase_timed", False):
            return

        @functools.wraps(original)
        def wrapped(*args, **kwargs):
            sid = current_timing_sid()
            if not sid:
                return original(*args, **kwargs)
            detail_suffix = ""
            if detail_factory is not None:
                try:
                    value = str(detail_factory(*args, **kwargs) or "").strip()
                    if value:
                        detail_suffix = f"; target={value}"
                except Exception:
                    pass
            started = time.monotonic()
            emit_timing(
                sid,
                "agent.phase_started",
                detail=f"phase={phase}{detail_suffix}",
            )
            try:
                result = original(*args, **kwargs)
            except Exception as exc:
                emit_timing(
                    sid,
                    "agent.phase_failed",
                    detail=(
                        f"phase={phase}{detail_suffix}; "
                        f"elapsedMs={int((time.monotonic() - started) * 1000)}; "
                        f"error={type(exc).__name__}: {exc}"
                    ),
                )
                raise
            emit_timing(
                sid,
                "agent.phase_ready",
                detail=(
                    f"phase={phase}{detail_suffix}; "
                    f"elapsedMs={int((time.monotonic() - started) * 1000)}"
                ),
            )
            return result

        wrapped._desktop_phase_timed = True
        setattr(owner, attribute, wrapped)

    def install_agent_phase_timing(run_agent, ai_agent):
        """Install process-wide wrappers; a thread-local sid scopes emissions."""
        if namespace.get("_desktop_agent_phase_timing_installed"):
            return
        namespace["_desktop_agent_phase_timing_installed"] = True

        for attribute, phase in (
            ("_load_cfg", "config.load"),
            ("_resolve_startup_runtime", "runtime.selection"),
            ("_resolve_runtime_with_fallback", "runtime.resolve"),
            ("_load_provider_routing", "provider.routing"),
            ("_load_enabled_toolsets", "toolsets.config"),
            ("_load_reasoning_config", "reasoning.config"),
            ("_load_service_tier", "service_tier.config"),
        ):
            timed_callable(server, attribute, phase)

        timed_callable(ai_agent, "__init__", "agent.instance_init")
        timed_callable(ai_agent, "_get_transport", "transport.initialize")
        timed_callable(ai_agent, "_create_openai_client", "model_client.create")
        timed_callable(run_agent, "get_tool_definitions", "tools.snapshot")

        try:
            import model_tools

            timed_callable(
                model_tools,
                "_compute_tool_definitions",
                "tools.definitions",
            )
        except Exception:
            pass

        try:
            import tools.registry as tool_registry

            timed_callable(
                tool_registry,
                "_check_fn_cached",
                "tool.availability_check",
                detail_factory=lambda check_fn, *args, **kwargs: (
                    f"{getattr(check_fn, '__module__', '')}."
                    f"{getattr(check_fn, '__qualname__', getattr(check_fn, '__name__', 'unknown'))}"
                ).strip("."),
            )
        except Exception:
            pass

        try:
            import agent.ssl_guard as ssl_guard

            timed_callable(
                ssl_guard,
                "verify_ca_bundle_with_fallback",
                "tls.verify_ca_bundle",
            )
        except Exception:
            pass

        for module_name, phase in (
            ("hermes_cli.mcp_startup", "mcp.shared_wait"),
            ("tui_gateway.entry", "mcp.gateway_wait"),
        ):
            try:
                module = __import__(module_name, fromlist=["wait_for_mcp_discovery"])
                timed_callable(module, "wait_for_mcp_discovery", phase)
            except Exception:
                pass

    original_make_agent = namespace["_make_agent"]

    @functools.wraps(original_make_agent)
    def timed_make_agent(sid, *args, **kwargs):
        started = time.monotonic()
        emit_timing(sid, "agent.construct_started")
        previous_sid = current_timing_sid()
        phase_context.sid = sid
        try:
            import_started = time.monotonic()
            emit_timing(
                sid,
                "agent.phase_started",
                detail="phase=run_agent.import",
            )
            try:
                import run_agent
                from run_agent import AIAgent
            except Exception as exc:
                emit_timing(
                    sid,
                    "agent.phase_failed",
                    detail=(
                        "phase=run_agent.import; "
                        f"elapsedMs={int((time.monotonic() - import_started) * 1000)}; "
                        f"error={type(exc).__name__}: {exc}"
                    ),
                )
                raise
            emit_timing(
                sid,
                "agent.phase_ready",
                detail=(
                    "phase=run_agent.import; "
                    f"elapsedMs={int((time.monotonic() - import_started) * 1000)}"
                ),
            )
            install_agent_phase_timing(run_agent, AIAgent)
            agent = original_make_agent(sid, *args, **kwargs)
        except Exception as exc:
            emit_timing(
                sid,
                "agent.construct_failed",
                detail=(
                    f"elapsedMs={int((time.monotonic() - started) * 1000)}; "
                    f"error={type(exc).__name__}: {exc}"
                ),
            )
            raise
        finally:
            if previous_sid is None:
                try:
                    del phase_context.sid
                except AttributeError:
                    pass
            else:
                phase_context.sid = previous_sid

        request_sequence = {"value": 0}

        def wrap_provider_call(attribute, transport):
            original_call = getattr(agent, attribute, None)
            if not callable(original_call):
                return

            @functools.wraps(original_call)
            def timed_provider_call(*call_args, **call_kwargs):
                request_sequence["value"] += 1
                sequence = request_sequence["value"]
                request_started = time.monotonic()
                identity = (
                    f"sequence={sequence}; transport={transport}; "
                    f"provider={getattr(agent, 'provider', '')}; "
                    f"model={getattr(agent, 'model', '')}"
                )
                emit_timing(sid, "agent.api_request_started", detail=identity)
                try:
                    result = original_call(*call_args, **call_kwargs)
                except Exception as exc:
                    emit_timing(
                        sid,
                        "agent.api_request_failed",
                        detail=(
                            f"{identity}; "
                            f"elapsedMs={int((time.monotonic() - request_started) * 1000)}; "
                            f"error={type(exc).__name__}: {exc}"
                        ),
                    )
                    raise
                emit_timing(
                    sid,
                    "agent.api_request_finished",
                    detail=(
                        f"{identity}; "
                        f"elapsedMs={int((time.monotonic() - request_started) * 1000)}"
                    ),
                )
                return result

            setattr(agent, attribute, timed_provider_call)

        # Normal desktop chat uses the streaming call. Keep the non-streaming
        # wrapper for providers that explicitly reject streaming; its transport
        # label makes a nested fallback visible rather than ambiguous.
        wrap_provider_call("_interruptible_streaming_api_call", "stream")
        wrap_provider_call("_interruptible_api_call", "non_stream")
        emit_timing(
            sid,
            "agent.construct_ready",
            detail=f"elapsedMs={int((time.monotonic() - started) * 1000)}",
        )
        return agent

    original_start_agent_build = namespace["_start_agent_build"]

    @functools.wraps(original_start_agent_build)
    def timed_start_agent_build(sid, session):
        claim = object()
        claimed = session.setdefault("_desktop_build_timing_claim", claim) is claim
        started_at_ms = int(time.time() * 1000)
        started = time.monotonic()
        result = original_start_agent_build(sid, session)
        if not claimed:
            return result
        if not session.get("agent_build_started"):
            session.pop("_desktop_build_timing_claim", None)
            return result

        session["_desktop_agent_build_started_at_ms"] = started_at_ms
        emit_readiness(sid, session)

        emit_timing(sid, "agent.build_started", at_ms=started_at_ms)

        def watch_ready():
            ready = session.get("agent_ready")
            if ready is not None:
                ready.wait()
            elapsed_ms = int((time.monotonic() - started) * 1000)
            error = str(session.get("agent_error") or "").strip()
            emit_readiness(sid, session)
            emit_timing(
                sid,
                "agent.build_failed" if error else "agent.build_ready",
                detail=(
                    f"elapsedMs={elapsed_ms}; error={error}"
                    if error
                    else f"elapsedMs={elapsed_ms}"
                ),
            )

        threading.Thread(
            target=watch_ready,
            name=f"desktop-agent-timing-{sid}",
            daemon=True,
        ).start()
        return result

    namespace["_make_agent"] = timed_make_agent
    namespace["_start_agent_build"] = timed_start_agent_build


@method("session.readiness")
def session_readiness(rid, params: dict) -> dict:
    """Return current readiness so reconnects never depend on missed events."""
    sid = str(params.get("session_id") or "").strip()
    session = _sessions.get(sid)
    if not session:
        return _err(rid, 4007, "session not found")
    return _ok(rid, _desktop_session_readiness_payload(sid, session))


# @lat: [[chat-commands#Cold-session model selection]]
@method("model.options")
def model_options(rid, params: dict) -> dict:
    """Return a local snapshot immediately and single-flight a full refresh."""
    try:
        import json
        import threading
        from hermes_cli.inventory import build_model_options_payload

        session = _sessions.get(params.get("session_id", ""))
        agent = session.get("agent") if session else None
        ctx = _model_picker_context(agent)
        flags = (
            bool(params.get("explicit_only")),
            bool(params.get("include_unconfigured")),
        )
        cache_key = json.dumps(
            {
                "provider": ctx.current_provider,
                "model": ctx.current_model,
                "base_url": ctx.current_base_url,
                "providers": ctx.user_providers,
                "custom_providers": ctx.custom_providers,
                "flags": flags,
            },
            sort_keys=True,
            default=str,
        )
        cache = globals().setdefault("_desktop_model_options_cache", {})
        inflight = globals().setdefault("_desktop_model_options_inflight", set())
        lock = globals().setdefault("_desktop_model_options_lock", threading.Lock())
        force_refresh = bool(params.get("refresh"))
        with lock:
            payload = cache.get(cache_key)
            if (force_refresh or payload is None) and cache_key not in inflight:
                inflight.add(cache_key)

                def refresh_catalog():
                    try:
                        refreshed = build_model_options_payload(
                            ctx,
                            explicit_only=flags[0],
                            include_unconfigured=flags[1],
                            refresh=force_refresh,
                        )
                        refreshed["refreshing"] = False
                        with lock:
                            cache[cache_key] = refreshed
                        broadcaster = globals().get("_broadcast_global_event")
                        if callable(broadcaster):
                            broadcaster("model.options.updated", refreshed)
                    except Exception:
                        logger.warning(
                            "background model catalog refresh failed", exc_info=True
                        )
                    finally:
                        with lock:
                            inflight.discard(cache_key)

                threading.Thread(
                    target=refresh_catalog,
                    name="model-options-refresh",
                    daemon=True,
                ).start()
            if payload is None:
                payload = _desktop_local_model_options_snapshot(ctx)
                cache[cache_key] = payload
            response = dict(payload)
            response["refreshing"] = cache_key in inflight
        return _ok(rid, response)
    except Exception as exc:
        return _err(rid, 5033, str(exc))


@method("model.identity")
def model_identity(rid, params: dict) -> dict:
    """Return effective session identity without provider discovery."""
    session = _sessions.get(params.get("session_id", ""))
    if not session:
        return _err(rid, 4007, "session not found")
    _desktop_remove_model_switch_markers(session)
    agent = session.get("agent")
    if agent is not None:
        info = _session_info(agent, session)
        base_url = str(getattr(agent, "base_url", "") or "")
    else:
        override = session.get("model_override") or {}
        resumed = session.get("resume_runtime_overrides") or {}
        info = {
            "model": str(
                override.get("model")
                or (resumed.get("model_override") or {}).get("model")
                or _resolve_model()
            ),
            "provider": str(
                override.get("provider")
                or resumed.get("provider_override")
                or ""
            ),
        }
        base_url = str(
            override.get("base_url") or resumed.get("base_url_override") or ""
        )
    override = session.get("model_override") or {}
    effective_api_mode = str(override.get("api_mode") or "")
    if agent is not None:
        effective_api_mode = str(
            getattr(agent, "api_mode", "") or effective_api_mode
        )
    identity = _desktop_route_identity(
        {
            "model": str(info.get("model") or ""),
            "provider": str(info.get("provider") or ""),
            "base_url": base_url,
            "requested_provider": str(override.get("requested_provider") or ""),
            "api_mode": effective_api_mode,
        }
    )
    identity["selection_generation"] = int(
        session.get("model_selection_generation", 0)
    )
    return _ok(rid, identity)


@method("model.resolve")
def model_resolve(rid, params: dict) -> dict:
    """Resolve generic custom routing solely from local provider config."""
    session = _sessions.get(params.get("session_id", ""))
    agent = session.get("agent") if session else None
    ctx = _model_picker_context(agent)
    return _ok(
        rid,
        _desktop_resolve_model_route(
            ctx,
            params.get("provider"),
            params.get("model"),
            params.get("base_url"),
        ),
    )


# @lat: [[chat-commands#Cold-session model selection]]
@method("session.create")
def desktop_session_create(rid, params: dict) -> dict:
    """Create with the final route identity before deferred Agent startup."""
    response = _desktop_original_session_create(rid, params)
    result = response.get("result") if isinstance(response, dict) else None
    sid = str((result or {}).get("session_id") or "").strip()
    requested_model = str(params.get("model") or "").strip()
    requested_provider = str(params.get("provider") or "").strip()
    requested_base_url = str(params.get("base_url") or "").strip()
    if (
        not sid
        or not requested_model
        or not requested_provider
        or requested_provider.lower() == "auto"
    ):
        if sid:
            session = _sessions.get(sid)
            if session:
                result["readiness"] = _desktop_session_readiness_payload(
                    sid, session
                )
        return response

    session = _sessions.get(sid)
    if not session:
        return response
    home_token = None
    try:
        profile_home = session.get("profile_home")
        if profile_home:
            home_token = set_hermes_home_override(profile_home)
        route = _desktop_resolve_model_route(
            _model_picker_context(None),
            requested_provider,
            requested_model,
            requested_base_url,
        )
        route_provider = str(route.get("provider") or requested_provider).strip()
        route_base_url = str(route.get("base_url") or requested_base_url).strip()
        session["model_override"] = {
            "model": requested_model,
            "provider": route_provider or None,
            "requested_provider": requested_provider,
            "base_url": route_base_url or None,
            "api_mode": route.get("api_mode") or None,
            "route_id": route.get("route_id"),
        }
        if session.get("agent_build_started"):
            session["pending_model_switch"] = {
                "raw": f"{requested_model} --provider {route_provider}",
                "confirm_expensive_model": True,
                "display_model": requested_model,
                "display_provider": route_provider,
            }
        info = result.setdefault("info", {})
        info.update(
            route
        )
        server_generation = int(session.get("model_selection_generation", 0)) + 1
        session["model_selection_generation"] = server_generation
        info["selection_generation"] = server_generation
        result["readiness"] = _desktop_session_readiness_payload(sid, session)
    except Exception as exc:
        _sessions.pop(sid, None)
        return _err(rid, 5030, f"model route resolution failed: {exc}")
    finally:
        if home_token is not None:
            reset_hermes_home_override(home_token)
    return response


# @lat: [[chat-commands#Cold-session model selection]]
@method("session.model.set")
def session_model_set(rid, params: dict) -> dict:
    """Apply a session route directly, without starting the slash worker."""
    sid = str(params.get("session_id") or "").strip()
    session = _sessions.get(sid)
    if not session:
        return _err(rid, 4007, "session not found")
    if session.get("running"):
        return _err(rid, 4091, "cannot switch model while a turn is running")

    requested_provider = str(params.get("provider") or "").strip()
    requested_model = str(params.get("model") or "").strip()
    requested_base_url = str(params.get("base_url") or "").strip()
    requested_route_id = str(params.get("route_id") or "").strip()
    if not requested_model:
        return _err(rid, 4004, "model value required")

    home_token = None
    try:
        profile_home = session.get("profile_home")
        if profile_home:
            home_token = set_hermes_home_override(profile_home)
        agent = session.get("agent")
        route = _desktop_resolve_model_route(
            _model_picker_context(agent),
            requested_provider,
            requested_model,
            requested_base_url,
        )
        route_provider = str(route.get("provider") or requested_provider).strip()
        route_base_url = str(route.get("base_url") or requested_base_url).strip()
        route_id = str(route.get("route_id") or "").strip()
        if requested_route_id and requested_route_id != route_id:
            return _err(rid, 4092, "model route changed; resolve it again")
        raw = (
            f"{requested_model} --provider {route_provider}"
            if route_provider
            else requested_model
        )

        if agent is None:
            session["model_override"] = {
                "model": requested_model,
                "provider": route_provider or None,
                "requested_provider": requested_provider or None,
                "base_url": route_base_url or None,
                "api_mode": route.get("api_mode") or None,
                "route_id": route_id,
            }
            # A resume pre-warm may already be constructing the old route. The
            # pending switch is consumed immediately before the first model call,
            # so even that race cannot make the first turn use the stale model.
            if session.get("agent_build_started"):
                session["pending_model_switch"] = {
                    "raw": raw,
                    "confirm_expensive_model": True,
                    "display_model": requested_model,
                    "display_provider": route_provider,
                }
        else:
            _apply_model_switch(
                sid,
                session,
                raw,
                confirm_expensive_model=True,
                pin_session_override=True,
                persist_override=False,
            )
            session.setdefault("model_override", {})[
                "requested_provider"
            ] = requested_provider or None
            session["model_override"].update(
                {
                    "api_mode": route.get("api_mode") or None,
                    "route_id": route_id,
                }
            )

        effective = session.get("model_override") or {}
        effective_identity = _desktop_route_identity(
            {
                "model": str(effective.get("model") or requested_model),
                "provider": str(effective.get("provider") or route_provider),
                "requested_provider": requested_provider,
                "base_url": str(effective.get("base_url") or route_base_url),
                "api_mode": str(effective.get("api_mode") or ""),
            }
        )
        session.setdefault("model_override", {})["route_id"] = effective_identity[
            "route_id"
        ]
        server_generation = int(session.get("model_selection_generation", 0)) + 1
        session["model_selection_generation"] = server_generation
        effective_identity["selection_generation"] = server_generation
        _desktop_remove_model_switch_markers(session)
        return _ok(
            rid,
            effective_identity,
        )
    except Exception as exc:
        return _err(rid, 5030, str(exc))
    finally:
        if home_token is not None:
            reset_hermes_home_override(home_token)


def register(server) -> None:
    # HandlerRegistry rebinds handler globals to server.py; publish the helper
    # there first so model.options can call it after registration.
    # These callbacks remain module-defined after publication, so bind the
    # runtime predicate into their own globals as well as the server module.
    globals()["_is_model_switch_marker"] = vars(server).get(
        "_is_model_switch_marker"
    )
    vars(server)["_desktop_local_model_options_snapshot"] = _local_snapshot
    vars(server)["_desktop_configured_models"] = _configured_models
    vars(server)["_desktop_route_identity"] = _route_identity
    vars(server)["_desktop_resolve_model_route"] = _resolve_model_route
    vars(server)["_desktop_session_readiness_payload"] = (
        _session_readiness_payload
    )
    vars(server)["_desktop_remove_model_switch_markers"] = (
        _remove_model_switch_markers
    )
    vars(server)["_desktop_original_session_create"] = vars(server)["_methods"][
        "session.create"
    ]
    vars(server)["_append_model_switch_marker"] = _discard_model_switch_marker
    _install_desktop_runtime_timing(server)
    _registry.install(server)
