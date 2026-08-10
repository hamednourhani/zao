/**
 * Flow Package Registry — resolves flow packages by ID.
 *
 * ## Resolution order
 *
 * 1. Explicit path (absolute path to a package directory)
 * 2. `<projectRoot>/.zao/flows/<packageId>/` — repo-level packages
 * 3. `~/.zao/flows/<packageId>/` — global packages
 * 4. Shipped `defaults/flows/<packageId>/` — controller defaults
 *
 * Falls back to the "default" package when no packageId is specified.
 * The default package is always loaded from the controller's shipped defaults.
 *
 * ## Fail-closed
 *
 * - Package directory not found → error (names the package and resolution path)
 * - Package fails to load → error (delegates to {@link loadFlowPackage})
 *
 * @module package-registry
 */

import { existsSync } from "node:fs";
import { resolve as resolvePath, join, relative } from "node:path";
import { homedir } from "node:os";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadFlowPackage, type LoadedFlowPackage } from "./package-loader.ts";
import { compileFlowPackage, type CompiledFlowPackage } from "./package-compiler.ts";

// ── Package ID Validation ────────────────────────────────────────────

/**
 * Valid package ID format: letters, digits, underscores, and hyphens only.
 * This is the only format accepted for registry-based lookup.
 *
 * Other forms (paths, relative paths, special prefixes) are rejected or
 * treated as explicit path references based on context.
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

// ── Path Resolution ─────────────────────────────────────────────────

/**
 * Resolves the path to the controller's shipped defaults directory.
 * In dev: `packages/controller/defaults/`
 * In production: alongside the installed package.
 */
function resolveDefaultsDir(): string {
  try {
    const moduleDir = dirname(fileURLToPath(import.meta.url));
    // flow-package/package-registry.ts → src/ → controller/
    return resolvePath(moduleDir, "..", "..", "defaults");
  } catch {
    return resolvePath(
      process.env["ZAO_HOME"] ?? join(homedir(), ".zao"),
      "defaults",
    );
  }
}

/**
 * Resolves a package directory by package ID.
 *
 * Searches in order:
 * 1. Project-level: `<projectRoot>/.zao/flows/<packageId>/`
 * 2. Global: `~/.zao/flows/<packageId>/`
 * 3. Defaults: `<defaultsDir>/flows/<packageId>/`
 *
 * @param packageId - The package identifier.
 * @param projectRoot - The project root directory.
 * @returns The resolved absolute path, or null if not found.
 */
