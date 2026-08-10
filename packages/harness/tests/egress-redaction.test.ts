/**
 * Egress redaction tests for zao.
 *
 * Verifies that secrets in prompts and artifacts are redacted before
 * reaching external LLM APIs (Story 005B).
 *
 * Covers all 5 acceptance tests:
 * - TEST-1: Prompt with `sk-ant-api03-...` → redacted before reaching mock generateObject
 * - TEST-2: Prompt with `Bearer eyJ...` → redacted before reaching mock generateObject
 * - TEST-3: Prompt with `PASSWORD=...` → redacted before reaching mock generateObject
 * - TEST-4: Retry prompt uses redacted content (not original)
 * - TEST-5: Warning emitted when secrets redacted from artifacts (buildContext)
 *
 * @module egress-redaction.test
 */

import { describe, expect, test, mock, afterAll } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { TypeValidationError } from "@ai-sdk/provider";
import { NoObjectGeneratedError } from "ai";
import { generateStructuredResponse } from "../src/core/llm.ts";
import { buildContext } from "../src/core/context.ts";
import type { BuildContextParams } from "../src/core/context.ts";
import { getRoleDef } from "./fixtures/role-registry.ts";
import { mockClientFromLegacy } from "./fixtures/mock-llm-client.ts";

// ── Test Schema ──────────────────────────────────────────────────

const TestSchema = z.object({
  answer: z.string(),
});

// ── Mock Helpers (same patterns as core-llm.test.ts) ─────────────

function mockSuccessResult<T>(object: T) {
  return {
    object,
    reasoning: undefined,
    finishReason: "stop" as const,
    usage: {
      inputTokens: 100,
      outputTokens: 50,
      totalTokens: 150,
      inputTokenDetails: { noCacheTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0 },
      outputTokenDetails: { textTokens: 50, reasoningTokens: 0 },
      raw: undefined,
    },
    warnings: undefined,
    request: { body: undefined, headers: undefined },
    response: { id: "test-id", timestamp: new Date(), modelId: "test-model", headers: {} },
    providerMetadata: undefined,
    toJsonResponse: () => new Response(),
  };
}

function zodErrorShape(issues: Array<{ path: string[]; message: string }>) {
  return {
    name: "ZodError",
    message: JSON.stringify(issues),
    issues: issues.map(({ path, message }) => ({
      code: "invalid_type",
      expected: "string",
      received: "undefined",
      path,
      message,
    })),
  };
}

// ── Default Model Config ─────────────────────────────────────────

const mockConfig = {
  provider: "openai" as const,
  model: "gpt-4o",
  apiKey: "sk-test-key-12345",
};

// ── Suite ────────────────────────────────────────────────────────

