"""JingYuAI desktop cold-start RPCs installed into the packaged gateway."""

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
    """Resolve a billing-class provider to a concrete local route."""
    requested = str(requested or "").strip()
    model = str(model or "").strip()
    normalized_url = str(base_url or "").strip().rstrip("/").lower()
    if requested.lower() != "custom":
        return {
            "model": model,
            "provider": requested,
            "requested_provider": requested,
            "base_url": str(base_url or "").strip(),
        }

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
    for slug, config in candidates:
        configured_url = str(
            config.get("base_url") or config.get("api_url") or ""
        ).strip()
        models = _configured_models(config.get("models"))
        if model and model in models:
            model_matches.append((slug, configured_url))
        if (
            normalized_url
            and configured_url.rstrip("/").lower() == normalized_url
            and (not models or model in models)
        ):
            resolved = slug
            resolved_url = configured_url or resolved_url
            break
    if resolved == requested and not normalized_url and len(model_matches) == 1:
        resolved, resolved_url = model_matches[0]
    return {
        "model": model,
        "provider": resolved,
        "requested_provider": requested,
        "base_url": resolved_url,
    }


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
    return _ok(
        rid,
        {
            "model": str(info.get("model") or ""),
            "provider": str(info.get("provider") or ""),
            "base_url": base_url,
            "requested_provider": str(override.get("requested_provider") or ""),
        },
    )


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
            {
                "model": requested_model,
                "provider": route_provider,
                "requested_provider": requested_provider,
                "base_url": route_base_url,
            }
        )
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

        effective = session.get("model_override") or {}
        return _ok(
            rid,
            {
                "model": str(effective.get("model") or requested_model),
                "provider": str(effective.get("provider") or route_provider),
                "requested_provider": requested_provider,
                "base_url": str(effective.get("base_url") or route_base_url),
            },
        )
    except Exception as exc:
        return _err(rid, 5030, str(exc))
    finally:
        if home_token is not None:
            reset_hermes_home_override(home_token)


def register(server) -> None:
    # HandlerRegistry rebinds handler globals to server.py; publish the helper
    # there first so model.options can call it after registration.
    vars(server)["_desktop_local_model_options_snapshot"] = _local_snapshot
    vars(server)["_desktop_configured_models"] = _configured_models
    vars(server)["_desktop_resolve_model_route"] = _resolve_model_route
    vars(server)["_desktop_original_session_create"] = vars(server)["_methods"][
        "session.create"
    ]
    _registry.install(server)
