// Jira REST client — faithful TS port of src/jira_qa_crew/jira/rest_provider.py
// Fetch issue via REST API v3, normalize ADF to plain text.

import type { Settings } from "./config";
import type { JiraIssue, JiraSource } from "./models";

export class JiraError extends Error {
  status?: number;
  providerErrors?: Record<string, string>;
  constructor(message: string, status?: number, providerErrors?: Record<string, string>) {
    super(message);
    this.status = status;
    this.providerErrors = providerErrors;
  }
}

const FIELDS =
  "summary,description,issuetype,status,priority,labels,components," +
  "parent,subtasks,issuelinks,comment";

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

// ---------------------------------------------------------------------------
// ADF -> text (port of jira/adf.py normalize_text)
// ---------------------------------------------------------------------------
type ADFNode = {
  type?: string;
  text?: string;
  content?: ADFNode[];
  attrs?: Record<string, unknown>;
};

export function normalizeAdf(input: unknown): string {
  if (typeof input === "string") return input.trim();
  if (input && typeof input === "object" && (input as ADFNode).type === "doc") {
    return flattenAdf(input as ADFNode).trim();
  }
  return "";
}

function flattenAdf(node: ADFNode): string {
  const parts: string[] = [];
  const blockTypes = new Set([
    "paragraph", "heading", "codeBlock", "blockquote", "rule",
    "panel", "listItem", "bulletList", "orderedList", "tableRow", "table",
  ]);
  for (const child of node.content ?? []) {
    const text = child.text ?? flattenAdf(child);
    parts.push(text);
    if (blockTypes.has(child.type ?? "")) parts.push("\n");
  }
  return parts.join(" ");
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------
export class JiraRestProvider {
  constructor(private settings: Settings) {}

  private base(): string {
    return `${this.settings.jiraUrl}/rest/api/${this.settings.jiraApiVersion}`;
  }

  private auth(): { headers?: Record<string, string>; auth?: [string, string] } {
    if (this.settings.jiraAuthMode === "bearer") {
      return { headers: { Authorization: `Bearer ${this.settings.jiraBearerToken}` } };
    }
    return { auth: [this.settings.jiraEmail, this.settings.jiraApiToken] };
  }

  async healthCheck(): Promise<[boolean, string]> {
    if (!this.settings.jiraUrl) return [false, "REST is not configured"];
    try {
      await this.request("/myself");
      return [true, `REST reachable at ${this.settings.jiraUrl}`];
    } catch (e) {
      return [false, e instanceof Error ? e.message : String(e)];
    }
  }

  async fetchIssue(issueKey: string): Promise<JiraIssue> {
    const params = new URLSearchParams({ fields: FIELDS });
    if (this.settings.jiraAcceptanceCriteriaField) {
      params.set("fields", `${FIELDS},${this.settings.jiraAcceptanceCriteriaField}`);
    }
    const payload = await this.request(`/issue/${encodeURIComponent(issueKey)}?${params}`);
    if (!payload || typeof payload !== "object" || !("fields" in payload)) {
      throw new JiraError(`Jira REST response for ${issueKey} has no 'fields' object`);
    }
    return buildIssueFromRest(payload as Record<string, any>, this.settings, "REST");
  }

  private async request(path: string): Promise<unknown> {
    const { headers, auth } = this.auth();
    const url = `${this.base()}${path}`;
    const attempts = Math.max(1, this.settings.pipelineMaxRetries);
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        const requestHeaders: Record<string, string> = { Accept: "application/json", ...(headers ?? {}) };
        if (auth) {
          requestHeaders.Authorization = "Basic " + Buffer.from(auth.join(":")).toString("base64");
        }
        const res = await fetch(url, {
          headers: requestHeaders,
          signal: AbortSignal.timeout(this.settings.jiraTimeoutSeconds * 1000),
        });
        if (res.status === 401 || res.status === 403) {
          throw new JiraError(
            `Jira rejected the credentials (HTTP ${res.status}). Check JIRA_EMAIL/JIRA_API_TOKEN.`,
            res.status
          );
        }
        if (res.status === 404) {
          throw new JiraError("Issue not found, or this account cannot see it (HTTP 404).", 404);
        }
        if (res.status >= 400) {
          const text = await res.text().catch(() => "");
          if (!RETRYABLE_STATUS.has(res.status)) {
            throw new JiraError(`Jira REST returned HTTP ${res.status}: ${text.slice(0, 300)}`, res.status);
          }
          lastError = new JiraError(`Jira REST returned HTTP ${res.status}`, res.status);
        } else {
          return await res.json();
        }
      } catch (e) {
        if (e instanceof JiraError && (e.status === 401 || e.status === 403 || e.status === 404)) throw e;
        if (e instanceof Error && e.name === "TimeoutError") {
          lastError = new JiraError(`Jira REST timed out after ${this.settings.jiraTimeoutSeconds}s`);
        } else if (e instanceof JiraError) {
          lastError = e;
        } else {
          lastError = new JiraError(`Jira REST connection failed: ${e}`);
        }
      }
      if (attempt < attempts) {
        await new Promise((r) => setTimeout(r, Math.min(2 ** (attempt - 1), 8) * 1000));
      }
    }
    throw lastError ?? new JiraError("Jira REST failed for an unknown reason");
  }
}

