const PROVIDERS = Object.freeze({
  openai: {
    label: "OpenAI",
    endpoint: "https://api.openai.com/v1/chat/completions",
    modelsEndpoint: "https://api.openai.com/v1/models",
    header: "authorization"
  },
  nvidia: {
    label: "NVIDIA NIM",
    endpoint: "https://integrate.api.nvidia.com/v1/chat/completions",
    modelsEndpoint: "https://integrate.api.nvidia.com/v1/models",
    header: "authorization"
  },
  anthropic: {
    label: "Anthropic",
    endpoint: "https://api.anthropic.com/v1/messages",
    modelsEndpoint: null,
    header: "x-api-key"
  }
});

const CURATED_MODELS = Object.freeze({
  nvidia: Object.freeze([
    Object.freeze({ id: "deepseek-ai/deepseek-v4-flash", label: "DeepSeek V4 Flash", description: "#1 Recommended · Best balance" }),
    Object.freeze({ id: "openai/gpt-oss-20b", label: "GPT OSS 20B", description: "#2 Fastest · Reasoning" }),
    Object.freeze({ id: "z-ai/glm-5.2", label: "GLM 5.2", description: "#3 Best quality · Slower" }),
    Object.freeze({ id: "nvidia/nemotron-3-nano-30b-a3b", label: "Nemotron 3 Nano 30B", description: "#4 Fast · NVIDIA" }),
    Object.freeze({ id: "meta/llama-3.1-8b-instruct", label: "Llama 3.1 8B Instruct", description: "#5 Lightweight · Fast" })
  ]),
  openai: Object.freeze([
    Object.freeze({ id: "gpt-4.1-mini", label: "GPT-4.1 mini", description: "Fast" })
  ]),
  anthropic: Object.freeze([
    Object.freeze({ id: "claude-sonnet-4-5", label: "Claude Sonnet", description: "Balanced" })
  ])
});

const SECRET_PATTERN = /(?:sk|nvapi)-[A-Za-z0-9_-]+/g;

export class ProviderError extends Error {
  constructor(message, options = {}) {
    super(message, options.cause ? { cause: options.cause } : undefined);
    this.name = "ProviderError";
    this.code = options.code ?? "provider_error";
    this.provider = options.provider ?? "unknown";
    this.status = options.status ?? null;
    this.retryable = Boolean(options.retryable);
  }
}

export function providerDefinition(id) {
  const definition = PROVIDERS[id];
  if (!definition) throw new ProviderError(`Unsupported provider: ${String(id)}`, { code: "unsupported_provider", provider: String(id) });
  return definition;
}

export function curatedModels(provider) {
  providerDefinition(provider);
  return (CURATED_MODELS[provider] ?? []).map((model) => ({ ...model, source: "curated" }));
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

function providerHeaders(provider, key) {
  const definition = providerDefinition(provider);
  const headers = { "content-type": "application/json" };
  if (provider === "anthropic") {
    headers[definition.header] = key;
    headers["anthropic-version"] = "2023-06-01";
  } else {
    headers[definition.header] = `Bearer ${key}`;
  }
  return headers;
}

export function buildProviderRequest({ provider, model, messages = [], prompt = "", systemPrompt, key, stream = true, maxTokens = 900 }) {
  const definition = providerDefinition(provider);
  if (typeof systemPrompt !== "string" || !systemPrompt.trim()) throw new TypeError("A system prompt is required");
  const headers = providerHeaders(provider, key);
  const conversation = boundedConversationMessages(messages?.length ? messages : [{ role: "user", content: prompt }]);
  if (!conversation.length) throw new Error("A provider request requires at least one user message");
  if (provider === "anthropic") {
    return {
      url: definition.endpoint,
      init: { method: "POST", headers, body: JSON.stringify({ model, max_tokens: maxTokens, stream, system: systemPrompt, messages: conversation }) }
    };
  }
  return {
    url: definition.endpoint,
    init: { method: "POST", headers, body: JSON.stringify({ model, stream, max_tokens: maxTokens, temperature: stream ? 0.2 : 0, messages: [{ role: "system", content: systemPrompt }, ...conversation] }) }
  };
}

function redact(value) {
  return String(value ?? "").replace(SECRET_PATTERN, "[redacted]").slice(0, 500);
}

function responseDetail(text) {
  const safe = redact(text);
  try {
    const parsed = JSON.parse(safe);
    return redact(parsed?.error?.message ?? parsed?.message ?? safe);
  } catch {
    return safe;
  }
}

function errorFromResponse(provider, status, detail) {
  const definition = providerDefinition(provider);
  const normalizedDetail = responseDetail(detail);
  if (status === 401) {
    return new ProviderError(`${definition.label} rejected this API key. Save a valid key and try again.`, { code: "invalid_key", provider, status });
  }
  if (status === 403) {
    return new ProviderError(`${definition.label} does not allow this key to use the selected model. Check account access or choose another model.`, { code: "permission_denied", provider, status });
  }
  if (status === 404 || /model.+(?:not found|does not exist|unavailable)/i.test(normalizedDetail)) {
    return new ProviderError("The selected model is unavailable. Refresh models or choose another model.", { code: "model_unavailable", provider, status });
  }
  if (status === 429) {
    return new ProviderError(`${definition.label} rate-limited this request. Wait for the quota to reset or choose another model.`, { code: "rate_limited", provider, status, retryable: true });
  }
  if (status >= 500) {
    return new ProviderError(`${definition.label} is temporarily unavailable. Try again.`, { code: "provider_unavailable", provider, status, retryable: true });
  }
  return new ProviderError(`${definition.label} returned ${status}${normalizedDetail ? `: ${normalizedDetail}` : ""}`, { code: "bad_request", provider, status });
}

export function normalizeProviderError(error, provider = "unknown") {
  if (error instanceof ProviderError) return error;
  const definition = PROVIDERS[provider];
  const label = definition?.label ?? "The provider";
  if (error?.name === "AbortError" || error?.name === "TimeoutError") {
    return new ProviderError(`${label} did not respond before the connection test timed out.`, { code: "timeout", provider, retryable: true, cause: error });
  }
  if (error instanceof TypeError) {
    return new ProviderError(`${label} could not be reached. Check your internet connection and try again.`, { code: "network_error", provider, retryable: true, cause: error });
  }
  return new ProviderError(redact(error?.message ?? error ?? "Provider request failed"), { code: "provider_error", provider, cause: error });
}

export function serializeProviderError(error, provider = "unknown") {
  const normalized = normalizeProviderError(error, provider);
  return {
    code: normalized.code,
    message: redact(normalized.message),
    provider: normalized.provider,
    status: normalized.status,
    retryable: normalized.retryable
  };
}

async function providerFetch(provider, url, init, fetchImpl) {
  let response;
  try {
    response = await fetchImpl(url, init);
  } catch (error) {
    if (error?.name === "AbortError") throw error;
    throw normalizeProviderError(error, provider);
  }
  if (!response.ok) throw errorFromResponse(provider, response.status, await response.text());
  return response;
}

function withTimeout(signal, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new DOMException("Timed out", "TimeoutError")), timeoutMs);
  const abort = () => controller.abort(signal?.reason);
  if (signal?.aborted) abort();
  signal?.addEventListener("abort", abort, { once: true });
  return {
    signal: controller.signal,
    cleanup() {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
    }
  };
}

