import { useEffect, useState } from "react";
import { Check, Puzzle, X } from "lucide-react";

interface InstalledSkill {
  name: string;
  category: string;
  description: string;
}

interface SessionSkillPickerProps {
  profile?: string;
  activeSkills: string[];
  onChange: (names: string[]) => void;
}

/** Select installed skills for one chat without changing the global library. */
export function SessionSkillPicker({
  profile,
  activeSkills,
  onChange,
}: SessionSkillPickerProps): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [skills, setSkills] = useState<InstalledSkill[]>([]);
  const [loading, setLoading] = useState(false);

  async function loadSkills(): Promise<void> {
    setLoading(true);
    try {
      setSkills(await window.hermesAPI.listUserAddedSkills(profile));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    const refresh = (): void => void loadSkills();
    window.addEventListener("hermes-skills-changed", refresh);
    return () => window.removeEventListener("hermes-skills-changed", refresh);
  }, [profile]);

  function toggle(name: string): void {
    onChange(
      activeSkills.includes(name)
        ? activeSkills.filter((skill) => skill !== name)
        : [...activeSkills, name],
    );
  }

  return (
    <div className="session-skill-picker">
      <button
        type="button"
        className={`btn-ghost session-skill-trigger ${activeSkills.length > 0 ? "session-skill-trigger-active" : ""}`}
        onClick={() => {
          setOpen((value) => !value);
          if (!open) void loadSkills();
        }}
        title="为当前聊天启用 SKILL"
        aria-expanded={open}
      >
        <Puzzle size={14} />
        技能{activeSkills.length > 0 ? ` ${activeSkills.length}` : ""}
      </button>
      {open && (
        <div
          className="session-skill-popover"
          role="dialog"
          aria-label="当前聊天的 SKILL"
        >
          <div className="session-skill-popover-header">
            <strong>当前聊天 SKILL</strong>
            <div className="session-skill-popover-actions">
              {activeSkills.length > 0 && (
                <button
                  type="button"
                  className="btn-ghost session-skill-clear"
                  onClick={() => onChange([])}
                >
                  清空选择
                </button>
              )}
              <button
                type="button"
                className="btn-ghost"
                onClick={() => setOpen(false)}
                aria-label="关闭"
              >
                <X size={14} />
              </button>
            </div>
          </div>
          <p className="session-skill-help">
            选择后持续用于本聊天；取消选择即可停用。
          </p>
          {loading ? (
            <div className="session-skill-empty">正在读取已添加的 SKILL…</div>
          ) : skills.length === 0 ? (
            <div className="session-skill-empty">
              还没有已导入的 SKILL，请先在“发现”中导入。
            </div>
          ) : (
            <div className="session-skill-list">
              {skills.map((skill) => {
                const selected = activeSkills.includes(skill.name);
                return (
                  <button
                    type="button"
                    key={skill.name}
                    className={`session-skill-option ${selected ? "session-skill-option-selected" : ""}`}
                    onClick={() => toggle(skill.name)}
                  >
                    <span className="session-skill-option-copy">
                      <strong>{skill.name}</strong>
                      <small>{skill.description || skill.category}</small>
                    </span>
                    {selected && (
                      <span className="session-skill-selected-label">
                        <Check size={15} />
                        已启用
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
