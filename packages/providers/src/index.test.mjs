import { describe, expect, it, vi } from "vitest";
import {
  boundedConversationMessages,
  buildProviderRequest,
  curatedModels,
  listModels,
  parseServerSentEvent,
  ProviderError,
  serializeProviderError,
  testConnection
} from "./index.mjs";

describe("provider adapters", () => {
  it("builds an Anthropic streaming request without leaking the key into the body", () => {
    const request = buildProviderRequest({
      provider: "anthropic",
      model: "claude",
      messages: [{ role: "user", content: "hello" }, { role: "assistant", content: "Hi" }, { role: "user", content: "build on that" }],
      key: "secret-key"
    });
    expect(request.init.headers["x-api-key"]).toBe("secret-key");
    expect(request.init.body).not.toContain("secret-key");
    expect(JSON.parse(request.init.body)).toMatchObject({
      stream: true,
      messages: [
        { role: "user", content: "hello" },
        { role: "assistant", content: "Hi" },
        { role: "user", content: "build on that" }
      ]
    });
  });

  it("sends prior turns to OpenAI-compatible providers", () => {
    const request = buildProviderRequest({
      provider: "nvidia",
      model: "model",
      messages: [{ role: "user", content: "first" }, { role: "assistant", content: "answer" }, { role: "user", content: "follow up" }],
      key: "nvapi-test"
    });
    expect(JSON.parse(request.init.body).messages.slice(1)).toEqual([
      { role: "user", content: "first" },
      { role: "assistant", content: "answer" },
      { role: "user", content: "follow up" }
    ]);
  });

  it("bounds context from the newest turns without starting on an assistant message", () => {
    const messages = [
      { role: "user", content: "old question" },
      { role: "assistant", content: "old answer" },
      { role: "user", content: "new question" }
    ];
    expect(boundedConversationMessages(messages, { maxMessages: 2, maxCharacters: 100 })).toEqual([
      { role: "user", content: "new question" }
    ]);
  });

  it("truncates an oversized newest user message to the character budget", () => {
    expect(boundedConversationMessages([{ role: "user", content: "abcdefghij" }], { maxMessages: 24, maxCharacters: 6 })).toEqual([
      { role: "user", content: "abcdef" }
    ]);
  });

  it("rejects histories that contain no usable user turn", () => {
    expect(boundedConversationMessages([{ role: "assistant", content: "orphaned" }])).toEqual([]);
    expect(() => buildProviderRequest({ provider: "openai", model: "model", messages: [{ role: "assistant", content: "orphaned" }], key: "key" })).toThrow("at least one user message");
  });

  it("parses OpenAI-compatible and Anthropic tokens", () => {
    expect(parseServerSentEvent("openai", 'data: {"choices":[{"delta":{"content":"Hi"}}]}').text).toBe("Hi");
    expect(parseServerSentEvent("anthropic", 'data: {"type":"content_block_delta","delta":{"text":"There"}}').text).toBe("There");
  });
});

describe("provider capabilities", () => {
  it("ships multiple curated NVIDIA chat models", () => {
    expect(curatedModels("nvidia").map((model) => model.id)).toEqual([
      "deepseek-ai/deepseek-v4-flash",
      "openai/gpt-oss-20b",
      "z-ai/glm-5.2",
      "nvidia/nemotron-3-nano-30b-a3b",
      "meta/llama-3.1-8b-instruct"
    ]);
  });

  it("discovers, normalizes, and sorts models without exposing the key", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ data: [{ id: "z/model" }, { id: "a/model" }, { id: "z/model" }, {}] }), { status: 200 }));
    const models = await listModels({ provider: "nvidia", key: "nvapi-secret", fetchImpl });
    expect(models.map((model) => model.id)).toEqual(["a/model", "z/model"]);
    expect(fetchImpl).toHaveBeenCalledWith("https://integrate.api.nvidia.com/v1/models", expect.objectContaining({ method: "GET" }));
    expect(fetchImpl.mock.calls[0][1].headers.authorization).toBe("Bearer nvapi-secret");
  });

  it("verifies the selected model with a tiny non-streaming generation", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: "OK" } }] }), { status: 200 }));
    const result = await testConnection({
      provider: "nvidia",
      model: "meta/llama-3.3-70b-instruct",
      key: "nvapi-secret",
      fetchImpl,
      now: () => new Date("2026-07-19T12:00:00.000Z")
    });
    const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(body).toMatchObject({ model: "meta/llama-3.3-70b-instruct", stream: false, max_tokens: 4 });
    expect(result).toMatchObject({ ok: true, model: "meta/llama-3.3-70b-instruct", testedAt: "2026-07-19T12:00:00.000Z" });
  });

  it("normalizes invalid keys and redacts provider details", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ error: { message: "bad nvapi-supersecret" } }), { status: 401 }));
    await expect(testConnection({ provider: "nvidia", model: "a/model", key: "nvapi-supersecret", fetchImpl })).rejects.toMatchObject({ code: "invalid_key", status: 401 });
    const serialized = serializeProviderError(new ProviderError("leaked nvapi-supersecret", { provider: "nvidia" }), "nvidia");
    expect(serialized.message).toContain("[redacted]");
    expect(serialized.message).not.toContain("supersecret");
  });

  it("reports unsupported discovery as a stable capability error", async () => {
    await expect(listModels({ provider: "anthropic", key: "secret" })).rejects.toMatchObject({ code: "model_discovery_unsupported" });
  });

  it("preserves caller cancellation without relabeling it as a timeout", async () => {
    const abort = new DOMException("Cancelled", "AbortError");
    const fetchImpl = vi.fn(async () => { throw abort; });
    await expect(testConnection({ provider: "nvidia", model: "a/model", key: "nvapi-secret", fetchImpl })).rejects.toBe(abort);
  });
});