// ---------------------------------------------------------------------------
// Payload mapping (port of build_issue_from_rest)
// ---------------------------------------------------------------------------
function nameOf(container: unknown): string {
  if (container && typeof container === "object") {
    const c = container as Record<string, unknown>;
    return String(c.name ?? c.displayName ?? "");
  }
  return "";
}

export function buildIssueFromRest(
  payload: Record<string, any>,
  settings: Settings,
  source: JiraSource
): JiraIssue {
  const fields = payload.fields ?? {};
  const key = String(payload.key ?? "");
  if (!key) throw new JiraError("Issue payload has no 'key'");

  const links: string[] = [];
  for (const link of fields.issuelinks ?? []) {
    if (!link || typeof link !== "object") continue;
    const linkType = (link.type?.name ?? "relates to") as string;
    for (const dir of ["inwardIssue", "outwardIssue"]) {
      const target = link[dir];
      if (target && typeof target === "object" && target.key) {
        links.push(`${linkType}: ${target.key}`);
      }
    }
  }

  const comments: string[] = [];
  if (settings.jiraIncludeComments) {
    const raw = fields.comment?.comments ?? [];
    for (const comment of raw.slice(0, settings.jiraMaxComments)) {
      const author = nameOf(comment.author) || "unknown";
      const body = normalizeAdf(comment.body);
      if (body) comments.push(`${author}: ${body}`);
    }
  }

  let acceptance = "";
  if (settings.jiraAcceptanceCriteriaField) {
    acceptance = normalizeAdf(fields[settings.jiraAcceptanceCriteriaField]);
  }

  const parent = fields.parent;
  return {
    key,
    summary: String(fields.summary ?? ""),
    description: normalizeAdf(fields.description),
    issue_type: nameOf(fields.issuetype),
    status: nameOf(fields.status),
    priority: nameOf(fields.priority),
    labels: (fields.labels ?? []).map(String),
    components: (fields.components ?? []).map(nameOf).filter(Boolean),
    parent: parent && typeof parent === "object" ? String(parent.key) : null,
    subtasks: (fields.subtasks ?? []).filter((s: any) => s && typeof s === "object" && s.key).map((s: any) => String(s.key)),
    linked_issues: links,
    acceptance_criteria_raw: acceptance,
    comments,
    url: settings.jiraUrl ? `${settings.jiraUrl}/browse/${key}` : "",
    source,
    raw_fields: {
      summary: fields.summary, issuetype: fields.issuetype,
      status: fields.status, priority: fields.priority, labels: fields.labels,
    },
  };
}
