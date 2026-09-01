# Jira QA Crew — Next.js

A faithful TypeScript port of the CrewAI QA pipeline (chapter_13), deployed on
Vercel as a Next.js app. Same logic, same agents, same prompts, same Jira and
Command Code integration — with a beige UI.

## Stack

- Next.js 16 (App Router), React 19, TypeScript
- `app/api/run/route.ts` — runs the full 4-agent pipeline synchronously
- Jira REST fetch, Command Code Provider API (`deepseek/deepseek-v4-flash`)
- Pydantic-style JSON validation in TS, same traceability math

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
```

## Local

```bash
npm install
npm run dev   # http://localhost:3000
```
