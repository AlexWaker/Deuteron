import process from "node:process";

import boxen from "boxen";
import figlet from "figlet";
import gradient from "gradient-string";
import prompts from "prompts";

import type { ParsedArgs } from "./cli.js";
import { CliError } from "./output.js";
import { loadState, saveState } from "./state.js";

const INIT_REQUIRED_COMMANDS = new Set(["wallet"]);

export interface InitFlowOptions {
  force?: boolean;
  skipPrompt?: boolean;
  jsonMode?: boolean;
  printIntro?: boolean;
}

export interface InitFlowResult {
  alreadyInitialized: boolean;
  isInitialized: true;
}

export async function runInitializationFlow(options: InitFlowOptions = {}): Promise<InitFlowResult> {
  const state = await loadState();

  if (state.isInitialized && !options.force) {
    return {
      alreadyInitialized: true,
      isInitialized: true,
    };
  }

  if (options.printIntro && !options.jsonMode) {
    process.stdout.write(`${renderBanner()}\n`);
    process.stdout.write(`${renderNotice()}\n`);
  }

  if (!options.skipPrompt) {
    await promptForAgreement();
  }

  state.isInitialized = true;
  await saveState(state);

  return {
    alreadyInitialized: false,
    isInitialized: true,
  };
}

export async function ensureInitializedForCommand(
  parsed: ParsedArgs,
  options: Pick<InitFlowOptions, "jsonMode" | "skipPrompt">,
): Promise<void> {
  const [command] = parsed.positionals;

  if (!command || !INIT_REQUIRED_COMMANDS.has(command)) {
    return;
  }

  const state = await loadState();
  if (state.isInitialized) {
    return;
  }

  if (options.jsonMode && !options.skipPrompt) {
    throw new CliError(
      "cli.not_initialized",
      "Deuteron is not initialized yet. Run `deu init` first, or re-run with --yes to accept the onboarding flow.",
    );
  }

  if ((!process.stdin.isTTY || !process.stdout.isTTY) && !options.skipPrompt) {
    throw new CliError(
      "cli.not_initialized",
      "Deuteron is not initialized yet. Run `deu init --yes` once in a trusted terminal before using wallet commands.",
    );
  }

  await runInitializationFlow({
    skipPrompt: options.skipPrompt,
    jsonMode: options.jsonMode,
    printIntro: !options.jsonMode,
  });
}

function renderBanner(): string {
  const banner = figlet.textSync("DEUTERON", {
    font: "ANSI Shadow",
    horizontalLayout: "full",
  });

  return gradient(["#7dd3fc", "#38bdf8", "#34d399", "#f59e0b"]).multiline(banner);
}

function renderNotice(): string {
  const message = [
    "Architecture",
    "- Deuteron uses a local CLI plus a background agent for sensitive wallet actions.",
    "- Sensitive material is stored in your local Keychain instead of plain files or shell history.",
    "",
    "Security Notice",
    "- Mnemonics and private keys should never be pasted into normal shell arguments.",
    "- Export commands reveal plaintext secrets and should only be used on a trusted machine.",
    "- Losing access to your login Keychain or exported backup can permanently lock you out of funds.",
    "",
    "Agreement",
    "- Type y or I Agree to continue.",
  ].join("\n");

  return boxen(message, {
    padding: 1,
    borderStyle: "round",
    borderColor: "yellow",
    title: "Deuteron Onboarding",
    titleAlignment: "center",
  });
}

async function promptForAgreement(): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new CliError(
      "cli.confirmation_required",
      "Onboarding requires an interactive terminal. Re-run with --yes if you want to accept the disclaimer non-interactively.",
    );
  }

  const response = await prompts({
    type: "text",
    name: "agreement",
    message: "Type y or I Agree to continue",
    validate: (value: string) => {
      const normalized = value.trim().toLowerCase();
      return normalized === "y" || normalized === "i agree"
        ? true
        : "Please type y or I Agree.";
    },
  });

  const normalized = typeof response.agreement === "string" ? response.agreement.trim().toLowerCase() : "";
  if (normalized !== "y" && normalized !== "i agree") {
    throw new CliError("cli.confirmation_rejected", "Initialization cancelled by user", undefined, 130);
  }
}