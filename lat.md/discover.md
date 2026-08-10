# Discover

The Discover screen exposes employee-facing catalogs and a profile-local writing-template library shared with Capabilities and chat.

## Writing templates entry

The Discover tab row contains Skills, Agents, and 写作模板; MCPs and Workflows are not shown in this employee-facing navigation.

Selecting 写作模板 opens a searchable template view. “添加写作模板” accepts common document formats beside the local-Skill import action, then refreshes every mounted template view.

[[src/main/writing-templates.ts#importWritingTemplate]] copies the selected file byte-for-byte into the current profile's `writing-templates` directory and writes only indexing metadata beside it. The desktop does not parse, normalize, or adapt document contents; [[src/main/writing-templates.ts#listWritingTemplates]] returns the stored originals for display and later Agent attachment.

## Capabilities writing templates entry

The bottom-left Capabilities destination opens [[src/renderer/src/screens/Tools/Tools.tsx#Tools]], whose employee tab row contains Tools, Skills, and 写作模板; the MCP Servers tab is hidden from this navigation.

Selecting 写作模板 shows the same searchable profile-local collection as Discover. Both views receive the `hermes-writing-templates-changed` refresh event after import, so a template added in Discover appears without restarting the app.

## Chat template activation

Writing templates are inert until the employee explicitly selects one for a conversation.

[[src/renderer/src/screens/Chat/SessionTemplatePicker.tsx#SessionTemplatePicker]] provides a single-select composer control after the web-preview button and persists the chosen template id per chat. On each ordinary turn, [[src/renderer/src/screens/Chat/hooks/useChatActions.ts#useChatActions]] privately attaches the unchanged source file and adds a generic instruction telling the Agent to read and interpret it; slash commands are unchanged.

The desktop never contains format-specific template interpretation. [[src/renderer/src/screens/Chat/sessionSkillEnvelope.ts#buildSessionSkillEnvelope]] carries only the selected filename and the generic Agent instruction, while `file.attach` supplies the original file reference. The private block and attachment references are placed before `[User message]`, allowing the packaged runtime to persist only the employee-authored suffix.
