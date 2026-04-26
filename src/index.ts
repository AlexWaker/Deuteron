#!/usr/bin/env node

import process from "node:process";

// import { getBundledBinaryPath, RUNTIME_ROOT, SOCKET_PATH, STAGED_BINARY_PATH } from "./config.js";
import {
  getBundledBinaryPath,
  RUNTIME_ROOT,
  SOCKET_PATH,
  STAGED_BINARY_PATH,
  STATE_PATH,
} from "./config.js";
import {
  getAgentStatus,
  hasStagedBinary,
  pingAgent,
  startAgent,
  stopAgent,
} from "./agent.js";
import {
  ensurePositionals,
  getStringFlag,
  hasFlag,
  normalizeParsedArgs,
  parseArgs,
  readSensitiveInput,
  requireConfirmation,
  requireSensitiveAuthorization,
  requireStringFlag,
  writeSensitiveOutput,
  type ParsedArgs,
} from "./cli.js";
import { ensureInitializedForCommand, runInitializationFlow } from "./onboarding.js";
import { handleLendCommand } from "./lend.js";
import {
  CliError,
  failure,
  renderContextTable,
  renderListTable,
  renderTable,
  success,
} from "./output.js";
import { loadState } from "./state.js";
import {
  createHdWallet,
  deriveWallet,
  exportMnemonic,
  exportPrivateKey,
  getCurrentWalletContext,
  getWalletCounts,
  importMnemonicWallet,
  importPrivateKeyWallet,
  listWallets,
  removeWallet,
  renameWallet,
  switchWallet,
} from "./wallet.js";

const VERSION = "0.1.0";
const HELP_TEXT = `Deuteron wallet CLI

Usage:
  deu help [--json]
  deu init [--force] [--yes] [--json]
  deu version [--json]
  deu doctor [--json]
  deu ping [--json]
  deu agent start [--json]
  deu agent status [--json]
  deu agent stop [--json]
  deu wallet create [--alias <name>] [--yes] [--json]
  deu wallet import mnemonic [--alias <name>] (--from-stdin | --from-file <path>) [--yes] [--json]
  deu wallet import private-key --chain <chain> [--alias <name>] (--from-stdin | --from-file <path>) [--yes] [--json]
  deu wallet derive --from <name> [--alias <name>] [--yes] [--json]
  deu wallet ls [--chain <chain>] [--json]
  deu wallet switch --alias <name> [--chain <chain>] [--json]
  deu wallet current [--json]
  deu wallet rename --alias <old-name> --new-alias <new-name> [--json]
  deu wallet remove --alias <name> [--yes] [--json]
  deu wallet export mnemonic --alias <name> [--to-file <path>] [--yes] [--json]
  deu wallet export private-key --alias <name> [--chain <chain>] [--to-file <path>] [--yes] [--json]
  deu lend earn tokens [--source <api|sdk|auto>] [--api-key <key>] [--rpc <url>] [--json]
  deu lend earn positions [--owner <address> | --current] [--source <api|sdk|auto>] [--api-key <key>] [--rpc <url>] [--json]
  deu lend earn earnings [--owner <address> | --current] --positions <mint1,mint2,...> [--api-key <key>] [--json]
  deu lend earn preview --asset <mint> [--assets-raw <int>] [--shares-raw <int>] [--rpc <url>] [--json]
  deu lend earn <deposit|withdraw|mint|redeem> build ... [--json]
  deu lend borrow vaults [--rpc <url>] [--json]
  deu lend borrow vault --vault-id <id> [--rpc <url>] [--json]
  deu lend borrow positions [--owner <address> | --current] [--rpc <url>] [--json]
  deu lend borrow position --vault-id <id> --position-id <nft_id> [--rpc <url>] [--json]
  deu lend borrow <create-position|deposit|borrow|repay|withdraw|liquidate> build ... [--json]

Development:
  pnpm deu init --yes --json
  pnpm deu create wallet --yes --json

All commands accept --json for machine-readable output.`;

interface CommandResult<T = unknown> {
  code: string;
  data: T;
  human: string;
}

