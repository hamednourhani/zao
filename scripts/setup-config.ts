#!/usr/bin/env bun
/**
 * Interactive config setup for zao.
 * Run after `make install` to create ~/.zao/llm-providers.yaml.
 *
 * Usage:
 *   bun run scripts/setup-config.ts
 *   bun run scripts/setup-config.ts --api-key sk-xxx  # non-interactive
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const configDir = join(homedir(), ".zao");
const configFile = join(configDir, "llm-providers.yaml");

if (existsSync(configFile)) {
  console.log(`✓ Config already exists at ${configFile}`);
  process.exit(0);
}

// Non-interactive mode
const apiKeyArg = process.argv.find(a => a.startsWith("--api-key="));
if (apiKeyArg) {
  const key = apiKeyArg.split("=")[1];
  mkdirSync(configDir, { recursive: true });
  writeFileSync(configFile, [
    "llm_providers:",
    "  deepseek:",
    `    api_key: "${key}"`,
    "    default_model: deepseek-chat",
    "    models: [deepseek-chat]",
    ""
  ].join("\n"));
  console.log(`✓ Config created at ${configFile}`);
  process.exit(0);
}

// Interactive mode
console.log(" No config found. Let's set one up.\n");

const apiKey = prompt("DeepSeek API key:")?.trim();
if (!apiKey) {
  console.log(" Skipped — set DEEPSEEK_API_KEY and run again.");
  process.exit(0);
}

mkdirSync(configDir, { recursive: true });
writeFileSync(configFile, [
  "providers:",
  "  deepseek:",
  `    api_key: "${apiKey}"`,
  "    default_model: deepseek-chat",
  "    models: [deepseek-chat]",
  ""
].join("\n"));

console.log(`\n✓ Config created at ${configFile}`);
console.log('  Try: zao run dev-cycle "Your first task" --verbose');
