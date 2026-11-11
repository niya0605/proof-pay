/**
 * Shared engine for the three bounded AI workflows. It calls the model, validates the
 * output with Zod, retries once on invalid output, and logs every model and tool call
 * to `events`. No workflow can change state; each returns data a service validates.
 */
import { z } from "zod";
import { logEvent } from "../services/eventService.ts";

export type ToolDef = { name: string; description: string; input_schema: Record<string, unknown> };
export type ContentBlock =
  | { type: "text"; text: string }
  // Provider state that must be sent back on later turns: Gemini generateContent's
  // thoughtSignature, or the Interactions API's thought steps that preceded this call.
  | { type: "tool_use"; id: string; name: string; input: any; signature?: string; thoughts?: unknown[] }
  | { type: "tool_result"; tool_use_id: string; content: string; is_error?: boolean };
export type Message = { role: "user" | "assistant"; content: string | ContentBlock[] };
export type ModelRequest = { system: string; messages: Message[]; tools?: ToolDef[]; toolChoice?: { type: "tool"; name: string } | { type: "any" } | { type: "auto" }; maxTokens?: number };
export type ModelResponse = { content: ContentBlock[]; stopReason: string };
export type ModelCaller = (req: ModelRequest) => Promise<ModelResponse>;

/** LLM_PROVIDER: "gemini" (default) or "anthropic". */
export const provider = () => (process.env.LLM_PROVIDER ?? "gemini").toLowerCase();
export const llmConfigured = () => Boolean(process.env.LLM_API_KEY) || override !== null;
/** LLM_MODEL may list fallbacks, comma-separated: the next is tried when one is overloaded. */
export const modelList = () =>
  (process.env.LLM_MODEL || (provider() === "anthropic" ? "claude-sonnet-5-5" : "gemini-3.5-flash-lite,gemma-4-26b-a4b-it,gemini-3.5-flash"))
    .split(",")
    .map((m) => m.trim())
    .filter(Boolean);