registerPipeSafeExit();

async function main(): Promise<void> {
  const parsed = normalizeParsedArgs(parseArgs(process.argv.slice(2)));
  const jsonMode = hasFlag(parsed, "json");

  try {
    await ensureInitializedForCommand(parsed, {
      jsonMode,
      skipPrompt: hasFlag(parsed, "yes"),
    });
    const result = await dispatch(parsed, jsonMode);
    emitSuccess(result, jsonMode);
  } catch (error) {
    emitFailure(error, jsonMode);
    process.exitCode = error instanceof CliError ? error.exitCode : 1;
  }
}

async function dispatch(parsed: ParsedArgs, jsonMode: boolean): Promise<CommandResult> {
  const [command, subcommand, action, detail] = parsed.positionals;

  switch (command) {
    case undefined:
    case "help":
    case "--help":
    case "-h":
      return {
        code: "cli.help",
        data: { text: HELP_TEXT },
        human: HELP_TEXT,
      };

    case "version":
    case "--version":
    case "-v":
      return {
        code: "cli.version",
        data: { name: "deu", version: VERSION },
        human: `deu ${VERSION}`,
      };

    case "init":
      ensurePositionals(parsed, 1, "Usage: deu init [--force] [--yes] [--json]");
      return handleInitCommand(parsed, jsonMode);

    case "doctor":
      ensurePositionals(parsed, 1, "Usage: deu doctor [--json]");
      return handleDoctorCommand();

    case "ping":
      ensurePositionals(parsed, 1, "Usage: deu ping [--json]");
      return handlePingCommand();

    case "agent":
      return handleAgentCommand(parsed, subcommand);

    case "wallet":
      return handleWalletCommand(parsed, subcommand, action);

    case "lend":
      return handleLendCommand(parsed, subcommand, action, detail);

    default:
      throw new CliError("cli.command_unknown", `Unknown command: ${command}\n${HELP_TEXT}`);
  }
}

async function handleDoctorCommand(): Promise<CommandResult> {
  const walletCounts = await getWalletCounts();
  // const agent = await getAgentStatus();
  const agent = await getAgentStatus();
  const state = await loadState();
  const data = {
    name: "deu",
    version: VERSION,
    platform: process.platform,
    arch: process.arch,
    runtimeRoot: RUNTIME_ROOT,
    statePath: STATE_PATH,
    socketPath: SOCKET_PATH,
    bundledBinaryPath: getBundledBinaryPath(),
    stagedBinaryPath: STAGED_BINARY_PATH,
    stagedBinaryReady: hasStagedBinary(),
    // isInitialized: (await import("./state.js")).then ? undefined : undefined,
    isInitialized: state.isInitialized ?? false,
    walletCounts,
    agent,
  };

  const human = renderTable([
    ["Field", "Value"],
    ["Name", "deu"],
    ["Version", VERSION],
    ["Platform", `${process.platform}-${process.arch}`],
    ["Runtime Root", RUNTIME_ROOT],
    ["State Path", STATE_PATH],
    ["Socket Path", SOCKET_PATH],
    ["Bundled Binary", getBundledBinaryPath()],
    ["Staged Binary", STAGED_BINARY_PATH],
    ["Staged Binary Ready", String(hasStagedBinary())],
    ["Initialized", String(state.isInitialized ?? false)],
    ["Wallet Total", String(walletCounts.total)],
    ["Wallet HD", String(walletCounts.hd)],
    ["Wallet PK", String(walletCounts.privateKey)],
    ["Agent Running", String(agent.running)],
    ["Agent Status", agent.ok ? agent.data?.reply ?? agent.code : agent.error?.message ?? agent.code],
  ]);

  return {
    code: "doctor.ok",
    data,
    human,
  };
}

async function handleInitCommand(parsed: ParsedArgs, jsonMode: boolean): Promise<CommandResult> {
  const result = await runInitializationFlow({
    force: hasFlag(parsed, "force"),
    skipPrompt: hasFlag(parsed, "yes"),
    jsonMode,
    printIntro: !jsonMode,
  });

  return {
    code: result.alreadyInitialized ? "init.already_initialized" : "init.completed",
    data: result,
    human: result.alreadyInitialized
      ? "Deuteron is already initialized."
      : "Deuteron initialization completed.",
  };
}

