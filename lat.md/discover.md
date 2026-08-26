# Discover

The Discover screen exposes employee-facing catalogs and a profile-local writing-template library shared with Capabilities and chat.

## Skill ownership columns

The Skills tab separates product-managed system skills from profile-local user skills so employees can understand ownership at a glance.

[[src/renderer/src/screens/Discover/Discover.tsx#Discover]] renders two columns after applying the shared search query. Bundled entries appear under 系统自带 SKILL, reusing matching registry metadata when available; that column alone has an accessible expand/collapse control.

[[src/main/skills.ts#listUserAddedSkills]] defines the user boundary as the `custom` category or the desktop user-added marker. User cards are always rendered in the 用户添加的 SKILL column and remain visible when the system column is collapsed.

## Starter user skills

Each profile receives editable starter skills that cover common employee roles, conversational skill creation, and internal-knowledge market reports.

[[src/main/skills.ts#ensureStarterUserSkills]] copies `hr`, `project-manager`, `finance`, `skill-creator`, and `market-report-rag` from `resources/starter-skills` into the profile's `skills/custom` directory. Provisioning is idempotent and never overwrites an existing same-name directory.

The Skill Creator starter guides a dialogue from trigger examples and scope through file creation and validation, defaulting new skills to the active profile's user-owned custom directory.

## Market report user Skill

The market-report RAG Skill is included in the user-added catalog and per-chat picker for fresh installations and named profiles, without replacing an employee's existing custom instructions.

`syncMarketReportStarterSkill` in `scripts/apply-offline-runtime-overlays.mjs` synchronizes the repository-owned RAG source into starter resources during development preparation and release overlay application, excluding Python caches and local env files. The existing profile provisioning path marks its custom copy as user-added. The legacy research runtime copy remains for compatibility; no user directories are deleted or moved.

## Writing templates entry

The Discover tab row contains Skills, Agents, and 写作模板; MCPs and Workflows are not shown in this employee-facing navigation.

Selecting 写作模板 opens a searchable template view. “添加写作模板” accepts common document and spreadsheet formats (`.xls`/`.xlsx` included), then opens an application modal for the description and refreshes every mounted template view without relying on a browser prompt.

[[src/main/writing-templates.ts#importWritingTemplate]] copies the selected file byte-for-byte into the current profile's `writing-templates` directory and writes only indexing metadata beside it. The desktop does not parse, normalize, or adapt document contents; [[src/main/writing-templates.ts#listWritingTemplates]] returns the stored originals for display and later Agent attachment.

Employees can select a template and use the fixed bottom actions to preview its description and source-file details or modify it. Preview opens the original in its system application on request; modify updates the description or replaces the stored source through [[src/main/writing-templates.ts#replaceWritingTemplateFile]] while preserving the library id.

## Capabilities writing templates entry

The bottom-left Capabilities destination opens [[src/renderer/src/screens/Tools/Tools.tsx#Tools]], whose employee tab row contains Tools, Skills, and 写作模板; the MCP Servers tab is hidden from this navigation.

Selecting 写作模板 shows the same searchable profile-local collection as Discover. Both views receive the `hermes-writing-templates-changed` refresh event after import, so a template added in Discover appears without restarting the app.

Template descriptions are collected after import and stored in each template's metadata so the Capabilities list can show a concise explanation instead of only the source filename; older metadata falls back to that filename.

## Chat template activation

Writing templates are inert until the employee explicitly selects one for a conversation.

[[src/renderer/src/screens/Chat/SessionTemplatePicker.tsx#SessionTemplatePicker]] provides a single-select composer control after the web-preview button and persists the chosen template id per chat. On each ordinary turn, [[src/renderer/src/screens/Chat/hooks/useChatActions.ts#useChatActions]] privately attaches the unchanged source file and adds a generic instruction telling the Agent to read and interpret it; slash commands are unchanged.

The desktop never contains format-specific template interpretation. [[src/renderer/src/screens/Chat/sessionSkillEnvelope.ts#buildSessionSkillEnvelope]] carries only the selected filename and the generic Agent instruction, while `file.attach` supplies the original file reference. The private block and attachment references are placed before `[User message]`, allowing the packaged runtime to persist only the employee-authored suffix.
