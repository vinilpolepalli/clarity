import { Fragment, type ReactNode } from "react";

type MarkdownBlock =
  | { type: "code"; language: string; content: string }
  | { type: "heading"; level: 1 | 2 | 3; content: string }
  | { type: "unordered-list"; items: string[] }
  | { type: "ordered-list"; items: string[] }
  | { type: "quote"; content: string }
  | { type: "paragraph"; content: string };

function isBlockStart(line: string) {
  return /^(?:```|#{1,3}\s+|[-*+]\s+|\d+[.)]\s+|>\s?)/.test(line);
}

export function parseMarkdownBlocks(text: string): MarkdownBlock[] {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const blocks: MarkdownBlock[] = [];

  for (let index = 0; index < lines.length;) {
    const line = lines[index] ?? "";
    if (!line.trim()) { index += 1; continue; }

    const fence = line.match(/^```\s*([^\s`]*)?\s*$/);
    if (fence) {
      const language = fence[1] || "text";
      const code: string[] = [];
      index += 1;
      while (index < lines.length && !/^```\s*$/.test(lines[index] ?? "")) code.push(lines[index++] ?? "");
      if (index < lines.length) index += 1;
      blocks.push({ type: "code", language, content: code.join("\n") });
      continue;
    }

    const heading = line.match(/^(#{1,3})\s+(.+)$/);
    if (heading) {
      blocks.push({ type: "heading", level: (heading[1] ?? "").length as 1 | 2 | 3, content: heading[2] ?? "" });
      index += 1;
      continue;
    }

    const unordered = line.match(/^[-*+]\s+(.+)$/);
    if (unordered) {
      const items: string[] = [];
      while (index < lines.length) {
        const item = lines[index]?.match(/^[-*+]\s+(.+)$/);
        if (!item) break;
        items.push(item[1] ?? "");
        index += 1;
      }
      blocks.push({ type: "unordered-list", items });
      continue;
    }

    const ordered = line.match(/^\d+[.)]\s+(.+)$/);
    if (ordered) {
      const items: string[] = [];
      while (index < lines.length) {
        const item = lines[index]?.match(/^\d+[.)]\s+(.+)$/);
        if (!item) break;
        items.push(item[1] ?? "");
        index += 1;
      }
      blocks.push({ type: "ordered-list", items });
      continue;
    }

    const quote = line.match(/^>\s?(.*)$/);
    if (quote) {
      const quoteLines: string[] = [];
      while (index < lines.length) {
        const item = lines[index]?.match(/^>\s?(.*)$/);
        if (!item) break;
        quoteLines.push(item[1] ?? "");
        index += 1;
      }
      blocks.push({ type: "quote", content: quoteLines.join("\n") });
      continue;
    }

    const paragraph: string[] = [];
    while (index < lines.length && lines[index]?.trim() && !isBlockStart(lines[index] ?? "")) paragraph.push(lines[index++] ?? "");
    blocks.push({ type: "paragraph", content: paragraph.join("\n") });
  }

  return blocks;
}

function inlineMarkdown(text: string): ReactNode[] {
  const tokens = /(\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)|`([^`]+)`|\*\*([^*]+)\*\*|__([^_]+)__|\*([^*]+)\*|_([^_]+)_)/g;
  const nodes: ReactNode[] = [];
  let cursor = 0;
  let match: RegExpExecArray | null;

  while ((match = tokens.exec(text))) {
    if (match.index > cursor) nodes.push(text.slice(cursor, match.index));
    if (match[2] && match[3]) {
      nodes.push(<a href={match[3]} key={`${match.index}-link`} rel="noreferrer" target="_blank">{match[2]}</a>);
    } else if (match[4]) {
      nodes.push(<code key={`${match.index}-code`}>{match[4]}</code>);
    } else if (match[5] || match[6]) {
      nodes.push(<strong key={`${match.index}-strong`}>{match[5] || match[6]}</strong>);
    } else {
      nodes.push(<em key={`${match.index}-em`}>{match[7] || match[8]}</em>);
    }
    cursor = tokens.lastIndex;
  }
  if (cursor < text.length) nodes.push(text.slice(cursor));
  return nodes;
}

function InlineContent({ content }: { content: string }) {
  return <>{content.split("\n").map((line, index) => <Fragment key={`${index}-${line}`}>{index > 0 && <br />}{inlineMarkdown(line)}</Fragment>)}</>;
}

export function MarkdownResponse({ text }: { text: string }) {
  return (
    <div className="response-copy markdown-response">
      {parseMarkdownBlocks(text).map((block, index) => {
        const key = `${block.type}-${index}`;
        switch (block.type) {
          case "code":
            return <pre className="markdown-code-block" data-language={block.language} key={key}><code>{block.content}</code></pre>;
          case "heading": {
            const Heading = `h${block.level}` as "h1" | "h2" | "h3";
            return <Heading className="markdown-heading" key={key}><InlineContent content={block.content} /></Heading>;
          }
          case "unordered-list":
            return <ul className="markdown-list" key={key}>{block.items.map((item, itemIndex) => <li key={`${key}-${itemIndex}`}><InlineContent content={item} /></li>)}</ul>;
          case "ordered-list":
            return <ol className="markdown-list" key={key}>{block.items.map((item, itemIndex) => <li key={`${key}-${itemIndex}`}><InlineContent content={item} /></li>)}</ol>;
          case "quote":
            return <blockquote className="markdown-quote" key={key}><InlineContent content={block.content} /></blockquote>;
          case "paragraph":
            return <p key={key}><InlineContent content={block.content} /></p>;
        }
      })}
    </div>
  );
}
