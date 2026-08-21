import { chatToAnthropic, chatToResponse } from "../services/protocol.js";

function start(res, headers = {}) {
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    ...headers,
  });
}

function words(text) {
  return String(text ?? "").match(/[\s\S]{1,24}/g) ?? [];
}

export function sendOpenAIStream(res, payload, headers = {}) {
  start(res, headers);
  const base = { id: payload.id, object: "chat.completion.chunk", created: payload.created, model: payload.model };
  res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] })}\n\n`);
  for (const content of words(payload.choices?.[0]?.message?.content)) {
    res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { content }, finish_reason: null }] })}\n\n`);
  }
  res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: payload.choices?.[0]?.finish_reason ?? "stop" }], usage: payload.usage })}\n\n`);
  res.end("data: [DONE]\n\n");
}

export function sendAnthropicStream(res, chatPayload, headers = {}) {
  start(res, headers);
  const payload = chatToAnthropic(chatPayload);
  res.write(`event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { ...payload, content: [], stop_reason: null } })}\n\n`);
  res.write(`event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })}\n\n`);
  for (const text of words(payload.content.find((block) => block.type === "text")?.text)) {
    res.write(`event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text } })}\n\n`);
  }
  res.write(`event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: 0 })}\n\n`);
  res.write(`event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: payload.stop_reason, stop_sequence: null }, usage: { output_tokens: payload.usage.output_tokens } })}\n\n`);
  res.end(`event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`);
}

export function sendResponsesStream(res, chatPayload, headers = {}) {
  start(res, headers);
  const payload = chatToResponse(chatPayload);
  res.write(`event: response.created\ndata: ${JSON.stringify({ type: "response.created", response: { ...payload, status: "in_progress", output: [] } })}\n\n`);
  const item = payload.output[0];
  res.write(`event: response.output_item.added\ndata: ${JSON.stringify({ type: "response.output_item.added", output_index: 0, item: { ...item, content: [] } })}\n\n`);
  for (const delta of words(payload.output_text)) res.write(`event: response.output_text.delta\ndata: ${JSON.stringify({ type: "response.output_text.delta", item_id: item.id, output_index: 0, content_index: 0, delta })}\n\n`);
  res.write(`event: response.output_text.done\ndata: ${JSON.stringify({ type: "response.output_text.done", item_id: item.id, output_index: 0, content_index: 0, text: payload.output_text })}\n\n`);
  res.end(`event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: payload })}\n\n`);
}
