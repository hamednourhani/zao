import { describe, test, expect } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const SCHEMAS_DIR = join(import.meta.dir, "..", "schemas");

const schemaFiles = readdirSync(SCHEMAS_DIR).filter((f) =>
  f.endsWith(".schema.json"),
);

interface ParsedSchema {
  name: string;
  path: string;
  content: Record<string, unknown>;
}

/**
 * Read and parse all .schema.json files. Throws immediately on invalid JSON.
 */
function loadSchemas(): ParsedSchema[] {
  const schemas: ParsedSchema[] = [];

  for (const file of schemaFiles) {
    const filePath = join(SCHEMAS_DIR, file);
    const raw = readFileSync(filePath, "utf-8");
    let parsed: Record<string, unknown>;

    try {
      parsed = JSON.parse(raw);
    } catch (cause) {
      throw new Error(`Invalid JSON in ${file}: ${cause}`);
    }

    schemas.push({ name: file, path: filePath, content: parsed });
  }

  return schemas;
}

const schemas = loadSchemas();

describe("schema-validity", () => {
  test("has .schema.json files to validate", () => {
    expect(schemas.length).toBeGreaterThan(0);
  });

  test("all schema files parse as valid JSON", () => {
    // If loadSchemas() returned without throwing, every file is valid JSON.
    for (const { name } of schemas) {
      // Re-parse to satisfy the "valid JSON" assertion explicitly.
      const raw = readFileSync(join(SCHEMAS_DIR, name), "utf-8");
      expect(() => JSON.parse(raw)).not.toThrow();
    }
  });

  for (const { name, content } of schemas) {
    test(`${name} — has required JSON Schema fields`, () => {
      // $schema must be present and point to a JSON Schema draft
      expect(content.$schema).toBeString();
      expect(content.$schema as string).toMatch(
        /^https?:\/\/json-schema\.org\/draft\//,
      );

      // type must be present and a string
      expect(content.type).toBeString();

      // Must have $id or title (at least one identifier)
      const hasIdOrTitle = !!(content.$id || content.title);
      expect(hasIdOrTitle).toBe(true);
    });
  }

  test("prints summary", () => {
    console.log(`${schemas.length} schema files validated`);
    expect(schemas.length).toBe(8);
  });
});
