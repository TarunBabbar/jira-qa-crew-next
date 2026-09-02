import { NextResponse } from "next/server";

import { loadSettings, llmReady, restReady } from "@/lib/config";

export const dynamic = "force-dynamic";

function mask(value: string): string {
  if (!value) return "not set";
  if (value.length <= 4) return "set";
  return `set (…${value.slice(-4)})`;
}

export async function GET() {
  const s = loadSettings();
  return NextResponse.json({
    llm: {
      ready: llmReady(s),
      model: s.llmModel || "not set",
      api_key: mask(s.llmApiKey),
      temperature: s.llmTemperature,
      structured_output: s.llmStructuredOutput,
    },
    jiraRest: {
      ready: restReady(s),
      url: s.jiraUrl || "not set",
      auth_mode: s.jiraAuthMode,
      email: mask(s.jiraEmail),
      token: mask(s.jiraApiToken || s.jiraBearerToken),
    },
    pipeline: {
      mode: s.jiraIntegrationMode,
      max_tickets: s.pipelineMaxTickets,
      demo_mode: s.demoMode,
      split_playwright: s.splitPlaywright,
      output_dir: s.outputDir,
    },
  });
}
