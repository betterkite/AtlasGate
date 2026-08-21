import { estimateTokens, id } from "../core/utils.js";

function textFromBlocks(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => part?.text ?? part?.input_text ?? part?.output_text ?? "").join("\n");
}

function normalizeContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return content ?? "";
  return content.map((part) => {
    if (part.type === "input_text" || part.type === "output_text") return { type: "text", text: part.text ?? "" };
    if (part.type === "input_image") return { type: "image_url", image_url: { url: part.image_url ?? part.url ?? "" } };
    if (part.type === "image" && part.source?.type === "base64") {
      return { type: "image_url", image_url: { url: `data:${part.source.media_type};base64,${part.source.data}` } };
    }
    return part;
  });
}

export function fromOpenAIChat(body) {
  return {
    protocol: "openai_chat",
    model: body.model ?? "auto",
    messages: (body.messages ?? []).map((message) => ({ ...message, content: normalizeContent(message.content) })),
    tools: body.tools ?? [], tool_choice: body.tool_choice,
    temperature: body.temperature, max_tokens: body.max_tokens ?? body.max_completion_tokens,
    stream: body.stream === true,
    metadata: body.metadata ?? {},
  };
}

export function fromResponses(body) {
  const items = typeof body.input === "string" ? [{ role: "user", content: body.input }] : (body.input ?? []);
  const messages = items.filter((item) => item?.role).map((item) => ({
    role: item.role,
    content: normalizeContent(item.content),
  }));
  if (body.instructions) messages.unshift({ role: "system", content: body.instructions });
  return {
    protocol: "openai_responses", model: body.model ?? "auto", messages,
    tools: body.tools ?? [], tool_choice: body.tool_choice,
    temperature: body.temperature, max_tokens: body.max_output_tokens,
    stream: body.stream === true, metadata: body.metadata ?? {},
  };
}

export function fromAnthropic(body) {
  const messages = (body.messages ?? []).map((message) => ({ ...message, content: normalizeContent(message.content) }));
  if (body.system) messages.unshift({ role: "system", content: textFromBlocks(body.system) });
  return {
    protocol: "anthropic_messages", model: body.model ?? "auto", messages,
    tools: (body.tools ?? []).map((tool) => ({
      type: "function", function: { name: tool.name, description: tool.description, parameters: tool.input_schema ?? { type: "object" } },
    })),
    tool_choice: body.tool_choice, temperature: body.temperature, max_tokens: body.max_tokens,
    stream: body.stream === true, metadata: body.metadata ?? {},
  };
}

export function toOpenAIRequest(request, model) {
  return compact({
    model,
    messages: request.messages.map((message) => ({ ...message, content: normalizeContent(message.content) })),
    tools: request.tools?.length ? request.tools : undefined,
    tool_choice: request.tool_choice,
    temperature: request.temperature,
    max_tokens: request.max_tokens,
    stream: false,
  });
}

export function toAnthropicRequest(request, model) {
  const system = request.messages.filter((message) => message.role === "system").map((message) => textFromBlocks(message.content)).join("\n\n");
  const messages = request.messages.filter((message) => message.role !== "system").map((message) => ({
    role: message.role === "tool" ? "user" : message.role,
    content: typeof message.content === "string" ? message.content : message.content.map((part) => {
      if (part.type === "image_url" && part.image_url?.url?.startsWith("data:")) {
        const match = part.image_url.url.match(/^data:([^;]+);base64,(.+)$/s);
        if (match) return { type: "image", source: { type: "base64", media_type: match[1], data: match[2] } };
      }
      return part.type === "text" ? part : { type: "text", text: textFromBlocks([part]) };
    }),
  }));
  return compact({
    model, system: system || undefined, messages,
    tools: request.tools?.map((tool) => ({
      name: tool.function?.name ?? tool.name,
      description: tool.function?.description ?? tool.description,
      input_schema: tool.function?.parameters ?? tool.input_schema ?? { type: "object" },
    })),
    temperature: request.temperature, max_tokens: request.max_tokens ?? 1024, stream: false,
  });
}

export function anthropicToChat(payload, model, requestId) {
  const blocks = payload.content ?? [];
  const text = blocks.filter((block) => block.type === "text").map((block) => block.text).join("\n");
  const toolCalls = blocks.filter((block) => block.type === "tool_use").map((block) => ({
    id: block.id, type: "function", function: { name: block.name, arguments: JSON.stringify(block.input ?? {}) },
  }));
  const message = { role: "assistant", content: text || null };
  if (toolCalls.length) message.tool_calls = toolCalls;
  const input = payload.usage?.input_tokens ?? 0;
  const output = payload.usage?.output_tokens ?? estimateTokens(text);
  return {
    id: `chatcmpl-${requestId}`, object: "chat.completion", created: Math.floor(Date.now() / 1000), model,
    choices: [{ index: 0, message, finish_reason: payload.stop_reason === "tool_use" ? "tool_calls" : "stop" }],
    usage: { prompt_tokens: input, completion_tokens: output, total_tokens: input + output },
  };
}

export function chatToAnthropic(payload) {
  const message = payload.choices?.[0]?.message ?? {};
  const content = [];
  if (message.content) content.push({ type: "text", text: message.content });
  for (const call of message.tool_calls ?? []) {
    let input = {};
    try { input = JSON.parse(call.function?.arguments ?? "{}"); } catch { input = { raw: call.function?.arguments ?? "" }; }
    content.push({ type: "tool_use", id: call.id ?? id("toolu"), name: call.function?.name ?? "tool", input });
  }
  return {
    id: payload.id?.replace(/^chatcmpl-/, "msg_") ?? id("msg"), type: "message", role: "assistant",
    model: payload.model, content, stop_reason: message.tool_calls?.length ? "tool_use" : "end_turn", stop_sequence: null,
    usage: { input_tokens: payload.usage?.prompt_tokens ?? 0, output_tokens: payload.usage?.completion_tokens ?? 0 },
  };
}

export function chatToResponse(payload) {
  const message = payload.choices?.[0]?.message ?? {};
  const output = [{
    id: id("msg"), type: "message", status: "completed", role: "assistant",
    content: [{ type: "output_text", text: message.content ?? "", annotations: [] }],
  }];
  for (const call of message.tool_calls ?? []) output.push({
    id: call.id ?? id("call"), type: "function_call", status: "completed",
    name: call.function?.name, arguments: call.function?.arguments ?? "{}",
  });
  return {
    id: payload.id?.replace(/^chatcmpl-/, "resp_") ?? id("resp"), object: "response",
    created_at: payload.created, status: "completed", model: payload.model, output,
    output_text: message.content ?? "",
    usage: {
      input_tokens: payload.usage?.prompt_tokens ?? 0,
      output_tokens: payload.usage?.completion_tokens ?? 0,
      total_tokens: payload.usage?.total_tokens ?? 0,
    },
  };
}

export function responseText(payload) {
  return payload.choices?.[0]?.message?.content ?? "";
}

function compact(value) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}
