import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildOpenApiDocument } from "../src/api/openapi.js";

/**
 * Regenerate the merged API contract baseline at
 * web/src/api/contracts/openapi.json from the implementation. The UI
 * milestone consumes this file; drift fails the openapi contract test.
 */
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const targetDir = path.join(repoRoot, "web", "src", "api", "contracts");
const target = path.join(targetDir, "openapi.json");

const document = buildOpenApiDocument();
fs.mkdirSync(targetDir, { recursive: true });
fs.writeFileSync(target, `${JSON.stringify(document, null, 2)}\n`, "utf8");
console.log(`wrote ${path.relative(repoRoot, target)}`);
