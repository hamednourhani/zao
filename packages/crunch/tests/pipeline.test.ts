import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import type { z } from "zod";
import type { LlmClient, ModelOptions } from "@zao/llm-clients";
import {
  validateInput,
  readContext,
  research,
  synthesize,
  emitBlueprint,
  crunch,
  decisionRound,
} from "../src/pipeline.ts";
import type {
  GenerateStructuredFn,
  DecisionRoundFn,
} from "../src/pipeline.ts";
import { BlueprintSchema, SynthesisResultSchema } from "../src/schemas.ts";
import type { ResearchStep, SynthesisResult } from "../src/schemas.ts";

// ── Test Helpers ───────────────────────────────────────────────────

let tempDir: string;

beforeAll(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "crunch-test-"));
});

afterAll(async () => {
  await fs.rm(tempDir, { recursive: true, force: true });
});

/**
 * Creates a mock LlmClient for testing. Returns a dummy client that
 * doesn't actually make network calls — the generate function handles everything.
 */
function createMockClient(llmId = "test:mock"): LlmClient {
  return {
    llmId,
    providerId: "test",
    modelSlug: "mock",
    apiModelId: "mock-model",
    createModel: (_options?: ModelOptions) => ({
      specificationVersion: "v1",
      provider: "test",
      modelId: "mock-model",
      defaultObjectGenerationMode: "json",
      doGenerate: async () => {
        throw new Error("Mock model does not generate text — use injectable generate function");
      },
    }),
  } as unknown as LlmClient;
}

/**
 * Creates a mock LlmClientRegistry that returns our mock client.
 */
function createMockRegistry(client: LlmClient = createMockClient()) {
  return {
    getClient: async (_llmId: string): Promise<LlmClient> => client,
    listClients: () => [{ llmId: client.llmId, providerId: client.providerId, modelSlug: client.modelSlug, apiModelId: client.apiModelId }],
    registerProvider: () => {},
  };
}

/**
 * Creates a mock generate function that returns predetermined results.
 *
 * Uses call-order tracking: first 3 calls return ResearchSteps, 4th+
 * returns SynthesisResult. For isolated calls (e.g., direct synthesize
 * tests), use {@link createMockSynthesisGenerate}.
 */
function createMockGenerate(
  researchResponses: ResearchStep[] = [],
  synthesisResponse?: SynthesisResult,
): GenerateStructuredFn {
  let callIndex = 0;
  let researchIndex = 0;
  let synthesisCalled = false;

  return async <T>(
    _prompt: string,
    _schema: z.ZodSchema<T>,
    _client: LlmClient,
    _options?: ModelOptions,
  ): Promise<{ success: boolean; result?: T; error?: string }> => {
    callIndex++;

    // First 3 calls are research steps (for full pipeline orchestration)
    if (callIndex <= 3) {
      const step = researchResponses[researchIndex];
      researchIndex++;
      if (step) {
        return { success: true, result: step as unknown as T };
      }
      return {
        success: true,
        result: {
          perspective: "fallback",
          findings: "Fallback research finding.",
        } as unknown as T,
      };
    }

    // 4th+ call is synthesis
    if (!synthesisCalled && synthesisResponse) {
      synthesisCalled = true;
      return { success: true, result: synthesisResponse as unknown as T };
    }
    return {
      success: true,
      result: {
        summary: "Default synthesis summary.",
        decision: "Default decision.",
        alternatives: [],
        risks: [],
      } as unknown as T,
    };
  };
}

/**
 * Creates a mock generate that always returns a SynthesisResult.
 * For use in isolated {@link synthesize} tests.
 */
function createMockSynthesisGenerate(
  synthesisResponse?: SynthesisResult,
): GenerateStructuredFn {
  let called = false;

  return async <T>(
    _prompt: string,
    _schema: z.ZodSchema<T>,
    _client: LlmClient,
    _options?: ModelOptions,
  ): Promise<{ success: boolean; result?: T; error?: string }> => {
    if (!called && synthesisResponse) {
      called = true;
      return { success: true, result: synthesisResponse as unknown as T };
    }
    return {
      success: true,
      result: {
        summary: "Default synthesis.",
        decision: "Default.",
        alternatives: [],
        risks: [],
      } as unknown as T,
    };
  };
}

