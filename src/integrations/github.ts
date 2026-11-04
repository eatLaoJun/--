import path from "node:path";
import { readJson } from "../utils/paths.js";
import type { Ticket } from "../domain/types.js";
import { normalizeTicket, type LoadedTicket } from "./ticket.js";

interface GithubIssueFixture {
  issue?: {
    number?: number;
    title?: string;
    body?: string;
    html_url?: string;
    labels?: Array<string | { name?: string }>;
  };
  ticket?: Ticket;
}

interface ProjectMapping {
  projectId: string;
  repoName: string;
  repoTemplate: string;
  expected: string;
  commands: Record<string, string>;
  constraints?: Ticket["constraints"];
}

/**
 * GitHub issue adapter.
 *
 * Local fixture path: reads a JSON file (ticket fields + optional issue metadata).
 * URL/number: uses GITHUB_TOKEN and fixtures/github/projects.json to map a repo
 * to the authorized template + trusted commands. It never lets the issue text
 * choose the repository or commands.
 */
export async function loadGithubIssue(projectRoot: string, input: string): Promise<LoadedTicket> {
  const trimmed = input.trim();
  const local = path.isAbsolute(trimmed) ? trimmed : path.resolve(projectRoot, trimmed);
  if (!/^https?:\/\//i.test(trimmed) && !/^\d+$/.test(trimmed)) {
    const fixture = await readJson<GithubIssueFixture & Ticket>(local);
    if (!fixture) throw new Error(`GitHub issue fixture not found: ${input}`);
    if (fixture.ticket) {
      const ticket = applyIssueMetadata(fixture.ticket, fixture.issue);
      return normalizeTicket(projectRoot, ticket, input);
    }
    return normalizeTicket(projectRoot, fixture as Ticket, input);
  }

  const reference = parseGithubIssueReference(trimmed);
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    throw new Error(
      `GITHUB_TOKEN is required to fetch ${trimmed}. ` +
        `For local demos use fixtures/github/issue-101.json instead.`,
    );
  }
  const mapping = await loadProjectMapping(projectRoot, reference.ownerRepo);
  const response = await fetch(
    `https://api.github.com/repos/${reference.ownerRepo}/issues/${reference.number}`,
    {
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/vnd.github+json",
        "user-agent": "forgepilot",
      },
    },
  );
  if (!response.ok) {
    throw new Error(`GitHub API ${response.status}: ${await response.text()}`);
  }
  const issue = (await response.json()) as {
    number: number;
    title: string;
    body?: string;
    html_url: string;
    labels?: Array<{ name?: string }>;
  };
  const ticket: Ticket = {
    ticketId: `GH-${reference.ownerRepo.replace("/", "-")}-${issue.number}`,
    projectId: mapping.projectId,
    title: issue.title,
    description: issue.body || issue.title,
    expected: mapping.expected,
    repoName: mapping.repoName,
    repoTemplate: mapping.repoTemplate,
    issueUrl: issue.html_url,
    issueNumber: issue.number,
    commands: mapping.commands,
    constraints: mapping.constraints,
  };
  return normalizeTicket(projectRoot, ticket, trimmed);
}

function applyIssueMetadata(
  ticket: Ticket,
  issue?: GithubIssueFixture["issue"],
): Ticket {
  if (!issue) return ticket;
  return {
    ...ticket,
    title: ticket.title || issue.title || ticket.ticketId,
    description: ticket.description || issue.body || "",
    issueUrl: issue.html_url,
    issueNumber: issue.number,
  };
}

function parseGithubIssueReference(input: string): { ownerRepo: string; number: number } {
  if (/^\d+$/.test(input)) {
    throw new Error(`Issue number alone is ambiguous; pass a full GitHub issue URL.`);
  }
  const match = input.match(/github\.com\/([^/]+)\/([^/]+)\/issues\/(\d+)/i);
  if (!match) throw new Error(`Unsupported GitHub issue URL: ${input}`);
  return { ownerRepo: `${match[1]}/${match[2]}`, number: Number(match[3]) };
}

async function loadProjectMapping(projectRoot: string, ownerRepo: string): Promise<ProjectMapping> {
  const mappings = await readJson<Record<string, ProjectMapping>>(
    path.resolve(projectRoot, "fixtures/github/projects.json"),
  );
  const mapping = mappings?.[ownerRepo];
  if (!mapping) {
    throw new Error(
      `No project mapping for ${ownerRepo}. Add it to fixtures/github/projects.json ` +
        `(repoTemplate + trusted commands) before fetching issues.`,
    );
  }
  return mapping;
}
