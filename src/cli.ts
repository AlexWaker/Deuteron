import { promises as fs } from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline/promises";

import { CliError } from "./output.js";

export interface ParsedArgs {
  positionals: string[];
  flags: Record<string, string | boolean>;
}

export function parseArgs(argv: string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags: Record<string, string | boolean> = {};

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];

    if (token === "--") {
      positionals.push(...argv.slice(index + 1));
      break;
    }

    if (!token.startsWith("--") || token === "--") {
      positionals.push(token);
      continue;
    }

    const [flagName, inlineValue] = token.slice(2).split("=", 2);
    if (!flagName) {
      throw new CliError("cli.flag_invalid", `Invalid flag: ${token}`);
    }

    if (inlineValue !== undefined) {
      flags[flagName] = inlineValue;
      continue;
    }

    const nextToken = argv[index + 1];
    if (nextToken !== undefined && !nextToken.startsWith("--")) {
      flags[flagName] = nextToken;
      index += 1;
      continue;
    }

    flags[flagName] = true;
  }

  return { positionals, flags };
}

export function normalizeParsedArgs(parsed: ParsedArgs): ParsedArgs {
  const positionals = [...parsed.positionals];

  if (positionals[0] === "wallet" && positionals[1]) {
    positionals[1] = normalizeWalletVerb(positionals[1]);
  }

  if (positionals.length >= 2 && positionals[1] === "wallet") {
    return {
      ...parsed,
      positionals: ["wallet", normalizeWalletVerb(positionals[0]), ...positionals.slice(2)],
    };
  }

  return {
    ...parsed,
    positionals,
  };
}

export function hasFlag(parsed: ParsedArgs, name: string): boolean {
  return parsed.flags[name] !== undefined;
}

export function getStringFlag(parsed: ParsedArgs, name: string): string | undefined {
  const value = parsed.flags[name];
  return typeof value === "string" ? value : undefined;
}

export function requireStringFlag(parsed: ParsedArgs, name: string, usage: string): string {
  const value = getStringFlag(parsed, name);
  if (!value) {
    throw new CliError("cli.flag_required", `Missing required flag --${name}\n${usage}`);
  }

  return value;
}

export function ensurePositionals(parsed: ParsedArgs, count: number, usage: string): void {
  if (parsed.positionals.length !== count) {
    throw new CliError("cli.usage", usage);
  }
}

export async function readSensitiveInput(parsed: ParsedArgs, usage: string): Promise<string> {
  const fromStdin = hasFlag(parsed, "from-stdin");
  const fromFile = getStringFlag(parsed, "from-file");

  if ((fromStdin ? 1 : 0) + (fromFile ? 1 : 0) !== 1) {
    throw new CliError(
      "cli.input_source_required",
      `Exactly one of --from-stdin or --from-file must be provided\n${usage}`,
    );
  }

  if (fromFile) {
    try {
      return await fs.readFile(path.resolve(fromFile), "utf8");
    } catch (error) {
      throw new CliError(
        "cli.input_read_failed",
        `Failed to read input file: ${fromFile}`,
        error instanceof Error ? { cause: error.message } : undefined,
      );
    }
  }

  const content = await readAllStdin();
  if (!content.trim()) {
    throw new CliError("cli.stdin_empty", "No input was received from stdin");
  }

  return content;
}

export async function requireConfirmation(parsed: ParsedArgs, message: string): Promise<void> {
  if (hasFlag(parsed, "yes")) {
    return;
  }

  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new CliError(
      "cli.confirmation_required",
      `This command requires explicit confirmation. Re-run with --yes to proceed.\n${message}`,
    );
  }

  const prompt = createInterface({ input: process.stdin, output: process.stdout });

  try {
    const answer = await prompt.question(`${message} [y/N] `);
    if (!/^y(es)?$/i.test(answer.trim())) {
      throw new CliError("cli.confirmation_rejected", "Operation cancelled by user", undefined, 130);
    }
  } finally {
    prompt.close();
  }
}

export async function requireSensitiveAuthorization(
  level: 2 | 3 | 4,
  action: string,
): Promise<void> {
  if (process.platform !== "darwin") {
    return;
  }

  try {
    await runSecurityAuthorize("system.privilege.admin");
  } catch (error) {
    if (isSecurityAuthorizationCancelled(error)) {
      throw new CliError(
        "cli.authorization_rejected",
        `Sensitive level ${level} authorization was cancelled by the user for: ${action}`,
        { level, action },
        130,
      );
    }

    throw new CliError(
      "cli.authorization_failed",
      `macOS authorization failed for sensitive level ${level} action: ${action}`,
      {
        level,
        action,
        cause: error instanceof Error ? error.message : String(error),
      },
    );
  }
}

export async function writeSensitiveOutput(filePath: string, value: string): Promise<string> {
  const resolvedPath = path.resolve(filePath);
  await fs.mkdir(path.dirname(resolvedPath), { recursive: true, mode: 0o700 });
  await fs.writeFile(resolvedPath, value.endsWith("\n") ? value : `${value}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  return resolvedPath;
}

async function readAllStdin(): Promise<string> {
  const chunks: Buffer[] = [];

  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }

  return Buffer.concat(chunks).toString("utf8");
}

async function runSecurityAuthorize(right: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn("security", ["authorize", "-u", right], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    child.stdout.on("data", (chunk) => {
      stdoutChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });

    child.stderr.on("data", (chunk) => {
      stderrChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });

    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }

      const stdout = Buffer.concat(stdoutChunks).toString("utf8").trim();
      const stderr = Buffer.concat(stderrChunks).toString("utf8").trim();
      reject(
        Object.assign(
          new Error(stderr || stdout || `security authorize exited with code ${code ?? -1}`),
          {
            code,
            stdout,
            stderr,
          },
        ),
      );
    });
  });
}

function isSecurityAuthorizationCancelled(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (("stderr" in error &&
      typeof error.stderr === "string" &&
      /cancel|canceled|cancelled/i.test(error.stderr)) ||
      ("message" in error &&
        typeof error.message === "string" &&
        /cancel|canceled|cancelled/i.test(error.message)))
  );
}

function normalizeWalletVerb(value: string): string {
  switch (value) {
    case "delete":
      return "remove";
    case "list":
      return "ls";
    default:
      return value;
  }
}