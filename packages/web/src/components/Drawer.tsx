import React, { useEffect, useMemo } from "react";
import type { EventRow } from "@clogdy/shared";
import { reconstructUnifiedDiff } from "@clogdy/shared";
import JsonView from "@uiw/react-json-view";
import { darkTheme } from "@uiw/react-json-view/dark";
import { parseDiff, Diff, Hunk, tokenize, markEdits } from "react-diff-view";
import { Highlight, Prism, themes } from "prism-react-renderer";

// prism-react-renderer vendors Prism WITHOUT a shell grammar, so Bash commands
// would render uncolored. Register a small, defensive bash grammar once (the
// documented extension point) so the command/content highlighters actually
// colorize. Guarded so we never clobber a real grammar. Patterns are single-
// consume alternations (no nested quantifiers) → linear, backtrack-safe.
const prismLanguages = Prism.languages as Record<string, unknown>;
if (!prismLanguages.bash) {
  prismLanguages.bash = {
    comment: { pattern: /(^|\s)#.*/, lookbehind: true, greedy: true },
    string: {
      pattern: /"(?:\\[\s\S]|\$\([^)]*\)|`[^`]*`|[^"\\])*"|'[^']*'/,
      greedy: true,
    },
    variable: /\$(?:\{[^}]*\}|\w+|[!@#?*$0-9-])/,
    keyword:
      /\b(?:if|then|else|elif|fi|for|while|until|do|done|case|esac|in|function|select|return|exit|break|continue|export|local|readonly|declare|set|unset|trap|source)\b/,
    builtin:
      /\b(?:echo|cd|ls|cat|grep|sed|awk|cp|mv|rm|mkdir|rmdir|touch|chmod|chown|kill|ps|sudo|env|find|xargs|tee|sort|uniq|head|tail|wc|cut|tr|test|read|printf|pwd|git|npm|bun|node|python)\b/,
    boolean: /\b(?:true|false)\b/,
    number: { pattern: /(^|\s)-?\d+(?:\.\d+)?(?=\s|$)/, lookbehind: true },
    operator: /&&|\|\||>>|<<|[|&;<>]|[=!]=?/,
    punctuation: /[(){}[\]]/,
  };
  prismLanguages.shell = prismLanguages.bash;
}

// JsonView dark theme tuned to the drawer's near-black panels.
const JSON_THEME = {
  ...darkTheme,
  "--w-rjv-background-color": "#0d0d0d",
  border: "1px solid #222",
  padding: "8px",
  marginTop: "4px",
} as React.CSSProperties;

// Map a file extension to a vendored Prism language (others degrade to plain).
const EXT_LANG: Record<string, string> = {
  ts: "typescript", mts: "typescript", cts: "typescript", tsx: "tsx",
  js: "javascript", mjs: "javascript", cjs: "javascript", jsx: "jsx",
  json: "json", py: "python", md: "markdown", markdown: "markdown",
  css: "css", html: "markup", htm: "markup", xml: "markup", svg: "markup",
  go: "go", rs: "rust", sql: "sql", yml: "yaml", yaml: "yaml",
  c: "c", h: "c", sh: "bash", bash: "bash",
};

function languageFor(filePath: string): string {
  const ext = filePath.split(".").pop()?.toLowerCase() ?? "";
  return EXT_LANG[ext] ?? "";
}

interface DrawerProps {
  event: EventRow | null;
  onClose: () => void;
  onCorrFilter: (corr: string) => void;
}

function DrawerSection({ label, body }: { label: string; body: string }): React.ReactElement {
  return (
    <>
      <h4>{label}</h4>
      <pre>{body}</pre>
    </>
  );
}

/** Parse a JSON string to an object/array, or null for primitives / bad JSON. */
function parseJsonObject(s: string | null): object | null {
  if (!s) return null;
  try {
    const v: unknown = JSON.parse(s);
    return v !== null && typeof v === "object" ? (v as object) : null;
  } catch {
    return null;
  }
}

/**
 * Syntax-highlight `code` via prism-react-renderer's render-prop → React
 * elements (never dangerouslySetInnerHTML). Unknown languages tokenize to a
 * single plain run, so this degrades gracefully.
 */
function CodeBlock({ code, language }: { code: string; language: string }): React.ReactElement {
  return (
    <Highlight theme={themes.vsDark} code={code} language={language}>
      {({ style, tokens, getLineProps, getTokenProps }) => (
        <pre className="drawer-code" style={{ ...style, background: "#0d0d0d" }}>
          {tokens.map((line, i) => (
            <div key={i} {...getLineProps({ line })}>
              {line.map((token, j) => (
                <span key={j} {...getTokenProps({ token })} />
              ))}
            </div>
          ))}
        </pre>
      )}
    </Highlight>
  );
}

