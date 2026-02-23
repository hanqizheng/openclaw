# Workflow Publisher

Private workflow plugin for:

- fixed-source web collection (`/scan <topic>`)
- Telegram review + two-step publish buttons
- article import API publishing with idempotency and audit history

## Commands

- `/scan <topic> [profile]`
- `/pub list [topic]`
- `/pub prepare <candidateId>`
- `/pub confirm <candidateId> <nonce> [draft|publish]`
- `/pub cancel <candidateId>`

## Optional tools

- `workflow_collect`
- `workflow_candidate_list`
- `workflow_publish_prepare`
- `workflow_publish_confirm`
- `site_article_import`

## Config

Configure under `plugins.entries.workflow-publisher.config`.

Set the import token in env (default key name from config):

```bash
export ARTICLE_IMPORT_SECRET='...'
```

Set the translation token as well (or let translation reuse import token):

```bash
export ARTICLE_TRANSLATE_SECRET='...'
```

When translation is enabled, publish confirmation is fail-closed: if title/slug bilingual generation fails, `/pub confirm` is blocked and returns a translation error instead of silently publishing fallback content.

Example:

```json5
{
  plugins: {
    entries: {
      "workflow-publisher": {
        enabled: true,
        config: {
          telegram: {
            approvers: ["123456789"],
            pendingTtlMinutes: 15,
          },
          dedupe: {
            windowDays: 7,
          },
          limits: {
            maxCandidatesPerRun: 10,
          },
          sources: {
            defaultProfile: "finance",
            profiles: {
              finance: {
                domains: ["seekingalpha.com", "reuters.com", "ft.com"],
                queries: ["{topic} market update", "{topic} analysis"],
              },
            },
          },
          topics: {
            defaultCategoryId: 1,
            categoryMap: {
              ai: 3,
              macro: 5,
            },
          },
          publishing: {
            defaultIsPublished: false,
            defaultDataSource: "NEW",
            api: {
              baseUrl: "http://localhost:5789",
              importPath: "/api/integrations/articles/import",
              tokenEnv: "ARTICLE_IMPORT_SECRET",
              timeoutSeconds: 45,
            },
            translation: {
              enabled: true,
              model: "gpt-4.1-mini",
              api: {
                baseUrl: "http://localhost:5789",
                path: "/api/integrations/articles/translate",
                tokenEnv: "ARTICLE_TRANSLATE_SECRET",
                timeoutSeconds: 30,
              },
            },
          },
        },
      },
    },
  },
}
```

If you want models to call these tools, add them to allowlists (they are optional tools by default).
