// lib/mcp-normalizer.ts

/**
 * Types for MCP-style tool schemas.
 * We support both `inputSchema` and `input_schema`.
 */

export type JSONSchema = {
  type?: string;
  properties?: Record<string, JSONSchema>;
  items?: JSONSchema;
  enum?: any[];
  required?: string[];
  [key: string]: any;
};

export type MCPToolDefinition = {
  name: string;
  description?: string;
  inputSchema?: JSONSchema;
  input_schema?: JSONSchema;
};

export type NormalizationLog = {
  targetKey: string;
  fromKey?: string;
  reason: string;
};

export type NormalizedArgumentsResult = {
  normalized: Record<string, any>;
  logs: NormalizationLog[];
};

/**
 * Utility: normalize a field name for comparison.
 * Lowercase, remove non-alphanumerics.
 */
function normalizeFieldName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * Utility: split camelCase / snake_case / kebab-case into tokens.
 */
function tokenize(name: string): string[] {
  const cleaned = name.replace(/[-_]/g, " ");
  return cleaned
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
}

/**
 * Very light fuzzy similarity: Jaccard over token sets.
 */
function tokenSimilarity(a: string, b: string): number {
  const tokensA = new Set(tokenize(a));
  const tokensB = new Set(tokenize(b));
  if (!tokensA.size || !tokensB.size) return 0;

  let intersection = 0;
  for (const t of tokensA) {
    if (tokensB.has(t)) intersection++;
  }
  const union = tokensA.size + tokensB.size - intersection;
  return intersection / union;
}

/**
 * Global semantic synonym hints.
 * We don't bind to a specific tool – we bind to concepts.
 */
const globalConceptSynonyms: Record<string, string[]> = {
  recipient_email: ["to", "email", "recipient", "recipient_email", "mail_to", "send_to"],
  subject: ["subject", "title", "topic", "headline"],
  body: ["body", "message", "msg", "content", "text"],
  query: ["q", "query", "search", "keyword", "term"],
  url: ["url", "link", "href", "address", "endpoint"],
  amount: ["amount", "value", "total", "price"],
  date: ["date", "when", "day"],
  phone: ["phone", "phone_number", "mobile", "cell"],
};

/**
 * Given a schema key, infer which global concept bucket it might belong to.
 * Very heuristic, but good enough for auto-mapping.
 */
function guessConceptForSchemaKey(schemaKey: string): string | undefined {
  const key = schemaKey.toLowerCase();
  if (key.includes("email")) return "recipient_email";
  if (key === "to") return "recipient_email";
  if (key.includes("subject") || key.includes("title")) return "subject";
  if (key.includes("body") || key.includes("message") || key.includes("content")) return "body";
  if (key.includes("query") || key.includes("search")) return "query";
  if (key.includes("url") || key.includes("link")) return "url";
  if (key.includes("amount") || key.includes("total") || key.includes("price")) return "amount";
  if (key.includes("date") || key.includes("day")) return "date";
  if (key.includes("phone") || key.includes("mobile")) return "phone";
  return undefined;
}

/**
 * Coerce values based on JSON Schema type.
 * Light-touch: don't be too strict, just helpful.
 */
