// LLM client — Command Code Provider API (OpenAI-compatible).
// Faithful TS port of the structured-output ladder in structured.py and the
// _execute_and_validate loop in pipeline.py. The model id is sent verbatim
// (deepseek/deepseek-v4-flash), matching the Command Code catalog.

import type { Settings } from "./config";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface CompletionOptions {
  responseFormat?: { type: "json_object" } | { type: "json_schema"; json_schema: unknown };
}

export class LlmError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LlmError";
  }
}

// Substrings that identify "this provider cannot enforce a JSON schema".
const SCHEMA_REJECTION_MARKERS = [
  "response_format",
  "json_schema",
  "unsupported_value",
  "structured output",
];

const EMPTY_RESPONSE_MARKERS = [
  "none or empty",
  "invalid response from llm call",
  "empty response",
];

const FENCE_RE = /```(?:json|JSON)?\s*([\s\S]*?)```/g;

export function schemaRejected(exc: unknown): boolean {
  const text = String(exc).toLowerCase();
  if (!text.includes("400") && !text.includes("invalid_request") && !text.includes("unsupported")) {
    return false;
  }
  return SCHEMA_REJECTION_MARKERS.some((m) => text.includes(m));
}

export function isEmptyResponse(exc: unknown): boolean {
  const text = String(exc).toLowerCase();
  return EMPTY_RESPONSE_MARKERS.some((m) => text.includes(m));
}

export function looksTruncated(text: string): boolean {
  const stripped = (text ?? "").trim();
  if (!stripped.startsWith("{") && !stripped.startsWith("[")) return false;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (const ch of stripped) {
    if (escaped) { escaped = false; continue; }
    if (ch === "\\") { escaped = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === "{" || ch === "[") depth++;
    else if (ch === "}" || ch === "]") depth--;
  }
  return inString || depth > 0;
}

export function extractJson(text: string): unknown {
  if (!text || !text.trim()) return null;
  const candidates: string[] = [];
  const stripped = text.trim();
  candidates.push(stripped);
  for (const m of stripped.matchAll(FENCE_RE)) candidates.push(m[1].trim());
  const start = stripped.indexOf("{");
  const end = stripped.lastIndexOf("}");
  if (start !== -1 && end > start) candidates.push(stripped.slice(start, end + 1));
  for (const candidate of candidates) {
    try {
      const payload = JSON.parse(candidate);
      if (payload && typeof payload === "object") return payload;
      if (Array.isArray(payload) && payload.length && typeof payload[0] === "object") {
        return payload[0];
      }
    } catch {
      // try next candidate
    }
  }
  return null;
}

export function parseModel<T>(text: string): T | null {
  const payload = extractJson(text);
  if (payload === null || payload === undefined) return null;
  return payload as T;
}

function jsonModeInstruction(schema: unknown): string {
  return `\n\n### OUTPUT FORMAT (mandatory)\nReply with a single JSON object and nothing else. No prose before it, no prose after it, no markdown fence. It must validate against this JSON schema:\n\n${JSON.stringify(schema)}\n\nUse only the field names in the schema. Omit a field rather than inventing a value for it.`;
}

// Strip description/title/default/examples noise from a JSON schema (port of compact_schema).
export function compactSchema(schema: unknown, keysAreNames = false): unknown {
  if (Array.isArray(schema)) return schema.map((x) => compactSchema(x));
  if (schema && typeof schema === "object") {
    const obj = schema as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      if (!keysAreNames && ["description", "title", "default", "examples"].includes(key)) continue;
      out[key] = compactSchema(value, key === "properties" || key === "$defs" || key === "definitions");
    }
    return out;
  }
  return schema;
}

export interface LlmCallResult {
  content: string;
  usage?: { promptTokens?: number; completionTokens?: number };
}

// ---------------------------------------------------------------------------
// The client
// ---------------------------------------------------------------------------
export class CommandCodeLlm {
  constructor(private settings: Settings) {}