describe("egress redaction — generateStructuredResponse", () => {
  // ── TEST-1: Anthropic-style API key redacted before egress ──

  test("redacts sk-ant-api03-... before mock generateObject (TEST-1)", async () => {
    let capturedPrompt = "";
    const mockGenObj = mock((params: { prompt: string }) => {
      capturedPrompt = params.prompt;
      return Promise.resolve(mockSuccessResult({ answer: "done" }));
    });

    const promptWithSecret =
      "Use this API key for the call: sk-ant-api03-abc123def456ghi789";

    await generateStructuredResponse(
      promptWithSecret,
      TestSchema,
      mockClientFromLegacy(mockConfig),
      undefined,
      mockGenObj as unknown as typeof import("ai").generateObject,
    );

    expect(capturedPrompt).not.toContain("sk-ant-api03-abc123def456ghi789");
    expect(capturedPrompt).toContain("[REDACTED]");
  });

  // ── TEST-2: Bearer JWT token redacted before egress ──

  test("redacts Bearer eyJ... before mock generateObject (TEST-2)", async () => {
    let capturedPrompt = "";
    const mockGenObj = mock((params: { prompt: string }) => {
      capturedPrompt = params.prompt;
      return Promise.resolve(mockSuccessResult({ answer: "done" }));
    });

    const promptWithBearer =
      "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.signature";

    await generateStructuredResponse(
      promptWithBearer,
      TestSchema,
      mockClientFromLegacy(mockConfig),
      undefined,
      mockGenObj as unknown as typeof import("ai").generateObject,
    );

    expect(capturedPrompt).not.toContain("eyJhbGci");
    expect(capturedPrompt).toContain("Bearer [REDACTED]");
  });

  // ── TEST-3: Env-var PASSWORD pattern redacted before egress ──

  test("redacts PASSWORD=... before mock generateObject (TEST-3)", async () => {
    let capturedPrompt = "";
    const mockGenObj = mock((params: { prompt: string }) => {
      capturedPrompt = params.prompt;
      return Promise.resolve(mockSuccessResult({ answer: "done" }));
    });

    const promptWithPassword =
      "Database config: PASSWORD=sup3rs3cr3t!";

    await generateStructuredResponse(
      promptWithPassword,
      TestSchema,
      mockClientFromLegacy(mockConfig),
      undefined,
      mockGenObj as unknown as typeof import("ai").generateObject,
    );

    expect(capturedPrompt).not.toContain("sup3rs3cr3t");
    expect(capturedPrompt).toContain("PASSWORD=[REDACTED]");
  });

  // ── TEST-4: Retry prompt uses redacted content ──

  test("retry prompt uses redacted content, not original (TEST-4)", async () => {
    const retryPrompts: string[] = [];

    // Build a TypeValidationError wrapping a ZodError, wrapped in
    // NoObjectGeneratedError (same pattern as core-llm.test.ts).
    const zodErr = zodErrorShape([
      { path: ["answer"], message: "Required" },
    ]);
    const typeValErr = new TypeValidationError({
      value: {},
      cause: zodErr,
    });
    const noObjErr = new NoObjectGeneratedError({
      message: "No object generated",
      cause: typeValErr,
      text: "{}",
      response: {} as any,
      usage: { inputTokens: 10, outputTokens: 0, totalTokens: 10 } as any,
      finishReason: "stop",
    });

    // First call: throw schema validation error (triggers retry)
    // Second call: succeed — capture the retry prompt
    const mockGenObj = mock()
      .mockRejectedValueOnce(noObjErr)
      .mockImplementationOnce((params: { prompt: string }) => {
        retryPrompts.push(params.prompt);
        return Promise.resolve(mockSuccessResult({ answer: "corrected" }));
      });

    const promptWithSecret =
      "Generate a response. API key: sk-ant-api03-retry-test-key-xyz";

    await generateStructuredResponse(
      promptWithSecret,
      TestSchema,
      mockClientFromLegacy(mockConfig),
      undefined,
      mockGenObj as unknown as typeof import("ai").generateObject,
    );

    expect(retryPrompts).toHaveLength(1);

    // Retry prompt must NOT contain the original secret
    expect(retryPrompts[0]!).not.toContain("sk-ant-api03-retry-test-key-xyz");
    // Retry prompt should contain [REDACTED] and the error feedback
    expect(retryPrompts[0]!).toContain("[REDACTED]");
    expect(retryPrompts[0]!).toContain("Your previous response failed schema validation");
  });

  // ── Edge: OpenAI-style sk- key redacted at egress ──

  test("redacts OpenAI-style sk- keys before mock generateObject (EDGE-1)", async () => {
    let capturedPrompt = "";
    const mockGenObj = mock((params: { prompt: string }) => {
      capturedPrompt = params.prompt;
      return Promise.resolve(mockSuccessResult({ answer: "done" }));
    });

    const promptWithOpenAIKey =
      "Use: sk-abcdefghij1234567890abcdef";

    await generateStructuredResponse(
      promptWithOpenAIKey,
      TestSchema,
      mockClientFromLegacy(mockConfig),
      undefined,
      mockGenObj as unknown as typeof import("ai").generateObject,
    );

    expect(capturedPrompt).not.toContain("sk-abcdefghij1234567890abcdef");
    expect(capturedPrompt).toContain("[REDACTED]");
  });

  // ── Edge: x-api-key header redacted at egress ──

  test("redacts x-api-key headers before mock generateObject (EDGE-2)", async () => {
    let capturedPrompt = "";
    const mockGenObj = mock((params: { prompt: string }) => {
      capturedPrompt = params.prompt;
      return Promise.resolve(mockSuccessResult({ answer: "done" }));
    });

    const promptWithHeader = "x-api-key: my-secret-service-key-789";

    await generateStructuredResponse(
      promptWithHeader,
      TestSchema,
      mockClientFromLegacy(mockConfig),
      undefined,
      mockGenObj as unknown as typeof import("ai").generateObject,
    );

    expect(capturedPrompt).not.toContain("my-secret-service-key-789");
    expect(capturedPrompt).toContain("x-api-key: [REDACTED]");
  });

  // ── Edge: API_KEY= env var redacted at egress ──

  test("redacts API_KEY= env-var before mock generateObject (EDGE-3)", async () => {
    let capturedPrompt = "";
    const mockGenObj = mock((params: { prompt: string }) => {
      capturedPrompt = params.prompt;
      return Promise.resolve(mockSuccessResult({ answer: "done" }));
    });

    const promptWithApiKey =
      "The service uses API_KEY=sk-live-1234567890abcdefghij";

    await generateStructuredResponse(
      promptWithApiKey,
      TestSchema,
      mockClientFromLegacy(mockConfig),
      undefined,
      mockGenObj as unknown as typeof import("ai").generateObject,
    );

    expect(capturedPrompt).not.toContain("sk-live-1234567890abcdefghij");
    expect(capturedPrompt).toContain("API_KEY=[REDACTED]");
  });

  // ── Edge: SECRET= env var redacted at egress ──

  test("redacts SECRET= env-var before mock generateObject (EDGE-4)", async () => {
    let capturedPrompt = "";
    const mockGenObj = mock((params: { prompt: string }) => {
      capturedPrompt = params.prompt;
      return Promise.resolve(mockSuccessResult({ answer: "done" }));
    });

    const promptWithSecret =
      "Environment: SECRET=prod-database-password";

    await generateStructuredResponse(
      promptWithSecret,
      TestSchema,
      mockClientFromLegacy(mockConfig),
      undefined,
      mockGenObj as unknown as typeof import("ai").generateObject,
    );

    expect(capturedPrompt).not.toContain("prod-database-password");
    expect(capturedPrompt).toContain("SECRET=[REDACTED]");
  });

  // ── Edge: JSON-aware redaction at egress ──

  test("redacts JSON-format secrets before mock generateObject (EDGE-5)", async () => {
    let capturedPrompt = "";
    const mockGenObj = mock((params: { prompt: string }) => {
      capturedPrompt = params.prompt;
      return Promise.resolve(mockSuccessResult({ answer: "done" }));
    });

    const promptWithJsonSecret =
      'Config: {"api_key":"sk-hush-1234567890abcdefghijklmnop"}';

    await generateStructuredResponse(
      promptWithJsonSecret,
      TestSchema,
      mockClientFromLegacy(mockConfig),
      undefined,
      mockGenObj as unknown as typeof import("ai").generateObject,
    );

    expect(capturedPrompt).not.toContain("sk-hush-1234567890abcdefghijklmnop");
    expect(capturedPrompt).toContain('"api_key":"[REDACTED]"');
  });

  // ── Edge: Clean prompt passes through unchanged ──

  test("clean prompt passes through unchanged to mock generateObject (EDGE-6)", async () => {
    let capturedPrompt = "";
    const mockGenObj = mock((params: { prompt: string }) => {
      capturedPrompt = params.prompt;
      return Promise.resolve(mockSuccessResult({ answer: "done" }));
    });

    const cleanPrompt = "Please analyze this code and suggest improvements.";

    await generateStructuredResponse(
      cleanPrompt,
      TestSchema,
      mockClientFromLegacy(mockConfig),
      undefined,
      mockGenObj as unknown as typeof import("ai").generateObject,
    );

    // Prompt should be identical — no false-positive redaction
    expect(capturedPrompt).toBe(cleanPrompt);
    expect(capturedPrompt).not.toContain("[REDACTED]");
  });

  // ── Edge: Multiple secret types in one prompt ──

  test("redacts all secret types in a single prompt before egress (EDGE-7)", async () => {
    let capturedPrompt = "";
    const mockGenObj = mock((params: { prompt: string }) => {
      capturedPrompt = params.prompt;
      return Promise.resolve(mockSuccessResult({ answer: "done" }));
    });

    const multiSecretPrompt = [
      "Multiple secrets:",
      "Anthropic: sk-ant-api03-multi-test-abc",
      "OpenAI: sk-12345678901234567890ab",
      "Bearer: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.abc.def",
      "header: x-api-key: multi-test-key",
      "Env: PASSWORD=multi-pass",
      "JSON: {\"SECRET\":\"multi-json-secret\"}",
    ].join("\n");

    await generateStructuredResponse(
      multiSecretPrompt,
      TestSchema,
      mockClientFromLegacy(mockConfig),
      undefined,
      mockGenObj as unknown as typeof import("ai").generateObject,
    );

    // Verify no raw secrets leak
    expect(capturedPrompt).not.toContain("sk-ant-api03-multi-test-abc");
    expect(capturedPrompt).not.toContain("sk-12345678901234567890ab");
    expect(capturedPrompt).not.toContain("eyJhbGci");
    expect(capturedPrompt).not.toContain("multi-test-key");
    expect(capturedPrompt).not.toContain("multi-pass");
    expect(capturedPrompt).not.toContain("multi-json-secret");

    // Verify redaction placeholders exist
    // Count [REDACTED] occurrences — should be several
    const redactedCount = (capturedPrompt.match(/\[REDACTED\]/g) ?? []).length;
    expect(redactedCount).toBeGreaterThanOrEqual(5);
  });

  // ── Edge: Deterministic redaction (AC-4: cache prefix stability) ──

  test("redaction is deterministic at egress — same input → same output (EDGE-8)", async () => {
    const capturedPrompts: string[] = [];

    const promptWithSecret =
      "API: sk-ant-api03-deterministic-test-12345\nToken: Bearer eyJdet.abc.def";

    // Call twice and capture both redacted prompts
    for (let i = 0; i < 2; i++) {
      const mockGenObj = mock((params: { prompt: string }) => {
        capturedPrompts.push(params.prompt);
        return Promise.resolve(mockSuccessResult({ answer: "done" }));
      });

      await generateStructuredResponse(
        promptWithSecret,
        TestSchema,
        mockClientFromLegacy(mockConfig),
        undefined,
        mockGenObj as unknown as typeof import("ai").generateObject,
      );
    }

    expect(capturedPrompts).toHaveLength(2);
    // Both redacted prompts must be identical for cache stability
    expect(capturedPrompts[0]!).toBe(capturedPrompts[1]!);
    expect(capturedPrompts[0]!).not.toContain("sk-ant-api03-deterministic-test-12345");
    expect(capturedPrompts[0]!).toContain("[REDACTED]");
  });

  // ── Edge: Empty prompt — no crash ──

  test("handles empty prompt without crashing (EDGE-9)", async () => {
    let capturedPrompt = "";
    const mockGenObj = mock((params: { prompt: string }) => {
      capturedPrompt = params.prompt;
      return Promise.resolve(mockSuccessResult({ answer: "done" }));
    });

    await generateStructuredResponse(
      "",
      TestSchema,
      mockClientFromLegacy(mockConfig),
      undefined,
      mockGenObj as unknown as typeof import("ai").generateObject,
    );

    // Empty string should remain empty (no crash, no [REDACTED] appended)
    expect(capturedPrompt).toBe("");
  });

  // ── Edge: Secret at beginning of prompt ──

  test("redacts secret at very beginning of prompt (EDGE-10)", async () => {
    let capturedPrompt = "";
    const mockGenObj = mock((params: { prompt: string }) => {
      capturedPrompt = params.prompt;
      return Promise.resolve(mockSuccessResult({ answer: "done" }));
    });

    // Secret is the very first thing in the prompt
    const promptLeading = "PASSWORD=first-thing-in-prompt then some normal text follows.";

    await generateStructuredResponse(
      promptLeading,
      TestSchema,
      mockClientFromLegacy(mockConfig),
      undefined,
      mockGenObj as unknown as typeof import("ai").generateObject,
    );

    expect(capturedPrompt).not.toContain("first-thing-in-prompt");
    expect(capturedPrompt).toContain("PASSWORD=[REDACTED]");
  });

  // ── Edge: Secret at end of prompt ──

  test("redacts secret at very end of prompt (EDGE-11)", async () => {
    let capturedPrompt = "";
    const mockGenObj = mock((params: { prompt: string }) => {
      capturedPrompt = params.prompt;
      return Promise.resolve(mockSuccessResult({ answer: "done" }));
    });

    // Secret is the very last thing in the prompt
    const promptTrailing = "Some normal text and then the credential SECRET=trailing-secret";

    await generateStructuredResponse(
      promptTrailing,
      TestSchema,
      mockClientFromLegacy(mockConfig),
      undefined,
      mockGenObj as unknown as typeof import("ai").generateObject,
    );

    expect(capturedPrompt).not.toContain("trailing-secret");
    expect(capturedPrompt).toContain("SECRET=[REDACTED]");
  });
});