async function handlePingCommand(): Promise<CommandResult> {
  const response = await pingAgent();
  if (!response.ok || !response.data) {
    throw new CliError(response.code, response.error?.message ?? "Agent ping failed");
  }

  return {
    code: "agent.ping",
    data: response,
    human: `Agent reachable at ${response.data.socket} (pid ${response.data.pid})`,
  };
}

async function handleAgentCommand(parsed: ParsedArgs, subcommand?: string): Promise<CommandResult> {
  switch (subcommand) {
    case "start": {
      ensurePositionals(parsed, 2, "Usage: deu agent start [--json]");
      const response = await startAgent();
      return {
        code: "agent.start",
        data: response,
        human: renderAgentStatus("start", response),
      };
    }
    case "status": {
      ensurePositionals(parsed, 2, "Usage: deu agent status [--json]");
      const response = await getAgentStatus();
      return {
        code: "agent.status",
        data: response,
        human: renderAgentStatus("status", response),
      };
    }
    case "stop": {
      ensurePositionals(parsed, 2, "Usage: deu agent stop [--json]");
      const response = await stopAgent();
      return {
        code: "agent.stop",
        data: response,
        human: renderAgentStatus("stop", response),
      };
    }
    default:
      throw new CliError("cli.usage", "Usage: deu agent <start|status|stop> [--json]");
  }
}

