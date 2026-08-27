# Discover

The Discover screen exposes employee-facing catalogs and a profile-local writing-template library shared with Capabilities and chat.

## Skill ownership columns

The Skills tab separates product-managed system skills from profile-local user skills so employees can understand ownership at a glance.

[[src/renderer/src/screens/Discover/Discover.tsx#Discover]] renders two columns after applying the shared search query. Bundled entries appear under 系统自带 SKILL, reusing matching registry metadata when available; that column alone has an accessible expand/collapse control.

[[src/main/skills.ts#listUserAddedSkills]] defines the user boundary as the `custom` category or the desktop user-added marker. User cards are always rendered in the 用户添加的 SKILL column and remain visible when the system column is collapsed.

## Starter user skills

Each packaged profile receives editable custom Skills for common employee roles, conversational skill creation, and three internal-knowledge reports.

`scripts/prepare-offline-runtime.mjs` stages the repository-owned `resources/starter-skills` inventory into `preset-content/skills/custom`. [[src/main/installer.ts#installBundledProfileContent]] installs it during default-profile startup and named-profile creation; opening the picker performs no filesystem copy. Existing same-name directories always win.

The Skill Creator starter guides a dialogue from trigger examples and scope through file creation and validation, defaulting new skills to the active profile's user-owned custom directory.

## Market report user Skill

Market, HR, and finance RAG report Skills are included in the user-added catalog and per-chat picker for fresh installations and named profiles, without replacing employee edits.

The fixed custom inventory contains `market-report-rag`, `hr-analysis-report-rag`, and `finance-analysis-report-rag`. Development preparation copies the same three directories into the default profile's `skills/custom`; packaged and development preparation move an obsolete profile `skills/research/market-report-rag` into `skill-backups`, so the bare name resolves only to the maintained custom Skill without discarding possible local edits.

## Managed report Skill upgrades

Product-maintained report Skills receive corrected contracts on application upgrades while their previous custom directories remain recoverable.

[[src/main/preset-content.ts#installManagedReportSkills]] compares a packaged content revision, stages each changed report Skill, moves an existing same-name custom directory to `skill-backups`, and atomically activates the packaged version. A given revision is installed only once; all other starter and employee-created custom Skills retain the normal never-overwrite behavior.

## Legacy report Skill migration

An older product-owned research copy is preserved outside discovery roots when the maintained custom market report Skill exists, preventing both duplicate picker entries and ambiguous `skill_view` resolution.

[[src/main/preset-content.ts#quarantineLegacyMarketReportSkill]] moves the exact legacy directory into the profile's `skill-backups` directory during packaged preset installation. Development preparation applies the same migration before the Agent starts; unrelated research Skills are untouched.

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
