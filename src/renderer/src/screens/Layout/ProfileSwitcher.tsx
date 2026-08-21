import { useState, useEffect, useCallback, useRef } from "react";
import {
  Brain,
  ChevronDown,
  KeyRound,
  ProfileIcon,
  Settings,
  Check,
  Search,
  Workflow,
} from "../../assets/icons";
import { useI18n } from "../../components/useI18n";
import ProfileAvatar from "../../components/common/ProfileAvatar";
import { useProfileModal } from "../../components/profile/ProfileModalContext";

interface ProfileInfo {
  id: string;
  name: string;
  isDefault: boolean;
  isActive: boolean;
  model: string;
  skillCount: number;
  gatewayRunning: boolean;
  color?: string;
  avatar?: string | null;
}

interface ProfileSwitcherProps {
  /** Id of the currently active profile ("default" for the base workspace). */
  activeProfile: string;
  /** Called after a successful switch so the shell can reset chat state. */
  onSwitch: (name: string) => void;
  /** Open the full Profiles management screen. */
  onManage: () => void;
  /** Open the provider credentials screen. */
  onOpenProviders: () => void;
  /** Open the capabilities screen. */
  onOpenTools: () => void;
  /** Open Agent memory. */
  onOpenMemory: () => void;
  /** Open application settings. */
  onOpenSettings: () => void;
  /** Marks the currently visible destination in the account menu. */
  activeDestination?: "providers" | "tools" | "memory";
  /** Render as an icon-only sidebar footer affordance. */
  compact?: boolean;
}

/**
 * Sidebar-footer account control. The avatar/name opens an upward action menu
 * containing Profile and the workspace destinations removed from the footer
 * icon row. Profile switching remains available from anywhere via Cmd/Ctrl+P:
 * a fuzzy search field on top, running profiles grouped above a "Stopped"
 * section, each row showing its model in monospace and a running dot.
 */
