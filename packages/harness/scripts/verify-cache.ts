#!/usr/bin/env bun
/**
 * Prompt Cache Verification Script
 *
 * Makes two consecutive identical LLM calls to verify that the second
 * call hits the prompt cache (cacheReadTokens > 0). The stable system
 * prompt prefix designed in `context.ts` should cause DeepSeek to cache
 * and reuse the prefix on the second call.
 *
 * Usage: bun packages/harness/scripts/verify-cache.ts
 *
 * Requires: DEEPSEEK_API_KEY environment variable.
 *
 * @module verify-cache
 */

import { generateStructuredResponse } from "../src/core/llm.ts";
import { z } from "zod";
import { createDefaultRegistry } from "@zao/llm-clients";

const apiKey = process.env.DEEPSEEK_API_KEY || process.env.OPENAI_API_KEY;
if (!apiKey) {
  process.stderr.write("Error: DEEPSEEK_API_KEY or OPENAI_API_KEY must be set.\n");
  process.exit(1);
}

// Minimal schema for verification
const TestSchema = z.object({
  answer: z.string(),
});

async function main(): Promise<void> {
  const registry = await createDefaultRegistry();
  const client = await registry.getClient("deepseek:deepseek-chat");

  process.stderr.write("=== Prompt Cache Verification ===\n\n");
  process.stderr.write("Call 1 (cold): Sending identical prompt...\n");

  // First call — cold cache, no cacheReadTokens expected
  const result1 = await generateStructuredResponse(
    "What is the capital of France? Answer with just the city name.",
    TestSchema,
    client,
    { cache: true, temperature: 0 },
  );

  if (!result1.success) {
    process.stderr.write(`Call 1 failed: ${result1.error}\n`);
    process.exit(1);
  }

  const event1 = result1.events[result1.events.length - 1]!;
  process.stderr.write(`  Cache hit: ${event1.cache_hit}\n`);
  process.stderr.write(`  Prompt tokens: ${event1.prompt_tokens}\n`);
  process.stderr.write(`  Completion tokens: ${event1.completion_tokens}\n\n`);

  process.stderr.write("Call 2 (warm): Sending identical prompt...\n");

  // Second call — should hit cache if provider supports it
  const result2 = await generateStructuredResponse(
    "What is the capital of France? Answer with just the city name.",
    TestSchema,
    client,
    { cache: true, temperature: 0 },
  );

  if (!result2.success) {
    process.stderr.write(`Call 2 failed: ${result2.error}\n`);
    process.exit(1);
  }

  const event2 = result2.events[result2.events.length - 1]!;
  process.stderr.write(`  Cache hit: ${event2.cache_hit}\n`);
  process.stderr.write(`  Prompt tokens: ${event2.prompt_tokens}\n`);
  process.stderr.write(`  Completion tokens: ${event2.completion_tokens}\n\n`);

  if (event2.cache_hit) {
    process.stderr.write("SUCCESS: Prompt cache hit detected on second call.\n");
  } else {
    process.stderr.write(
      "NOTE: No cache hit detected. This may be expected if:\n" +
      "  - The provider doesn't support prompt caching\n" +
      "  - The system prompt changed between calls\n" +
      "  - The cache TTL expired\n",
    );
  }
}

main().catch((err) => {
  process.stderr.write(`Fatal: ${err.message}\n`);
  process.exit(2);
});
