"use client";

import { useEffect, useRef, useState } from "react";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
interface ConfigStatus {
  llm: { ready: boolean; model: string; api_key: string; temperature: number; structured_output: string };
  jiraRest: { ready: boolean; url: string; auth_mode: string; email: string; token: string };
  pipeline: { mode: string; max_tickets: number; demo_mode: boolean; output_dir: string };
}

interface StageInfo { status: string; message: string }
interface ProgressEvent { ticketKey: string; stage: string; status: string; message: string }

interface RunResponse {
  run_id: string;
  requested_keys: string[];
  invalid_inputs: string[];
  duplicates_removed: string[];
  successful: boolean;
  results: ResultItem[];
}

interface ResultItem {
  ticket_key: string;
  status: string;
  source: string | null;
  error: string;
  warnings: string[];
  duration_seconds: number | null;
  stages: Array<{ stage: string; status: string; message: string }>;
  analysis: any;
  test_plan: any;
  test_cases: any;
  playwright: any;
  coverage: any;
  artifacts_md: Record<string, string>;
}

const STAGE_ORDER = ["Jira Fetch", "Jira Analyst", "Test Plan Writer", "Test Case Writer", "Playwright Coder", "Artifacts"];

const STATUS_ICON: Record<string, string> = {
  PENDING: "⚪", RUNNING: "🔵", COMPLETED: "🟢", WARNING: "🟡", FAILED: "🔴",
};

const esc = (s: unknown) =>
  String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string)
  );

// ---------------------------------------------------------------------------
// Sidebar config (mirrors render_config_panel)
// ---------------------------------------------------------------------------
function ConfigSidebar({ status, mode }: { status: ConfigStatus | null; mode: string }) {
  const blocks = [
    { label: "LLM", key: "llm", block: status?.llm },
    { label: "Jira REST", key: "jira_rest", block: status?.jiraRest },
  ];
  return (
    <aside className="sidebar">
      <div className="sidebar-inner">
        <h3>Configuration</h3>
        {blocks.map(({ label, block }) => (
          <div className={`cfg-row ${block?.ready ? "ok" : "bad"}`} key={label}>
            <span className="dot">{block?.ready ? "🟢" : "🔴"}</span>
            <strong>{label}</strong>
            {block && (
              <div className="cfg-detail">
                {Object.entries(block).filter(([k]) => k !== "ready").map(([k, v]) => (
                  <div key={k} className="cfg-line">
                    <span>{k}:</span> <code>{esc(v)}</code>
                  </div>
                ))}
              </div>
            )}
          </div>
        ))}
        <div className="cfg-meta">
          Mode `{mode}` · max {status?.pipeline.max_tickets ?? "?"} tickets · output `{status?.pipeline.output_dir ?? "outputs"}`
        </div>
        {status?.pipeline.demo_mode && (
          <div className="cfg-warn">DEMO MODE is on. Tickets are read from local fixtures, not from Jira.</div>
        )}
        <div className={`cfg-ready ${status && status.llm.ready ? "ok" : "bad"}`}>
          {status && status.llm.ready ? "Ready to run." : "Not ready to run — see configuration above."}
        </div>
        <div className="cfg-hint">Secrets come from environment variables. They are never entered in the UI and never displayed.</div>
      </div>
    </aside>
  );
}