/**
 * Creates a mock generate that fails on the first call(s) then succeeds.
 * Used to test retry/error handling.
 */
function createFailingThenSucceedingGenerate(
  failCount: number,
  successResponse: ResearchStep,
): GenerateStructuredFn {
  let callCount = 0;

  return async <T>(
    _prompt: string,
    _schema: z.ZodSchema<T>,
    _client: LlmClient,
    _options?: ModelOptions,
  ): Promise<{ success: boolean; result?: T; error?: string }> => {
    callCount++;
    if (callCount <= failCount) {
      return { success: false, error: "Invalid JSON response from model" };
    }
    return { success: true, result: successResponse as unknown as T };
  };
}

// ── Tests ──────────────────────────────────────────────────────────

describe("validateInput", () => {
  test("throws on empty string", () => {
    expect(() => validateInput("")).toThrow("Question must be a non-empty string");
  });

  test("throws on whitespace-only string", () => {
    expect(() => validateInput("   \t\n  ")).toThrow("Question must be a non-empty string");
  });

  test("returns trimmed string for valid question", () => {
    const result = validateInput("  How do I add rate limiting?  ");
    expect(result).toBe("How do I add rate limiting?");
  });

  test("passes on valid non-empty question", () => {
    const result = validateInput("What is the architecture?");
    expect(result).toBe("What is the architecture?");
  });
});

describe("readContext", () => {
  test("reads files from temp directory", async () => {
    // Create test files in temp directory
    const testDir = path.join(tempDir, "readContext-test-1");
    await fs.mkdir(testDir, { recursive: true });
    await fs.writeFile(path.join(testDir, "file1.txt"), "Content of file 1");
    await fs.writeFile(path.join(testDir, "file2.txt"), "Content of file 2");

    const context = await readContext(testDir);
    expect(context).toContain("file1.txt");
    expect(context).toContain("Content of file 1");
    expect(context).toContain("file2.txt");
    expect(context).toContain("Content of file 2");
  });

  test("reads specific files when contextFiles provided", async () => {
    const testDir = path.join(tempDir, "readContext-test-2");
    await fs.mkdir(testDir, { recursive: true });
    await fs.writeFile(path.join(testDir, "a.txt"), "File A");
    await fs.writeFile(path.join(testDir, "b.txt"), "File B");

    const context = await readContext(testDir, ["a.txt"]);
    expect(context).toContain("a.txt");
    expect(context).toContain("File A");
    expect(context).not.toContain("b.txt");
  });

  test("handles empty directory gracefully", async () => {
    const testDir = path.join(tempDir, "readContext-test-3");
    await fs.mkdir(testDir, { recursive: true });

    const context = await readContext(testDir);
    expect(context).toBe("");
  });

  test("handles non-existent directory gracefully", async () => {
    const context = await readContext("/nonexistent/path/12345");
    expect(context).toBe("");
  });
});

describe("research", () => {
  test("produces 3 ResearchSteps with mock LLM", async () => {
    const mockSteps: ResearchStep[] = [
      { perspective: "architect", findings: "Architecture is modular." },
      { perspective: "security", findings: "Security looks good." },
      { perspective: "testing", findings: "Tests are comprehensive." },
    ];
    const mockGenerate = createMockGenerate(mockSteps);
    const registry = createMockRegistry();

    const steps = await research(
      "Test question",
      "Some context",
      registry,
      { _generate: mockGenerate },
    );

    expect(steps.length).toBe(3);
    expect(steps[0]?.perspective).toBe("architect");
    expect(steps[0]?.findings).toBe("Architecture is modular.");
    expect(steps[1]?.perspective).toBe("security");
    expect(steps[2]?.perspective).toBe("testing");
  });

  test("handles LLM failure — includes error step", async () => {
    const failGen = createFailingThenSucceedingGenerate(
      999, // Always fail
      { perspective: "ignored", findings: "Ignored" },
    );
    const registry = createMockRegistry();

    const steps = await research(
      "Test question",
      "Context",
      registry,
      { _generate: failGen },
    );

    expect(steps.length).toBe(3);
    for (const step of steps) {
      expect(step.findings).toContain("Research failed");
    }
  });
});

