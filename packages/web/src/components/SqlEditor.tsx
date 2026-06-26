// CodeMirror 6 SQL editor (syntax highlighting + bracket matching). Shipped
// unconditionally — bundle size is not a constraint here; the editing UX is
// worth the weight (user directive, DECISIONS.md D-5.k).
import React, { useMemo, useRef, useState } from "react";
import CodeMirror, { keymap, Prec, EditorView } from "@uiw/react-codemirror";
import { sql } from "@codemirror/lang-sql";

interface SqlEditorProps {
  value: string;
  onChange: (sql: string) => void;
  onRun: () => void;
  error: string | null;
}

const EXAMPLES = [
  {
    label: "Tool usage counts",
    sql: "SELECT tool, COUNT(*) n FROM events WHERE kind='tool_use' GROUP BY tool ORDER BY n DESC",
  },
  {
    label: "Latency p50/p95",
    sql: "SELECT tool, quantile_cont(dur_ms,0.5) p50, quantile_cont(dur_ms,0.95) p95 FROM events WHERE dur_ms IS NOT NULL GROUP BY tool",
  },
  {
    label: "Events per hour",
    sql: "SELECT date_trunc('hour', make_timestamp(ts*1000)) hr, COUNT(*) FROM events GROUP BY hr ORDER BY hr",
  },
];

export default function SqlEditor({
  value,
  onChange,
  onRun,
  error,
}: SqlEditorProps): React.ReactElement {
  const [showExamples, setShowExamples] = useState(false);
  // Keep onRun fresh inside the (memoized) CodeMirror keymap without rebuilding it.
  const onRunRef = useRef(onRun);
  onRunRef.current = onRun;

  const extensions = useMemo(
    () => [
      sql(),
      EditorView.lineWrapping,
      // Cmd/Ctrl-Enter runs the query (highest precedence so it beats defaults).
      Prec.highest(
        keymap.of([
          {
            key: "Mod-Enter",
            run: () => {
              onRunRef.current();
              return true;
            },
          },
        ]),
      ),
    ],
    [],
  );

  return (
    <div id="sql-editor">
      <div className="sql-toolbar">
        <div style={{ position: "relative", display: "inline-block" }}>
          <button
            id="sql-examples-btn"
            onClick={() => setShowExamples((s) => !s)}
          >
            Examples ▾
          </button>
          {showExamples && (
            <ul id="sql-examples-list">
              {EXAMPLES.map((ex) => (
                <li
                  key={ex.label}
                  onClick={() => {
                    onChange(ex.sql);
                    setShowExamples(false);
                  }}
                >
                  {ex.label}
                </li>
              ))}
            </ul>
          )}
        </div>
        <button id="sql-run" onClick={onRun}>
          ▶ Run
        </button>
      </div>
      <CodeMirror
        id="sql-cm"
        value={value}
        onChange={onChange}
        extensions={extensions}
        theme="dark"
        height="140px"
        basicSetup={{ highlightActiveLine: false }}
        placeholder="SELECT … FROM events WHERE … (Ctrl/Cmd+Enter to run)"
      />
      {error !== null && (
        <div id="sql-error" className="sql-error">
          {error}
        </div>
      )}
    </div>
  );
}