function coerceValue(value: any, schema?: JSONSchema): any {
  if (!schema || value === null || value === undefined) return value;

  const type = schema.type;

  if (!type) return value;

  try {
    switch (type) {
      case "string":
        if (typeof value === "string") return value;
        return String(value);

      case "number":
      case "integer": {
        if (typeof value === "number") return value;
        const n = Number(value);
        return Number.isNaN(n) ? value : n;
      }

      case "boolean": {
        if (typeof value === "boolean") return value;
        if (typeof value === "string") {
          const v = value.toLowerCase();
          if (["true", "yes", "1"].includes(v)) return true;
          if (["false", "no", "0"].includes(v)) return false;
        }
        return value;
      }

      case "array": {
        if (Array.isArray(value)) return value;
        // allow comma-separated string
        if (typeof value === "string") {
          return value.split(",").map(s => s.trim());
        }
        // wrap single value
        return [value];
      }

      case "object": {
        if (typeof value === "object" && !Array.isArray(value)) return value;
        if (typeof value === "string") {
          try {
            const parsed = JSON.parse(value);
            if (typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
          } catch {
            /* ignore */
          }
        }
        return value;
      }

      default:
        return value;
    }
  } catch {
    return value;
  }
}

/**
 * Normalize arguments based on MCP tool schema.
 * - Handles `inputSchema` and `input_schema`
 * - Does direct, normalized, synonym, and fuzzy matching
 * - Performs light type coercion
 */
export function normalizeMCPArguments(
  tool: MCPToolDefinition,
  rawArgs: Record<string, any> | null | undefined
): NormalizedArgumentsResult {
  const logs: NormalizationLog[] = [];

  if (!rawArgs || typeof rawArgs !== "object") {
    return { normalized: {}, logs: [{ targetKey: "*", reason: "No arguments provided" }] };
  }

  const schema: JSONSchema | undefined = tool.inputSchema || tool.input_schema;
  if (!schema || !schema.properties || typeof schema.properties !== "object") {
    // No schema → nothing to normalize
    return { normalized: { ...rawArgs }, logs: [{ targetKey: "*", reason: "No schema; passthrough" }] };
  }

  const properties = schema.properties;
  const required = schema.required ?? [];

  // Precompute normalized keys for raw args
  const rawEntries = Object.entries(rawArgs);
  const rawNormalizedMap = new Map<string, { key: string; value: any }>();
  for (const [key, value] of rawEntries) {
    rawNormalizedMap.set(normalizeFieldName(key), { key, value });
  }

  const normalized: Record<string, any> = {};

  // For each expected property in the schema, try to find the best-matching raw argument
  for (const [schemaKey, propSchema] of Object.entries(properties)) {
    const targetNorm = normalizeFieldName(schemaKey);
    const concept = guessConceptForSchemaKey(schemaKey);

    // 1) Direct normalized match
    if (rawNormalizedMap.has(targetNorm)) {
      const match = rawNormalizedMap.get(targetNorm)!;
      normalized[schemaKey] = coerceValue(match.value, propSchema);
      logs.push({
        targetKey: schemaKey,
        fromKey: match.key,
        reason: "Direct key match (normalized)",
      });
      continue;
    }

    // 2) Concept / synonym mapping
    if (concept && globalConceptSynonyms[concept]) {
      const candidates = globalConceptSynonyms[concept];
      let found: { key: string; value: any } | undefined;

      for (const candidate of candidates) {
        const normCandidate = normalizeFieldName(candidate);
        if (rawNormalizedMap.has(normCandidate)) {
          found = rawNormalizedMap.get(normCandidate)!;
          break;
        }
      }

      if (found) {
        normalized[schemaKey] = coerceValue(found.value, propSchema);
        logs.push({
          targetKey: schemaKey,
          fromKey: found.key,
          reason: `Concept-based synonym match (${concept})`,
        });
        continue;
      }
    }

    // 3) Fuzzy token similarity (fallback)
    let best: { score: number; key: string; value: any } | null = null;
    for (const [rawKey, { value }] of rawNormalizedMap.entries()) {
      const score = tokenSimilarity(schemaKey, rawKey);
      if (score >= 0.6 && (!best || score > best.score)) {
        best = { score, key: rawKey, value };
      }
    }

    if (best) {
      const originalKey = rawEntries.find(([k]) => normalizeFieldName(k) === best!.key)?.[0] ?? best.key;
      normalized[schemaKey] = coerceValue(best.value, propSchema);
      logs.push({
        targetKey: schemaKey,
        fromKey: originalKey,
        reason: `Fuzzy token similarity match (score=${best.score.toFixed(2)})`,
      });
      continue;
    }

    // 4) No match found → leave undefined, unless required → set null and log
    if (required.includes(schemaKey)) {
      normalized[schemaKey] = null;
      logs.push({
        targetKey: schemaKey,
        reason: "Required field missing; set to null",
      });
    } else {
      logs.push({
        targetKey: schemaKey,
        reason: "No matching argument found; left undefined",
      });
    }
  }

  // 5) Optionally, keep any extra raw args that didn't map to schema keys
  //    (you can disable this if you want strict mode)
  for (const [key, value] of rawEntries) {
    if (!(key in normalized)) {
      normalized[key] = value;
      logs.push({
        targetKey: key,
        fromKey: key,
        reason: "Extra argument preserved (not in schema)",
      });
    }
  }

  return { normalized, logs };
}