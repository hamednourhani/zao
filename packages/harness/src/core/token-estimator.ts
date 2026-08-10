/**
 * Token Estimator — accurate token counting for context budgeting.
 *
 * Provides multiple estimation strategies:
 * - `heuristic`: fast chars/4 approximation (no dependencies)
 * - `gpt-tokenizer`: accurate GPT-family tokenizer using the `gpt-tokenizer` package
 * - `auto`: tries `gpt-tokenizer` first, falls back to `heuristic`
 *
 * @module token-estimator
 */

import { encode } from "gpt-tokenizer";
import type { TokenizerStrategy } from "./config.ts";

// ── Interface ─────────────────────────────────────────────────────

/**
 * Token estimator — takes text and returns an estimated token count.
 */
export interface TokenEstimator {
  /** Human-readable name of the active strategy. */
  readonly name: string;
  /**
   * Estimates how many tokens a given text would consume.
   * Always returns a number >= 0.
   */
  estimate(text: string): number;
  /**
   * Returns true if this estimator supports a given provider.
   * The heuristic estimator supports all models (as fallback).
   */
  supportsProvider(provider: string): boolean;
}

// ── Implementation: Heuristic (chars/4) ──────────────────────────

/**
 * Fast chars/4 heuristic — always available, no dependencies.
 */
class HeuristicEstimator implements TokenEstimator {
  readonly name = "heuristic";

  estimate(text: string): number {
    return Math.ceil(text.length / 4);
  }

  supportsProvider(_provider: string): boolean {
    return true;
  }
}

// ── Implementation: GPT Tokenizer ──────────────────────────────────

/**
 * Accurate GPT-family tokenizer.
 * Supports OpenAI (gpt-*, o1-*, o3-*) and DeepSeek (deepseek-*)
 * models which use GPT-compatible tokenizers.
 */
class GptTokenizerEstimator implements TokenEstimator {
  readonly name = "gpt-tokenizer";

  estimate(text: string): number {
    return encode(text).length;
  }

  supportsProvider(provider: string): boolean {
    return provider === "openai" || provider === "deepseek";
  }
}

// ── Factory ────────────────────────────────────────────────────────

/**
 * Creates a token estimator with the given strategy.
 *
 * NOTE: `createTokenEstimator("auto")` returns a GptTokenizerEstimator without
 * provider awareness. For provider-aware auto-selection (gpt-tokenizer for
 * openai/deepseek, heuristic fallback for others), use `estimateTokens()`.
 *
 * @param strategy - The estimation strategy ("auto", "heuristic", or "gpt-tokenizer").
 * @returns A TokenEstimator instance.
 */
export function createTokenEstimator(
  strategy: TokenizerStrategy = "auto",
): TokenEstimator {
  switch (strategy) {
    case "heuristic":
      return new HeuristicEstimator();
    case "gpt-tokenizer":
      return new GptTokenizerEstimator();
    case "auto":
    default:
      // Auto: prefer gpt-tokenizer for GPT-compatible models
      return new GptTokenizerEstimator();
  }
}

/**
 * Estimates tokens using the best available strategy for the given
 * provider and model. Falls back to chars/4 heuristic when the
 * gpt-tokenizer doesn't support the provider.
 *
 * @param text - The text to estimate tokens for.
 * @param provider - The LLM provider (e.g. "openai", "deepseek").
 * @param strategy - The configured tokenizer strategy.
 * @returns Estimated token count.
 *
 * NOTE: This is the provider-aware entry point. Prefer this over
 * `createTokenEstimator("auto")` which does not consider provider.
 */
export function estimateTokens(
  text: string,
  provider: string,
  strategy: TokenizerStrategy = "auto",
): number {
  if (strategy === "heuristic") {
    return Math.ceil(text.length / 4);
  }

  if (strategy === "gpt-tokenizer" || strategy === "auto") {
    // gpt-tokenizer supports openai and deepseek providers
    if (provider === "openai" || provider === "deepseek") {
      return encode(text).length;
    }
  }

  // Fallback to chars/4 for unknown providers
  return Math.ceil(text.length / 4);
}
