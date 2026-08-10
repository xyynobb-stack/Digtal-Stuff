const SESSION_SKILL_INSTRUCTION =
  "Built-in skills are always available to this chat. The listed names are the only user-added custom skills enabled for this chat. Load and follow each listed custom skill with the skill_view tool before answering. An empty list means no custom skills are enabled.";

const SESSION_SKILL_PREFIX = "[Active session skills: ";
const USER_MESSAGE_MARKER = "\n\n[User message]\n";

interface SessionWritingTemplate {
  fileName: string;
}

/**
 * Build the private control envelope sent to Hermes for an ordinary chat turn.
 * The renderer must keep showing and persisting `userText`, not this transport
 * representation.
 */
export function buildSessionSkillEnvelope(
  userText: string,
  skills: ReadonlyArray<string>,
  writingTemplate?: SessionWritingTemplate | null,
): string {
  const templateInstruction = writingTemplate
    ? `\n\n[Active writing template: ${writingTemplate.fileName}]\nThe attached original file named "${writingTemplate.fileName}" is the writing template selected by the user. Read it with the available tools and follow its structure, style, and formatting requirements for this request. Interpret the template yourself; the desktop has not extracted or transformed its contents.`
    : "";
  return `${SESSION_SKILL_PREFIX}${skills.join(", ")}]\n${SESSION_SKILL_INSTRUCTION}${templateInstruction}${USER_MESSAGE_MARKER}${userText}`;
}

/** Place gateway file references inside the private section of our envelope. */
export function addAttachmentRefsToSessionEnvelope(
  value: string,
  refs: ReadonlyArray<string>,
): string {
  if (refs.length === 0 || !value.startsWith(SESSION_SKILL_PREFIX))
    return value;
  const marker = value.indexOf(USER_MESSAGE_MARKER);
  if (marker < 0) return value;
  const attachmentBlock = `\n\n[Attached files]\n${refs.join("\n")}`;
  return `${value.slice(0, marker)}${attachmentBlock}${value.slice(marker)}`;
}

/**
 * Recover the user-authored text from the exact private envelope emitted by
 * `buildSessionSkillEnvelope`. A strict match avoids altering a real message
 * that merely happens to mention active session skills.
 */
export function unwrapSessionSkillEnvelope(value: string): string {
  if (!value.startsWith(SESSION_SKILL_PREFIX)) return value;

  const selectionEnd = value.indexOf("]\n", SESSION_SKILL_PREFIX.length);
  if (selectionEnd < 0) return value;

  const controlStart = selectionEnd + 2;
  if (!value.startsWith(SESSION_SKILL_INSTRUCTION, controlStart)) return value;
  const marker = value.indexOf(USER_MESSAGE_MARKER, controlStart);
  if (marker < 0) return value;

  return value.slice(marker + USER_MESSAGE_MARKER.length);
}
