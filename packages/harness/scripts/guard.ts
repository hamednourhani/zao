/**
 * Guardrail Grep — forbidden-pattern sweep over src/ per governance §B.
 *
 * Runs static checks for patterns that violate the complexity budget:
 * - eval/new Function (dynamic code loading)
 * - dynamic import of non-literal paths
 * - hardcoded role names outside tests/defaults/scripts/
 * - forbidden skip-on-invalid patterns on manifest/state writers
 *
 * Also supports `--scan-store` mode: scans JSON files under `~/.zao/`
 * for credential patterns (apiKey, api_key, apiSecret, token) per ADR-009.
 *
 * Exit code 0 = clean. Non-zero = violations found (each printed to stdout).
 * Fast (<1s).
 *
 * Usage: bun scripts/guard.ts [--dir <path>] [--scan-store]
 *
 * @module guard
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { homedir } from "node:os";

// ── Rule definitions ─────────────────────────────────────────────

/** A guard rule with an optional file-scope filter. */
export interface Rule {
  name: string;
  pattern: RegExp;
  message: string;
  /** Lines of context to show before/after match */
  context: number;
  /**
   * Optional filter: if provided, the rule is ONLY applied to files
   * for which this function returns true (relative path from scan root).
   */
  appliesTo?: (relativePath: string) => boolean;
}

// ── File-scope helpers ────────────────────────────────────────────

/** Files known as state-transition writers (relative to src/). R5 targets only these. */
const STATE_WRITER_FILES = [
  "core/artifacts.ts",
  "core/session-store.ts",
  "core/loop.ts",
  "core/delegation.ts",
  "core/resume.ts",
];

function isStateWriter(rel: string): boolean {
  return STATE_WRITER_FILES.some((f) => rel === f || rel.endsWith("/" + f));
}

function isR4Excluded(rel: string): boolean {
  return (
    rel.startsWith("tests/") ||
    rel.includes("/tests/") ||
    rel.startsWith("defaults/") ||
    rel.includes("/defaults/") ||
    rel.startsWith("scripts/") ||
    rel.includes("/scripts/") ||
    rel.startsWith("schemas/") ||
    rel.includes("/schemas/") ||
    rel.includes("guard")
  );
}

// ── Rules ─────────────────────────────────────────────────────────

