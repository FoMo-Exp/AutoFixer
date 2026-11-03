/**
 * Deterministic path-pattern matching for ownership, CODEOWNERS, and team
 * rules.
 *
 * Pattern semantics (fixed, documented, no configuration):
 *
 * - `dir/` — matches every path under the `dir/` prefix.
 * - `a/b.txt`, `node/**\/*.ts` — a full-path glob, anchored to the whole path.
 * - `*.ts` (no slash) — a basename glob, matched against the final path
 *   segment anywhere in the tree (CODEOWNERS semantics).
 *
 * Glob syntax: `**` matches any characters including `/` (leading `**` plus
 * a separator also matches zero directories, and a trailing `**` under a
 * directory prefix matches the directory itself and everything under it),
 * `*` matches any characters except `/`, `?` matches exactly one character
 * except `/`, everything else is literal.
 */

function globSource(pattern: string): string {
  const segments = pattern.split("/");
  let source = "";
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index] ?? "";
    const last = index === segments.length - 1;
    if (segment === "**") {
      source += last ? "(?:.+)?" : "(?:[^/]+/)*";
      continue;
    }
    for (const char of segment) {
      if (char === "*") {
        source += "[^/]*";
      } else if (char === "?") {
        source += "[^/]";
      } else {
        source += /[.*+?^${}()|[\]\\]/.test(char) ? `\\${char}` : char;
      }
    }
    if (!last) {
      source += "/";
    }
  }
  return source;
}

function normalizePath(path: string): string {
  let normalized = path;
  while (normalized.startsWith("./")) {
    normalized = normalized.slice(2);
  }
  return normalized;
}

/**
 * True when `path` matches `pattern` under the semantics above. Both sides
 * are repository-relative; `./` prefixes are ignored.
 */
export function pathMatchesPattern(pattern: string, path: string): boolean {
  const normalizedPath = normalizePath(path);
  if (pattern.endsWith("/") && !pattern.endsWith("**/")) {
    return normalizedPath.startsWith(pattern);
  }
  const effective = pattern.includes("/") ? pattern : `**/${pattern}`;
  return new RegExp(`^${globSource(effective)}$`).test(normalizedPath);
}