// ── Suite: Context/Artifact redaction warnings ────────────────────

describe("egress redaction — buildContext artifact warnings", () => {
  let tempDirs: string[] = [];

  function makeTempDir(): string {
    const dir = join("/tmp", `zao-test-redact-${crypto.randomUUID()}`);
    tempDirs.push(dir);
    return dir;
  }

  async function ensureDir(dir: string): Promise<void> {
    await mkdir(dir, { recursive: true });
  }

  afterAll(async () => {
    for (const dir of tempDirs) {
      try {
        await rm(dir, { recursive: true, force: true });
      } catch {
        // Best-effort cleanup
      }
    }
  });

  // ── TEST-5: Warning emitted when secrets redacted from artifacts ──

  test("emits warning when secrets redacted from artifacts (TEST-5)", async () => {
    const projectRoot = makeTempDir();
    await ensureDir(projectRoot);

    // Create a golden example to avoid missing-fixture warnings
    await ensureDir(join(projectRoot, "tests/fixtures"));
    await writeFile(
      join(projectRoot, "tests/fixtures/golden-developer.json"),
      JSON.stringify({ answer: "example" }),
    );

    // Create an artifact with secrets
    const artifactPath = join(projectRoot, "secret-config.txt");
    await writeFile(
      artifactPath,
      `# Config\nAPI_KEY=sk-ant-api03-deadbeef123456789\nSECRET=my-password\nTOKEN=abc123\n`,
    );

    const params: BuildContextParams = {
      roleDef: getRoleDef("developer"),
      roleName: "developer",
      task: "Fix the login bug",
      artifacts: [artifactPath],
      modelConfig: {
        provider: "openai",
        model: "gpt-4o",
        contextWindow: 128000,
      },
      projectRoot,
    };

    const result = await buildContext(params);

    // Verify the context does NOT contain the raw secrets
    expect(result.context).not.toContain("sk-ant-api03-deadbeef123456789");
    expect(result.context).not.toContain("my-password");
    expect(result.context).not.toContain("abc123");

    // The context should contain redacted placeholders
    expect(result.context).toContain("[REDACTED]");

    // Verify the warning was emitted
    const redactionWarnings = result.warnings.filter((w) =>
      w.startsWith("Secrets redacted in"),
    );
    expect(redactionWarnings.length).toBeGreaterThanOrEqual(1);
    expect(redactionWarnings[0]!).toContain(artifactPath);
    expect(redactionWarnings[0]!).toContain("pattern(s) replaced");
  });

  // ── Edge: Clean artifact — no false redaction warnings ──

  test("clean artifact produces no redaction warnings (EDGE-12)", async () => {
    const projectRoot = makeTempDir();
    await ensureDir(projectRoot);

    // Create a golden example to avoid missing-fixture warnings
    await ensureDir(join(projectRoot, "tests/fixtures"));
    await writeFile(
      join(projectRoot, "tests/fixtures/golden-developer.json"),
      JSON.stringify({ answer: "example" }),
    );

    // Create a clean artifact with no secrets
    const artifactPath = join(projectRoot, "clean-config.txt");
    await writeFile(
      artifactPath,
      "# Clean config\nPORT=8080\nHOST=localhost\nDEBUG=true\n",
    );

    const params: BuildContextParams = {
      roleDef: getRoleDef("developer"),
      roleName: "developer",
      task: "Fix the login bug",
      artifacts: [artifactPath],
      modelConfig: {
        provider: "openai",
        model: "gpt-4o",
        contextWindow: 128000,
      },
      projectRoot,
    };

    const result = await buildContext(params);

    // No redaction warnings should be emitted for clean content
    const redactionWarnings = result.warnings.filter((w) =>
      w.startsWith("Secrets redacted in"),
    );
    expect(redactionWarnings).toHaveLength(0);

    // Content should be preserved as-is
    expect(result.context).toContain("PORT=8080");
    expect(result.context).toContain("HOST=localhost");
    expect(result.context).not.toContain("[REDACTED]");
  });

  // ── Edge: Task containing secrets → context redacted ──

  test("task with secrets produces redacted context in buildContext (EDGE-13)", async () => {
    const projectRoot = makeTempDir();
    await ensureDir(projectRoot);

    // Create a golden example to avoid missing-fixture warnings
    await ensureDir(join(projectRoot, "tests/fixtures"));
    await writeFile(
      join(projectRoot, "tests/fixtures/golden-developer.json"),
      JSON.stringify({ answer: "example" }),
    );

    const params: BuildContextParams = {
      roleDef: getRoleDef("developer"),
      roleName: "developer",
      task: "Use API key: sk-ant-api03-task-secret-12345 for the integration",
      artifacts: [],
      modelConfig: {
        provider: "openai",
        model: "gpt-4o",
        contextWindow: 128000,
      },
      projectRoot,
    };

    const result = await buildContext(params);

    // Task context should be redacted at egress level (in generateStructuredResponse),
    // but buildContext does NOT redact the task itself — only artifacts.
    // The task secret is caught by the egress choke point in llm.ts.
    // So: context may contain the raw secret, but that's the design (defense in depth —
    // redaction happens at the network choke point, not at context-build).
    //
    // This test verifies that buildContext does not crash on task-with-secrets
    // AND that the context is assembled correctly.
    // The task itself is NOT redacted by buildContext — only artifacts get
    // redacted on-load. Task secrets are caught at the egress choke point
    // in generateStructuredResponse.
    expect(result.context).toContain("sk-ant-api03-task-secret-12345");

    // No spurious warnings about artifacts (there are none)
    const redactionWarnings = result.warnings.filter((w) =>
      w.startsWith("Secrets redacted in"),
    );
    expect(redactionWarnings).toHaveLength(0);
  });

  // ── Edge: Multiple artifacts with mixed secrets ──

  test("emits warnings for each artifact that contains secrets (EDGE-14)", async () => {
    const projectRoot = makeTempDir();
    await ensureDir(projectRoot);

    await ensureDir(join(projectRoot, "tests/fixtures"));
    await writeFile(
      join(projectRoot, "tests/fixtures/golden-developer.json"),
      JSON.stringify({ answer: "example" }),
    );

    // Artifact A: has secrets
    const secretArtifactPath = join(projectRoot, "secret-a.txt");
    await writeFile(
      secretArtifactPath,
      "PASSWORD=alpha-secret\n",
    );

    // Artifact B: clean, no secrets
    const cleanArtifactPath = join(projectRoot, "clean-b.txt");
    await writeFile(
      cleanArtifactPath,
      "This is safe content.\n",
    );

    // Artifact C: also has secrets
    const secretArtifactPathC = join(projectRoot, "secret-c.txt");
    await writeFile(
      secretArtifactPathC,
      "API_KEY=gamma-secret-key\n",
    );

    const params: BuildContextParams = {
      roleDef: getRoleDef("developer"),
      roleName: "developer",
      task: "Review the config files",
      artifacts: [secretArtifactPath, cleanArtifactPath, secretArtifactPathC],
      modelConfig: {
        provider: "openai",
        model: "gpt-4o",
        contextWindow: 128000,
      },
      projectRoot,
    };

    const result = await buildContext(params);

    // Context must not contain raw secrets
    expect(result.context).not.toContain("alpha-secret");
    expect(result.context).not.toContain("gamma-secret-key");
    // Safe content passes through
    expect(result.context).toContain("This is safe content.");

    // Should have exactly 2 redaction warnings (one per secret artifact)
    const redactionWarnings = result.warnings.filter((w) =>
      w.startsWith("Secrets redacted in"),
    );
    expect(redactionWarnings).toHaveLength(2);
    expect(redactionWarnings[0]!).toContain("secret-a.txt");
    expect(redactionWarnings[1]!).toContain("secret-c.txt");
  });
});