async function handleWalletCommand(
  parsed: ParsedArgs,
  subcommand?: string,
  action?: string,
): Promise<CommandResult> {
  switch (subcommand) {
    case "create": {
      ensurePositionals(parsed, 2, "Usage: deu wallet create [--alias <name>] [--yes] [--json]");
      await requireConfirmation(parsed, "Create a new wallet and store its mnemonic in Keychain?");
      await requireSensitiveAuthorization(3, "wallet create");
      const wallet = await createHdWallet(getStringFlag(parsed, "alias"));
      return {
        code: "wallet.created",
        data: wallet,
        human: renderHdWallet(wallet, "Wallet created"),
      };
    }
    case "import": {
      if (action === "mnemonic") {
        ensurePositionals(
          parsed,
          3,
          "Usage: deu wallet import mnemonic [--alias <name>] (--from-stdin | --from-file <path>) [--yes] [--json]",
        );
        await requireConfirmation(parsed, "Import a mnemonic wallet into local Keychain storage?");
        await requireSensitiveAuthorization(3, "wallet import mnemonic");
        const source = await readSensitiveInput(
          parsed,
          "Usage: deu wallet import mnemonic [--alias <name>] (--from-stdin | --from-file <path>) [--yes] [--json]",
        );
        const wallet = await importMnemonicWallet(source, getStringFlag(parsed, "alias"));
        return {
          code: "wallet.imported_mnemonic",
          data: wallet,
          human: renderHdWallet(wallet, "Mnemonic wallet imported"),
        };
      }

      if (action === "private-key") {
        ensurePositionals(
          parsed,
          3,
          "Usage: deu wallet import private-key --chain <chain> [--alias <name>] (--from-stdin | --from-file <path>) [--yes] [--json]",
        );
        await requireConfirmation(parsed, "Import a private-key wallet into local Keychain storage?");
        await requireSensitiveAuthorization(3, "wallet import private-key");
        const source = await readSensitiveInput(
          parsed,
          "Usage: deu wallet import private-key --chain <chain> [--alias <name>] (--from-stdin | --from-file <path>) [--yes] [--json]",
        );
        const wallet = await importPrivateKeyWallet(
          source,
          requireStringFlag(
            parsed,
            "chain",
            "Usage: deu wallet import private-key --chain <chain> [--alias <name>] (--from-stdin | --from-file <path>) [--yes] [--json]",
          ),
          getStringFlag(parsed, "alias"),
        );
        return {
          code: "wallet.imported_private_key",
          data: wallet,
          human: renderPrivateKeyWallet(wallet, "Private-key wallet imported"),
        };
      }

      throw new CliError(
        "cli.usage",
        "Usage: deu wallet import <mnemonic|private-key> ... [--json]",
      );
    }
    case "derive": {
      ensurePositionals(
        parsed,
        2,
        "Usage: deu wallet derive --from <name> [--alias <name>] [--yes] [--json]",
      );
      await requireConfirmation(parsed, "Derive a new child wallet from the selected mnemonic wallet?");
      await requireSensitiveAuthorization(3, "wallet derive");
      const wallet = await deriveWallet(
        requireStringFlag(
          parsed,
          "from",
          "Usage: deu wallet derive --from <name> [--alias <name>] [--yes] [--json]",
        ),
        getStringFlag(parsed, "alias"),
      );
      return {
        code: "wallet.derived",
        data: wallet,
        human: renderHdWallet(wallet, "Child wallet derived"),
      };
    }
    case "ls": {
      ensurePositionals(parsed, 2, "Usage: deu wallet ls [--chain <chain>] [--json]");
      const rows = await listWallets(getStringFlag(parsed, "chain"));
      return {
        code: "wallet.list",
        data: rows,
        human: renderListTable(rows),
      };
    }
    case "switch": {
      ensurePositionals(
        parsed,
        2,
        "Usage: deu wallet switch --alias <name> [--chain <chain>] [--json]",
      );
      const context = await switchWallet(
        requireStringFlag(
          parsed,
          "alias",
          "Usage: deu wallet switch --alias <name> [--chain <chain>] [--json]",
        ),
        getStringFlag(parsed, "chain"),
      );
      return {
        code: "wallet.context_switched",
        data: context,
        human: `Current wallet context\n${renderContextTable(context)}`,
      };
    }
    case "current": {
      ensurePositionals(parsed, 2, "Usage: deu wallet current [--json]");
      const context = await getCurrentWalletContext();
      return {
        code: "wallet.context_current",
        data: context,
        human: renderContextTable(context),
      };
    }
    case "rename": {
      ensurePositionals(
        parsed,
        2,
        "Usage: deu wallet rename --alias <old-name> --new-alias <new-name> [--json]",
      );
      const result = await renameWallet(
        requireStringFlag(
          parsed,
          "alias",
          "Usage: deu wallet rename --alias <old-name> --new-alias <new-name> [--json]",
        ),
        requireStringFlag(
          parsed,
          "new-alias",
          "Usage: deu wallet rename --alias <old-name> --new-alias <new-name> [--json]",
        ),
      );
      return {
        code: "wallet.renamed",
        data: result,
        human: `Renamed wallet ${result.alias} to ${result.newAlias}`,
      };
    }
    case "remove": {
      ensurePositionals(
        parsed,
        2,
        "Usage: deu wallet remove --alias <name> [--yes] [--json]",
      );
      const alias = requireStringFlag(
        parsed,
        "alias",
        "Usage: deu wallet remove --alias <name> [--yes] [--json]",
      );
      await requireConfirmation(parsed, `Remove wallet ${alias} and delete sensitive references if applicable?`);
      await requireSensitiveAuthorization(4, `wallet remove ${alias}`);
      const result = await removeWallet(alias);
      return {
        code: "wallet.removed",
        data: result,
        human: `Removed wallet ${result.alias} (${result.kind}); deleted secret: ${result.deletedSecret}`,
      };
    }
    case "export": {
      if (action === "mnemonic") {
        ensurePositionals(
          parsed,
          3,
          "Usage: deu wallet export mnemonic --alias <name> [--to-file <path>] [--yes] [--json]",
        );
        await requireConfirmation(parsed, "Export mnemonic in plaintext? This will expose sensitive material.");
        await requireSensitiveAuthorization(2, "wallet export mnemonic");
        const result = await exportMnemonic(
          requireStringFlag(
            parsed,
            "alias",
            "Usage: deu wallet export mnemonic --alias <name> [--to-file <path>] [--yes] [--json]",
          ),
        );
        return handleExportResult(parsed, result, "Mnemonic exported");
      }

      if (action === "private-key") {
        ensurePositionals(
          parsed,
          3,
          "Usage: deu wallet export private-key --alias <name> [--chain <chain>] [--to-file <path>] [--yes] [--json]",
        );
        await requireConfirmation(parsed, "Export private key in plaintext? This will expose sensitive material.");
        await requireSensitiveAuthorization(2, "wallet export private-key");
        const result = await exportPrivateKey(
          requireStringFlag(
            parsed,
            "alias",
            "Usage: deu wallet export private-key --alias <name> [--chain <chain>] [--to-file <path>] [--yes] [--json]",
          ),
          getStringFlag(parsed, "chain"),
        );
        return handleExportResult(parsed, result, "Private key exported");
      }

      throw new CliError(
        "cli.usage",
        "Usage: deu wallet export <mnemonic|private-key> ... [--json]",
      );
    }
    default:
      throw new CliError(
        "cli.usage",
        "Usage: deu wallet <create|import|derive|ls|switch|current|rename|remove|export> ... [--json]",
      );
  }
}

