import { parseArgs, type ParseArgsConfig } from "node:util";
import { ConfigError, loadConfig } from "../config.js";
import { createDb, type Db } from "../db/client.js";
import { OPERATOR_ACTOR, TransitionError } from "../db/transition.js";
import { CampaignConnectorError, type ConnectorDeps } from "../modules/campaign-connector/index.js";
import { CampaignsError } from "../modules/campaigns/index.js";
import { BriefReaderError } from "../modules/brief-reader/index.js";
import { InvalidConfigError } from "../modules/campaign-config/index.js";
import { campaignCommands } from "./commands/campaign.js";
import { guardCommands } from "./commands/guard.js";

// Every command prints one JSON document to stdout. Failures print
// {"error":{"code","message"}} and exit non-zero, so the operator playbook can
// branch on the code. Every write made through the CLI is attributed to the operator.

export class UsageError extends Error {}

export type CommandContext = {
  /** Opens the database on first use; read-only commands that don't need it never connect. */
  db: () => Db;
  actor: string;
  connector: ConnectorDeps;
  positionals: string[];
  options: Record<string, string | boolean | undefined>;
  stdin: () => Promise<string>;
};

export type Command = {
  summary: string;
  usage: string;
  options?: ParseArgsConfig["options"];
  run: (ctx: CommandContext) => Promise<unknown>;
  /** Exit code on success (default 0). */
  exitCode?: (result: unknown) => number;
};

const groups: Record<string, Record<string, Command>> = {
  campaign: campaignCommands,
  guard: guardCommands,
};

export type RunDeps = {
  env?: NodeJS.ProcessEnv;
  db?: Db;
  connector?: ConnectorDeps;
  stdin?: () => Promise<string>;
};

export type RunResult = { exitCode: number; output: unknown };

function help(): unknown {
  return {
    usage: "clipper <group> <command> [args] [--options]",
    commands: Object.fromEntries(
      Object.entries(groups).flatMap(([g, cmds]) =>
        Object.entries(cmds).map(([name, c]) => [`${g} ${name}`, { usage: c.usage, summary: c.summary }]),
      ),
    ),
  };
}

function errorResult(code: string, message: string, exitCode = 1): RunResult {
  return { exitCode, output: { error: { code, message } } };
}

export async function run(argv: string[], deps: RunDeps = {}): Promise<RunResult> {
  const [group, name, ...rest] = argv;
  if (!group || group === "help" || group === "--help") return { exitCode: 0, output: help() };
  const command = groups[group]?.[name ?? ""];
  if (!command) return errorResult("usage", `Unknown command: ${[group, name].filter(Boolean).join(" ")}. Run \`clipper help\`.`);

  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({ args: rest, options: command.options ?? {}, allowPositionals: true, strict: true });
  } catch (err) {
    return errorResult("usage", `${(err as Error).message}. Usage: clipper ${group} ${name} ${command.usage}`);
  }

  let opened: { db: Db; pool?: { end(): Promise<void> } } | undefined;
  const ctx: CommandContext = {
    db: () => {
      if (!opened) {
        if (deps.db) opened = { db: deps.db };
        else {
          const { DATABASE_URL } = loadConfig(["db"], deps.env ?? process.env);
          opened = createDb(DATABASE_URL);
        }
      }
      return opened.db;
    },
    actor: OPERATOR_ACTOR,
    connector: deps.connector ?? {},
    positionals: parsed.positionals,
    options: parsed.values as CommandContext["options"],
    stdin: deps.stdin ?? readStdin,
  };

  try {
    const output = await command.run(ctx);
    return { exitCode: command.exitCode?.(output) ?? 0, output };
  } catch (err) {
    if (err instanceof UsageError) return errorResult("usage", `${err.message}. Usage: clipper ${group} ${name} ${command.usage}`);
    if (err instanceof ConfigError) return errorResult("config", err.message);
    if (err instanceof InvalidConfigError) {
      return { exitCode: 1, output: { error: { code: err.code, message: err.message, issues: err.issues } } };
    }
    if (
      err instanceof CampaignsError ||
      err instanceof TransitionError ||
      err instanceof CampaignConnectorError ||
      err instanceof BriefReaderError
    ) {
      return errorResult(err.code, err.message);
    }
    return errorResult("internal", (err as Error).stack ?? String(err));
  } finally {
    await opened?.pool?.end();
  }
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

// Small helpers for command implementations.
export function positional(ctx: CommandContext, index: number, name: string): string {
  const value = ctx.positionals[index];
  if (!value) throw new UsageError(`Missing <${name}>`);
  return value;
}

export function requiredOption(ctx: CommandContext, name: string): string {
  const value = ctx.options[name];
  if (typeof value !== "string" || !value.trim()) throw new UsageError(`Missing --${name}`);
  return value;
}
