# Jira QA Crew — Next.js

A faithful TypeScript port of the CrewAI QA pipeline (chapter_13), deployed on
Vercel as a Next.js app. Same logic, same agents, same prompts, same Jira and
Command Code integration — with a beige UI.

## Stack

- Next.js 16 (App Router), React 19, TypeScript
- `app/api/run/route.ts` — runs the pipeline synchronously (SSE streaming)
- `app/api/run/code/route.ts` — runs only the Playwright code stage on demand
- Jira REST fetch, Command Code Provider API (`deepseek/deepseek-v4-flash`)
- Pydantic-style JSON validation in TS, same traceability math

## Pipeline

Four sequential agent stages, streamed live to the UI with per-stage timers and
a collapsible per-stage output:

1. **Jira Fetch** — fetch the ticket from Jira REST
2. **Jira Analyst** — requirements analysis (REQ-*, AC-*, provenance)
3. **Test Plan Writer** — the 12-section test plan
4. **Test Case Writer** — detailed test cases with coverage
5. **Playwright Coder** — Playwright TypeScript (the slowest stage)
6. **Artifacts** — coverage report + downloads (markdown/CSV/ZIP incl. `.ts`)

## Vercel timeout handling (split mode)

Vercel's Hobby functions have a hard **300s limit**. A full run of all 4 LLM
stages can exceed that — the Playwright stage is the longest and the usual
cause of a timeout.

Set **`SPLIT_PLAYWRIGHT=1`** in the Vercel project to split the run:

- The main run stops after **Test Cases** (~3 min, fits the limit), and the
  ticket shows a warning with a **"Generate Playwright Code"** button.
- Clicking it calls `/api/run/code`, which runs **only** the Playwright stage
  (~1–2 min) in a fresh request, so it never exceeds 300s.
- Per-stage elapsed timers and a timeout notice make the limits visible.

Locally (or with `SPLIT_PLAYWRIGHT` unset) the full pipeline runs in one
request with no timeout.

## Env vars (Vercel project)

```
LLM_MODEL=deepseek/deepseek-v4-flash
LLM_API_KEY=<command code key>
LLM_BASE_URL=https://api.commandcode.ai/provider/v1
LLM_MAX_TOKENS=16000
JIRA_INTEGRATION_MODE=rest
JIRA_URL=https://your-domain.atlassian.net
JIRA_EMAIL=you@example.com
JIRA_API_TOKEN=<jira token>

# Optional: split the Playwright stage into its own request (recommended on Vercel)
SPLIT_PLAYWRIGHT=1
```

## Local

```bash
npm install
npm run dev   # http://localhost:3000
```

To test split mode locally, add `SPLIT_PLAYWRIGHT=1` to `.env.local` and
restart the dev server.
