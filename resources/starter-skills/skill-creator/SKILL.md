---
name: skill-creator
description: 通过对话创建或更新可复用的Agent技能，过程中明确触发条件、执行流程、输出规范、约束规则与配套资源；适用于用户提出搭建、定制、优化或封装基于SKILL.md功能模块的需求场景。
---

# Skill Creator

Guide the user from a conversational idea to a concise, reusable skill that Hermes can discover and invoke.

## Conversation workflow

1. Ask for one or two representative requests that should trigger the skill, plus the expected outcome. Infer low-risk details from context instead of asking for every preference.
2. Define the skill boundary: included tasks, excluded tasks, required inputs, output quality, and safety or approval points.
3. Choose a lowercase hyphen-case name under 64 characters. Avoid a name that collides with an existing skill.
4. Plan only reusable resources that add real value: `scripts/` for deterministic repeated operations, `references/` for detailed domain material, and `assets/` for output templates or media.
5. Show the proposed name, trigger description, workflow, and files. Obtain confirmation before writing when the destination or overwrite behavior is ambiguous.

## Create the skill

Create `<skill-name>/SKILL.md` with YAML frontmatter containing only `name` and `description`. Make the description state both what the skill does and when it should trigger. Write the body as direct instructions to another capable agent; include non-obvious procedures, constraints, checks, and concise examples.

Default to the active profile's `skills/custom` directory so the skill appears as user-added in JingYuAI. Preserve existing files, never overwrite a skill without explicit approval, and keep supporting paths relative to the skill directory.

When useful, add `agents/openai.yaml` with a human-facing display name, a 25-64 character short description, and a one-sentence default prompt that explicitly mentions `$skill-name`.

## Validate and hand off

Check that the directory name matches the frontmatter name, the YAML is valid, no placeholders remain, referenced files exist, and the trigger description is specific. Exercise the skill against at least one representative request when safe.

Finish by telling the user where the skill was created, what requests trigger it, which files were added, and how to invoke it. If validation cannot run, state the exact manual checks completed.
