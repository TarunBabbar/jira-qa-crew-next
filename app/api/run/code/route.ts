import { NextRequest } from "next/server";

import { loadSettings, redact } from "@/lib/config";
import { QAPipeline } from "@/lib/pipeline";
import type { RequirementAnalysis, TestCaseSuite, TestPlan } from "@/lib/models";
import { validateAnalysis, validateTestCases, validateTestPlan } from "@/lib/validation";

export const maxDuration = 300;
export const dynamic = "force-dynamic";

function sse(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

export async function POST(req: NextRequest) {
  const settings = loadSettings();

  let body: { ticket_key?: string; analysis?: unknown; test_plan?: unknown; test_cases?: unknown };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const ticketKey = (body.ticket_key ?? "").trim().toUpperCase();
  if (!ticketKey) {
    return Response.json({ error: "ticket_key is required" }, { status: 400 });
  }

  // Re-validate the client-provided upstream objects; do not trust them blindly.
  let analysis: RequirementAnalysis;
  let plan: TestPlan;
  let suite: TestCaseSuite;
  try {
    analysis = body.analysis as RequirementAnalysis;
    plan = body.test_plan as TestPlan;
    suite = body.test_cases as TestCaseSuite;
    const a = validateAnalysis(analysis, ticketKey);
    const p = validateTestPlan(plan, analysis, ticketKey);
    const c = validateTestCases(suite, analysis, ticketKey);
    if (!a.ok || !p.ok || !c.ok) {
      return Response.json({
        error: [...a.errors, ...p.errors, ...c.errors].slice(0, 8).join(" ; ") || "upstream objects invalid",
      }, { status: 400 });
    }
  } catch (e) {
    return Response.json({ error: redact(settings, `invalid upstream objects: ${e}`) }, { status: 400 });
  }

  // SSE: stream the Playwright stage progress, then a single done event.
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: string, data: unknown) => {
        try { controller.enqueue(encoder.encode(sse(event, data))); } catch { /* client gone */ }
      };
      try {
        const pipeline = new QAPipeline(settings, (t, stage, status, message, duration) => {
          send("progress", { ticketKey: t, stage, status, message, duration });
        });
        const bundle = await pipeline.runPlaywrightOnly({ ticketKey, analysis, testPlan: plan, testCases: suite });
        send("done", { ticket_key: ticketKey, playwright: bundle, zip_b64: null });
      } catch (e) {
        send("error", { error: redact(settings, `${(e as Error).name}: ${e}`) });
      }
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
