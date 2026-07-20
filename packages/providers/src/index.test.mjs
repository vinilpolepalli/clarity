import { describe, expect, it } from "vitest";
import { buildProviderRequest, parseServerSentEvent } from "./index.mjs";

describe("provider adapters", () => {
  it("builds an Anthropic streaming request without leaking the key into the body", () => {
    const request = buildProviderRequest({ provider: "anthropic", model: "claude", prompt: "hello", systemPrompt: "coding mode", key: "secret-key" });
    expect(request.init.headers["x-api-key"]).toBe("secret-key");
    expect(request.init.body).not.toContain("secret-key");
    expect(JSON.parse(request.init.body)).toMatchObject({ stream: true, system: "coding mode" });
  });

  it("places the supplied prompt in an OpenAI-compatible system message", () => {
    const request = buildProviderRequest({ provider: "openai", model: "gpt", prompt: "hello", systemPrompt: "sales mode", key: "secret-key" });
    const body = JSON.parse(request.init.body);
    expect(body.messages[0]).toEqual({ role: "system", content: "sales mode" });
    expect(body.messages[1]).toEqual({ role: "user", content: "hello" });
    expect(request.init.body).not.toContain("secret-key");
  });

  it("rejects a blank system prompt before building a request", () => {
    expect(() => buildProviderRequest({ provider: "openai", model: "gpt", prompt: "hello", systemPrompt: " ", key: "secret-key" })).toThrow("system prompt is required");
  });

  it("parses OpenAI-compatible and Anthropic tokens", () => {
    expect(parseServerSentEvent("openai", 'data: {"choices":[{"delta":{"content":"Hi"}}]}').text).toBe("Hi");
    expect(parseServerSentEvent("anthropic", 'data: {"type":"content_block_delta","delta":{"text":"There"}}').text).toBe("There");
  });
});
