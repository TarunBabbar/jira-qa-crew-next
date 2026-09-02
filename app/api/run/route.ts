import { NextRequest } from "next/server";

import { blockingProblems, loadSettings, redact } from "@/lib/config";
import { QAPipeline } from "@/lib/pipeline";
import type { RunSummary, TicketResult } from "@/lib/models";
import {
  renderRequirementsMd, renderTestPlanMd, renderTestCasesMd, renderTestCasesCsv,
  renderTraceabilityCsv, renderPlaywrightMd, renderRunSummaryMd,
} from "@/lib/artifacts";
import { zipSync, strToU8 } from "fflate";

export const maxDuration = 300;
export const dynamic = "force-dynamic";

const KEY_RE = /^[A-Z][A-Z0-9_]+-\d+$/;

function sse(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

export async function POST(req: NextRequest) {
  const settings = loadSettings();

  if (!settings.demoMode) {
    const problems = blockingProblems(settings);
    if (problems.length) {
      return Response.json({ error: problems.join(" ; ") }, { status: 400 });
    }
  }

  let body: { tickets?: unknown };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const raw = Array.isArray(body.tickets) ? body.tickets.map(String) : [String(body.tickets ?? "")];
  const seen = new Set<string>();
  const valid: string[] = [];
  const invalid: string[] = [];
  const duplicates: string[] = [];
  for (const item of raw) {
    const key = item.trim().toUpperCase();
    if (!key) continue;
    if (!KEY_RE.test(key)) { invalid.push(item.trim()); continue; }
    if (seen.has(key)) { duplicates.push(key); continue; }
    seen.add(key);
    valid.push(key);
  }
  if (!valid.length) {
    return Response.json({ error: "No valid Jira ticket IDs were found in the input." }, { status: 400 });
  }
  const tickets = valid.slice(0, settings.pipelineMaxTickets);

  // SSE stream: progress events during the run, then a single "done" event.
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: string, data: unknown) => {
        try { controller.enqueue(encoder.encode(sse(event, data))); } catch { /* client gone */ }
      };

      let run;
      try {
        const pipeline = new QAPipeline(settings, (ticketKey, stage, status, message, duration) => {
          send("progress", { ticketKey, stage, status, message, duration });
        });
        run = await pipeline.run(tickets);
      } catch (e) {
        send("error", { error: redact(settings, `${(e as Error).name}: ${e}`) });
        controller.close();
        return;
      }

      const summary = shapeRun(settings, run);
      send("done", summary);
      controller.close();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}

function shapeRun(settings: ReturnType<typeof loadSettings>, run: Awaited<ReturnType<QAPipeline["run"]>>) {
  const results = run.results.map((r) => {
    const md: Record<string, string> = {};
    if (r.analysis) md["requirements_analysis.md"] = renderRequirementsMd(r.analysis);
    if (r.test_plan) md["test_plan.md"] = renderTestPlanMd(r.test_plan);
    if (r.test_cases) {
      md["test_cases.md"] = renderTestCasesMd(r.test_cases);
      md["test_cases.csv"] = renderTestCasesCsv(r.test_cases);
    }
    if (r.playwright) md["playwright_tests.md"] = renderPlaywrightMd(r.playwright);
    if (r.coverage) md["traceability_matrix.csv"] = renderTraceabilityCsv(r.coverage);
    md["run_summary.md"] = renderRunSummaryMd(run);
    return {
      ticket_key: r.ticket_key,
      status: r.status,
      source: r.source,
      error: redact(settings, r.error),
      warnings: r.warnings.map((w) => redact(settings, w)),
      duration_seconds: r.started_at && r.finished_at
        ? Math.round((new Date(r.finished_at).getTime() - new Date(r.started_at).getTime()) / 1000)
        : null,
      stages: r.stages,
      analysis: r.analysis,
      test_plan: r.test_plan,
      test_cases: r.test_cases,
      playwright: r.playwright,
      coverage: r.coverage,
      needs_code: settings.splitPlaywright && !r.playwright,
      artifacts_md: md,
    };
  });

  // Server-side ZIP of every artifact, including the generated Playwright
  // .ts test files (the actual test code, not just the markdown).
  let zipB64: string | null = null;
  try {
    const files: Record<string, Uint8Array> = {};
    for (const r of run.results) {
      const md = results.find((x) => x.ticket_key === r.ticket_key)?.artifacts_md ?? {};
      for (const [name, content] of Object.entries(md)) {
        files[`${r.ticket_key}/${name}`] = strToU8(content);
      }
      for (const f of r.playwright?.files ?? []) {
        files[`${r.ticket_key}/playwright/${f.path}`] = strToU8(f.content);
      }
    }
    const zip = zipSync(files, { level: 6 });
    zipB64 = Buffer.from(zip).toString("base64");
  } catch (e) {
    console.error("zip build failed", e);
  }

  return {
    run_id: run.run_id,
    requested_keys: run.requested_keys,
    invalid_inputs: run.invalid_inputs,
    duplicates_removed: run.duplicates_removed,
    successful: run.results.some((r) => r.status === "COMPLETED" || r.status === "COMPLETED_WITH_WARNINGS"),
    results,
    zip_b64: zipB64,
  };
}