export async function listModels({ provider, key, signal, fetchImpl = fetch, timeoutMs = 10_000 }) {
  const definition = providerDefinition(provider);
  if (!definition.modelsEndpoint) {
    throw new ProviderError(`${definition.label} does not expose model discovery through this adapter.`, { code: "model_discovery_unsupported", provider });
  }
  const timed = withTimeout(signal, timeoutMs);
  try {
    const response = await providerFetch(provider, definition.modelsEndpoint, { method: "GET", headers: providerHeaders(provider, key), signal: timed.signal }, fetchImpl);
    let payload;
    try { payload = await response.json(); }
    catch (error) { throw new ProviderError(`${definition.label} returned an invalid model list.`, { code: "invalid_response", provider, cause: error }); }
    const ids = Array.isArray(payload?.data)
      ? payload.data.map((model) => typeof model === "string" ? model : model?.id)
      : Array.isArray(payload?.models) ? payload.models.map((model) => typeof model === "string" ? model : model?.id) : [];
    return [...new Set(ids.filter((id) => typeof id === "string" && id.trim()).map((id) => id.trim()))]
      .sort((left, right) => left.localeCompare(right))
      .map((id) => ({ id, label: id, description: "Discovered", source: "discovered" }));
  } finally {
    timed.cleanup();
  }
}

export async function testConnection({ provider, model, key, signal, fetchImpl = fetch, timeoutMs = 15_000, now = () => new Date() }) {
  const definition = providerDefinition(provider);
  const selectedModel = String(model ?? "").trim();
  if (!selectedModel) throw new ProviderError("Choose a model before testing the connection.", { code: "model_required", provider });
  const request = buildProviderRequest({
    provider,
    model: selectedModel,
    prompt: "Reply only with OK.",
    systemPrompt: "You are testing a provider connection. Follow the user instruction exactly.",
    key,
    stream: false,
    maxTokens: 4
  });
  const timed = withTimeout(signal, timeoutMs);
  const startedAt = Date.now();
  try {
    const response = await providerFetch(provider, request.url, { ...request.init, signal: timed.signal }, fetchImpl);
    let payload;
    try { payload = await response.json(); }
    catch (error) { throw new ProviderError(`${definition.label} returned an invalid test response.`, { code: "invalid_response", provider, cause: error }); }
    const valid = provider === "anthropic"
      ? Array.isArray(payload?.content) && payload.content.length > 0
      : Array.isArray(payload?.choices) && payload.choices.length > 0;
    if (!valid) throw new ProviderError(`${definition.label} returned an unexpected test response.`, { code: "invalid_response", provider });
    return {
      ok: true,
      provider,
      model: selectedModel,
      testedAt: now().toISOString(),
      latencyMs: Math.max(0, Date.now() - startedAt)
    };
  } finally {
    timed.cleanup();
  }
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
  const { provider, signal, onToken = () => {}, fetchImpl = fetch } = options;
  const { url, init } = buildProviderRequest(options);
  const response = await providerFetch(provider, url, { ...init, signal }, fetchImpl);
  if (!response.body) throw new ProviderError(`${providerDefinition(provider).label} returned an empty response.`, { code: "empty_response", provider });
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
