import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildOpenApiDocument } from "../src/api/openapi.js";

/**
 * Regenerate the merged API contract baseline under web/src/api/contracts:
 *   - openapi.json   the OpenAPI 3.1 document
 *   - schema.d.ts    the generated TypeScript client types (openapi-typescript)
 *
 * The UI milestone consumes both; the openapi drift test fails if either the
 * committed JSON or the types no longer match a fresh generation.
 */
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const targetDir = path.join(repoRoot, "web", "src", "api", "contracts");
const jsonPath = path.join(targetDir, "openapi.json");
const typesPath = path.join(targetDir, "schema.d.ts");

const document = buildOpenApiDocument();
fs.mkdirSync(targetDir, { recursive: true });
fs.writeFileSync(jsonPath, `${JSON.stringify(document, null, 2)}\n`, "utf8");
console.log(`wrote ${path.relative(repoRoot, jsonPath)}`);

// Generate the TypeScript client types from the freshly written document so
// the types and the JSON can never disagree. Resolve the CLI from the package
// root (node/), since this file is compiled into dist/scripts/.
const packageRoot = path.resolve(repoRoot, "node");
const cli = path.join(packageRoot, "node_modules", "openapi-typescript", "bin", "cli.js");
execFileSync(process.execPath, [cli, jsonPath, "-o", typesPath], { stdio: "inherit" });
console.log(`wrote ${path.relative(repoRoot, typesPath)}`);
