/**
 * Gemini adapter: request translation, forced function calling, thoughtSignature round-trip,
 * rate-limit retry and the OpenAPI-schema fallback, all against a local fake Gemini server.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { initDb } from "../src/db/migrate.ts";
import { callModel, runAI, setModelCaller, toGeminiSchema, toInputSchema } from "../src/ai/engine.ts";

let server: http.Server;
let bodies: any[] = [];
let script: Array<(body: any) => { status: number; json: any }> = [];

beforeAll(async () => {
  initDb(":memory:");
  setModelCaller(null);
  const handler: http.RequestListener = (req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = JSON.parse(raw);
      bodies.push({ url: req.url, key: req.headers["x-goog-api-key"], body });
      const next = script.shift() ?? (() => ({ status: 500, json: { error: "no script" } }));
      const out = next(body);
      res.writeHead(out.status, { "content-type": "application/json" }).end(JSON.stringify(out.json));
    });
  };
  server = http.createServer(handler);
  await new Promise<void>((r) => server.listen(0, r));
  process.env.LLM_PROVIDER = "gemini";
  process.env.LLM_GEMINI_API = "generatecontent";
  process.env.LLM_API_KEY = "test-key";
  process.env.LLM_MODEL = "gemini-test";
  process.env.LLM_BASE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  for (const k of ["LLM_PROVIDER", "LLM_GEMINI_API", "LLM_API_KEY", "LLM_MODEL", "LLM_BASE_URL"]) delete process.env[k];
  await new Promise<void>((r) => server.close(() => r()));
});
beforeEach(() => {
  bodies = [];
  script = [];
});

const call = (name: string, args: any, extra: any = {}) => ({
  status: 200,
  json: { candidates: [{ content: { role: "model", parts: [{ functionCall: { name, args }, ...extra }] }, finishReason: "STOP" }] },
});

describe("gemini generateContent adapter", () => {
  it("runAI forces the respond tool and parses the function call", async () => {
    script.push(() => call("respond", { n: 3 }));
    const out = await runAI({ milestoneId: null, task: "t", system: "sys", prompt: "hello", schema: z.object({ n: z.number() }), fallback: () => ({ n: 0 }) });
    expect(out).toEqual({ data: { n: 3 }, source: "ai" });
    const { url, key, body } = bodies[0];
    expect(url).toBe("/v1beta/models/gemini-test:generateContent");
    expect(key).toBe("test-key");
    expect(body.systemInstruction.parts[0].text).toBe("sys");
    expect(body.contents).toEqual([{ role: "user", parts: [{ text: "hello" }] }]);
    expect(body.toolConfig.functionCallingConfig).toEqual({ mode: "ANY", allowedFunctionNames: ["respond"] });
    expect(body.tools[0].functionDeclarations[0].name).toBe("respond");
    expect(body.tools[0].functionDeclarations[0].parametersJsonSchema.properties.n.type).toBe("number");
  });

  it("invalid output is retried with a functionResponse, then falls back", async () => {
    script.push(() => call("respond", { n: "x" }), () => call("respond", { n: "y" }));
    const out = await runAI({ milestoneId: null, task: "t", system: "s", prompt: "p", schema: z.object({ n: z.number() }), fallback: () => ({ n: 0 }) });
    expect(out.source).toBe("fallback");
    const retry = bodies[1].body.contents;
    expect(retry[1]).toEqual({ role: "model", parts: [{ functionCall: { name: "respond", args: { n: "x" } } }] });
    expect(retry[2].parts[0].functionResponse.name).toBe("respond");
    expect(retry[2].parts[0].functionResponse.response.error).toMatch(/Invalid output/);
  });

  it("returns thoughtSignature with the function call on the next turn", async () => {
    script.push(() => call("open_page", {}, { thoughtSignature: "SIG123" }));
    const first = await callModel(null, "agent", { system: "s", messages: [{ role: "user", content: "go" }], tools: [{ name: "open_page", description: "d", input_schema: { type: "object", properties: {} } }], toolChoice: { type: "any" } });
    const use = first.content[0] as any;
    expect(use).toMatchObject({ type: "tool_use", name: "open_page", signature: "SIG123" });
    expect(first.stopReason).toBe("tool_use");
    script.push(() => call("finish", {}));
    await callModel(null, "agent", {
      system: "s",
      messages: [
        { role: "user", content: "go" },
        { role: "assistant", content: first.content },
        { role: "user", content: [{ type: "tool_result", tool_use_id: use.id, content: "page text" }] },
      ],
      tools: [{ name: "open_page", description: "d", input_schema: { type: "object", properties: {} } }],
      toolChoice: { type: "any" },
    });
    const c = bodies[1].body.contents;
    expect(c[1].parts[0]).toEqual({ functionCall: { name: "open_page", args: {} }, thoughtSignature: "SIG123" });
    expect(c[2].parts[0]).toEqual({ functionResponse: { name: "open_page", response: { result: "page text" } } });
    expect(bodies[1].body.toolConfig.functionCallingConfig).toEqual({ mode: "ANY" });
  });

  it("retries a 429 after the suggested delay", async () => {
    script.push(() => ({ status: 429, json: { error: { details: [{ retryDelay: "0s" }] } } }), () => call("respond", { n: 1 }));
    const out = await runAI({ milestoneId: null, task: "t", system: "s", prompt: "p", schema: z.object({ n: z.number() }), fallback: () => ({ n: 0 }) });
    expect(out.source).toBe("ai");
    expect(bodies).toHaveLength(2);
  });

  it("falls back to the OpenAPI schema subset if parametersJsonSchema is rejected", async () => {
    script.push(() => ({ status: 400, json: { error: { message: "Unknown name \"parametersJsonSchema\"" } } }), () => call("respond", { n: 1 }));
    const out = await runAI({ milestoneId: null, task: "t", system: "s", prompt: "p", schema: z.object({ n: z.number() }), fallback: () => ({ n: 0 }) });
    expect(out.source).toBe("ai");
    const decl = bodies[1].body.tools[0].functionDeclarations[0];
    expect(decl.parametersJsonSchema).toBeUndefined();
    expect(decl.parameters.properties.n.type).toBe("number");
  });

  it("toGeminiSchema strips unsupported keywords", () => {
    const schema = toInputSchema(z.object({ kind: z.literal("a"), tag: z.string().nullable(), list: z.array(z.number()).max(3) }).strict());
    const g = toGeminiSchema(schema);
    expect(JSON.stringify(g)).not.toMatch(/additionalProperties|\$schema|"const"/);
    expect(g.properties.kind.enum).toEqual(["a"]);
    expect(g.properties.list).toMatchObject({ type: "array", maxItems: 3 });
  });
});

const step = (name: string, args: any, withThought = true) => ({
  status: 200,
  json: { status: "requires_action", steps: [...(withThought ? [{ type: "thought", signature: "T1" }] : []), { type: "function_call", id: `call_${name}`, name, arguments: args }] },
});

describe("gemini interactions adapter", () => {
  beforeAll(() => {
    process.env.LLM_GEMINI_API = "interactions";
    process.env.LLM_MODEL = "m-busy,m-ok";
  });

  it("forces respond, sends a step list, parses the function call", async () => {
    script.push(() => step("respond", { n: 7 }));
    const out = await runAI({ milestoneId: null, task: "t", system: "sys", prompt: "hello", schema: z.object({ n: z.number() }), fallback: () => ({ n: 0 }) });
    expect(out).toEqual({ data: { n: 7 }, source: "ai" });
    const { url, key, body } = bodies[0];
    expect(url).toBe("/v1beta/interactions");
    expect(key).toBe("test-key");
    expect(body.model).toBe("m-busy");
    expect(body.system_instruction).toBe("sys");
    expect(body.input).toEqual([{ type: "user_input", content: [{ type: "text", text: "hello" }] }]);
    expect(body.tools[0]).toMatchObject({ type: "function", name: "respond" });
    expect(body.generation_config.tool_choice).toEqual({ allowed_tools: { mode: "any", tools: ["respond"] } });
    expect(body.store).toBe(false);
  });

  it("sends thought steps back before the call, and tool results as function_result", async () => {
    script.push(() => step("open_page", {}));
    const tools = [{ name: "open_page", description: "d", input_schema: { type: "object", properties: {} } }];
    const first = await callModel(null, "agent", { system: "s", messages: [{ role: "user", content: "go" }], tools, toolChoice: { type: "any" } });
    const use = first.content[0] as any;
    expect(use).toMatchObject({ type: "tool_use", id: "call_open_page", name: "open_page", thoughts: [{ type: "thought", signature: "T1" }] });
    script.push(() => step("finish", {}));
    await callModel(null, "agent", {
      system: "s",
      messages: [
        { role: "user", content: "go" },
        { role: "assistant", content: first.content },
        { role: "user", content: [{ type: "tool_result", tool_use_id: use.id, content: "page text", is_error: true }] },
      ],
      tools,
      toolChoice: { type: "any" },
    });
    expect(bodies[1].body.input).toEqual([
      { type: "user_input", content: [{ type: "text", text: "go" }] },
      { type: "thought", signature: "T1" },
      { type: "function_call", id: "call_open_page", name: "open_page", arguments: {} },
      { type: "function_result", call_id: "call_open_page", name: "open_page", result: "page text", is_error: true },
    ]);
    expect(bodies[1].body.generation_config.tool_choice).toBe("any");
  });

  it("moves to the next model when one stays overloaded", async () => {
    const busy = () => ({ status: 503, json: { error: { message: "high demand", code: "service_unavailable" } } });
    script.push(busy, busy, () => step("respond", { n: 1 }, false));
    const out = await runAI({ milestoneId: null, task: "t", system: "s", prompt: "p", schema: z.object({ n: z.number() }), fallback: () => ({ n: 0 }) });
    expect(out.source).toBe("ai");
    expect(bodies.map((b) => b.body.model)).toEqual(["m-busy", "m-busy", "m-ok"]);
  }, 30000);

  it("a 429 quota error skips straight to the next model", async () => {
    script.push(() => ({ status: 429, json: { error: { message: "Rate limit exceeded (limit: 20 requests per day)" } } }), () => step("respond", { n: 2 }, false));
    const out = await runAI({ milestoneId: null, task: "t", system: "s", prompt: "p", schema: z.object({ n: z.number() }), fallback: () => ({ n: 0 }) });
    expect(out.data).toEqual({ n: 2 });
    expect(bodies.map((b) => b.body.model)).toEqual(["m-busy", "m-ok"]);
  });

  it("a 400 is not retried and ends in the fallback", async () => {
    script.push(() => ({ status: 400, json: { error: { message: "bad", code: "invalid_request" } } }));
    const out = await runAI({ milestoneId: null, task: "t", system: "s", prompt: "p", schema: z.object({ n: z.number() }), fallback: () => ({ n: 0 }) });
    expect(out.source).toBe("fallback");
    expect(bodies).toHaveLength(1);
  });
});
