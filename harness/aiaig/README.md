# AIAIG OpenClaw MVP

This folder defines the first clean OpenClaw shape for the AIAIG workflow.

It is meant to hold versioned harness source, not live runtime state.

## What Belongs In Git

- Agent instructions and workflow templates
- Repo-local plugin source
- Example config snippets

## What Stays Local

- `~/.openclaw/openclaw.json`
- `~/.openclaw/.env`
- sessions, logs, credentials, and caches
- article packets and grounded-search budget state

## Layering

- `cron`
  - Runs the daily discovery turn at 08:00.
  - Wakes the `aiaig-editor` agent instead of calling the site API directly.

- `agent`
  - Uses `aiaig_grounded_search` for budgeted discovery and `web_fetch` for source expansion.
  - Uses the plugin tools below for workflow state, search budgeting, payload validation, and publishing.
  - Uses Telegram as the only human review surface.

- `plugin`
  - Loaded from `plugins.load.paths` so the repo-local plugin source is the runtime source of truth.
  - `aiaig_packet_save`
  - `aiaig_packet_get`
  - `aiaig_search_budget_status`
  - `aiaig_grounded_search`
  - `aiaig_article_build_payload`
  - `aiaig_article_validate`
  - `aiaig_article_publish`

- `Telegram`
  - Carries candidate-topic selection, draft preview, and publish confirmation.
  - Inline buttons send callback text back into the agent as `callback_data: ...`.

## Workflow

1. Daily cron wakes `aiaig-editor`.
2. Agent discovers candidate news across configured countries/regions.
3. Agent proposes 3 to 5 candidate topics.
4. Agent saves those topics with `aiaig_packet_save`.
5. Agent sends a Telegram message with inline buttons:
   - `aiaig:topic:<packetId>:<candidateId>`
6. When a callback arrives, the agent:
   - loads the packet with `aiaig_packet_get`
   - expands the selected topic into bilingual Markdown article fields
   - builds a valid import payload with `aiaig_article_build_payload`
   - validates it with `aiaig_article_validate`
   - saves the draft packet
   - sends preview buttons
7. Preview buttons:
   - `aiaig:draft:<packetId>`
   - `aiaig:publish:<packetId>`
8. Agent loads the draft packet and calls `aiaig_article_publish`.

## Design Rules

- Topic judgment is agent work; cost enforcement is plugin work.
- AIAIG API calls are plugin work, not skill work.
- AIAIG discovery should use the budgeted grounded-search tool, not raw `web_search`.
- AIAIG draft generation should use the payload-builder tool, not model-authored JSON strings.
- Telegram buttons only carry compact workflow ids, never the full article JSON.
- Every publish path must validate before POST.
- Validation and publish failures must be surfaced back to Telegram explicitly.
- The root payload is treated as `zh-CN`; English goes into `translations.en` and `blockTranslations.*.en`.

## Current Scope

This MVP now includes a Gemini-grounded discovery tool with:

- a persistent on-disk search cache
- a hard daily request budget
- a default `gemini-2.5-flash-lite` model so each request maps cleanly to one grounded-prompt slot
- optional HTTP proxy routing for hosts that cannot reach Google APIs directly

Keep broader source-specific crawling out of the plugin until the editorial flow is stable.
