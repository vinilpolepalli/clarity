import { describe, expect, it } from "vitest";
import { buildProviderRequest, parseServerSentEvent } from "./index.mjs";

describe("provider adapters", () => {
  it("builds an Anthropic streaming request without leaking the key into the body", () => {
    const request = buildProviderRequest({ provider: "anthropic", model: "claude", prompt: "hello", key: "secret-key" });
    expect(request.init.headers["x-api-key"]).toBe("secret-key");
    expect(request.init.body).not.toContain("secret-key");
    expect(JSON.parse(request.init.body).stream).toBe(true);
  });

  it("parses OpenAI-compatible and Anthropic tokens", () => {
    expect(parseServerSentEvent("openai", 'data: {"choices":[{"delta":{"content":"Hi"}}]}').text).toBe("Hi");
    expect(parseServerSentEvent("anthropic", 'data: {"type":"content_block_delta","delta":{"text":"There"}}').text).toBe("There");
  });
});
