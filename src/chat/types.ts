import type { Env } from "../env";

export type ChatRole = "system" | "user" | "assistant" | "tool";

export interface ChatMessage {
  role: ChatRole;
  /** 文本消息为 string；多模态等场景可能为数组 */
  content: string | unknown[];
  [key: string]: unknown;
}

export interface ResponseFormat {
  type: string;
  json_schema?: unknown;
}

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  stream?: boolean;
  tools?: unknown[];
  tool_choice?: unknown;
  response_format?: ResponseFormat;
  /** 其余 OpenAI 字段原样透传 */
  [key: string]: unknown;
}

export type ChatResponse = Record<string, unknown>;

export interface Capabilities {
  systemPrompt: boolean;
  tools: boolean;
  jsonObject: boolean;
  jsonSchema: boolean;
}

export interface ChatProvider {
  id: string;
  capabilities: Capabilities;
  chat(req: ChatRequest, env: Env, signal: AbortSignal): Promise<ChatResponse>;
}
