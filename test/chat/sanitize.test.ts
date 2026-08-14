import { describe, expect, it } from "vitest";
import { mergeSystem, sanitizeRequest } from "../../src/chat/sanitize";
import type { Capabilities, ChatRequest } from "../../src/chat/types";

const ALL: Capabilities = { systemPrompt: true, tools: true, jsonObject: true, jsonSchema: true };
const NONE: Capabilities = { systemPrompt: false, tools: false, jsonObject: false, jsonSchema: false };

describe("sanitizeRequest", () => {
  it("removes tools and tool_choice when tools not supported", () => {
    const req: ChatRequest = {
      model: "m",
      messages: [{ role: "user", content: "hi" }],
      tools: [{ type: "function", function: { name: "f" } }],
      tool_choice: "auto",
    };
    const out = sanitizeRequest(req, { ...ALL, tools: false });
    expect(out.tools).toBeUndefined();
    expect(out.tool_choice).toBeUndefined();
    expect(req.tools).toHaveLength(1); // 入参未被修改
  });

  it("keeps tools when supported", () => {
    const req: ChatRequest = {
      model: "m",
      messages: [{ role: "user", content: "hi" }],
      tools: [{ type: "function" }],
      tool_choice: "auto",
    };
    const out = sanitizeRequest(req, ALL);
    expect(out.tools).toEqual([{ type: "function" }]);
    expect(out.tool_choice).toBe("auto");
  });

  it("removes response_format json_object when not supported", () => {
    const req: ChatRequest = {
      model: "m",
      messages: [],
      response_format: { type: "json_object" },
    };
    expect(sanitizeRequest(req, { ...ALL, jsonObject: false }).response_format).toBeUndefined();
  });

  it("downgrades json_schema to json_object when only json_object supported", () => {
    const req: ChatRequest = {
      model: "m",
      messages: [],
      response_format: { type: "json_schema", json_schema: { name: "s" } },
    };
    const out = sanitizeRequest(req, { ...ALL, jsonSchema: false });
    expect(out.response_format).toEqual({ type: "json_object" });
  });

  it("removes json_schema when neither format supported", () => {
    const req: ChatRequest = {
      model: "m",
      messages: [],
      response_format: { type: "json_schema" },
    };
    const out = sanitizeRequest(req, { ...ALL, jsonSchema: false, jsonObject: false });
    expect(out.response_format).toBeUndefined();
  });

  it("keeps json_schema untouched when supported", () => {
    const rf = { type: "json_schema", json_schema: { name: "s" } };
    const req: ChatRequest = { model: "m", messages: [], response_format: rf };
    expect(sanitizeRequest(req, ALL).response_format).toEqual(rf);
  });

  it("keeps response_format type text regardless of capabilities", () => {
    const req: ChatRequest = { model: "m", messages: [], response_format: { type: "text" } };
    expect(sanitizeRequest(req, NONE).response_format).toEqual({ type: "text" });
  });

  it("merges system into first user message when systemPrompt not supported", () => {
    const req: ChatRequest = {
      model: "m",
      messages: [
        { role: "system", content: "be brief" },
        { role: "user", content: "hi" },
      ],
    };
    const out = sanitizeRequest(req, { ...ALL, systemPrompt: false });
    expect(out.messages).toEqual([{ role: "user", content: "be brief\nhi" }]);
  });
});

describe("mergeSystem", () => {
  it("merges all system messages into the first user message in original order", () => {
    const out = mergeSystem([
      { role: "system", content: "s1" },
      { role: "user", content: "hello" },
      { role: "system", content: "s2" },
    ]);
    expect(out).toEqual([{ role: "user", content: "s1\ns2\nhello" }]);
  });

  it("returns messages unchanged when no system message", () => {
    const msgs = [{ role: "user" as const, content: "hi" }];
    expect(mergeSystem(msgs)).toEqual(msgs);
  });

  it("inserts a new user message when no user message exists", () => {
    const out = mergeSystem([
      { role: "system", content: "s1" },
      { role: "assistant", content: "a" },
    ]);
    expect(out).toEqual([
      { role: "user", content: "s1" },
      { role: "assistant", content: "a" },
    ]);
  });

  it("inserts a new user message when first user content is not a string", () => {
    const out = mergeSystem([
      { role: "system", content: "s1" },
      { role: "user", content: [{ type: "text", text: "image caption" }] },
    ]);
    expect(out[0]).toEqual({ role: "user", content: "s1" });
    expect(out[1]?.content).toEqual([{ type: "text", text: "image caption" }]);
  });
});