async function handleExportResult(
  parsed: ParsedArgs,
  result: Awaited<ReturnType<typeof exportMnemonic>> | Awaited<ReturnType<typeof exportPrivateKey>>,
  label: string,
): Promise<CommandResult> {
  const toFile = getStringFlag(parsed, "to-file");

  if (toFile) {
    const outputPath = await writeSensitiveOutput(toFile, result.value);
    return {
      code: "wallet.exported_file",
      data: {
        alias: result.alias,
        kind: result.kind,
        chain: result.chain,
        filePath: outputPath,
      },
      human: `${label} to ${outputPath}`,
    };
  }

  return {
    code: "wallet.exported_stdout",
    data: result,
    human: `${label}\nWARNING: sensitive material follows\n${result.value}`,
  };
}

function renderAgentStatus(action: string, response: Awaited<ReturnType<typeof getAgentStatus>>): string {
  if (!response.ok || !response.data) {
    return `Agent ${action}: unavailable\n${response.error?.message ?? response.code}`;
  }

  return renderTable([
    ["Field", "Value"],
    ["Action", action],
    ["Running", String(response.running)],
    ["Status", response.data.reply],
    ["PID", String(response.data.pid)],
    ["Version", response.data.version],
    ["Socket", response.data.socket],
  ]);
}

function renderHdWallet(
  wallet: Awaited<ReturnType<typeof createHdWallet>>,
  label: string,
): string {
  return `${label}\n${renderTable([
    ["Alias", "Type", "Account Index"],
    [wallet.alias, wallet.type, String(wallet.accountIndex)],
  ])}\n\n${renderTable([
    ["Chain", "Address"],
    ["ethereum", wallet.addresses.ethereum],
    ["solana", wallet.addresses.solana],
    ["bitcoin", wallet.addresses.bitcoin],
  ])}`;
}

function renderPrivateKeyWallet(
  wallet: Awaited<ReturnType<typeof importPrivateKeyWallet>>,
  label: string,
): string {
  return `${label}\n${renderTable([
    ["Alias", "Type", "Chain", "Address"],
    [wallet.alias, wallet.type, wallet.chain, wallet.address],
  ])}`;
}

function emitSuccess(result: CommandResult, jsonMode: boolean): void {
  if (jsonMode) {
    process.stdout.write(`${JSON.stringify(success(result.code, result.data), null, 2)}\n`);
    return;
  }

  process.stdout.write(`${result.human}\n`);
}

function emitFailure(error: unknown, jsonMode: boolean): void {
  if (jsonMode) {
    process.stderr.write(`${JSON.stringify(failure(error), null, 2)}\n`);
    return;
  }

  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
}

function registerPipeSafeExit(): void {
  const handleStreamError = (error: unknown): void => {
    if (isEpipeError(error)) {
      process.exit(0);
    }

    throw error;
  };

  process.stdout.on("error", handleStreamError);
  process.stderr.on("error", handleStreamError);
}

function isEpipeError(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error && error.code === "EPIPE";
}

main();
