import { Fragment, useState, type ReactNode } from "react";
import { Check, Copy } from "lucide-react";

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

const KEYWORDS = new Set("as async await break case catch class const continue def default do else except export extends finally for from function if import in interface let new of return static switch throw try while with yield".split(" "));
const LITERALS = new Set("false true null none undefined".split(" "));
const BUILT_INS = new Set("bool dict enumerate float int len list map print range set str tuple".split(" "));
const TYPES = new Set("any boolean dict float int list number object string tuple void".split(" "));

function codeTokenTone(token: string) {
  const normalized = token.toLowerCase();
  if (token.startsWith("#") || token.startsWith("//")) return "comment";
  if (token.startsWith("\"") || token.startsWith("'")) return "string";
  if (/^\d/.test(token)) return "number";
  if (KEYWORDS.has(normalized)) return "keyword";
  if (LITERALS.has(normalized)) return "literal";
  if (BUILT_INS.has(normalized)) return "builtin";
  if (TYPES.has(normalized) || /^[A-Z][A-Za-z0-9_]*$/.test(token)) return "type";
  return "plain";
}

function HighlightedCode({ content }: { content: string }) {
  const tokenPattern = /(\/\/[^\n]*|#[^\n]*|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\b\d+(?:\.\d+)?\b|\b[A-Za-z_][A-Za-z0-9_]*\b)/g;
  return <>{content.split("\n").map((line, lineIndex) => {
    const nodes: ReactNode[] = [];
    let cursor = 0;
    let match: RegExpExecArray | null;
    tokenPattern.lastIndex = 0;
    while ((match = tokenPattern.exec(line))) {
      if (match.index > cursor) nodes.push(line.slice(cursor, match.index));
      const token = match[0];
      const tone = codeTokenTone(token);
      nodes.push(tone === "plain" ? token : <span className={`code-token is-${tone}`} key={`${lineIndex}-${match.index}`}>{token}</span>);
      cursor = tokenPattern.lastIndex;
    }
    if (cursor < line.length) nodes.push(line.slice(cursor));
    return <Fragment key={`${lineIndex}-${line}`}>{nodes}{lineIndex < content.split("\n").length - 1 && "\n"}</Fragment>;
  })}</>;
}

function CodeBlock({ language, content }: { language: string; content: string }) {
  const [copied, setCopied] = useState(false);
  async function copyCode() {
    try {
      await navigator.clipboard.writeText(content);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1_600);
    } catch {
      setCopied(false);
    }
  }
  return <div className="markdown-code-block" data-language={language}>
    <div className="markdown-code-header"><span>{language}</span><button type="button" onClick={() => void copyCode()} aria-label="Copy code">{copied ? <><Check size={13} /> Copied</> : <><Copy size={13} /> Copy</>}</button></div>
    <pre><code><HighlightedCode content={content} /></code></pre>
  </div>;
}

export function MarkdownResponse({ text }: { text: string }) {
  return (
    <div className="response-copy markdown-response">
      {parseMarkdownBlocks(text).map((block, index) => {
        const key = `${block.type}-${index}`;
        switch (block.type) {
          case "code":
            return <CodeBlock language={block.language} content={block.content} key={key} />;
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
