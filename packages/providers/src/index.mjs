const PROVIDERS = Object.freeze({
  openai: { endpoint: "https://api.openai.com/v1/chat/completions", header: "authorization" },
  nvidia: { endpoint: "https://integrate.api.nvidia.com/v1/chat/completions", header: "authorization" },
  anthropic: { endpoint: "https://api.anthropic.com/v1/messages", header: "x-api-key" }
});

export function providerDefinition(id) {
  const definition = PROVIDERS[id];
  if (!definition) throw new Error(`Unsupported provider: ${String(id)}`);
  return definition;
}

export function boundedConversationMessages(messages, { maxMessages = 24, maxCharacters = 18_000 } = {}) {
  const normalized = (Array.isArray(messages) ? messages : [])
    .filter((item) => item?.role === "user" || item?.role === "assistant")
    .map((item) => ({ role: item.role, content: String(item.content ?? "").trim().slice(0, 12_000) }))
    .filter((item) => item.content);
  const selected = [];
  let characters = 0;
  for (let index = normalized.length - 1; index >= 0 && selected.length < maxMessages; index -= 1) {
    const item = normalized[index];
    const remaining = maxCharacters - characters;
    if (remaining <= 0) break;
    if (item.content.length > remaining) {
      if (!selected.length) selected.unshift({ ...item, content: item.content.slice(0, remaining) });
      break;
    }
    selected.unshift(item);
    characters += item.content.length;
  }
  while (selected[0]?.role === "assistant") selected.shift();
  return selected;
}

export function buildProviderRequest({ provider, model, messages, prompt, key }) {
  const definition = providerDefinition(provider);
  const headers = { "content-type": "application/json" };
  const conversation = boundedConversationMessages(messages?.length ? messages : [{ role: "user", content: prompt }]);
  if (!conversation.length) throw new Error("A provider request requires at least one user message");
  if (provider === "anthropic") {
    headers[definition.header] = key;
    headers["anthropic-version"] = "2023-06-01";
    return {
      url: definition.endpoint,
      init: { method: "POST", headers, body: JSON.stringify({ model, max_tokens: 900, stream: true, system: systemPrompt(), messages: conversation }) }
    };
  }
  headers[definition.header] = `Bearer ${key}`;
  return {
    url: definition.endpoint,
    init: { method: "POST", headers, body: JSON.stringify({ model, stream: true, temperature: 0.2, messages: [{ role: "system", content: systemPrompt() }, ...conversation] }) }
  };
}

function systemPrompt() {
  return "You are Clarity, a concise meeting copilot. Use only supplied context, call out uncertainty, never invent quotes, and prefer decisions, owners, and next steps. Do not claim to be invisible or undetectable.";
}

export function parseServerSentEvent(provider, eventText) {
  const data = eventText.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).join("\n");
  if (!data || data === "[DONE]") return { done: data === "[DONE]", text: "" };
  const parsed = JSON.parse(data);
  if (provider === "anthropic") {
    return { done: parsed.type === "message_stop", text: parsed.type === "content_block_delta" ? parsed.delta?.text ?? "" : "" };
  }
  return { done: false, text: parsed.choices?.[0]?.delta?.content ?? "" };
}

export async function streamProviderResponse(options) {
  const { provider, signal, onToken = () => {} } = options;
  const { url, init } = buildProviderRequest(options);
  const response = await fetch(url, { ...init, signal });
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 500).replace(/(?:sk|nvapi)-[A-Za-z0-9_-]+/g, "[redacted]");
    throw new Error(`${provider} returned ${response.status}${detail ? `: ${detail}` : ""}`);
  }
  if (!response.body) throw new Error(`${provider} returned an empty response`);
  const decoder = new TextDecoder();
  let buffer = "";
  let result = "";
  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true }).replaceAll("\r\n", "\n");
    let boundary;
    while ((boundary = buffer.indexOf("\n\n")) >= 0) {
      const rawEvent = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const event = parseServerSentEvent(provider, rawEvent);
      if (event.text) { result += event.text; onToken(event.text, result); }
      if (event.done) return result;
    }
  }
  return result;
}
