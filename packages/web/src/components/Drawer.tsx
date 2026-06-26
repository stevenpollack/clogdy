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
// colorize. Guarded so we never clobber a real grammar. The `string` pattern is
// two non-overlapping alternatives (a backslash escape vs. any char that is not
// a quote or backslash), so matching stays linear — no catastrophic backtracking.
// `string` is declared before `comment` because Prism honors declaration order;
// otherwise a `#` inside a double-quoted string would be mis-tokenized as a comment.
const prismLanguages = Prism.languages as Record<string, unknown>;
if (!prismLanguages.bash) {
  prismLanguages.bash = {
    string: {
      pattern: /"(?:\\[\s\S]|[^"\\])*"|'[^']*'/,
      greedy: true,
    },
    comment: { pattern: /(^|\s)#.*/, lookbehind: true, greedy: true },
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
}

// JsonView dark theme tuned to the drawer's near-black panels.
const JSON_THEME = {
  ...darkTheme,
  "--w-rjv-background-color": "#0d0d0d",
  border: "1px solid #222",
  padding: "8px",
  marginTop: "4px",
} as React.CSSProperties;

// Size guards: very large strings are the heaviest render path (Prism
// tokenization is also the ReDoS vector, and a huge object/array builds
// thousands of DOM nodes), so cap them and degrade to a plain <pre>.
const CODE_CAP = 20000;
const JSON_CAP = 200000;

/**
 * Minimal error boundary: a render-time throw in an alpha rich renderer
 * (@uiw/react-json-view, react-diff-view) degrades just that panel to its <pre>
 * fallback instead of blanking the whole drawer (ground rule #7).
 */
class RenderBoundary extends React.Component<
  { children: React.ReactNode; fallback: React.ReactNode },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }
  render(): React.ReactNode {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

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
  // Skip Prism for very large input — tokenizing crafted/huge strings is the
  // heaviest path and the ReDoS vector; a raw <pre> still renders it readably.
  if (code.length > CODE_CAP) {
    return <pre className="drawer-code">{code}</pre>;
  }
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
      {(hunks) => hunks.map((h, i) => <Hunk key={i} hunk={h} />)}
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

  // Parse work memoized so a live-mode SSE re-render of the open drawer doesn't
  // re-parse these multi-KB/MB strings every time. Hooks must run unconditionally,
  // so they sit before the early return and null-guard `event` inside each memo.
  const raw = useMemo(() => {
    if (!event) return null;
    try {
      return JSON.stringify(JSON.parse(event.raw), null, 2);
    } catch {
      return event.raw;
    }
  }, [event]);
  const inputObj = useMemo(() => (event ? parseJsonObject(event.inputJson) : null), [event]);
  const resultObj = useMemo(() => (event ? parseJsonObject(event.result) : null), [event]);

  if (!event) return null;

  const e = event;

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

      {inputObj && e.inputJson && e.inputJson.length <= JSON_CAP ? (
        <>
          <h4>tool input</h4>
          <RenderBoundary fallback={<pre>{e.inputJson}</pre>}>
            <JsonView
              value={inputObj}
              style={JSON_THEME}
              collapsed={2}
              displayDataTypes={false}
              shortenTextAfterLength={0}
            />
          </RenderBoundary>
        </>
      ) : (
        e.inputJson && <DrawerSection label="tool input" body={e.inputJson} />
      )}

      <DrawerSection label="raw" body={raw ?? e.raw} />

      {resultObj && e.result && e.result.length <= JSON_CAP ? (
        <>
          <h4>result</h4>
          <RenderBoundary fallback={<pre>{e.result}</pre>}>
            <JsonView
              value={resultObj}
              style={JSON_THEME}
              collapsed={2}
              displayDataTypes={false}
              shortenTextAfterLength={0}
            />
          </RenderBoundary>
        </>
      ) : (
        e.result && <DrawerSection label="result" body={e.result} />
      )}

      {e.text && <DrawerSection label="text" body={e.text} />}
      {e.diff && (
        <RenderBoundary fallback={<DiffFallback body={e.diff} />}>
          <DiffSection raw={e.raw} body={e.diff} />
        </RenderBoundary>
      )}
      {e.stderr && <DrawerSection label="stderr" body={e.stderr} />}
    </div>
  );
}
