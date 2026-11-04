import path from "node:path";
import type { Ticket, TaskConstraints, Budget } from "../domain/types.js";
import { createBudget } from "../domain/types.js";
import { readJson } from "../utils/paths.js";

export interface LoadedTicket {
  ticket: Ticket;
  templatePath: string;
  constraints: TaskConstraints;
  budget: Budget;
  commands: Record<string, string>;
}

export async function loadTicket(projectRoot: string, ticketFile: string): Promise<LoadedTicket> {
  const absolute = path.isAbsolute(ticketFile) ? ticketFile : path.resolve(projectRoot, ticketFile);
  const ticket = await readJson<Ticket>(absolute);
  if (!ticket) throw new Error(`Ticket not found: ${ticketFile}`);
  return normalizeTicket(projectRoot, ticket, ticketFile);
}

export function normalizeTicket(projectRoot: string, ticket: Ticket, source = "ticket"): LoadedTicket {
  if (!ticket.ticketId || !ticket.description) throw new Error(`Invalid ticket: ${source}`);
  const templatePath = ticket.repoTemplate
    ? path.isAbsolute(ticket.repoTemplate)
      ? ticket.repoTemplate
      : path.resolve(projectRoot, ticket.repoTemplate)
    : undefined;
  if (!templatePath) throw new Error(`Ticket ${ticket.ticketId} has no repoTemplate`);
  const commands = ticket.commands ?? {};
  if (!commands.test) throw new Error(`Ticket ${ticket.ticketId} must define a test command`);
  const constraints: TaskConstraints = {
    protectedPaths: ticket.constraints?.protectedPaths ?? ["tests/**", "scripts/**", ".eval/**"],
    allowedPaths: ticket.constraints?.allowedPaths ?? ["**"],
    notes: ticket.constraints?.notes ?? [],
    acceptance: ticket.constraints?.acceptance ?? [],
  };
  return {
    ticket,
    templatePath,
    constraints,
    budget: createBudget(ticket.budget ?? {}),
    commands,
  };
}
