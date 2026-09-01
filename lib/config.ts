// Settings — faithful TS port of src/jira_qa_crew/config.py
// Reads from process.env (Vercel env vars). Nothing secret is exposed.

export type IntegrationMode = "auto" | "mcp" | "rest";
export type AuthMode = "basic" | "bearer";
export type StructuredOutputMode = "auto" | "schema" | "prompt";

const MIN_SECRET_LENGTH = 8;

function env(key: string, def = ""): string {
  return (process.env[key] ?? def).trim();
}
function envBool(key: string, def = false): boolean {
  const raw = env(key);
  if (!raw) return def;
  return ["1", "true", "yes", "on"].includes(raw.toLowerCase());
}
function envInt(key: string, def: number): number {
  const raw = env(key);
  if (!raw) return def;
  const n = parseInt(raw, 10);
  return Number.isNaN(n) ? def : n;
}
function envFloat(key: string, def: number): number {
  const raw = env(key);
  if (!raw) return def;
  const n = parseFloat(raw);
  return Number.isNaN(n) ? def : n;
}

export interface Settings {
  appName: string;
  outputDir: string;
  demoMode: boolean;

  llmModel: string;
  llmApiKey: string;
  llmBaseUrl: string;
  llmTemperature: number;
  llmMaxTokens: number;
  llmStructuredOutput: StructuredOutputMode;

  jiraIntegrationMode: IntegrationMode;
  jiraUrl: string;
  jiraAuthMode: AuthMode;
  jiraEmail: string;
  jiraApiToken: string;
  jiraBearerToken: string;
  jiraApiVersion: string;
  jiraAcceptanceCriteriaField: string;
  jiraIncludeComments: boolean;
  jiraMaxComments: number;
  jiraTimeoutSeconds: number;
  jiraKeyPattern: string;

  pipelineMaxTickets: number;
  pipelineMaxRetries: number;
  pipelineTicketTimeoutSeconds: number;
  pipelineMaxInputChars: number;
}

export function loadSettings(): Settings {
  const temperature = envFloat("LLM_TEMPERATURE", 0.1);
  return {
    appName: env("APP_NAME", "Jira QA Crew"),
    outputDir: env("OUTPUT_DIR", "outputs"),
    demoMode: envBool("DEMO_MODE", false),
    llmModel: env("LLM_MODEL", "deepseek/deepseek-v4-flash"),
    llmApiKey: env("LLM_API_KEY") || env("DEEPSEEK_API_KEY"),
    llmBaseUrl: env("LLM_BASE_URL", "https://api.commandcode.ai/provider/v1"),
    llmTemperature: temperature,
    llmMaxTokens: envInt("LLM_MAX_TOKENS", 16000),
    llmStructuredOutput: (env("LLM_STRUCTURED_OUTPUT", "auto") as StructuredOutputMode),
    jiraIntegrationMode: (env("JIRA_INTEGRATION_MODE", "auto") as IntegrationMode),
    jiraUrl: env("JIRA_URL").replace(/\/+$/, ""),
    jiraAuthMode: (env("JIRA_AUTH_MODE", "basic") as AuthMode),
    jiraEmail: env("JIRA_EMAIL"),
    jiraApiToken: env("JIRA_API_TOKEN"),
    jiraBearerToken: env("JIRA_BEARER_TOKEN"),
    jiraApiVersion: env("JIRA_API_VERSION", "3"),
    jiraAcceptanceCriteriaField: env("JIRA_ACCEPTANCE_CRITERIA_FIELD"),
    jiraIncludeComments: envBool("JIRA_INCLUDE_COMMENTS", false),
    jiraMaxComments: envInt("JIRA_MAX_COMMENTS", 20),
    jiraTimeoutSeconds: envInt("JIRA_TIMEOUT_SECONDS", 30),
    jiraKeyPattern: env("JIRA_KEY_PATTERN", "^[A-Z][A-Z0-9_]+-\\d+$"),
    pipelineMaxTickets: envInt("PIPELINE_MAX_TICKETS", 20),
    pipelineMaxRetries: envInt("PIPELINE_MAX_RETRIES", 2),
    pipelineTicketTimeoutSeconds: envInt("PIPELINE_TICKET_TIMEOUT_SECONDS", 600),
    pipelineMaxInputChars: envInt("PIPELINE_MAX_INPUT_CHARS", 4000),
  };
}

export function llmReady(s: Settings): boolean {
  return Boolean(s.llmModel && s.llmApiKey);
}

export function restReady(s: Settings): boolean {
  if (!s.jiraUrl) return false;
  if (s.jiraAuthMode === "basic") return Boolean(s.jiraEmail && s.jiraApiToken);
  return Boolean(s.jiraBearerToken);
}

export function secrets(s: Settings): string[] {
  const out: string[] = [];
  for (const v of [s.llmApiKey, s.jiraApiToken, s.jiraBearerToken]) {
    if (v && v.length >= MIN_SECRET_LENGTH) out.push(v);
  }
  return out;
}

export function redact(s: Settings, text: string): string {
  if (!text) return text;
  let cleaned = text;
  for (const secret of secrets(s)) {
    cleaned = cleaned.split(secret).join("***REDACTED***");
  }
  cleaned = cleaned.replace(/(Basic|Bearer)\s+[A-Za-z0-9+/=_\-.]{8,}/g, "$1 ***REDACTED***");
  return cleaned;
}

export function blockingProblems(s: Settings): string[] {
  const problems: string[] = [];
  if (s.demoMode) return problems;
  if (!llmReady(s)) {
    problems.push("LLM is not configured. Set LLM_MODEL and LLM_API_KEY.");
  }
  if (s.jiraIntegrationMode === "rest" && !restReady(s)) {
    problems.push("Integration mode is 'rest' but Jira REST settings are incomplete (JIRA_URL plus credentials).");
  } else if (s.jiraIntegrationMode === "auto" && !restReady(s)) {
    problems.push("Integration mode is 'auto' but REST is not configured, so no ticket can be fetched.");
  }
  return problems;
}