/**
 * Colored unified-diff fallback (reuses the `.rline` classes) for the rare case
 * where reconstructUnifiedDiff can't produce a parseable diff.
 */
function DiffFallback({ body }: { body: string }): React.ReactElement {
  return (
    <pre>
      {body.split("\n").map((l, i) => {
        const cls =
          l[0] === "+" ? "add" : l[0] === "-" ? "del" : l.startsWith("@@") ? "head" : "";
        return (
          <span key={i} className={cls ? `rline ${cls}` : "rline"}>
            {l + "\n"}
          </span>
        );
      })}
    </pre>
  );
}

/** One parsed diff file rendered with line numbers + word-level intra-line marks. */
function DiffFile({ file }: { file: ReturnType<typeof parseDiff>[number] }): React.ReactElement {
  const tokens = useMemo(() => {
    try {
      return tokenize(file.hunks, { enhancers: [markEdits(file.hunks)] });
    } catch {
      return undefined;
    }
  }, [file.hunks]);

  return (
    <Diff viewType="unified" diffType={file.type} hunks={file.hunks} tokens={tokens}>
      {(hunks) => hunks.map((h) => <Hunk key={h.content} hunk={h} />)}
    </Diff>
  );
}

/**
 * DIFF section: rebuild a real unified diff from the raw line and render it with
 * react-diff-view; if that isn't possible, fall back to the colored diff body.
 */
function DiffSection({ raw, body }: { raw: string; body: string }): React.ReactElement {
  const files = useMemo(() => {
    const unified = reconstructUnifiedDiff(raw);
    if (!unified) return null;
    try {
      const parsed = parseDiff(unified);
      return parsed.length ? parsed : null;
    } catch {
      return null;
    }
  }, [raw]);

  return (
    <>
      <h4>diff</h4>
      {files ? (
        files.map((f, i) => <DiffFile key={i} file={f} />)
      ) : (
        <DiffFallback body={body} />
      )}
    </>
  );
}

export function Drawer({ event, onClose, onCorrFilter }: DrawerProps): React.ReactElement | null {
  // Escape key closes the drawer
  useEffect(() => {
    if (!event) return;
    function onKeyDown(e: KeyboardEvent): void {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [event, onClose]);

  if (!event) return null;

  const e = event;

  // Pretty-print raw JSON (defensive)
  let raw = e.raw;
  try {
    const parsed: unknown = JSON.parse(e.raw);
    raw = JSON.stringify(parsed, null, 2);
  } catch {
    raw = e.raw;
  }

  const inputObj = parseJsonObject(e.inputJson);
  const resultObj = parseJsonObject(e.result);

  // Highlighted command (Bash) or written file content (Write).
  let codeBlock: React.ReactElement | null = null;
  if (e.tool === "Bash" && e.command) {
    codeBlock = (
      <>
        <h4>command</h4>
        <CodeBlock code={e.command} language="bash" />
      </>
    );
  } else if (
    e.tool === "Write" &&
    inputObj &&
    typeof (inputObj as Record<string, unknown>).content === "string"
  ) {
    const rec = inputObj as Record<string, unknown>;
    const fp = typeof rec.file_path === "string" ? rec.file_path : "";
    codeBlock = (
      <>
        <h4>content</h4>
        <CodeBlock code={rec.content as string} language={languageFor(fp)} />
      </>
    );
  }

  return (
    <div
      id="drawer"
      onClick={(ev) => ev.stopPropagation()}
    >
      <span className="close" onClick={onClose}>✕</span>

      {e.corr && (
        <>
          <h4>corr</h4>
          <span
            className="corr-link"
            onClick={() => {
              onCorrFilter(e.corr!);
              onClose();
            }}
          >
            {e.corr}
          </span>
        </>
      )}

      {codeBlock}

      {inputObj ? (
        <>
          <h4>tool input</h4>
          <JsonView value={inputObj} style={JSON_THEME} collapsed={2} displayDataTypes={false} />
        </>
      ) : (
        e.inputJson && <DrawerSection label="tool input" body={e.inputJson} />
      )}

      <DrawerSection label="raw" body={raw} />

      {resultObj ? (
        <>
          <h4>result</h4>
          <JsonView value={resultObj} style={JSON_THEME} collapsed={2} displayDataTypes={false} />
        </>
      ) : (
        e.result && <DrawerSection label="result" body={e.result} />
      )}

      {e.text && <DrawerSection label="text" body={e.text} />}
      {e.diff && <DiffSection raw={e.raw} body={e.diff} />}
      {e.stderr && <DrawerSection label="stderr" body={e.stderr} />}
    </div>
  );
}
