interface Metadata { name: string; description: string; issue?: string }

function scalar(raw: string): string {
  const text = raw.trim();
  if (!text) throw new Error("Empty metadata scalar");
  if (text.startsWith("'")) {
    const match = /^'((?:[^']|'')*)'\s*(?:#.*)?$/.exec(text);
    if (!match) throw new Error("Unsupported single-quoted metadata");
    return match[1].replace(/''/g, "'");
  }
  if (text.startsWith('"')) {
    const match = /^("(?:[^"\\]|\\.)*")\s*(?:#.*)?$/.exec(text);
    if (!match) throw new Error("Unsupported double-quoted metadata");
    try { return JSON.parse(match[1]) as string; }
    catch { throw new Error("Unsupported metadata escape (JSON-style escapes supported)"); }
  }
  const plain = text.replace(/\s+#.*$/, "").trimEnd();
  if (/^[\[\]{}!&*|>@`%]|^(?:null|true|false|~)$/i.test(plain) || /:\s/.test(plain) || /^[-?:](?:\s|$)/.test(plain)) {
    throw new Error("Complex or non-string metadata is unsupported");
  }
  return plain;
}

function blockValue(lines: string[], marker: string): string {
  const nonempty = lines.filter((line) => line.trim());
  const indent = Math.min(...nonempty.map((line) => /^ */.exec(line)![0].length));
  if (!nonempty.length) return "";
  if (!indent || lines.some((line) => /^ *\t/.test(line))) throw new Error("Unsupported block indentation");
  const values = lines.map((line) => line.trim() ? line.slice(indent) : "");
  let result = "";
  if (marker.startsWith("|")) result = values.join("\n");
  else {
    for (let index = 0; index < values.length; index++) {
      result += values[index];
      if (index === values.length - 1) break;
      const current = values[index];
      const next = values[index + 1];
      if (current && next && !/^\s/.test(current) && !/^\s/.test(next)) result += " ";
      else if (current && !next) result += "\n";
      else if (!current && !next) result += "\n";
      else if (/^\s/.test(current) || /^\s/.test(next)) result += "\n";
    }
  }
  if (marker.endsWith("-")) return result.replace(/\n+$/, "");
  if (marker.endsWith("+")) return result + "\n";
  return result.replace(/\n+$/, "") + "\n";
}

// This intentionally extracts two scalar fields, not executable YAML or a full
// YAML object. Unrelated metadata is never evaluated or materialized.
export function parseMetadata(content: string, fallback: string, truncated = false): Metadata {
  const lines = content.replace(/^\uFEFF/, "").split(/\r?\n/);
  const result: Metadata = { name: fallback, description: "" };
  if (lines[0] !== "---") return result;
  const end = lines.findIndex((line, index) => index > 0 && /^(?:---|\.\.\.)\s*$/.test(line));
  if (end < 0) {
    result.issue = truncated ? "Frontmatter exceeds 16 KiB header limit" : "Unterminated frontmatter";
    return result;
  }
  const issues: string[] = [];
  const seen = new Set<string>();
  for (let index = 1; index < end; index++) {
    const match = /^(name|description):(?:\s+(.*)|\s*)$/.exec(lines[index]);
    if (!match) {
      if (/^(name|description)\s*:/.test(lines[index])) issues.push("Unsupported metadata syntax");
      continue;
    }
    const key = match[1] as "name" | "description";
    if (seen.has(key)) { issues.push(`Duplicate metadata key: ${key}`); continue; }
    seen.add(key);
    const raw = (match[2] ?? "").trim();
    try {
      if (/^[>|][+-]?(?:\s+#.*)?$/.test(raw)) {
        const block: string[] = [];
        while (index + 1 < end && (/^\s/.test(lines[index + 1]) || !lines[index + 1].trim())) block.push(lines[++index]);
        result[key] = blockValue(block, raw.split(/\s/)[0]);
      } else {
        result[key] = scalar(raw);
        if (index + 1 < end && /^\s+\S/.test(lines[index + 1])) throw new Error("Unsupported metadata continuation; use a folded or literal block");
      }
      if (!result[key].trim()) issues.push(`Empty metadata: ${key}`);
    } catch (error) { issues.push(error instanceof Error ? error.message : String(error)); }
  }
  for (const key of ["name", "description"]) if (!seen.has(key)) issues.push(`Missing metadata: ${key}`);
  if (issues.length) result.issue = [...new Set(issues)].join("; ");
  return result;
}