describe("synthesize", () => {
  test("produces valid SynthesisResult with mock LLM", async () => {
    const expectedSynthesis: SynthesisResult = {
      summary: "This is a synthesis summary.",
      decision: "Go with option A.",
      alternatives: ["Option B: rejected because slower."],
      risks: ["Risk: performance regression."],
    };
    const mockGenerate = createMockSynthesisGenerate(expectedSynthesis);
    const registry = createMockRegistry();

    const researchSteps: ResearchStep[] = [
      { perspective: "architect", findings: "Architecture findings." },
      { perspective: "security", findings: "Security findings." },
      { perspective: "testing", findings: "Testing findings." },
    ];

    const result = await synthesize(
      "Test question",
      researchSteps,
      registry,
      { _generate: mockGenerate },
    );

    expect(result.summary).toBe("This is a synthesis summary.");
    expect(result.decision).toBe("Go with option A.");
    expect(result.alternatives.length).toBeGreaterThanOrEqual(0);
    expect(result.risks.length).toBeGreaterThanOrEqual(0);

    // Validate with schema
    const parsed = SynthesisResultSchema.safeParse(result);
    expect(parsed.success).toBe(true);
  });

  test("handles synthesis LLM failure", async () => {
    // Create a mock that always fails
    const alwaysFails: GenerateStructuredFn = async <T>(
      _prompt: string,
      _schema: z.ZodSchema<T>,
      _client: LlmClient,
      _options?: ModelOptions,
    ): Promise<{ success: boolean; result?: T; error?: string }> => {
      return { success: false, error: "Invalid JSON response from model" };
    };
    const registry = createMockRegistry();

    const result = await synthesize(
      "Test",
      [{ perspective: "architect", findings: "Some findings." }],
      registry,
      { _generate: alwaysFails },
    );

    expect(result.summary).toContain("Synthesis failed");
    expect(result.risks).toContain("Synthesis LLM call failed");
  });
});

