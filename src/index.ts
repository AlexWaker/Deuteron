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
import { getWalletAssets, type WalletAssetsView } from "./assets.js";
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
import { addNetwork, listNetworks } from "./network.js";
import { ensureInitializedForCommand, runInitializationFlow } from "./onboarding.js";
// import { handleLendCommand } from "./lend.js";
import {
  CliError,
  failure,
  renderContextTable,
  renderListTable,
  renderTable,
  success,
} from "./output.js";
import { loadState } from "./state.js";
import { transferAsset, approveErc20, type TransferResult, type Erc20ApproveResult } from "./transfer.js";
import {
  createHdWallet,
  deriveWallet,
  exportMnemonic,
  exportPrivateKey,
  getCurrentWalletContext,
  getWalletContext,
  getWalletCounts,
  importMnemonicWallet,
  importPrivateKeyWallet,
  listWallets,
  removeWallet,
  uninstallWallets,
  renameWallet,
  switchWallet,
} from "./wallet.js";

const VERSION = "0.1.0";
const BIGINT_BUFFER_WARNING_PREFIX = "bigint: Failed to load bindings, pure JS will be used";
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
  deu network add --id <network-id> --name <display-name> --ecosystem <ethereum|solana|bitcoin> [--aliases <a,b,c>] [--json]
  deu network ls [--ecosystem <ethereum|solana|bitcoin>] [--json]
  deu wallet create [--alias <name>] [--yes] [--json]
  deu wallet import mnemonic [--alias <name>] (--from-stdin | --from-file <path>) [--yes] [--json]
  deu wallet import private-key --chain <chain> [--alias <name>] (--from-stdin | --from-file <path>) [--yes] [--json]
  deu wallet derive --from <name> [--alias <name>] [--yes] [--json]
  deu wallet ls [--chain <chain>] [--json]
  deu wallet switch --alias <name> [--chain <chain>] [--json]
  deu wallet current [--json]
  deu wallet assets [--current | --alias <name> --chain <chain>] [--rpc <url>] [--json]
  deu wallet send [--current | --alias <name> --chain <chain>] --to <address> --amount <amount> [--asset native|spl|erc20] [--mint <mint>] [--token <contract>] [--rpc <url>] [--fee-rate <sat/vB>] [--dry-run] [--yes] [--json]
  deu wallet approve erc20 [--current | --alias <name> --chain <chain>] --token <contract> --spender <address> [--amount <amount> | --unlimited] [--rpc <url>] [--dry-run] [--yes] [--json]
  deu wallet rename --alias <old-name> --new-alias <new-name> [--json]
  deu wallet remove --alias <name> [--yes] [--json]
  deu wallet uninstall [--yes] [--json]
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

installKnownDependencyWarningFilter();
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

    case "network":
      return handleNetworkCommand(parsed, subcommand);

    case "wallet":
      return handleWalletCommand(parsed, subcommand, action);

    case "lend":
      return (await loadLendCommandHandler())(parsed, subcommand, action, detail);

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

