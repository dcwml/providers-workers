import type { Capabilities, ChatMessage, ChatRequest, ResponseFormat } from "./types";

function adjustResponseFormat(
  rf: ResponseFormat,
  caps: Capabilities,
): ResponseFormat | undefined {
  if (rf.type === "json_schema") {
    if (caps.jsonSchema) return rf;
    if (caps.jsonObject) return { type: "json_object" };
    return undefined;
  }
  if (rf.type === "json_object") {
    return caps.jsonObject ? rf : undefined;
  }
  return rf; // "text" 等其它类型不受能力开关约束
}

/**
 * 把所有 system 消息按原顺序拼接，合并进第一条 user 消息；
 * 无 user 消息（或首条 user 的 content 不是字符串）时，作为新的第一条 user 消息插入。
 */
export function mergeSystem(messages: ChatMessage[]): ChatMessage[] {
  const systems = messages.filter((m) => m.role === "system");
  if (systems.length === 0) return messages;

  const systemText = systems
    .map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)))
    .join("\n");
  const rest = messages.filter((m) => m.role !== "system");
  const firstUser = rest.find((m) => m.role === "user");

  if (firstUser && typeof firstUser.content === "string") {
    return rest.map((m) =>
      m === firstUser ? { ...m, content: `${systemText}\n${firstUser.content}` } : m,
    );
  }
  return [{ role: "user", content: systemText }, ...rest];
}

/** 按供应商能力裁剪 OpenAI 请求；不修改入参。 */
export function sanitizeRequest(req: ChatRequest, caps: Capabilities): ChatRequest {
  const out = structuredClone(req);

  if (!caps.tools) {
    delete out.tools;
    delete out.tool_choice;
  }

  if (out.response_format !== undefined) {
    const adjusted = adjustResponseFormat(out.response_format, caps);
    if (adjusted === undefined) delete out.response_format;
    else out.response_format = adjusted;
  }

  if (!caps.systemPrompt) {
    out.messages = mergeSystem(out.messages);
  }

  return out;
}