describe("emitBlueprint", () => {
  test("produces valid BlueprintSchema", () => {
    const synthesis: SynthesisResult = {
      summary: "All findings are consistent.",
      decision: "Implement the feature as described.",
      alternatives: ["Use a microservice instead — rejected: overkill."],
      risks: ["Risk: increased complexity."],
    };

    const blueprint = emitBlueprint(synthesis, "Add rate limiting");

    // Validate with Zod
    const parsed = BlueprintSchema.safeParse(blueprint);
    expect(parsed.success).toBe(true);

    if (parsed.success) {
      expect(parsed.data.schema_version).toBe("0.2.0");
      expect(parsed.data.blueprint_id).toContain("crunch-");
      expect(parsed.data.steps.length).toBe(4);

      const stepIds = parsed.data.steps.map((s) => s.id);
      expect(stepIds).toContain("read");
      expect(stepIds).toContain("plan");
      expect(stepIds).toContain("implement");
      expect(stepIds).toContain("review");

      // Verify full-schema fields
      const implementStep = parsed.data.steps[2];
      expect(implementStep).toBeDefined();
      expect(implementStep?.tools?.length).toBe(3);
      expect(implementStep?.loop?.target).toBe("implement");
      expect(implementStep?.loop?.max_iterations).toBe(5);
      expect(implementStep?.loop?.exit_when).toBe('review.status == "success"');

      const reviewStep = parsed.data.steps[3];
      expect(reviewStep).toBeDefined();
      expect(reviewStep?.output_spec?.status).toBe("requires_actions");
      expect(reviewStep?.output_spec?.recommended_next).toBe("implement");

      // Verify context_spec is in object form with receive_from
      const planStep = parsed.data.steps[1];
      if (planStep?.context_spec && typeof planStep.context_spec === "object") {
        expect(planStep.context_spec.receive_from).toContain("read");
      }
    }
  });

  test("blueprint steps have required task_template", () => {
    const synthesis: SynthesisResult = {
      summary: "Summary",
      decision: "Decision",
      alternatives: [],
      risks: [],
    };

    const blueprint = emitBlueprint(synthesis, "Task");
    const parsed = BlueprintSchema.safeParse(blueprint);
    expect(parsed.success).toBe(true);

    if (parsed.success) {
      for (const step of parsed.data.steps) {
        expect(step.task_template.length).toBeGreaterThan(0);
        expect(step.role.length).toBeGreaterThan(0);
        expect(step.id.length).toBeGreaterThan(0);
      }
    }
  });

  test("emitted blueprint passes full BlueprintSchema from @zao/blueprint", () => {
    const synthesis: SynthesisResult = {
      summary: "All findings are consistent.",
      decision: "Implement the feature.",
      alternatives: [],
      risks: [],
    };

    const blueprint = emitBlueprint(synthesis, "Add feature X");

    // The BlueprintSchema from @zao/blueprint (re-exported in schemas.ts)
    // is the full canonical schema with tools, loop, output_spec as
    // optional fields. The emitted blueprint should validate cleanly.
    const parsed = BlueprintSchema.safeParse(blueprint);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      // Verify dev-cycle structure
      expect(parsed.data.steps.length).toBe(4);

      // Verify implement step has tools and loop
      const implementStep = parsed.data.steps.find(s => s.id === "implement");
      expect(implementStep).toBeDefined();
      expect(implementStep?.tools).toBeDefined();
      expect(implementStep?.loop).toBeDefined();

      // Verify review step has output_spec
      const reviewStep = parsed.data.steps.find(s => s.id === "review");
      expect(reviewStep).toBeDefined();
      expect(reviewStep?.output_spec).toBeDefined();
    }
  });

  test("includes synthesized decision in plan step", () => {
    const synthesis: SynthesisResult = {
      summary: "Summary",
      decision: "Use Redis for rate limiting",
      alternatives: [],
      risks: ["Latency overhead"],
    };

    const blueprint = emitBlueprint(synthesis, "Add rate limiting");
    expect(blueprint.steps.length).toBe(4);

    const planStep = blueprint.steps[1];
    expect(planStep).toBeDefined();
    if (planStep) {
      expect(planStep.task_template).toContain("Use Redis for rate limiting");
      expect(planStep.task_template).toContain("Latency overhead");
    }
  });
});