function resolvePackageDir(
  packageId: string,
  projectRoot: string,
): string | null {
  // ── Sanitization: reject path-like inputs ──────────────────────
  // Package IDs for registry lookup must be simple identifiers.
  // Anything that looks like a filesystem path (/, \, ., ~, ..) is
  // rejected to prevent path traversal attacks.
  if (looksLikePath(packageId)) {
    throw new Error(
      `Invalid package identifier "${packageId}". ` +
        "Package IDs must be simple identifiers (letters, digits, underscores, hyphens). " +
        "Use explicitPath to load a package from a filesystem path.",
    );
  }

  if (!VALID_PACKAGE_ID_RE.test(packageId)) {
    throw new Error(
      `Invalid package identifier "${packageId}". ` +
        "Package IDs may only contain letters, digits, underscores, and hyphens.",
    );
  }

  // ── Resolution with path confinement check ─────────────────────
  // Layer 1: Project-level packages
  const projectPath = join(projectRoot, ".zao", "flows", packageId);
  if (existsSync(join(projectPath, "package.yaml"))) {
    // Assert: resolved path is within the intended root
    if (!isPathWithinRoot(projectPath, join(projectRoot, ".zao", "flows"))) {
      throw new Error(
        `Path traversal detected: "${packageId}" resolved to "${projectPath}" ` +
          `which is outside the allowed project flows directory.`,
      );
    }
    return projectPath;
  }

  // Layer 2: Global packages
  const globalRoot = join(homedir(), ".zao", "flows");
  const globalPath = join(globalRoot, packageId);
  if (existsSync(join(globalPath, "package.yaml"))) {
    if (!isPathWithinRoot(globalPath, globalRoot)) {
      throw new Error(
        `Path traversal detected: "${packageId}" resolved to "${globalPath}" ` +
          `which is outside the allowed global flows directory.`,
      );
    }
    return globalPath;
  }

  // Layer 3: Shipped defaults (must exist for "default")
  const defaultsRoot = join(resolveDefaultsDir(), "flows");
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

/**
 * Asserts that `resolved` is within `root` by checking the relative path.
 * Returns `true` if the resolved path is a descendant of root (or is root).
 */
function isPathWithinRoot(resolved: string, root: string): boolean {
  const rel = relative(root, resolved);
  // If relative() starts with ".." or is empty, it's outside the root
  return !rel.startsWith("..") && !rel.startsWith("/");
}

// ── Core Resolver ────────────────────────────────────────────────────

/**
 * Resolves and loads a flow package by ID, then compiles it.
 *
 * ## Resolution
 *
 * If `explicitPath` is provided, loads directly from that directory
 * (absolute path). Otherwise, resolves by `packageId` (defaults to "default")
 * through the layered resolution strategy.
 *
 * ## Compilation
 *
 * After loading, the package is compiled via {@link compileFlowPackage}
 * to produce a runtime-ready `CompiledFlowPackage` with resolved roles.
 *
 * @param options.explicitPath - Absolute path to a package directory.
 * @param options.packageId - Package identifier to resolve (defaults to "default").
 * @param options.projectRoot - Project root for repo-level resolution.
 * @returns A compiled flow package ready for execution.
 */
export async function resolveAndCompileFlowPackage(options: {
  explicitPath?: string;
  packageId?: string;
  projectRoot?: string;
}): Promise<CompiledFlowPackage> {
  let packageDir: string;

  if (options.explicitPath) {
    packageDir = resolvePath(options.explicitPath);
    if (!existsSync(join(packageDir, "package.yaml"))) {
      throw new Error(
        `Flow package not found at "${packageDir}". ` +
          "The directory must contain a package.yaml file.",
      );
    }
  } else {
    const pkgId = options.packageId ?? "default";
    const projectRoot = options.projectRoot ?? process.cwd();
    const resolved = resolvePackageDir(pkgId, projectRoot);
    if (!resolved) {
      throw new Error(
        `Flow package "${pkgId}" not found. ` +
          `Checked: <project>/.zao/flows/${pkgId}/, ~/.zao/flows/${pkgId}/, defaults/flows/${pkgId}/. ` +
          "Ensure the package exists or use the 'default' package.",
      );
    }
    packageDir = resolved;
  }

  const loaded = await loadFlowPackage(packageDir);
  return compileFlowPackage(loaded);
}

/**
 * Resolves and loads a flow package by ID without compiling.
 * Used for snapshot serialization where raw data is needed.
 *
 * @param options.explicitPath - Absolute path to a package directory.
 * @param options.packageId - Package identifier to resolve.
 * @param options.projectRoot - Project root for repo-level resolution.
 * @returns A loaded flow package.
 */
export async function resolveFlowPackage(options: {
  explicitPath?: string;
  packageId?: string;
  projectRoot?: string;
}): Promise<LoadedFlowPackage> {
  let packageDir: string;

  if (options.explicitPath) {
    packageDir = resolvePath(options.explicitPath);
    if (!existsSync(join(packageDir, "package.yaml"))) {
      throw new Error(
        `Flow package not found at "${packageDir}". ` +
          "The directory must contain a package.yaml file.",
      );
    }
  } else {
    const pkgId = options.packageId ?? "default";
    const projectRoot = options.projectRoot ?? process.cwd();
    const resolved = resolvePackageDir(pkgId, projectRoot);
    if (!resolved) {
      throw new Error(
        `Flow package "${pkgId}" not found. ` +
          `Checked: <project>/.zao/flows/${pkgId}/, ~/.zao/flows/${pkgId}/, defaults/flows/${pkgId}/. ` +
          "Ensure the package exists or use the 'default' package.",
      );
    }
    packageDir = resolved;
  }

  return loadFlowPackage(packageDir);
}