  async complete(
    messages: ChatMessage[],
    opts: CompletionOptions = {}
  ): Promise<LlmCallResult> {
    const { llmBaseUrl, llmApiKey, llmModel, llmTemperature, llmMaxTokens } = this.settings;
    const body: Record<string, unknown> = {
      model: llmModel,
      messages,
      temperature: llmTemperature,
      max_tokens: llmMaxTokens,
    };
    if (opts.responseFormat) body.response_format = opts.responseFormat;

    // Bounded backoff for transient upstream failures (524/5xx/429/network).
    // The provider is "temporarily unavailable" from time to time; retrying a
    // couple of times with a pause usually clears it. Non-transient errors
    // (400/401/403) fail immediately.
    const retryableStatus = (status: number) => status === 524 || status === 429 || status >= 500;
    const attempts = Math.max(1, this.settings.pipelineMaxRetries + 1);
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= attempts; attempt++) {
      let res: Response;
      try {
        res = await fetch(`${llmBaseUrl}/chat/completions`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${llmApiKey}`,
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(240000),
        });
      } catch (e) {
        // Network failure / timeout — retryable.
        lastError = new LlmError(`LLM request failed: ${e}`);
        if (attempt < attempts) {
          await new Promise((r) => setTimeout(r, Math.min(2 ** attempt * 1000, 10000)));
          continue;
        }
        throw lastError;
      }

      if (!res.ok) {
        const text = await res.text().catch(() => "");
        if (retryableStatus(res.status) && attempt < attempts) {
          lastError = new LlmError(`LLM HTTP ${res.status}: ${text.slice(0, 400)}`);
          await new Promise((r) => setTimeout(r, Math.min(2 ** attempt * 1000, 10000)));
          continue;
        }
        throw new LlmError(`LLM HTTP ${res.status}: ${text.slice(0, 400)}`);
      }

      const data = await res.json();
      const choice = data?.choices?.[0];
      const content: string = choice?.message?.content ?? "";
      if (!content) {
        throw new LlmError("Invalid response from LLM call - None or empty");
      }
      return {
        content,
        usage: {
          promptTokens: data?.usage?.prompt_tokens,
          completionTokens: data?.usage?.completion_tokens,
        },
      };
    }
    throw lastError ?? new LlmError("LLM request failed");
  }

  // Run one stage prompt, applying the enforcement ladder and returning parsed JSON
  // plus the raw completion text (so the UI can stream what the agent "wrote").
  async generateJson<T>(
    system: string,
    user: string,
    schema: unknown,
    opts: { allowSchema?: boolean; allowJsonObject?: boolean } = {}
  ): Promise<{ parsed: T | null; raw: string } | null> {
    const allowSchema = opts.allowSchema ?? true;
    const allowJsonObject = opts.allowJsonObject ?? true;
    let schemaAllowed = allowSchema;
    let jsonObjectAllowed = allowJsonObject;

    const ladder: Array<"schema" | "json" | "plain"> = [];
    if (schemaAllowed) ladder.push("schema");
    if (jsonObjectAllowed) ladder.push("json");
    ladder.push("plain");

    const maxEmpty = Math.max(1, this.settings.pipelineMaxRetries);
    let emptyAttempts = 0;
    const maxCalls = 4;

    for (let calls = 0, i = 0; i < ladder.length && calls < maxCalls; i++, calls++) {
      const rung = ladder[i];
      let prompt = user;
      let responseFormat: CompletionOptions["responseFormat"];

      if (rung === "schema") {
        responseFormat = { type: "json_schema", json_schema: { name: "result", schema: compactSchema(schema) } };
      } else if (rung === "json") {
        prompt = user + jsonModeInstruction(compactSchema(schema));
        responseFormat = { type: "json_object" };
      } else {
        prompt = user + jsonModeInstruction(compactSchema(schema));
        responseFormat = undefined;
      }

      try {
        const result = await this.complete(
          [
            { role: "system", content: system },
            { role: "user", content: prompt },
          ],
          { responseFormat }
        );
        const parsed = parseModel<T>(result.content);
        return { parsed, raw: result.content };
      } catch (e) {
        if (rung === "schema" && schemaRejected(e)) {
          schemaAllowed = false;
          continue;
        }
        if (rung === "json" && schemaRejected(e)) {
          jsonObjectAllowed = false;
          continue;
        }
        if (isEmptyResponse(e)) {
          if (emptyAttempts < maxEmpty) {
            emptyAttempts++;
            await new Promise((r) => setTimeout(r, Math.min(2 ** emptyAttempts, 8) * 1000));
            i--; // retry same rung
            continue;
          }
        }
        throw e;
      }
    }
    return null;
  }
}