describe("decisionRound", () => {
  test("returns { approved: true } when injectable fn approves", async () => {
    const result = await decisionRound({
      researchSteps: [
        { perspective: "architect", findings: "Architecture findings." },
      ],
      question: "Test question",
    }, async () => ({ approved: true }));

    expect(result.approved).toBe(true);
  });

  test("uses injected _decisionRoundFn when provided", async () => {
    const mockFn: DecisionRoundFn = async (_input) => ({
      approved: false,
      reason: "Need more research on security implications",
    });

    const result = await decisionRound(
      {
        researchSteps: [
          { perspective: "architect", findings: "Architecture findings." },
        ],
        question: "Test question",
      },
      mockFn,
    );

    expect(result.approved).toBe(false);
    if (!result.approved) {
      expect(result.reason).toBe("Need more research on security implications");
    }
  });

  test("pipeline stops when decisionRound returns { approved: false }", async () => {
    const mockResearchSteps: ResearchStep[] = [
      { perspective: "architect", findings: "Architecture findings." },
      { perspective: "security", findings: "Security findings." },
      { perspective: "testing", findings: "Testing findings." },
    ];

    const mockGenerate = createMockGenerate(mockResearchSteps);
    const registry = createMockRegistry();

    const mockDecisionFn: DecisionRoundFn = async (_input) => ({
      approved: false,
      reason: "Research findings are insufficient",
      requestMoreResearch: ["performance_analysis"],
    });

    const projectDir = path.join(tempDir, "decision-reject-project");
    await fs.mkdir(projectDir, { recursive: true });
    await fs.writeFile(path.join(projectDir, "README.md"), "# Test");

    const output = await crunch(
      { question: "Test rejection", projectDir },
      registry,
      {
        _generate: mockGenerate,
        _llmId: "test:mock",
        _decisionRoundFn: mockDecisionFn,
      },
    );

    // Should have stopped before synthesis — synthesis should reflect rejection
    expect(output.synthesis.summary).toContain("Decision not approved");
    expect(output.synthesis.summary).toContain("Research findings are insufficient");
    expect(output.synthesis.risks).toContain("Human decision round returned not-approved");
    // Should still have research steps
    expect(output.researchSteps.length).toBe(3);
    // Should still produce a valid blueprint
    expect(output.blueprint.steps.length).toBeGreaterThanOrEqual(1);
  });

  test("pipeline proceeds to synthesize when approved", async () => {
    const mockResearchSteps: ResearchStep[] = [
      { perspective: "architect", findings: "Architecture findings." },
      { perspective: "security", findings: "Security findings." },
      { perspective: "testing", findings: "Testing findings." },
    ];
    const mockSynthesis: SynthesisResult = {
      summary: "Synthesis after approval.",
      decision: "Go ahead.",
      alternatives: [],
      risks: [],
    };

    const mockGenerate = createMockGenerate(mockResearchSteps, mockSynthesis);
    const registry = createMockRegistry();

    const mockDecisionFn: DecisionRoundFn = async (_input) => ({
      approved: true,
    });

    const projectDir = path.join(tempDir, "decision-approve-project");
    await fs.mkdir(projectDir, { recursive: true });
    await fs.writeFile(path.join(projectDir, "README.md"), "# Test");

    const output = await crunch(
      { question: "Test approval", projectDir },
      registry,
      {
        _generate: mockGenerate,
        _llmId: "test:mock",
        _decisionRoundFn: mockDecisionFn,
      },
    );

    // Should have full pipeline output including synthesis
    expect(output.synthesis.summary).toBe("Synthesis after approval.");
    expect(output.synthesis.decision).toBe("Go ahead.");
    expect(output.researchSteps.length).toBe(3);
    expect(output.blueprint.steps.length).toBe(4);
  });
});