/** All guard rules. Exported so tests can import and inspect them. */
export const RULES: Rule[] = [
  // R1: eval() — dynamic code loading
  {
    name: "R1-no-eval",
    pattern: /\beval\s*\(/g,
    message: "eval() is forbidden (governance §B: dynamic code loading).",
    context: 1,
  },
  // R2: new Function — dynamic code loading
  {
    name: "R2-no-new-function",
    pattern: /new\s+Function\b/g,
    message: "new Function() is forbidden (governance §B: dynamic code loading).",
    context: 1,
  },
  // R3: dynamic import with non-literal paths
  {
    name: "R3-no-dynamic-import",
    // Matches import(...) where the argument is not a string literal.
    // Matches: import(someVar), import(`template/${var}`)
    // Skips:   import("./artifacts.ts"), import("../schemas/manifest.ts")
    pattern: /import\s*\(\s*(?!['"][^'"]*['"]\s*\))/g,
    message:
      "Non-literal dynamic import detected (governance §B: plugin systems are forbidden).",
    context: 2,
  },
  // R4: hardcoded role names — excluded from tests/, defaults/, scripts/, guard files
  {
    name: "R4-no-hardcoded-roles",
    pattern: /["'][\s]*(planner|developer|reviewer|architect)[\s]*["']/g,
    message:
      "Hardcoded role name detected (governance §A1: roles are inputs, not hardcoded). " +
      "If this is a legitimate use (test fixtures, defaults file), verify.",
    context: 1,
    appliesTo: (rel) => !isR4Excluded(rel),
  },
  // R5: silent skip-on-invalid — only checked on state-transition writers
  {
    name: "R5-no-silent-skip-on-state-write",
    pattern: /if\s*\(\s*\w+\.success\s*\)\s*\{/g,
    message:
      "Potential silent skip-on-invalid pattern detected (governance §E3). " +
      "If this is a state-transition writer (manifest, index), parse failure " +
      "must throw, not silently skip.",
    context: 3,
    appliesTo: (rel) => isStateWriter(rel),
  },
  // R6: no credential fields in session config artifacts (ADR-009)
  {
    name: "R6-no-credential-fields-in-session-config",
    pattern: /["'](?:apiKey|api_key|apiSecret|token)["']\s*:/g,
    message:
      "Credential field detected in session config artifact (ADR-009). " +
      "Session files must never contain apiKey, api_key, apiSecret, or token.",
    context: 2,
    appliesTo: (rel) => {
      // Only apply to files that write session-config.json
      return (
        rel === "core/loop.ts" ||
        rel.endsWith("/core/loop.ts") ||
        rel.includes("session-config") ||
        rel.includes("guard")
      );
    },
  },
  // R7: no direct provider factory imports outside packages/llm-clients (ADR-009, TD-033)
  {
    name: "R7-no-provider-imports-outside-llm-clients",
    pattern: /from\s+["']@ai-sdk\/(?:deepseek|openai|google|anthropic|groq|azure|cohere|mistral|xai|amazon-bedrock)["']/g,
    message:
      "Direct @ai-sdk provider import detected outside packages/llm-clients (ADR-009, TD-033). " +
      "Only packages/llm-clients may import provider factories. " +
      "Use @zao/llm-clients registry instead.",
    context: 2,
    appliesTo: (rel) => {
      // Allow in llm-clients tests, block everywhere else
      if (rel.includes("llm-clients")) return false;
      // Block in harness source and tests
      return !rel.startsWith("node_modules/");
    },
  },
  // R8: only CLI entry point may call boot() or __internalInit*
  {
    name: "R8-no-unauthorized-boot-callers",
    pattern: /\b(?:boot|__internalInit)\(/g,
    message:
      "Unauthorized boot/init call detected (governance §B1). " +
      "Only boot.ts, logger.ts, progress.ts, core/index.ts, and index.ts " +
      "may call boot() or __internalInit* functions.",
    context: 2,
    appliesTo: (rel) => {
      // Allow in authorized files
      if (
        rel === "index.ts" ||
        rel.endsWith("/index.ts") ||
        rel === "core/boot.ts" ||
        rel.endsWith("/core/boot.ts") ||
        rel === "core/logger.ts" ||
        rel.endsWith("/core/logger.ts") ||
        rel === "core/progress.ts" ||
        rel.endsWith("/core/progress.ts") ||
        rel === "core/index.ts" ||
        rel.endsWith("/core/index.ts")
      ) return false;
      // Allow in tests
      if (rel.startsWith("tests/") || rel.includes("/tests/")) return false;
      // Allow in guard script itself
      if (rel.includes("guard")) return false;
      return true;
    },
  },
];

// ── Types ──────────────────────────────────────────────────────────

/** A single guard violation. */
export interface Finding {
  file: string;
  line: number;
  column: number;
  rule: string;
  message: string;
  snippet: string;
}

/** Result of scanning a directory. */
export interface ScanResult {
  findings: Finding[];
  fileCount: number;
}

// ── File traversal (synchronous) ───────────────────────────────────

/** Recursively collect .ts/.tsx files under dir, skipping node_modules and hidden dirs. */
function findSourceFiles(dir: string): string[] {
  const results: string[] = [];

  function walk(currentDir: string): void {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(currentDir, { withFileTypes: true });
    } catch {
      return; // skip unreadable directories
    }
    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "node_modules" && !entry.name.startsWith(".")) {
          walk(fullPath);
        }
      } else if (
        entry.isFile() &&
        (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx"))
      ) {
        results.push(fullPath);
      }
    }
  }

  walk(dir);
  return results;
}

// ── Scanning ──────────────────────────────────────────────────────

/** Scan a single file with the provided rules. */
function scanFile(
  filePath: string,
  rules: Rule[],
  relativeTo: string,
): Finding[] {
  const findings: Finding[] = [];

  let content: string;
  try {
    content = fs.readFileSync(filePath, "utf-8");
  } catch {
    return findings; // skip unreadable files
  }

  const lines = content.split("\n");
  const relativePath = path.relative(relativeTo, filePath);

  for (const rule of rules) {
    // Check per-rule file scope filter
    if (rule.appliesTo && !rule.appliesTo(relativePath)) {
      continue;
    }

    // Reset lastIndex for global regex
    rule.pattern.lastIndex = 0;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;

      // Check for inline guard:ignore comment on this line or up to 2 lines above
      const prevLine = i > 0 ? lines[i - 1]! : "";
      const prevPrevLine = i > 1 ? lines[i - 2]! : "";
      const ignorePattern = new RegExp(
        `//\\s*guard:ignore\\s+${rule.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`,
      );
      if (ignorePattern.test(line) || ignorePattern.test(prevLine) || ignorePattern.test(prevPrevLine)) {
        continue;
      }

      let match: RegExpExecArray | null;
      rule.pattern.lastIndex = 0;

      while ((match = rule.pattern.exec(line)) !== null) {
        // Build snippet with context
        const contextStart = Math.max(0, i - rule.context);
        const contextEnd = Math.min(lines.length - 1, i + rule.context);
        const snippetLines: string[] = [];
        for (let j = contextStart; j <= contextEnd; j++) {
          const prefix = j === i ? ">" : " ";
          snippetLines.push(`${prefix} ${String(j + 1).padStart(4)} | ${lines[j]}`);
        }

        findings.push({
          file: relativePath,
          line: i + 1,
          column: match.index + 1,
          rule: rule.name,
          message: rule.message,
          snippet: snippetLines.join("\n"),
        });
      }
    }
  }

  return findings;
}

// ── Main scan function (exported for testability) ─────────────────

/**
 * Scan a directory recursively for forbidden patterns.
 *
 * @param dirPath - Absolute path to the directory to scan.
 * @param rules - Array of rules to apply.
 * @returns All findings and the number of files scanned.
 */
export function scanDirectory(dirPath: string, rules: Rule[]): ScanResult {
  const files = findSourceFiles(dirPath);
  const allFindings: Finding[] = [];
  for (const file of files) {
    allFindings.push(...scanFile(file, rules, dirPath));
  }
  return { findings: allFindings, fileCount: files.length };
}

// ── Store Scan (ADR-009) ─────────────────────────────────────────

/**
 * Scans JSON files under the zao store root (`~/.zao/`) for credential patterns.
 *
 * ## ADR-009
 *
 * Session files must NEVER contain apiKey, api_key, apiSecret, or token.
 * This function searches for these patterns in all .json files under the
 * store root and returns findings for any matches.
 *
 * @param storeRoot - The resolved store root path.
 * @returns Array of findings (file path + matching line info).
 */
async function scanStoreForCredentials(storeRoot: string): Promise<Finding[]> {
  const CREDENTIAL_PATTERNS = [
    { name: "apiKey", pattern: /"apiKey"\s*:/g },
    { name: "api_key", pattern: /"api_key"\s*:/g },
    { name: "apiSecret", pattern: /"apiSecret"\s*:/g },
    { name: "token", pattern: /"token"\s*:/g },
  ];

  const findings: Finding[] = [];

  // Collect all .json files under the store root recursively
  function findJsonFiles(dir: string): string[] {
    const results: string[] = [];
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory() && !entry.name.startsWith(".")) {
          results.push(...findJsonFiles(fullPath));
        } else if (entry.isFile() && entry.name.endsWith(".json")) {
          results.push(fullPath);
        }
      }
    } catch {
      // Skip unreadable directories
    }
    return results;
  }

  const jsonFiles = findJsonFiles(storeRoot);
  for (const filePath of jsonFiles) {
    let content: string;
    try {
      content = fs.readFileSync(filePath, "utf-8");
    } catch {
      continue; // skip unreadable files
    }

    const lines = content.split("\n");
    for (const { name, pattern } of CREDENTIAL_PATTERNS) {
      pattern.lastIndex = 0;

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!;
        pattern.lastIndex = 0;

        let match: RegExpExecArray | null;
        while ((match = pattern.exec(line)) !== null) {
          const contextStart = Math.max(0, i - 2);
          const contextEnd = Math.min(lines.length - 1, i + 2);
          const snippetLines: string[] = [];
          for (let j = contextStart; j <= contextEnd; j++) {
            const prefix = j === i ? ">" : " ";
            snippetLines.push(`${prefix} ${String(j + 1).padStart(4)} | ${lines[j]}`);
          }

          findings.push({
            file: path.relative(storeRoot, filePath),
            line: i + 1,
            column: match.index + 1,
            rule: "R6-no-credential-fields-in-session-config",
            message: `Credential field "${name}" found in store artifact (ADR-009).`,
            snippet: snippetLines.join("\n"),
          });
        }
      }
    }
  }

  return findings;
}

