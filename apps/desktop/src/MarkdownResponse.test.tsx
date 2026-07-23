import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MarkdownResponse, parseMarkdownBlocks } from "./MarkdownResponse";

describe("MarkdownResponse", () => {
  it("renders fenced source as a code block instead of plain response text", () => {
    const markup = renderToStaticMarkup(<MarkdownResponse text={"# Example\n\n```ts\nconst answer = 42;\n```"} />);

    expect(markup).toContain("<h1");
    expect(markup).toContain("Example");
    expect(markup).toContain('class="markdown-code-block"');
    expect(markup).toContain('data-language="ts"');
    expect(markup).toContain("Copy code");
    expect(markup).toContain('class="code-token is-keyword">const</span> answer = <span class="code-token is-number">42</span>');
  });

  it("keeps common Markdown blocks structured", () => {
    expect(parseMarkdownBlocks("- first\n- second\n\n> quoted\n\n`inline`").map((block) => block.type)).toEqual([
      "unordered-list",
      "quote",
      "paragraph"
    ]);
  });
});