describe("crunch (full pipeline)", () => {
  test("end-to-end with mock LLM", async () => {
    const mockResearchSteps: ResearchStep[] = [
      { perspective: "architect", findings: "Modular architecture." },
      { perspective: "security", findings: "No security issues." },
      { perspective: "testing", findings: "Need integration tests." },
    ];
    const mockSynthesis: SynthesisResult = {
      summary: "The project is ready for the change.",
      decision: "Implement with the described approach.",
      alternatives: ["Alternative approach rejected: too complex."],
      risks: ["Risk: performance regression in high-traffic paths."],
    };

    const mockGenerate = createMockGenerate(mockResearchSteps, mockSynthesis);
    const registry = createMockRegistry();

    // Create a temp project directory
    const projectDir = path.join(tempDir, "end-to-end-project");
    await fs.mkdir(projectDir, { recursive: true });
    await fs.writeFile(path.join(projectDir, "README.md"), "# Test Project\n\nThis is a test.");

    const output = await crunch(
      {
        question: "How do I add rate limiting?",
        projectDir,
      },
      registry,
      { _generate: mockGenerate, _llmId: "test:mock", _decisionRoundFn: async () => ({ approved: true }) },
    );

    // Validate the output
    expect(output.researchSteps.length).toBe(3);
    expect(output.synthesis.summary.length).toBeGreaterThan(0);
    expect(output.blueprint.steps.length).toBe(4);
    expect(output.metadata.modelUsed).toBe("test:mock");
    expect(output.metadata.tokensUsed).toBeGreaterThan(0);
    expect(output.metadata.duration).toBeGreaterThanOrEqual(0);

    // Full schema validation
    const { CrunchOutputSchema } = await import("../src/schemas.ts");
    const parsed = CrunchOutputSchema.safeParse(output);
    expect(parsed.success).toBe(true);
  });

  test("handles empty project directory gracefully", async () => {
    const mockResearchSteps: ResearchStep[] = [
      { perspective: "architect", findings: "No code to analyze." },
      { perspective: "security", findings: "No code to analyze." },
      { perspective: "testing", findings: "No code to analyze." },
    ];
    const mockSynthesis: SynthesisResult = {
      summary: "No codebase context available.",
      decision: "Proceed with general best practices.",
      alternatives: [],
      risks: ["Lack of context may lead to generic recommendations."],
    };

    const mockGenerate = createMockGenerate(mockResearchSteps, mockSynthesis);
    const registry = createMockRegistry();

    const emptyDir = path.join(tempDir, "empty-project");
    await fs.mkdir(emptyDir, { recursive: true });

    const output = await crunch(
      { question: "Add tests", projectDir: emptyDir },
      registry,
      { _generate: mockGenerate, _llmId: "test:mock", _decisionRoundFn: async () => ({ approved: true }) },
    );

    expect(output.researchSteps.length).toBe(3);
    expect(output.blueprint.steps.length).toBe(4);

    const { CrunchOutputSchema } = await import("../src/schemas.ts");
    const parsed = CrunchOutputSchema.safeParse(output);
    expect(parsed.success).toBe(true);
  });

  test("handles mock LLM returning invalid/unexpected output", async () => {
    // Create a mock generate that always fails
    const alwaysFails: GenerateStructuredFn = async <T>(
      _prompt: string,
      _schema: z.ZodSchema<T>,
      _client: LlmClient,
      _options?: ModelOptions,
    ): Promise<{ success: boolean; result?: T; error?: string }> => {
      return { success: false, error: "Invalid JSON response from model" };
    };

    const registry = createMockRegistry();
    const projectDir = path.join(tempDir, "fail-project");
    await fs.mkdir(projectDir, { recursive: true });
    await fs.writeFile(path.join(projectDir, "main.ts"), "console.log('hello');");

    const output = await crunch(
      { question: "Test", projectDir },
      registry,
      { _generate: alwaysFails, _llmId: "test:mock", _decisionRoundFn: async () => ({ approved: true }) },
    );

    // Even with all LLM calls failing, the pipeline should complete
    expect(output.researchSteps.length).toBe(3);
    expect(output.blueprint.steps.length).toBe(4);
    expect(output.synthesis.summary).toContain("Synthesis failed");

    const { CrunchOutputSchema } = await import("../src/schemas.ts");
    const parsed = CrunchOutputSchema.safeParse(output);
    expect(parsed.success).toBe(true);
  });

  test("crunch validates input (fail-closed)", async () => {
    const mockGenerate = createMockGenerate();
    const registry = createMockRegistry();

    await expect(
      crunch(
        { question: "", projectDir: tempDir },
        registry,
        { _generate: mockGenerate, _decisionRoundFn: async () => ({ approved: true }) },
      ),
    ).rejects.toThrow("Question must be a non-empty string");
  });

  test("crunch with contextFiles reads specific files", async () => {
    const mockResearchSteps: ResearchStep[] = [
      { perspective: "architect", findings: "Architecture findings." },
      { perspective: "security", findings: "Security findings." },
      { perspective: "testing", findings: "Testing findings." },
    ];
    const mockSynthesis: SynthesisResult = {
      summary: "Summary after reading specific files.",
      decision: "Decision.",
      alternatives: [],
      risks: [],
    };
    const mockGenerate = createMockGenerate(mockResearchSteps, mockSynthesis);
    const registry = createMockRegistry();

    const projectDir = path.join(tempDir, "context-files-project");
    await fs.mkdir(projectDir, { recursive: true });
    await fs.writeFile(path.join(projectDir, "readme.md"), "# Project");
    await fs.writeFile(path.join(projectDir, "src.ts"), "// source code");
    await fs.writeFile(path.join(projectDir, "ignored.ts"), "// should be ignored");

    const output = await crunch(
      {
        question: "Test with context files",
        projectDir,
        contextFiles: ["readme.md", "src.ts"],
      },
      registry,
      { _generate: mockGenerate, _llmId: "test:mock", _decisionRoundFn: async () => ({ approved: true }) },
    );

    expect(output.researchSteps.length).toBe(3);
    expect(output.blueprint.steps.length).toBe(4);
  });
});
