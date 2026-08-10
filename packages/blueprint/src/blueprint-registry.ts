/**
 * Blueprint Registry — resolves blueprint packages by ID.
 *
 * ## Resolution order
 *
 * 1. Explicit path (absolute path to a blueprint package directory)
 * 2. `~/.zao/blueprints/<packageId>/` — global blueprints
 * 3. Shipped `defaults/blueprints/<packageId>/` — built-in defaults
 *
 * ## Fail-closed
 *
 * - Package directory not found → error (names the package and resolution path)
 * - Package fails to load → error (delegates to {@link loadBlueprintPackage})
 * - Path-traversal hardening on all path lookups
 *
 * @module blueprint-registry
 */

import { existsSync } from "node:fs";
import { resolve as resolvePath, join, relative } from "node:path";
import { homedir } from "node:os";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadBlueprintPackage, type LoadedBlueprintPackage } from "./blueprint-loader.ts";

// ── Package ID Validation ────────────────────────────────────────────

/**
 * Valid package ID format: letters, digits, underscores, and hyphens only.
 */
const VALID_PACKAGE_ID_RE = /^[a-zA-Z0-9_-]+$/;

/**
 * Returns true if the given string looks like a filesystem path rather
 * than a package identifier.
 */
function looksLikePath(value: string): boolean {
  return (
    value.startsWith("/") ||
    value.startsWith(".") ||
    value.startsWith("~") ||
    value.includes("/") ||
    value.includes("\\")
  );
}

// ── Path Confinement ─────────────────────────────────────────────────

/**
 * Asserts that `resolved` is within `root` by checking the relative path.
 * Returns `true` if the resolved path is a descendant of root (or is root).
 */
function isPathWithinRoot(resolved: string, root: string): boolean {
  const rel = relative(root, resolved);
  return !rel.startsWith("..") && !rel.startsWith("/");
}

/**
 * Resolves the path to the blueprint package's shipped defaults directory.
 */
function resolveDefaultsDir(): string {
  try {
    const moduleDir = dirname(fileURLToPath(import.meta.url));
    // src/blueprint-registry.ts → src/ → blueprint/ → defaults/
    return resolvePath(moduleDir, "..", "defaults");
  } catch {
    return resolvePath(
      process.env["ZAO_HOME"] ?? join(homedir(), ".zao"),
      "defaults",
    );
  }
}

// ── Package Directory Resolution ─────────────────────────────────────

/**
 * Resolves a blueprint package directory by package ID.
 *
 * Searches in order:
 * 1. Global: `~/.zao/blueprints/<packageId>/`
 * 2. Defaults: `<defaultsDir>/blueprints/<packageId>/`
 *
 * @param packageId - The package identifier.
 * @returns The resolved absolute path, or null if not found.
 */
function resolveBlueprintPackageDir(packageId: string): string | null {
  // ── Sanitization: reject path-like inputs ──────────────────────
  if (looksLikePath(packageId)) {
    throw new Error(
      `Invalid blueprint identifier "${packageId}". ` +
        "Blueprint IDs must be simple identifiers (letters, digits, underscores, hyphens). " +
        "Use explicitPath to load a blueprint from a filesystem path.",
    );
  }

  if (!VALID_PACKAGE_ID_RE.test(packageId)) {
    throw new Error(
      `Invalid blueprint identifier "${packageId}". ` +
        "Blueprint IDs may only contain letters, digits, underscores, and hyphens.",
    );
  }

  // Use ZAO_HOME as override for the global blueprints root (test support)
  const moHome = process.env["ZAO_HOME"] ?? join(homedir(), ".zao");

  // ── Resolution with path confinement check ─────────────────────
  // Layer 1: Global blueprints
  const globalRoot = join(moHome, "blueprints");
  const globalPath = join(globalRoot, packageId);
  if (existsSync(join(globalPath, "package.yaml"))) {
    if (!isPathWithinRoot(globalPath, globalRoot)) {
      throw new Error(
        `Path traversal detected: "${packageId}" resolved to "${globalPath}" ` +
          `which is outside the allowed global blueprints directory.`,
      );
    }
    return globalPath;
  }

  // Layer 2: Shipped defaults
  const defaultsRoot = join(resolveDefaultsDir(), "blueprints");
  const defaultsPath = join(defaultsRoot, packageId);
  if (existsSync(join(defaultsPath, "package.yaml"))) {
    if (!isPathWithinRoot(defaultsPath, defaultsRoot)) {
      throw new Error(
        `Path traversal detected: "${packageId}" resolved to "${defaultsPath}" ` +
          `which is outside the allowed defaults directory.`,
      );
    }
    return defaultsPath;
  }

  return null;
}

// ── Core Resolver ────────────────────────────────────────────────────

/**
 * Resolves and loads a blueprint package by ID.
 *
 * ## Resolution
 *
 * If `explicitPath` is provided, loads directly from that directory
 * (absolute path). Otherwise, resolves by `packageId` through the
 * layered resolution strategy.
 *
 * @param options.explicitPath - Absolute path to a blueprint package directory.
 * @param options.packageId - Blueprint identifier to resolve.
 * @returns A loaded and validated blueprint package.
 */
export async function resolveBlueprintPackage(options: {
  explicitPath?: string;
  packageId?: string;
}): Promise<LoadedBlueprintPackage> {
  let packageDir: string;

  if (options.explicitPath) {
    packageDir = resolvePath(options.explicitPath);
    if (!existsSync(join(packageDir, "package.yaml"))) {
      throw new Error(
        `Blueprint package not found at "${packageDir}". ` +
          "The directory must contain a package.yaml file.",
      );
    }
  } else {
    const pkgId = options.packageId;
    if (!pkgId) {
      throw new Error(
        "Blueprint resolution requires either explicitPath or packageId.",
      );
    }
    const resolved = resolveBlueprintPackageDir(pkgId);
    if (!resolved) {
      throw new Error(
        `Blueprint package "${pkgId}" not found. ` +
          `Checked: ~/.zao/blueprints/${pkgId}/, defaults/blueprints/${pkgId}/. ` +
          "Ensure the blueprint package exists.",
      );
    }
    packageDir = resolved;
  }

  return loadBlueprintPackage(packageDir);
}
