import { describe, expect, it } from "vitest";
import { boundedConversationMessages, buildProviderRequest, parseServerSentEvent } from "./index.mjs";

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
