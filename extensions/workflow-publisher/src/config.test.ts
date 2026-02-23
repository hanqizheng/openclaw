import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveWorkflowConfig } from "./config.js";

describe("workflow-publisher config", () => {
  it("fills discovery defaults", () => {
    const cfg = resolveWorkflowConfig({
      pluginConfig: {
        sources: {
          profiles: {
            default: {
              domains: ["example.com"],
            },
          },
        },
        publishing: {
          api: {
            baseUrl: "http://127.0.0.1:5789",
            tokenEnv: "ARTICLE_IMPORT_SECRET",
          },
          translation: {
            enabled: true,
          },
        },
      },
      stateDir: "/tmp/workflow-publisher-config-test",
    });

    expect(cfg.discoveryEnabled).toBe(true);
    expect(cfg.discoveryApiBaseUrl).toBe("http://127.0.0.1:5789");
    expect(cfg.discoveryApiPath).toBe("/api/integrations/articles/search");
    expect(cfg.discoveryApiTokenEnv).toBe("ARTICLE_TRANSLATE_SECRET");
    expect(cfg.discoveryMaxResultsPerQuery).toBe(8);
    expect(cfg.discoveryMinContentChars).toBe(800);
    expect(cfg.discoveryBlockedPathPatterns).toContain("/search");
    expect(cfg.sqlitePath).toBe(
      path.join("/tmp/workflow-publisher-config-test", "workflow-publisher.sqlite"),
    );
  });

  it("applies custom discovery settings", () => {
    const cfg = resolveWorkflowConfig({
      pluginConfig: {
        sources: {
          profiles: {
            custom: {
              domains: ["news.example.com"],
            },
          },
          defaultProfile: "custom",
        },
        publishing: {
          api: {
            baseUrl: "http://127.0.0.1:5789",
            tokenEnv: "ARTICLE_IMPORT_SECRET",
          },
          discovery: {
            enabled: false,
            maxResultsPerQuery: 12,
            minContentChars: 1500,
            allowedPathPatterns: ["/article/"],
            blockedPathPatterns: ["/list"],
            api: {
              baseUrl: "https://discover.example.com",
              path: "/discover/search",
              tokenEnv: "ARTICLE_DISCOVERY_SECRET",
              timeoutSeconds: 9,
            },
          },
        },
      },
      stateDir: "/tmp/workflow-publisher-config-test",
    });

    expect(cfg.discoveryEnabled).toBe(false);
    expect(cfg.discoveryApiBaseUrl).toBe("https://discover.example.com");
    expect(cfg.discoveryApiPath).toBe("/discover/search");
    expect(cfg.discoveryApiTokenEnv).toBe("ARTICLE_DISCOVERY_SECRET");
    expect(cfg.discoveryApiTimeoutMs).toBe(9000);
    expect(cfg.discoveryMaxResultsPerQuery).toBe(12);
    expect(cfg.discoveryMinContentChars).toBe(1500);
    expect(cfg.discoveryAllowedPathPatterns).toEqual(["/article/"]);
    expect(cfg.discoveryBlockedPathPatterns).toEqual(["/list"]);
  });
});