async function handleNetworkCommand(parsed: ParsedArgs, subcommand?: string): Promise<CommandResult> {
  switch (subcommand) {
    case "add": {
      const usage = "Usage: deu network add --id <network-id> --name <display-name> --ecosystem <ethereum|solana|bitcoin> [--aliases <a,b,c>] [--json]";
      ensurePositionals(parsed, 2, usage);
      const result = await addNetwork({
        id: requireStringFlag(parsed, "id", usage),
        name: requireStringFlag(parsed, "name", usage),
        ecosystem: requireStringFlag(parsed, "ecosystem", usage),
        aliases: getStringFlag(parsed, "aliases"),
      });
      return {
        code: "network.added",
        data: result,
        human: renderNetworkAdded(result),
      };
    }
    case "ls":
    case "list": {
      const usage = "Usage: deu network ls [--ecosystem <ethereum|solana|bitcoin>] [--json]";
      ensurePositionals(parsed, 2, usage);
      const result = await listNetworks(getStringFlag(parsed, "ecosystem"));
      return {
        code: "network.list",
        data: result,
        human: renderNetworkList(result),
      };
    }
    default:
      throw new CliError("cli.usage", "Usage: deu network <add|ls> ... [--json]");
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
    case "assets": {
      ensurePositionals(
        parsed,
        2,
        "Usage: deu wallet assets [--current | --alias <name> --chain <chain>] [--rpc <url>] [--json]",
      );
      const alias = getStringFlag(parsed, "alias");
      const hasCurrent = hasFlag(parsed, "current");

      if (alias && hasCurrent) {
        throw new CliError(
          "wallet.assets_target_conflict",
          "Use either --current or --alias, not both",
        );
      }

      const context = alias
        ? await getWalletContext(alias, getStringFlag(parsed, "chain"))
        : await getCurrentWalletContext();
      const assets = await getWalletAssets(context, {
        rpcUrl: getStringFlag(parsed, "rpc"),
      });

      return {
        code: "wallet.assets",
        data: assets,
        human: renderWalletAssets(assets),
      };
    }
    case "send":
    case "transfer": {
      const usage =
        "Usage: deu wallet send [--current | --alias <name> --chain <chain>] --to <address> --amount <amount> [--asset native|spl|erc20] [--mint <mint>] [--token <contract>] [--rpc <url>] [--fee-rate <sat/vB>] [--dry-run] [--yes] [--json]";
      ensurePositionals(parsed, 2, usage);
      const asset = getStringFlag(parsed, "asset") ?? "native";
      if (!["native", "spl", "erc20"].includes(asset)) {
        throw new CliError("wallet.transfer_asset_unsupported", `Unknown --asset: ${asset}. Use native, spl, or erc20`, {
          asset,
        });
      }

      const alias = getStringFlag(parsed, "alias");
      const hasCurrent = hasFlag(parsed, "current");
      if (alias && hasCurrent) {
        throw new CliError("wallet.transfer_target_conflict", "Use either --current or --alias, not both");
      }

      const context = alias
        ? await getWalletContext(alias, getStringFlag(parsed, "chain"))
        : await getCurrentWalletContext();
      const to = requireStringFlag(parsed, "to", usage);
      const amount = requireStringFlag(parsed, "amount", usage);
      const dryRun = hasFlag(parsed, "dry-run");

      if (asset === "spl" && !getStringFlag(parsed, "mint")) {
        throw new CliError("wallet.transfer_mint_required", "SPL transfer requires --mint <mint-address>\n" + usage);
      }
      if (asset === "erc20" && !getStringFlag(parsed, "token")) {
        throw new CliError("wallet.transfer_token_required", "ERC-20 transfer requires --token <contract>\n" + usage);
      }

      if (!dryRun) {
        await requireConfirmation(
          parsed,
          `Send ${amount} (${asset}) on ${context.chain} from ${context.address} to ${to}?`,
        );
      }

      const result = await transferAsset(context, {
        to,
        amount,
        asset,
        mint: getStringFlag(parsed, "mint"),
        token: getStringFlag(parsed, "token"),
        rpcUrl: getStringFlag(parsed, "rpc"),
        feeRate: getStringFlag(parsed, "fee-rate"),
        dryRun,
      });

      return {
        code: dryRun ? "wallet.transfer_dry_run" : "wallet.transfer_sent",
        data: result,
        human: renderTransferResult(result),
      };
    }
    case "approve": {
      if (action !== "erc20") {
        throw new CliError(
          "cli.usage",
          "Usage: deu wallet approve erc20 [--current | --alias <name> --chain <chain>] --token <contract> --spender <address> [--amount <amount> | --unlimited] [--rpc <url>] [--dry-run] [--yes] [--json]",
        );
      }
      const usage =
        "Usage: deu wallet approve erc20 [--current | --alias <name> --chain <chain>] --token <contract> --spender <address> [--amount <amount> | --unlimited] [--rpc <url>] [--dry-run] [--yes] [--json]";
      ensurePositionals(parsed, 3, usage);

      const alias = getStringFlag(parsed, "alias");
      const hasCurrent = hasFlag(parsed, "current");
      if (alias && hasCurrent) {
        throw new CliError("wallet.approve_target_conflict", "Use either --current or --alias, not both");
      }

      const context = alias
        ? await getWalletContext(alias, getStringFlag(parsed, "chain"))
        : await getCurrentWalletContext();

      const token = requireStringFlag(parsed, "token", usage);
      const spender = requireStringFlag(parsed, "spender", usage);
      const unlimited = hasFlag(parsed, "unlimited");
      const amount = getStringFlag(parsed, "amount");
      const dryRun = hasFlag(parsed, "dry-run");

      if (!unlimited && !amount) {
        throw new CliError("wallet.approve_amount_required", "Provide --amount <amount> or --unlimited\n" + usage);
      }
      if (unlimited && amount) {
        throw new CliError("wallet.approve_amount_conflict", "Use either --amount or --unlimited, not both");
      }

      if (!dryRun) {
        await requireConfirmation(
          parsed,
          unlimited
            ? `Approve unlimited ${token} for ${spender} from ${context.address}?`
            : `Approve ${amount} of ${token} for ${spender} from ${context.address}?`,
        );
      }

      const result = await approveErc20(context, {
        token,
        spender,
        unlimited,
        amount,
        rpcUrl: getStringFlag(parsed, "rpc"),
        dryRun,
      });

      return {
        code: dryRun ? "wallet.approve_dry_run" : "wallet.approve_sent",
        data: result,
        human: renderApproveResult(result),
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

    case "uninstall": {
      ensurePositionals(
        parsed,
        2,
        "Usage: deu wallet uninstall [--yes] [--json]",
      );
      await requireConfirmation(
        parsed,
        "Uninstall local wallet data and delete all stored wallets, mnemonic groups, and sensitive references?",
      );
      await requireSensitiveAuthorization(4, "wallet uninstall");
      const result = await uninstallWallets();
      return {
        code: "wallet.uninstalled",
        data: result,
        human: renderWalletUninstall(result),
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
        "Usage: deu wallet <create|import|derive|ls|switch|current|assets|send|approve|rename|remove|uninstall|export> ... [--json]",
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

function renderWalletAssets(assets: WalletAssetsView): string {
  const tokenRows =
    assets.tokens.length === 0
      ? "No non-zero SPL token balances found."
      : renderTable([
          ["Mint", "Amount", "Decimals", "Token Account"],
          ...assets.tokens.map((token) => [
            token.mint,
            token.amount,
            String(token.decimals),
            token.tokenAccount,
          ]),
        ]);

  return `Wallet assets\n${renderTable([
    ["Field", "Value"],
    ["Alias", assets.alias],
    ["Type", assets.type],
    ["Chain", assets.chain],
    ["Address", assets.address],
    ["RPC", assets.rpcUrl],
    [assets.native.symbol, assets.native.amount],
  ])}\n\n${tokenRows}`;
}

function renderTransferResult(result: TransferResult): string {
  return `Wallet transfer ${result.dryRun ? "dry run" : "sent"}\n${renderTable([
    ["Field", "Value"],
    ["Alias", result.alias],
    ["Type", result.type],
    ["Chain", result.chain],
    ["Asset", result.asset],
    ["Amount", result.amount],
    ["Raw Amount", result.rawAmount],
    ["From", result.from],
    ["To", result.to],
    ["Mint", result.mint ?? "-"],
    ["Token Contract", result.tokenContract ?? "-"],
    ["Decimals", result.decimals !== undefined ? String(result.decimals) : "-"],
    ["Token Program", result.tokenProgram ?? "-"],
    ["Dry Run", String(result.dryRun)],
    ["RPC", result.rpcUrl ?? "-"],
    ["Tx Hash", result.txHash ?? "-"],
    ["Signature", result.signature ?? "-"],
    ["Estimated Fee", result.estimatedFee ?? "-"],
    ["Fee Rate", result.feeRate ?? "-"],
  ])}`;
}

function renderApproveResult(result: Erc20ApproveResult): string {
  return `ERC-20 approve ${result.dryRun ? "dry run" : "sent"}\n${renderTable([
    ["Field", "Value"],
    ["Alias", result.alias],
    ["Type", result.type],
    ["Chain", result.chain],
    ["From", result.from],
    ["Token", result.token],
    ["Spender", result.spender],
    ["Raw Amount", result.rawAmount],
    ["Dry Run", String(result.dryRun)],
    ["RPC", result.rpcUrl ?? "-"],
    ["Tx Hash", result.txHash ?? "-"],
    ["Estimated Fee", result.estimatedFee ?? "-"],
  ])}`;
}

function renderWalletUninstall(
  result: Awaited<ReturnType<typeof uninstallWallets>>,
): string {
  return `Wallet data uninstalled\n${renderTable([
    ["Field", "Value"],
    ["Removed Wallets", String(result.removedWallets)],
    ["Removed HD Wallets", String(result.removedHdWallets)],
    ["Removed PK Wallets", String(result.removedPrivateKeyWallets)],
    ["Removed Mnemonic Groups", String(result.removedMnemonicGroups)],
    ["Deleted Secrets", String(result.deletedSecrets)],
    ["Missing Secrets", String(result.missingSecrets)],
    ["Cleared Context", String(result.clearedContext)],
    ["Reset Initialized", String(result.resetInitialized)],
  ])}`;
}

function renderNetworkAdded(result: Awaited<ReturnType<typeof addNetwork>>): string {
  return `Network added\n${renderTable([
    ["Field", "Value"],
    ["Id", result.id],
    ["Name", result.displayName],
    ["Ecosystem", result.ecosystem],
    ["Source", result.source],
    ["Aliases", result.aliases.length > 0 ? result.aliases.join(", ") : "-"],
  ])}`;
}

function renderNetworkList(result: Awaited<ReturnType<typeof listNetworks>>): string {
  if (result.length === 0) {
    return "No supported networks found";
  }

  return renderTable([
    ["Id", "Name", "Ecosystem", "Source", "Aliases"],
    ...result.map((item) => [
      item.id,
      item.displayName,
      item.ecosystem,
      item.source,
      item.aliases.length > 0 ? item.aliases.join(", ") : "-",
    ]),
  ]);
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

async function loadLendCommandHandler(): Promise<typeof import("./lend.js").handleLendCommand> {
  const module = await import("./lend.js");
  return module.handleLendCommand;
}

function installKnownDependencyWarningFilter(): void {
  const originalWarn = console.warn.bind(console);

  console.warn = (...args: unknown[]) => {
    if (typeof args[0] === "string" && args[0].startsWith(BIGINT_BUFFER_WARNING_PREFIX)) {
      return;
    }

    originalWarn(...args);
  };
}

function isEpipeError(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error && error.code === "EPIPE";
}

main();