export default function ProfileSwitcher({
  activeProfile,
  onSwitch,
  onManage,
  onOpenProviders,
  onOpenTools,
  onOpenMemory,
  onOpenSettings,
  activeDestination,
  compact = false,
}: ProfileSwitcherProps): React.JSX.Element {
  const { t } = useI18n();
  const { openProfile } = useProfileModal();
  const [switchOpen, setSwitchOpen] = useState(false);
  const [accountMenuOpen, setAccountMenuOpen] = useState(false);
  const [profiles, setProfiles] = useState<ProfileInfo[]>([]);
  const [query, setQuery] = useState("");
  const [highlight, setHighlight] = useState(0);
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const switcherRef = useRef<HTMLDivElement>(null);

  const isMac = window.electron?.process?.platform === "darwin";
  const mod = isMac ? "⌘" : "Ctrl";

  const load = useCallback(() => {
    window.hermesAPI
      .listProfiles()
      .then(setProfiles)
      .catch(() => {
        /* keep last-known list */
      });
  }, []);

  // Load once on mount so the chip shows the correct name/avatar immediately.
  useEffect(() => {
    load();
  }, [load]);

  // Cmd/Ctrl+P toggles the picker from anywhere. P is unbound in the app menu,
  // so the renderer reliably receives it; preventDefault keeps the browser
  // print dialog from stealing it.
  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      if (
        (e.metaKey || e.ctrlKey) &&
        !e.altKey &&
        !e.shiftKey &&
        (e.key === "p" || e.key === "P")
      ) {
        e.preventDefault();
        setSwitchOpen((v) => !v);
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  // Refresh + reset search/focus each time the picker opens — counts and the
  // gateway dot drift while it's closed.
  useEffect(() => {
    if (!switchOpen) return;
    load();
    setQuery("");
    setHighlight(0);
    // Focus after the open animation's first frame so the caret lands reliably.
    const id = requestAnimationFrame(() => searchRef.current?.focus());
    return () => cancelAnimationFrame(id);
  }, [switchOpen, load]);

  useEffect(() => {
    if (!accountMenuOpen) return;
    function closeOnOutsidePointer(event: PointerEvent): void {
      if (!switcherRef.current?.contains(event.target as Node)) {
        setAccountMenuOpen(false);
      }
    }
    function closeOnEscape(event: KeyboardEvent): void {
      if (event.key === "Escape") setAccountMenuOpen(false);
    }
    document.addEventListener("pointerdown", closeOnOutsidePointer);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsidePointer);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [accountMenuOpen]);

  const activeInfo = profiles.find((p) => p.id === activeProfile);
  const hasDefaultFallbackName =
    activeInfo?.isDefault && activeInfo.name === activeInfo.id;
  const label =
    activeInfo && !hasDefaultFallbackName
      ? activeInfo.name
      : activeProfile === "default"
        ? t("common.appName")
        : activeProfile;

  function editCurrent(): void {
    setAccountMenuOpen(false);
    openProfile(activeProfile, { onChanged: load });
  }

  function runAccountAction(action: () => void): void {
    setAccountMenuOpen(false);
    action();
  }

  const handleSelect = useCallback(
    async (name: string): Promise<void> => {
      setSwitchOpen(false);
      if (name === activeProfile) return;
      try {
        await window.hermesAPI.setActiveProfile(name);
      } catch {
        /* still reflect the choice optimistically */
      }
      onSwitch(name);
    },
    [activeProfile, onSwitch],
  );

  // Fuzzy-ish filter across the user-facing name, the stable id, and the model.
  const q = query.trim().toLowerCase();
  const matches = (p: ProfileInfo): boolean =>
    !q ||
    p.name.toLowerCase().includes(q) ||
    p.id.toLowerCase().includes(q) ||
    (p.model || "").toLowerCase().includes(q);
  // Active profile floats to the top of its group; the rest keep list order.
  const byActiveFirst = (a: ProfileInfo, b: ProfileInfo): number =>
    Number(b.id === activeProfile) - Number(a.id === activeProfile);
  const filtered = profiles.filter(matches);
  const running = filtered.filter((p) => p.gatewayRunning).sort(byActiveFirst);
  const stopped = filtered.filter((p) => !p.gatewayRunning).sort(byActiveFirst);
  // Flat order drives keyboard navigation across both groups.
  const flat = [...running, ...stopped];

  // Keep the highlighted row scrolled into view as the selection moves.
  useEffect(() => {
    if (!switchOpen) return;
    listRef.current
      ?.querySelector(".profile-menu-item.highlighted")
      ?.scrollIntoView({ block: "nearest" });
  }, [highlight, switchOpen]);

  function onSearchKey(e: React.KeyboardEvent): void {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      // Clamp to the (possibly empty) filtered list — an empty list keeps 0
      // rather than drifting to -1.
      setHighlight((h) => Math.max(0, Math.min(flat.length - 1, h + 1)));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlight((h) => Math.max(0, h - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      // No-op when the query matches nothing — `flat[highlight]` is undefined.
      const target = flat[highlight];
      if (target) void handleSelect(target.id);
    } else if (e.key === "Escape") {
      e.stopPropagation();
      setSwitchOpen(false);
    }
  }

  function renderRow(p: ProfileInfo, flatIndex: number): React.JSX.Element {
    const isActive = p.id === activeProfile;
    return (
      <button
        key={p.id}
        className={`profile-menu-item ${isActive ? "active" : ""} ${
          flatIndex === highlight ? "highlighted" : ""
        }`}
        role="menuitemradio"
        aria-checked={isActive}
        onClick={() => void handleSelect(p.id)}
        onMouseMove={() => setHighlight(flatIndex)}
      >
        <ProfileAvatar
          name={p.id}
          color={p.color}
          avatar={p.avatar}
          size={32}
        />
        <span className="profile-menu-name">{p.name}</span>
        <span className="profile-menu-model">
          {p.model || t("agents.noModel")}
        </span>
        <span className="profile-menu-status">
          <span
            className={`profile-menu-gateway ${p.gatewayRunning ? "active" : ""}`}
            aria-hidden
          />
          {isActive && <Check size={16} className="profile-menu-check" />}
        </span>
      </button>
    );
  }

  return (
    <>
      <div
        ref={switcherRef}
        className={`profile-switcher ${compact ? "compact" : ""}`}
      >
        {accountMenuOpen && (
          <div className="account-menu" role="menu" aria-label="用户菜单">
            <button
              type="button"
              className="account-menu-item"
              role="menuitem"
              onClick={editCurrent}
            >
              <ProfileIcon size={17} />
              <span>{t("navigation.profile")}</span>
            </button>
            <div className="account-menu-divider" />
            <button
              type="button"
              className={`account-menu-item ${activeDestination === "providers" ? "active" : ""}`}
              role="menuitem"
              onClick={() => runAccountAction(onOpenProviders)}
            >
              <KeyRound size={17} />
              <span>{t("navigation.providers")}</span>
            </button>
            <button
              type="button"
              className={`account-menu-item ${activeDestination === "tools" ? "active" : ""}`}
              role="menuitem"
              onClick={() => runAccountAction(onOpenTools)}
            >
              <Workflow size={17} />
              <span>{t("navigation.tools")}</span>
            </button>
            <button
              type="button"
              className={`account-menu-item ${activeDestination === "memory" ? "active" : ""}`}
              role="menuitem"
              onClick={() => runAccountAction(onOpenMemory)}
            >
              <Brain size={17} />
              <span>{t("navigation.memory")}</span>
            </button>
            <button
              type="button"
              className="account-menu-item"
              role="menuitem"
              onClick={() => runAccountAction(onOpenSettings)}
            >
              <Settings size={17} />
              <span>{t("navigation.settings")}</span>
            </button>
          </div>
        )}
        <button
          type="button"
          className={`profile-switcher-trigger ${accountMenuOpen ? "open" : ""}`}
          onClick={() => setAccountMenuOpen((open) => !open)}
          title={label}
          aria-label={`${label} 用户菜单`}
          aria-haspopup="menu"
          aria-expanded={accountMenuOpen}
        >
          <ProfileAvatar
            name={activeProfile}
            color={activeInfo?.color}
            avatar={activeInfo?.avatar}
            size={compact ? 22 : 18}
          />
          {!compact && <span className="profile-switcher-name">{label}</span>}
          {!compact && (
            <ChevronDown size={15} className="profile-switcher-chevron" />
          )}
        </button>
      </div>

      {switchOpen && (
        <div
          className="profile-switch-overlay"
          onClick={() => setSwitchOpen(false)}
        >
          <div
            className="profile-switch-modal"
            role="dialog"
            aria-label={t("agents.switchProfile")}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="profile-switch-search">
              <Search
                size={16}
                className="profile-switch-search-icon"
                aria-hidden
              />
              <input
                ref={searchRef}
                className="profile-switch-search-input"
                type="text"
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value);
                  setHighlight(0);
                }}
                onKeyDown={onSearchKey}
                placeholder={t("agents.switchProfile")}
                aria-label={t("agents.switchProfile")}
              />
              <kbd className="profile-switch-kbd">{mod}P</kbd>
            </div>

            <div className="profile-switch-list" ref={listRef}>
              {flat.length === 0 ? (
                <div className="profile-switch-empty">
                  {t("agents.noProfilesMatch")}
                </div>
              ) : (
                <>
                  {running.map((p, i) => renderRow(p, i))}
                  {stopped.length > 0 && (
                    <div className="profile-switch-group">
                      {t("agents.stopped")}
                    </div>
                  )}
                  {stopped.map((p, i) => renderRow(p, running.length + i))}
                </>
              )}
            </div>

            <button
              className="profile-menu-manage"
              onClick={() => {
                setSwitchOpen(false);
                onManage();
              }}
            >
              <Settings size={14} />
              {t("agents.manageProfiles")}
            </button>
          </div>
        </div>
      )}
    </>
  );
}
