import { describe, test, expect } from "bun:test";
import {
  ResearchStepSchema,
  SynthesisResultSchema,
  CrunchOutputSchema,
  BlueprintSchema,
} from "../src/schemas.ts";

describe("ResearchStepSchema", () => {
  test("validates correct data", () => {
    const data = {
      perspective: "architect",
      findings: "The architecture is well-structured.",
    };
    const result = ResearchStepSchema.safeParse(data);
    expect(result.success).toBe(true);
  });

  test("rejects missing fields (strict)", () => {
    const result = ResearchStepSchema.safeParse({
      perspective: "architect",
    });
    expect(result.success).toBe(false);
  });

  test("rejects empty perspective", () => {
    const result = ResearchStepSchema.safeParse({
      perspective: "",
      findings: "Some findings.",
    });
    expect(result.success).toBe(false);
  });

  test("rejects extra fields (strict)", () => {
    const result = ResearchStepSchema.safeParse({
      perspective: "architect",
      findings: "Some findings.",
      extra: "should not be here",
    });
    expect(result.success).toBe(false);
  });
});

describe("SynthesisResultSchema", () => {
  test("validates correct data", () => {
    const data = {
      summary: "This is a summary.",
      decision: "Proceed with option A.",
      alternatives: ["Option B was rejected because..."],
      risks: ["Risk 1: performance impact"],
    };
    const result = SynthesisResultSchema.safeParse(data);
    expect(result.success).toBe(true);
  });

  test("rejects missing required fields", () => {
    const result = SynthesisResultSchema.safeParse({
      summary: "Summary only.",
    });
    expect(result.success).toBe(false);
  });

  test("allows empty alternatives array", () => {
    const data = {
      summary: "Summary",
      decision: "Decision",
      alternatives: [],
      risks: ["Risk 1"],
    };
    const result = SynthesisResultSchema.safeParse(data);
    expect(result.success).toBe(true);
  });

  test("allows empty risks array", () => {
    const data = {
      summary: "Summary",
      decision: "Decision",
      alternatives: [],
      risks: [],
    };
    const result = SynthesisResultSchema.safeParse(data);
    expect(result.success).toBe(true);
  });
});

describe("BlueprintSchema", () => {
  test("validates a minimal blueprint", () => {
    const data = {
      schema_version: "0.2.0" as const,
      blueprint_id: "test-blueprint",
      steps: [
        {
          id: "step1",
          role: "developer",
          task_template: "Implement {task}",
        },
      ],
    };
    const result = BlueprintSchema.safeParse(data);
    expect(result.success).toBe(true);
  });

  test("validates a full-schema blueprint with tools, loop, output_spec", () => {
    const data = {
      schema_version: "0.2.0" as const,
      blueprint_id: "test-full-schema",
      steps: [
        {
          id: "read",
          role: "explorer",
          task_template: "Read {task}",
          context_spec: {
            text: "Read the codebase.",
          },
        },
        {
          id: "plan",
          role: "designer",
          task_template: "Plan {task}",
          context_spec: {
            text: "Plan the implementation.",
            receive_from: ["read"],
          },
        },
        {
          id: "implement",
          role: "coder",
          task_template: "Implement {task}",
          context_spec: {
            text: "Implement the changes.",
            receive_from: ["plan"],
          },
          tools: [
            { tool: "readFile", scope: "agent_decides" as const },
            { tool: "writeFile", scope: "agent_decides" as const, requires_approval: false },
            { tool: "executeShell", scope: "agent_decides" as const, requires_approval: true },
          ],
          loop: {
            target: "implement",
            max_iterations: 5,
            exit_when: 'review.status == "success"',
          },
        },
        {
          id: "review",
          role: "inspector",
          task_template: "Review {task}",
          when: "implement.status == \"success\"",
          context_spec: {
            text: "Review the implementation.",
            receive_from: ["implement"],
          },
          output_spec: {
            status: "requires_actions" as const,
            recommended_next: "implement",
          },
        },
      ],
    };
    const result = BlueprintSchema.safeParse(data);
    expect(result.success).toBe(true);
    if (result.success) {
      const impl = result.data.steps[2];
      expect(impl?.tools?.length).toBe(3);
      expect(impl?.loop?.target).toBe("implement");
      expect(impl?.loop?.max_iterations).toBe(5);
      const review = result.data.steps[3];
      expect(review?.output_spec?.status).toBe("requires_actions");
      expect(review?.output_spec?.recommended_next).toBe("implement");
    }
  });

  test("rejects empty steps array", () => {
    const data = {
      schema_version: "0.2.0" as const,
      blueprint_id: "test-blueprint",
      steps: [],
    };
    const result = BlueprintSchema.safeParse(data);
    expect(result.success).toBe(false);
  });

  test("rejects invalid step id format", () => {
    const data = {
      schema_version: "0.2.0" as const,
      blueprint_id: "test-blueprint",
      steps: [
        {
          id: "INVALID_ID",
          role: "developer",
          task_template: "Do something",
        },
      ],
    };
    const result = BlueprintSchema.safeParse(data);
    expect(result.success).toBe(false);
  });
});

describe("CrunchOutputSchema", () => {
  test("validates full output", () => {
    const data = {
      blueprint: {
        schema_version: "0.2.0" as const,
        blueprint_id: "crunch-12345",
        steps: [
          {
            id: "read",
            role: "explorer",
            task_template: "Read {task}",
          },
        ],
      },
      researchSteps: [
        { perspective: "architect", findings: "Architecture is solid." },
        { perspective: "security", findings: "No major security concerns." },
        { perspective: "testing", findings: "Unit tests needed." },
      ],
      synthesis: {
        summary: "Everything looks good.",
        decision: "Proceed with implementation.",
        alternatives: ["Alternative A was rejected."],
        risks: ["Risk: schedule"],
      },
      metadata: {
        modelUsed: "deepseek:deepseek-chat",
        tokensUsed: 1200,
        duration: 5000,
      },
    };
    const result = CrunchOutputSchema.safeParse(data);
    expect(result.success).toBe(true);
  });

  test("rejects missing metadata fields", () => {
    const data = {
      blueprint: {
        schema_version: "0.2.0" as const,
        blueprint_id: "test",
        steps: [{ id: "step1", role: "dev", task_template: "Do {task}" }],
      },
      researchSteps: [],
      synthesis: {
        summary: "ok",
        decision: "proceed",
        alternatives: [],
        risks: [],
      },
      metadata: {
        modelUsed: "test:mock",
        // tokensUsed missing
        duration: 100,
      },
    };
    const result = CrunchOutputSchema.safeParse(data);
    expect(result.success).toBe(false);
  });
});