// ── Entry point ────────────────────────────────────────────────────

function main(): void {
  // ── --scan-store mode: scan JSON artifacts for credentials ───
  const scanStore = process.argv.includes("--scan-store");

  if (scanStore) {
    // Resolve store root: $ZAO_HOME → $XDG_DATA_HOME/zao → ~/.zao
    let storeRoot: string;
    if (process.env["ZAO_HOME"]) {
      storeRoot = process.env["ZAO_HOME"];
    } else if (process.env["XDG_DATA_HOME"]) {
      storeRoot = path.join(process.env["XDG_DATA_HOME"], "zao");
    } else {
      storeRoot = path.join(homedir(), ".zao");
    }

    if (!fs.existsSync(storeRoot)) {
      console.log(`[guard:store] OK — store root "${storeRoot}" does not exist (no sessions).`);
      process.exit(0);
    }

    scanStoreForCredentials(storeRoot).then((findings) => {
      if (findings.length === 0) {
        console.log(`[guard:store] OK — no credentials found in "${storeRoot}".`);
        process.exit(0);
      }
      for (const finding of findings) {
        console.log(`${finding.file}:${finding.line}:${finding.column} [${finding.rule}] ${finding.message}`);
      }
      console.log(`[guard:store] FAILED — ${findings.length} credential violation(s) in store.`);
      process.exit(1);
    }).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[guard:store] ERROR — ${message}`);
      process.exit(2);
    });
    return;
  }

  // ── Default source scan ──────────────────────────────────────
  // Parse --dir <path> CLI flag. When provided, scan that directory
  // instead of the default src/ relative to the script location.
  let srcPath: string;

  const dirFlagIndex = process.argv.indexOf("--dir");
  if (dirFlagIndex !== -1 && dirFlagIndex + 1 < process.argv.length) {
    const dirArg = process.argv[dirFlagIndex + 1]!;
    // Resolve relative to cwd (the directory from which guard.ts is invoked)
    srcPath = path.resolve(process.cwd(), dirArg);
  } else {
    // Default: guard.ts lives in scripts/ → go up one level to harness package root
    const scriptDir = path.dirname(new URL(import.meta.url).pathname);
    const cwd = path.dirname(scriptDir);
    srcPath = path.join(cwd, "src");
  }

  const { findings, fileCount } = scanDirectory(srcPath, RULES);

  if (findings.length === 0) {
    console.log(`[guard] OK — ${fileCount} files scanned, 0 violations.`);
    process.exit(0);
  }

  for (const finding of findings) {
    console.log(`${finding.file}:${finding.line}:${finding.column} [${finding.rule}] ${finding.message}`);
  }

  console.log(`[guard] FAILED — ${findings.length} violation(s).`);
  process.exit(1);
}

// Only run main when executed directly, not when imported as a module
if (import.meta.main) {
  main();
}