export const modelName = () => modelList()[0];
/** Gemini API surface: "interactions" (default; required for newer AQ.* keys) or "generatecontent". */
const geminiApi = () => (process.env.LLM_GEMINI_API ?? "interactions").toLowerCase();
const timeoutMs = () => Number(process.env.LLM_TIMEOUT_MS ?? 60000);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Anthropic Messages API over fetch. */
const anthropicCaller: ModelCaller = async (req) => {
  const res = await fetch(`${process.env.LLM_BASE_URL ?? "https://api.anthropic.com"}/v1/messages`, {
    method: "POST",
    signal: AbortSignal.timeout(timeoutMs()),
    headers: { "content-type": "application/json", "x-api-key": process.env.LLM_API_KEY ?? "", "anthropic-version": "2023-06-01" },
    body: JSON.stringify({
      model: modelName(),
      max_tokens: req.maxTokens ?? 2048,
      system: req.system,
      // Drop the Gemini-only field before sending.
      messages: req.messages.map((m) => (typeof m.content === "string" ? m : { ...m, content: m.content.map(({ signature, thoughts, ...b }: any) => b) })),
      ...(req.tools ? { tools: req.tools } : {}),
      ...(req.tools && req.toolChoice ? { tool_choice: req.toolChoice } : {}),
    }),
  });
  if (!res.ok) throw new Error(`LLM HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const body: any = await res.json();
  return { content: body.content, stopReason: body.stop_reason };
};

// ---------- Gemini (Google AI Studio, generativelanguage v1beta) ----------

const GEMINI_SCHEMA_KEYS = new Set(["type", "format", "description", "nullable", "enum", "properties", "required", "items", "anyOf", "minimum", "maximum", "minItems", "maxItems", "minLength", "maxLength", "pattern", "propertyOrdering"]);

/** Reduce a JSON Schema to the OpenAPI subset Gemini's `parameters` accepts (fallback path). */
export function toGeminiSchema(schema: any): any {
  if (Array.isArray(schema)) return schema.map(toGeminiSchema);
  if (!schema || typeof schema !== "object") return schema;
  const out: any = {};
  for (const [k, v] of Object.entries(schema)) {
    if (k === "const") out.enum = [v];
    else if (k === "type" && Array.isArray(v)) {
      const types = v.filter((t) => t !== "null");
      out.type = types[0] ?? "string";
      if (v.includes("null")) out.nullable = true;
    } else if (k === "properties") out.properties = Object.fromEntries(Object.entries(v as object).map(([pk, pv]) => [pk, toGeminiSchema(pv)]));
    else if (k === "oneOf") out.anyOf = toGeminiSchema(v);
    else if (GEMINI_SCHEMA_KEYS.has(k)) out[k] = typeof v === "object" ? toGeminiSchema(v) : v;
  }
  if (out.enum) out.enum = out.enum.map(String);
  if (out.enum && !out.type) out.type = "string";
  if (out.type === "object" && out.properties && Object.keys(out.properties).length === 0) delete out.properties;
  return out;
}

/** Translate the internal (Anthropic-shaped) conversation into Gemini `contents`. */
export function toGeminiContents(messages: Message[]) {
  const names = new Map<string, string>();
  return messages.map((m) => {
    const blocks: ContentBlock[] = typeof m.content === "string" ? [{ type: "text", text: m.content }] : m.content;
    const parts = blocks.flatMap((b): any[] => {
      if (b.type === "text") return b.text ? [{ text: b.text }] : [];
      if (b.type === "tool_use") {
        names.set(b.id, b.name);
        return [{ functionCall: { name: b.name, args: b.input ?? {} }, ...(b.signature ? { thoughtSignature: b.signature } : {}) }];
      }
      const name = names.get(b.tool_use_id) ?? "respond";
      return [{ functionResponse: { name, response: b.is_error ? { error: b.content } : { result: b.content } } }];
    });
    return { role: m.role === "assistant" ? "model" : "user", parts };
  });
}

function geminiBody(req: ModelRequest, schemaMode: "json" | "openapi") {
  const tools = req.tools?.length
    ? [{ functionDeclarations: req.tools.map((t) => ({ name: t.name, description: t.description, ...(schemaMode === "json" ? { parametersJsonSchema: t.input_schema } : { parameters: toGeminiSchema(t.input_schema) }) })) }]
    : undefined;
  const choice = req.toolChoice;
  const toolConfig =
    tools && choice && choice.type !== "auto"
      ? { functionCallingConfig: { mode: "ANY", ...(choice.type === "tool" ? { allowedFunctionNames: [choice.name] } : {}) } }
      : undefined;
  return {
    systemInstruction: { parts: [{ text: req.system }] },
    contents: toGeminiContents(req.messages),
    ...(tools ? { tools } : {}),
    ...(toolConfig ? { toolConfig } : {}),
    generationConfig: { maxOutputTokens: req.maxTokens ?? 2048 },
  };
}

let callSeq = 0;
let lastGeminiCall = 0;

const geminiCaller: ModelCaller = async (req) => {
  const base = process.env.LLM_BASE_URL ?? "https://generativelanguage.googleapis.com";
  const url = `${base}/v1beta/models/${encodeURIComponent(modelName())}:generateContent`;
  // Optional pacing for free-tier per-minute limits.
  const minGap = Number(process.env.LLM_MIN_INTERVAL_MS ?? 0);
  let schemaMode: "json" | "openapi" = "json";
  for (let attempt = 0; ; attempt++) {
    const wait = lastGeminiCall + minGap - Date.now();
    if (wait > 0) await sleep(wait);
    lastGeminiCall = Date.now();
    const res = await fetch(url, {
      method: "POST",
      signal: AbortSignal.timeout(timeoutMs()),
      headers: { "content-type": "application/json", "x-goog-api-key": process.env.LLM_API_KEY ?? "" },
      body: JSON.stringify(geminiBody(req, schemaMode)),
    });
    if (res.ok) {
      const body: any = await res.json();
      const cand = body.candidates?.[0];
      const parts: any[] = cand?.content?.parts ?? [];
      const content: ContentBlock[] = parts.flatMap((p): ContentBlock[] => {
        if (p.functionCall)
          return [{ type: "tool_use", id: p.functionCall.id ?? `g${++callSeq}`, name: p.functionCall.name, input: p.functionCall.args ?? {}, ...(p.thoughtSignature ? { signature: p.thoughtSignature } : {}) }];
        if (typeof p.text === "string" && !p.thought) return [{ type: "text", text: p.text }];
        return [];
      });
      const stopReason = content.some((c) => c.type === "tool_use") ? "tool_use" : String(cand?.finishReason ?? body.promptFeedback?.blockReason ?? "unknown").toLowerCase();
      return { content, stopReason };
    }
    const text = await res.text();
    // Older endpoints don't know `parametersJsonSchema`: retry once with the OpenAPI subset.
    if (res.status === 400 && schemaMode === "json" && /parametersJsonSchema|parameters_json_schema/i.test(text)) {
      schemaMode = "openapi";
      continue;
    }
    // Free-tier rate limit: honour the suggested retry delay (capped) up to twice.
    if ((res.status === 429 || res.status === 503) && attempt < 2) {
      const secs = Number(/"retryDelay":\s*"(\d+(?:\.\d+)?)s"/.exec(text)?.[1] ?? 5);
      await sleep(Math.min(secs, 20) * 1000);
      continue;
    }
    throw new Error(`LLM HTTP ${res.status}: ${text.slice(0, 300)}`);
  }
};

// ---------- Gemini Interactions API (v1beta/interactions, step-list format) ----------

/** Translate the internal conversation into an Interactions `input` step list. */
export function toInteractionSteps(messages: Message[]): any[] {
  const names = new Map<string, string>();
  const steps: any[] = [];
  for (const m of messages) {
    const blocks: ContentBlock[] = typeof m.content === "string" ? [{ type: "text", text: m.content }] : m.content;
    if (m.role === "user") {
      const text = blocks.filter((b) => b.type === "text").map((b: any) => b.text).join("\n");
      if (text) steps.push({ type: "user_input", content: [{ type: "text", text }] });
      for (const b of blocks)
        if (b.type === "tool_result")
          steps.push({ type: "function_result", call_id: b.tool_use_id, name: names.get(b.tool_use_id) ?? "respond", result: b.content, ...(b.is_error ? { is_error: true } : {}) });
    } else {
      for (const b of blocks) {
        if (b.type === "text" && b.text) steps.push({ type: "model_output", content: [{ type: "text", text: b.text }] });
        if (b.type === "tool_use") {
          names.set(b.id, b.name);
          steps.push(...(b.thoughts ?? []), { type: "function_call", id: b.id, name: b.name, arguments: b.input ?? {} });
        }
      }
    }
  }
  return steps;
}

/** Convert Interactions output steps back into internal blocks (thought steps ride on the first call). */
export function fromInteractionSteps(steps: any[]): ContentBlock[] {
  const out: ContentBlock[] = [];
  let pending: unknown[] = [];
  for (const st of steps ?? []) {
    if (st.type === "thought") pending.push(st);
    else if (st.type === "function_call") {
      out.push({ type: "tool_use", id: st.id ?? `g${++callSeq}`, name: st.name, input: st.arguments ?? {}, ...(pending.length ? { thoughts: pending } : {}) });
      pending = [];
    } else if (st.type === "model_output")
      for (const c of st.content ?? []) if (c.type === "text" && c.text) out.push({ type: "text", text: c.text });
  }
  return out;
}

const interactionsCaller: ModelCaller = async (req) => {
  const base = process.env.LLM_BASE_URL ?? "https://generativelanguage.googleapis.com";
  const choice = req.toolChoice;
  const tool_choice = req.tools?.length && choice && choice.type !== "auto" ? (choice.type === "tool" ? { allowed_tools: { mode: "any", tools: [choice.name] } } : "any") : undefined;
  const minGap = Number(process.env.LLM_MIN_INTERVAL_MS ?? 0);
  let lastErr = "";
  for (const model of modelList()) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const wait = lastGeminiCall + minGap - Date.now();
      if (wait > 0) await sleep(wait);
      lastGeminiCall = Date.now();
      let res: Response;
      try {
        res = await fetch(`${base}/v1beta/interactions`, {
          method: "POST",
          // Shorter than the generic timeout: a hung call should move on to the next model.
          signal: AbortSignal.timeout(Number(process.env.LLM_TIMEOUT_MS ?? 30000)),
          headers: { "content-type": "application/json", "x-goog-api-key": process.env.LLM_API_KEY ?? "" },
          body: JSON.stringify({
            model,
            system_instruction: req.system,
            input: toInteractionSteps(req.messages),
            ...(req.tools?.length ? { tools: req.tools.map((t) => ({ type: "function", name: t.name, description: t.description, parameters: t.input_schema })) } : {}),
            generation_config: { max_output_tokens: req.maxTokens ?? 8192, ...(tool_choice ? { tool_choice } : {}) },
            store: false,
          }),
        });
      } catch (e) {
        lastErr = `LLM ${model}: ${(e as Error).message}`;
        break; // timeout or network error: next model
      }
      const text = await res.text();
      if (res.ok) {
        const body: any = JSON.parse(text);
        const content = fromInteractionSteps(body.steps);
        const stopReason = content.some((c) => c.type === "tool_use") ? "tool_use" : String(body.status ?? "unknown");
        return { content, stopReason };
      }
      lastErr = `LLM HTTP ${res.status} (${model}): ${text.slice(0, 300)}`;
      if (res.status === 429) break; // quota (often daily on the free tier): next model right away
      if (res.status !== 503 && res.status !== 500) throw new Error(lastErr);
      if (attempt === 0) await sleep(2000); // overloaded: one short retry, then the next model
    }
  }
  throw new Error(lastErr || "LLM unavailable");
};

let override: ModelCaller | null = null;
/** Tests inject a fake model here. */
export function setModelCaller(fn: ModelCaller | null) {
  override = fn;
}

export async function callModel(milestoneId: string | null, task: string, req: ModelRequest): Promise<ModelResponse> {
  const caller = override ?? (provider() === "anthropic" ? anthropicCaller : geminiApi() === "generatecontent" ? geminiCaller : interactionsCaller);
  const started = Date.now();
  try {
    const res = await caller(req);
    logEvent(milestoneId, "ai", "model_call", {
      task,
      provider: override ? "test" : provider(),
      model: modelName(),
      ms: Date.now() - started,
      toolCalls: res.content.filter((c) => c.type === "tool_use").map((c: any) => ({ name: c.name, input: c.input })),
    });
    return res;
  } catch (e) {
    logEvent(milestoneId, "ai", "model_error", { task, error: (e as Error).message });
    throw e;
  }
}

export function toInputSchema(schema: z.ZodType): Record<string, unknown> {
  const { $schema, ...rest } = z.toJSONSchema(schema, { io: "input", unrepresentable: "any" }) as any;
  return rest;
}

/**
 * Single-shot structured output: the model must call the `respond` tool with input that
 * passes `schema`. One retry on invalid output, then the deterministic fallback.
 */
export async function runAI<T>(opts: {
  milestoneId: string | null;
  task: string;
  system: string;
  prompt: string;
  schema: z.ZodType<T>;
  jsonSchema?: Record<string, unknown>;
  fallback: () => T;
}): Promise<{ data: T; source: "ai" | "fallback"; issues?: string }> {
  const fallback = (why: string) => {
    logEvent(opts.milestoneId, "ai", "ai_fallback", { task: opts.task, reason: why });
    return { data: opts.fallback(), source: "fallback" as const, issues: why };
  };
  if (!llmConfigured()) return fallback("no LLM configured");
  const tool: ToolDef = { name: "respond", description: "Return your answer.", input_schema: opts.jsonSchema ?? toInputSchema(opts.schema) };
  const messages: Message[] = [{ role: "user", content: opts.prompt }];
  let lastIssue = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    let res: ModelResponse;
    try {
      res = await callModel(opts.milestoneId, opts.task, { system: opts.system, messages, tools: [tool], toolChoice: { type: "tool", name: "respond" } });
    } catch (e) {
      return fallback(`model error: ${(e as Error).message}`);
    }
    const use = res.content.find((c) => c.type === "tool_use") as Extract<ContentBlock, { type: "tool_use" }> | undefined;
    const parsed = opts.schema.safeParse(use?.input);
    if (parsed.success) return { data: parsed.data, source: "ai" };
    lastIssue = use ? JSON.stringify(parsed.error.issues).slice(0, 1500) : "no tool call";
    logEvent(opts.milestoneId, "ai", "ai_invalid_output", { task: opts.task, attempt, issues: lastIssue });
    if (use) {
      messages.push({ role: "assistant", content: res.content });
      messages.push({ role: "user", content: [{ type: "tool_result", tool_use_id: use.id, is_error: true, content: `Invalid output. Fix these issues and call respond again: ${lastIssue}` }] });
    }
  }
  return fallback(`invalid output after retry: ${lastIssue}`);
}

/** Wrap text from a submitted site so the model treats it as data, never instructions. */
export function untrusted(text: string): string {
  const clean = text.replace(/<\/?untrusted_page_data>/gi, "");
  return `<untrusted_page_data>\n${clean}\n</untrusted_page_data>`;
}