// ---------------------------------------------------------------------------
// Stage progress (mirrors render_stage_list)
// ---------------------------------------------------------------------------
function StageList({ stages }: { stages: Record<string, StageInfo> }) {
  return (
    <div className="stages">
      {STAGE_ORDER.map((stage) => {
        const info = stages[stage] ?? { status: "PENDING", message: "" };
        const icon = STATUS_ICON[info.status] ?? "⚪";
        return (
          <div className="qa-stage" key={stage}>
            {icon} <strong>{stage}</strong>
            {info.message && <span className="stage-msg"> — {esc(info.message)}</span>}
          </div>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// ZIP writer (store, no compression) — mirrors artifacts_service.build_zip
// ---------------------------------------------------------------------------
function buildCrcTable(): Uint32Array {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
}

function crc32(data: Uint8Array, table: Uint32Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = table[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function downloadAllZip(data: RunResponse) {
  const encoder = new TextEncoder();
  const files: Array<[string, Uint8Array]> = [];
  for (const r of data.results) {
    for (const [name, content] of Object.entries(r.artifacts_md ?? {})) {
      files.push([`${r.ticket_key}/${name}`, encoder.encode(content)]);
    }
  }
  if (!files.length) return;
  const chunks: Uint8Array[] = [];
  const localParts: Uint8Array[] = [];
  let offset = 0;
  const crcTable = buildCrcTable();
  for (const [name, content] of files) {
    const nameBytes = encoder.encode(name);
    const crc = crc32(content, crcTable);
    const local = new Uint8Array(30 + nameBytes.length);
    const dv = new DataView(local.buffer);
    dv.setUint32(0, 0x04034b50, true);
    dv.setUint16(4, 20, true);
    dv.setUint16(6, 0x800, true);
    dv.setUint16(8, 0, true);
    dv.setUint16(10, 0, true);
    dv.setUint16(12, 0, true);
    dv.setUint16(14, 0, true);
    dv.setUint32(16, crc, true);
    dv.setUint32(20, content.length, true);
    dv.setUint32(24, content.length, true);
    dv.setUint16(28, nameBytes.length, true);
    dv.setUint16(30, 0, true);
    local.set(nameBytes, 30);
    chunks.push(local, content);
    const central = new Uint8Array(46 + nameBytes.length);
    const cdv = new DataView(central.buffer);
    cdv.setUint32(0, 0x02014b50, true);
    cdv.setUint16(4, 20, true);
    cdv.setUint16(6, 20, true);
    cdv.setUint16(8, 0x800, true);
    cdv.setUint16(10, 0, true);
    cdv.setUint16(12, 0, true);
    cdv.setUint16(14, 0, true);
    cdv.setUint16(16, 0, true);
    cdv.setUint32(18, crc, true);
    cdv.setUint32(22, content.length, true);
    cdv.setUint32(26, content.length, true);
    cdv.setUint16(30, nameBytes.length, true);
    cdv.setUint16(32, 0, true);
    cdv.setUint16(34, 0, true);
    cdv.setUint16(36, 0, true);
    cdv.setUint16(38, 0, true);
    cdv.setUint32(40, 0, true);
    cdv.setUint32(44, offset, true);
    central.set(nameBytes, 46);
    localParts.push(central);
    offset += local.length + content.length;
  }
  const centralSize = localParts.reduce((a, b) => a + b.length, 0);
  const eocd = new Uint8Array(22);
  const edv = new DataView(eocd.buffer);
  edv.setUint32(0, 0x06054b50, true);
  edv.setUint16(8, files.length, true);
  edv.setUint16(10, files.length, true);
  edv.setUint32(12, centralSize, true);
  edv.setUint32(16, offset, true);
  const all = new Uint8Array(offset + centralSize + 22);
  let pos = 0;
  for (const c of [...chunks, ...localParts, eocd]) { all.set(c, pos); pos += c.length; }
  const blob = new Blob([all], { type: "application/zip" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = `${data.run_id}_qa_artifacts.zip`; a.click();
  URL.revokeObjectURL(url);
}

// ---------------------------------------------------------------------------
// Results (mirrors the 6-tab layout in results.py)
// ---------------------------------------------------------------------------
function ResultTabs({ result }: { result: ResultItem }) {
  const [tab, setTab] = useState("requirements");
  const tabs = [
    ["requirements", "Requirements Analysis"],
    ["plan", "Test Plan"],
    ["cases", "Test Cases"],
    ["playwright", "Playwright"],
    ["traceability", "Traceability"],
    ["details", "Run Details"],
  ];

  function download(name: string, content: string) {
    const blob = new Blob([content], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = name; a.click();
    URL.revokeObjectURL(url);
  }

  const coverage = result.coverage;
  const reqCoverage = coverage?.total_requirements
    ? Math.round((100 * coverage.covered_requirements) / coverage.total_requirements * 10) / 10
    : 0;
  const autoCoverage = coverage?.total_test_cases
    ? Math.round((100 * coverage.automated_test_cases) / coverage.total_test_cases * 10) / 10
    : 0;

  return (
    <div className="result-tabs">
      <div className="tab-bar">
        {tabs.map(([key, label]) => (
          <button key={key} className={`tab ${tab === key ? "active" : ""}`} onClick={() => setTab(key)}>{label}</button>
        ))}
      </div>

      {tab === "requirements" && result.analysis && (
        <div className="tab-panel">
          <div className="metrics">
            <div className="metric"><div className="v">{result.analysis.requirements?.length ?? 0}</div><div className="k">Requirements</div></div>
            <div className="metric"><div className="v">{result.analysis.acceptance_criteria?.length ?? 0}</div><div className="k">Acceptance criteria</div></div>
            <div className="metric"><div className="v">{result.analysis.missing_information?.length ?? 0}</div><div className="k">Missing info</div></div>
            <div className="metric"><div className="v">{result.analysis.open_questions?.length ?? 0}</div><div className="k">Open questions</div></div>
          </div>
          <p><strong>{esc(result.analysis.summary)}</strong></p>
          <p className="hint">{esc(result.analysis.description_summary)}</p>
          {result.analysis.missing_information?.length > 0 && (
            <div className="warn-box"><strong>Missing information</strong> (nothing was invented to fill these):
              <ul>{result.analysis.missing_information.map((m: string, i: number) => <li key={i}>{esc(m)}</li>)}</ul>
            </div>
          )}
          <h4>Requirements</h4>
          <table>
            <thead><tr><th>ID</th><th>Requirement</th><th>Category</th><th>Provenance</th><th>Source quote</th></tr></thead>
            <tbody>
              {(result.analysis.requirements ?? []).map((r: any) => (
                <tr key={r.id}>
                  <td><code>{esc(r.id)}</code></td><td>{esc(r.text)}</td>
                  <td>{esc(r.category)}</td><td>{esc(r.provenance)}</td><td>{esc(r.source_quote)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <h4>Acceptance Criteria</h4>
          <ul>
            {(result.analysis.acceptance_criteria ?? []).map((c: any) => (
              <li key={c.id}><code>{esc(c.id)}</code> {esc(c.text)} <span className="hint">(verifies {esc((c.requirement_ids ?? []).join(", "))})</span></li>
            ))}
          </ul>
        </div>
      )}

      {tab === "plan" && result.test_plan && (
        <div className="tab-panel">
          <h3>{esc(result.test_plan.title)}</h3>
          {(result.test_plan.sections ?? []).map((s: any) => (
            <div className="plan-section" key={s.number}>
              <h4>{s.number}. {esc(s.title)}</h4>
              <p>{esc(s.content)}</p>
            </div>
          ))}
          {(result.test_plan.scenarios ?? []).length > 0 && (
            <>
              <h4>High-Level Scenarios</h4>
              <table>
                <thead><tr><th>ID</th><th>Scenario</th><th>Priority</th><th>Traces to</th></tr></thead>
                <tbody>
                  {(result.test_plan.scenarios ?? []).map((sc: any) => (
                    <tr key={sc.id}>
                      <td><code>{esc(sc.id)}</code></td><td>{esc(sc.title)}</td>
                      <td>{esc(sc.priority)}</td>
                      <td>{esc([...(sc.requirement_ids ?? []), ...(sc.acceptance_criteria_ids ?? [])].join(", "))}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
        </div>
      )}

      {tab === "cases" && result.test_cases && (
        <div className="tab-panel">
          <table>
            <thead><tr><th>ID</th><th>Title</th><th>Priority</th><th>Type</th><th>Automation</th><th>Expected result</th></tr></thead>
            <tbody>
              {(result.test_cases.test_cases ?? []).map((tc: any) => (
                <tr key={tc.id}>
                  <td><code>{esc(tc.id)}</code></td><td>{esc(tc.title)}</td>
                  <td>{esc(tc.priority)}</td><td>{esc(tc.test_type)}</td>
                  <td>{esc(tc.automation_candidate)}</td><td>{esc(tc.expected_result)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {(result.test_cases.test_cases ?? []).map((tc: any) => (
            <details key={tc.id}>
              <summary>{esc(tc.id)} — {esc(tc.title)}</summary>
              <p><strong>Objective:</strong> {esc(tc.objective)}</p>
              {tc.preconditions?.length > 0 && <p><strong>Preconditions:</strong> {tc.preconditions.map(esc).join("; ")}</p>}
              {tc.test_data?.length > 0 && <p><strong>Test data:</strong> {tc.test_data.map(esc).join("; ")}</p>}
              <table>
                <thead><tr><th>#</th><th>Action</th><th>Expected</th></tr></thead>
                <tbody>
                  {(tc.steps ?? []).map((st: any) => (
                    <tr key={st.number}><td>{st.number}</td><td>{esc(st.action)}</td><td>{esc(st.expected)}</td></tr>
                  ))}
                </tbody>
              </table>
              <p><strong>Expected result:</strong> {esc(tc.expected_result)}</p>
              {tc.automation_rationale && <p className="hint"><strong>Automation rationale:</strong> {esc(tc.automation_rationale)}</p>}
              {tc.assumptions_or_blockers?.length > 0 && <p className="hint"><strong>Blockers:</strong> {tc.assumptions_or_blockers.map(esc).join("; ")}</p>}
            </details>
          ))}
        </div>
      )}

      {tab === "playwright" && result.playwright && (
        <div className="tab-panel">
          <div className={`readiness ${result.playwright.readiness === "READY" ? "ok" : "warn"}`}>
            Automation readiness: {esc(result.playwright.readiness)}
          </div>
          {result.playwright.missing_information?.length > 0 && (
            <div className="warn-box"><strong>Required before this suite can run:</strong>
              <ul>{result.playwright.missing_information.map((m: string, i: number) => <li key={i}>{esc(m)}</li>)}</ul>
            </div>
          )}
          {result.playwright.setup_notes && <details><summary>Setup notes</summary><p>{esc(result.playwright.setup_notes)}</p></details>}
          {(result.playwright.files ?? []).map((f: any) => (
            <div key={f.path}>
              <h4>{esc(f.path)}</h4>
              <pre>{esc(f.content)}</pre>
            </div>
          ))}
        </div>
      )}

      {tab === "traceability" && coverage && (
        <div className="tab-panel">
          <div className="metrics">
            <div className="metric"><div className="v">{reqCoverage}%</div><div className="k">Requirement coverage</div></div>
            <div className="metric"><div className="v">{autoCoverage}%</div><div className="k">Automated test cases</div></div>
            <div className="metric"><div className="v">{coverage.covered_acceptance_criteria}/{coverage.total_acceptance_criteria}</div><div className="k">Covered ACs</div></div>
            <div className="metric"><div className="v">{coverage.uncovered_requirements}</div><div className="k">Uncovered requirements</div></div>
          </div>
          <table>
            <thead><tr><th>Requirement</th><th>AC</th><th>Test cases</th><th>Automated</th><th>Coverage</th><th>Reason</th></tr></thead>
            <tbody>
              {(coverage.rows ?? []).map((row: any, i: number) => (
                <tr key={i}>
                  <td><code>{esc(row.requirement_id)}</code></td>
                  <td>{esc(row.acceptance_criterion_id || "—")}</td>
                  <td>{esc((row.test_case_ids ?? []).join(", ") || "—")}</td>
                  <td>{esc((row.automated_test_case_ids ?? []).join(", ") || "—")}</td>
                  <td>{esc(row.coverage_status)}</td>
                  <td>{esc(row.reason)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {coverage.orphan_requirement_ids?.length > 0 && (
            <div className="warn-box"><strong>Requirements with no test case:</strong> {esc(coverage.orphan_requirement_ids.join(", "))}</div>
          )}
          {coverage.orphan_acceptance_criteria_ids?.length > 0 && (
            <div className="warn-box"><strong>Acceptance criteria with no test case:</strong> {esc(coverage.orphan_acceptance_criteria_ids.join(", "))}</div>
          )}
          {coverage.unknown_reference_ids?.length > 0 && (
            <div className="warn-box"><strong>References to ids that do not exist:</strong> {esc(coverage.unknown_reference_ids.join(", "))}</div>
          )}
        </div>
      )}

      {tab === "details" && (
        <div className="tab-panel">
          <div className="metrics">
            <div className="metric"><div className="v">{esc(result.source || "—")}</div><div className="k">Source</div></div>
            <div className="metric"><div className="v">{result.duration_seconds ?? 0}s</div><div className="k">Duration</div></div>
            <div className="metric"><div className="v">{esc(result.status)}</div><div className="k">Status</div></div>
          </div>
          <h4>Stages</h4>
          <table>
            <thead><tr><th>Stage</th><th>Status</th><th>Message</th></tr></thead>
            <tbody>
              {(result.stages ?? []).map((s: any, i: number) => (
                <tr key={i}><td>{esc(s.stage)}</td><td>{esc(s.status)}</td><td>{esc(s.message)}</td></tr>
              ))}
            </tbody>
          </table>
          <h4>Downloads</h4>
          <div className="dl">
            {Object.entries(result.artifacts_md ?? {}).map(([name, content]) => (
              <a key={name} href="#" onClick={(e) => { e.preventDefault(); download(`${result.ticket_key}_${name}`, content); }}>{esc(name)}</a>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------
export default function Home() {
  const [status, setStatus] = useState<ConfigStatus | null>(null);
  const [tickets, setTickets] = useState("MDP-7");
  const [mode, setMode] = useState("");
  const [busy, setBusy] = useState(false);
  const [statusMsg, setStatusMsg] = useState("");
  const [progress, setProgress] = useState<Record<string, Record<string, StageInfo>>>({});
  const [data, setData] = useState<RunResponse | null>(null);
  const [error, setError] = useState("");
  const [overLimit, setOverLimit] = useState<string[]>([]);
  const progressRef = useRef(progress);
  progressRef.current = progress;

  useEffect(() => {
    fetch("/api/config").then((r) => r.json()).then(setStatus).catch(() => {});
  }, []);

  async function run() {
    setBusy(true);
    setError("");
    setData(null);
    setStatusMsg("Starting…");

    const input = tickets.split(/[\s,;\n]+/).filter(Boolean);
    const upper = [...new Set(input.map((t) => t.toUpperCase()))];

    try {
      const res = await fetch("/api/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tickets: upper }),
      });
      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        setStatusMsg("");
        setError(json.error || res.statusText);
        return;
      }

      // SSE stream
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let final: RunResponse | null = null;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buffer.indexOf("\n\n")) !== -1) {
          const chunk = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          const evtLine = chunk.split("\n").find((l) => l.startsWith("event: "));
          const dataLine = chunk.split("\n").find((l) => l.startsWith("data: "));
          if (!evtLine || !dataLine) continue;
          const event = evtLine.slice(7).trim();
          const payload = JSON.parse(dataLine.slice(6));
          if (event === "progress") {
            const p = payload as ProgressEvent;
            setProgress((prev) => ({
              ...prev,
              [p.ticketKey]: { ...(prev[p.ticketKey] ?? {}), [p.stage]: { status: p.status, message: p.message } },
            }));
            setStatusMsg(`${p.ticketKey} — ${p.stage}: ${p.status}`);
          } else if (event === "done") {
            final = payload as RunResponse;
          } else if (event === "error") {
            setError(payload.error);
          }
        }
      }

      if (final) {
        setStatusMsg(`Finished — ${final.results.filter((r) => r.status === "COMPLETED" || r.status === "COMPLETED_WITH_WARNINGS").length} completed`);
        setData(final);
      } else if (!error) {
        setError("Run ended without a result.");
      }
    } catch (e) {
      setStatusMsg("");
      setError(`Request failed: ${e}`);
    } finally {
      setBusy(false);
    }
  }

  const done = data?.results.filter((r) => r.status === "COMPLETED" || r.status === "COMPLETED_WITH_WARNINGS").length ?? 0;
  const failed = data?.results.filter((r) => r.status === "FAILED").length ?? 0;

  return (
    <div className="app-shell">
      <ConfigSidebar status={status} mode={mode || status?.pipeline.mode || ""} />

      <main className="main">
        <div className="hero">
          <h1>Jira QA Crew</h1>
          <p>Generate test plans, test cases, traceability, and Playwright automation directly from Jira.</p>
        </div>

        <div className="card">
          <div className="input-grid">
            <div>
              <label htmlFor="tickets">Jira ticket IDs</label>
              <textarea id="tickets" value={tickets} onChange={(e) => setTickets(e.target.value)} placeholder="VWO-48&#10;VWO-49, VWO-50" />
              <div className="hint">Separate with commas, spaces, semicolons or new lines. Duplicates are removed and keys are upper-cased.</div>
            </div>
            <div>
              <label>Jira integration mode</label>
              <div className="radio-group">
                {["Auto (MCP → REST)", "MCP only", "REST only"].map((label) => {
                  const val = label === "Auto (MCP → REST)" ? "auto" : label === "MCP only" ? "mcp" : "rest";
                  return (
                    <label key={label} className="radio">
                      <input type="radio" name="mode" checked={mode === val} onChange={() => setMode(val)} />
                      {label}
                    </label>
                  );
                })}
              </div>
            </div>
          </div>

          <details className="advanced">
            <summary>Advanced settings</summary>
            <div className="adv-grid">
              <div>Model: <code>{esc(status?.llm.model ?? "…")}</code></div>
              <div>Temperature: <code>{esc(status?.llm.temperature ?? "…")}</code></div>
              <div>Max tickets: <code>{esc(status?.pipeline.max_tickets ?? "…")}</code></div>
              <div>Retries per stage: <code>1 repair attempt</code></div>
              <div>Ticket timeout: <code>{esc(status?.pipeline.max_tickets ? "600s" : "…")}</code></div>
              <div>Output dir: <code>{esc(status?.pipeline.output_dir ?? "outputs")}</code></div>
            </div>
            <div className="hint">These come from the environment. Change them in the Vercel project env vars and redeploy.</div>
          </details>

          <div className="row">
            <button onClick={run} disabled={busy}>
              {busy ? "Running…" : "Analyze & Generate QA Pack"}
            </button>
            {statusMsg && <span className="hint">{busy && <span className="spin" />}{statusMsg}</span>}
          </div>
          {overLimit.length > 0 && <div className="warn-box">Only the first {esc(status?.pipeline.max_tickets ?? 20)} tickets are processed. Dropped: {overLimit.map(esc).join(", ")}</div>}
        </div>

        {error && <div className="card err"><strong>Error:</strong> {esc(error)}</div>}

        {/* Live stage progress */}
        {busy && Object.keys(progress).length > 0 && (
          <div className="card">
            <h3 style={{ marginTop: 0 }}>Pipeline</h3>
            {Object.entries(progress).map(([key, stages]) => (
              <div key={key}>
                <strong>{key}</strong>
                <StageList stages={stages} />
              </div>
            ))}
          </div>
        )}

        {/* Results */}
        {data && (
          <>
            <h3 style={{ margin: "0 0 .6rem" }}>Run summary</h3>
            <div className="summary">
              <div className="metric"><div className="v">{esc(data.run_id.replace("RUN-", ""))}</div><div className="k">Run ID</div></div>
              <div className="metric"><div className="v">{data.results.length}</div><div className="k">Tickets</div></div>
              <div className="metric"><div className="v">{done}</div><div className="k">Completed</div></div>
              <div className="metric"><div className="v">{data.results.filter((r) => r.status === "COMPLETED_WITH_WARNINGS").length}</div><div className="k">With warnings</div></div>
              <div className="metric"><div className="v">{failed}</div><div className="k">Failed</div></div>
            </div>

            <div className="card">
              <table>
                <thead><tr><th>Ticket</th><th>Status</th><th>Source</th><th>Automation</th><th>Requirements</th><th>Test cases</th><th>Req coverage %</th><th>Duration (s)</th></tr></thead>
                <tbody>
                  {data.results.map((r) => (
                    <tr key={r.ticket_key}>
                      <td>{esc(r.ticket_key)}</td>
                      <td>{esc(r.status)}</td>
                      <td>{esc(r.source || "—")}</td>
                      <td>{esc(r.playwright?.readiness || "—")}</td>
                      <td>{r.coverage?.total_requirements ?? 0}</td>
                      <td>{r.coverage?.total_test_cases ?? 0}</td>
                      <td>{r.coverage?.total_requirements ? Math.round(100 * r.coverage.covered_requirements / r.coverage.total_requirements * 10) / 10 : 0}</td>
                      <td>{r.duration_seconds ?? 0}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="row">
                <button onClick={() => downloadAllZip(data)}>Download all artifacts (ZIP)</button>
                <span className="hint">Artifacts on disk: `outputs/`</span>
              </div>
            </div>

            {data.results.map((r) => (
              <div className="card result-card" key={r.ticket_key}>
                <h2 className="result-head">
                  {esc(r.ticket_key)}
                  <span className={`badge ${r.status === "FAILED" ? "badge-err" : r.status === "COMPLETED" ? "badge-ok" : "badge-warn"}`}>{esc(r.status)}</span>
                  {r.source && <span className="badge badge-src">Source: {esc(r.source)}</span>}
                  {r.playwright && <span className={`badge ${r.playwright.readiness === "READY" ? "badge-ok" : "badge-warn"}`}>Automation: {esc(r.playwright.readiness)}</span>}
                </h2>
                {r.error && <div className="err">{esc(r.error)}</div>}
                {r.warnings.length > 0 && (
                  <details><summary>{r.warnings.length} warning(s)</summary>
                    {r.warnings.map((w, i) => <div key={i} className="hint">{esc(w)}</div>)}
                  </details>
                )}
                <ResultTabs result={r} />
              </div>
            ))}
          </>
        )}
      </main>
    </div>
  );
}
