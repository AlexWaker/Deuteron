import process from "node:process";

import BN from "bn.js";
import {
  getDepositIxs,
  getMintIxs,
  getRedeemIxs,
  getWithdrawIxs,
} from "@jup-ag/lend/earn";
import { getInitPositionIx, getLiquidateIx, getOperateIx, getRatioAtTick } from "@jup-ag/lend/borrow";
import { Client, DEFAULT_RPC_URL } from "@jup-ag/lend-read";
import {
  AddressLookupTableAccount,
  Connection,
  PublicKey,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";

import {
  ensurePositionals,
  getStringFlag,
  hasFlag,
  requireStringFlag,
  type ParsedArgs,
} from "./cli.js";
import { CliError, renderTable } from "./output.js";
import { getCurrentWalletContext } from "./wallet.js";

const JUPITER_LEND_API_BASE_URL = "https://api.jup.ag/lend/v1";
const TOKEN_PROGRAM_PUBLIC_KEY = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const RPC_RETRY_DELAYS_MS = [400, 1000, 2200] as const;
const LEND_RPC_TIMEOUT_MS = getPositiveIntegerEnv("DEU_LEND_RPC_TIMEOUT_MS") ?? 8000;
const JUPITER_API_TIMEOUT_MS = getPositiveIntegerEnv("DEU_JUP_API_TIMEOUT_MS") ?? 8000;

type EarnReadSource = "api" | "sdk" | "auto";
type EarnBuildSource = "api" | "sdk";
type EarnBuildFormat = "transaction" | "instructions";

interface CommandResult<T = unknown> {
  code: string;
  data: T;
  human: string;
}

interface ResolvedOwner {
  publicKey: PublicKey;
  address: string;
  source: "owner" | "current" | "implicit-current";
}

interface EarnTokenSummary {
  tokenAddress: string;
  underlyingAddress: string;
  symbol: string;
  name: string;
  decimals: number;
  totalAssets: string;
  totalSupply: string;
  rewardsRate?: string;
  supplyRate?: string;
  totalRate?: string;
  userSupplyData?: unknown;
}

interface EarnPositionSummary {
  tokenAddress: string;
  underlyingAddress?: string;
  symbol: string;
  name: string;
  decimals: number;
  ownerAddress: string;
  shares: string;
  underlyingAssets: string;
  underlyingBalance: string;
  allowance: string;
}

interface EarnEarningsSummary {
  address: string;
  ownerAddress: string;
  earnings: string;
  slot: number;
}

interface BorrowVaultSummary {
  vaultId: number;
  vaultAddress: string;
  supplyToken: string;
  borrowToken: string;
  collateralFactor: number;
  liquidationThreshold: number;
  withdrawable: string;
  borrowable: string;
  totalSupply: string;
  totalBorrow: string;
}

interface BorrowPositionSummary {
  vaultId: number;
  nftId: number;
  owner: string;
  supply: string;
  borrow: string;
  tick: number;
  isLiquidated: boolean;
  stateSource: "current-state" | "raw-fallback";
  warning?: string;
  liquidationThreshold?: number;
}

type BorrowVaultConfigRaw = NonNullable<Awaited<ReturnType<Client["vault"]["getVaultConfigRaw"]>>>;
type BorrowVaultStateRaw = NonNullable<Awaited<ReturnType<Client["vault"]["getVaultStateRaw"]>>>;
type BorrowRawPosition = NonNullable<Awaited<ReturnType<Client["vault"]["getUserPosition"]>>>;
type BorrowCurrentPositionState = Awaited<ReturnType<Client["vault"]["getCurrentPositionState"]>>;

interface BorrowVaultDetail {
  summary: BorrowVaultSummary;
  config: BorrowVaultConfigRaw;
  state: BorrowVaultStateRaw;
  raw: {
    vaultAddress: string;
    config: unknown;
    state: unknown;
  };
}

interface BorrowPositionSnapshot {
  state: BorrowCurrentPositionState;
  stateSource: "current-state" | "raw-fallback";
  warning?: string;
}

export async function handleLendCommand(
  parsed: ParsedArgs,
  category?: string,
  action?: string,
  mode?: string,
): Promise<CommandResult> {
  switch (category) {
    case "earn":
      return handleEarnCommand(parsed, action, mode);
    case "borrow":
      return handleBorrowCommand(parsed, action, mode);
    default:
      throw new CliError(
        "cli.usage",
        "Usage: deu lend <earn|borrow> ... [--json]",
      );
  }
}

async function handleEarnCommand(
  parsed: ParsedArgs,
  action?: string,
  mode?: string,
): Promise<CommandResult> {
  switch (action) {
    case "tokens":
      ensurePositionals(
        parsed,
        3,
        "Usage: deu lend earn tokens [--source <api|sdk|auto>] [--api-key <key>] [--rpc <url>] [--json]",
      );
      return handleEarnTokens(parsed);
    case "positions":
      ensurePositionals(
        parsed,
        3,
        "Usage: deu lend earn positions [--owner <address> | --current] [--source <api|sdk|auto>] [--api-key <key>] [--rpc <url>] [--json]",
      );
      return handleEarnPositions(parsed);
    case "earnings":
      ensurePositionals(
        parsed,
        3,
        "Usage: deu lend earn earnings [--owner <address> | --current] --positions <mint1,mint2,...> [--api-key <key>] [--json]",
      );
      return handleEarnEarnings(parsed);
    case "preview":
      ensurePositionals(
        parsed,
        3,
        "Usage: deu lend earn preview --asset <mint> [--assets-raw <int>] [--shares-raw <int>] [--rpc <url>] [--json]",
      );
      return handleEarnPreview(parsed);
    case "deposit":
    case "withdraw":
    case "mint":
    case "redeem":
      if (mode !== "build") {
        throw new CliError(
          "cli.usage",
          "Usage: deu lend earn <deposit|withdraw|mint|redeem> build ... [--json]",
        );
      }
      ensurePositionals(
        parsed,
        4,
        `Usage: deu lend earn ${action} build ${getEarnBuildUsageTail(action)} [--json]`,
      );
      return handleEarnBuild(parsed, action);
    default:
      throw new CliError(
        "cli.usage",
        "Usage: deu lend earn <tokens|positions|earnings|preview|deposit|withdraw|mint|redeem> ... [--json]",
      );
  }
}

async function handleBorrowCommand(
  parsed: ParsedArgs,
  action?: string,
  mode?: string,
): Promise<CommandResult> {
  switch (action) {
    case "vaults":
      ensurePositionals(parsed, 3, "Usage: deu lend borrow vaults [--rpc <url>] [--json]");
      return handleBorrowVaults(parsed);
    case "vault":
      ensurePositionals(
        parsed,
        3,
        "Usage: deu lend borrow vault --vault-id <id> [--rpc <url>] [--json]",
      );
      return handleBorrowVault(parsed);
    case "positions":
      ensurePositionals(
        parsed,
        3,
        "Usage: deu lend borrow positions [--owner <address> | --current] [--rpc <url>] [--json]",
      );
      return handleBorrowPositions(parsed);
    case "position":
      ensurePositionals(
        parsed,
        3,
        "Usage: deu lend borrow position --vault-id <id> --position-id <nft_id> [--rpc <url>] [--json]",
      );
      return handleBorrowPosition(parsed);
    case "create-position":
    case "deposit":
    case "borrow":
    case "repay":
    case "withdraw":
    case "liquidate":
      if (mode !== "build") {
        throw new CliError(
          "cli.usage",
          "Usage: deu lend borrow <create-position|deposit|borrow|repay|withdraw|liquidate> build ... [--json]",
        );
      }
      ensurePositionals(
        parsed,
        4,
        `Usage: deu lend borrow ${action} build ${getBorrowBuildUsageTail(action)} [--json]`,
      );
      return handleBorrowBuild(parsed, action);
    default:
      throw new CliError(
        "cli.usage",
        "Usage: deu lend borrow <vaults|vault|positions|position|create-position|deposit|borrow|repay|withdraw|liquidate> ... [--json]",
      );
  }
}

async function handleEarnTokens(parsed: ParsedArgs): Promise<CommandResult> {
  const requestedSource = resolveEarnReadSource(parsed);
  if (requestedSource !== "sdk") {
    try {
      const items = (await fetchJupiterApi("earn/tokens", {
        apiKey: getApiKey(parsed),
      })) as unknown[];
      const normalized = items.map(normalizeApiEarnToken);

      return {
        code: "lend.earn.tokens",
        data: {
          source: "api",
          items: normalized,
        },
        human: renderEarnTokens(normalized, "Jupiter Earn tokens (api)"),
      };
    } catch (error) {
      if (requestedSource === "api") {
        throw error;
      }
    }
  }

  const { client, rpcUrl } = createReadClient(parsed);
  const source = "sdk";
  const items = await withLendRpcHandling(
    "load Jupiter Earn tokens from Solana RPC",
    () => client.lending.getAllJlTokenDetails(),
  );
  const normalized = items.map(normalizeSdkEarnToken);

  return {
    code: "lend.earn.tokens",
    data: {
      source,
      rpcUrl,
      items: normalized,
    },
    human: renderEarnTokens(normalized, `Jupiter Earn tokens (${source})`),
  };
}

async function handleEarnPositions(parsed: ParsedArgs): Promise<CommandResult> {
  const requestedSource = resolveEarnReadSource(parsed);
  const owner = await resolveOwner(parsed, {
    commandLabel: "lend earn positions",
    usage:
      "Usage: deu lend earn positions [--owner <address> | --current] [--source <api|sdk|auto>] [--api-key <key>] [--rpc <url>] [--json]",
    allowImplicitCurrent: true,
  });

  if (requestedSource !== "sdk") {
    try {
      const items = (await fetchJupiterApi("earn/positions", {
        apiKey: getApiKey(parsed),
        query: { users: owner.address },
      })) as unknown[];
      const normalized = items.map(normalizeApiEarnPosition);

      return {
        code: "lend.earn.positions",
        data: {
          source: "api",
          owner: owner.address,
          ownerSource: owner.source,
          items: normalized,
        },
        human: renderEarnPositions(normalized, `Jupiter Earn positions for ${owner.address} (api)`),
      };
    } catch (error) {
      if (requestedSource === "api") {
        throw error;
      }
    }
  }

  const { client, rpcUrl } = createReadClient(parsed);
  const source = "sdk";
  const items = await withLendRpcHandling(
    `load Jupiter Earn positions for ${owner.address}`,
    () => client.lending.getUserPositions(owner.publicKey),
  );
  const normalized = items.map((item) => normalizeSdkEarnPosition(item, owner.address));

  return {
    code: "lend.earn.positions",
    data: {
      source,
      rpcUrl,
      owner: owner.address,
      ownerSource: owner.source,
      items: normalized,
    },
    human: renderEarnPositions(normalized, `Jupiter Earn positions for ${owner.address} (${source})`),
  };
}

async function handleEarnEarnings(parsed: ParsedArgs): Promise<CommandResult> {
  const owner = await resolveOwner(parsed, {
    commandLabel: "lend earn earnings",
    usage:
      "Usage: deu lend earn earnings [--owner <address> | --current] --positions <mint1,mint2,...> [--api-key <key>] [--json]",
    allowImplicitCurrent: true,
  });
  const positions = requireStringFlag(
    parsed,
    "positions",
    "Usage: deu lend earn earnings [--owner <address> | --current] --positions <mint1,mint2,...> [--api-key <key>] [--json]",
  )
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);

  if (positions.length === 0) {
    throw new CliError(
      "cli.flag_invalid",
      "Flag --positions must contain at least one position id or mint address",
    );
  }

  const items = (await fetchJupiterApi("earn/earnings", {
    apiKey: requireApiKey(parsed),
    query: {
      user: owner.address,
      positions: positions.join(","),
    },
  })) as unknown[];
  const normalized = items.map(normalizeApiEarnEarning);

  return {
    code: "lend.earn.earnings",
    data: {
      source: "api",
      owner: owner.address,
      ownerSource: owner.source,
      positions,
      items: normalized,
    },
    human: renderEarnEarnings(normalized, `Jupiter Earn earnings for ${owner.address}`),
  };
}

async function handleEarnPreview(parsed: ParsedArgs): Promise<CommandResult> {
  const usage =
    "Usage: deu lend earn preview --asset <mint> [--assets-raw <int>] [--shares-raw <int>] [--rpc <url>] [--json]";
  const asset = parsePublicKeyFlag(parsed, "asset", usage);
  const assetsRaw = parseOptionalBnFlag(parsed, "assets-raw");
  const sharesRaw = parseOptionalBnFlag(parsed, "shares-raw");

  if (!assetsRaw && !sharesRaw) {
    throw new CliError(
      "cli.flag_required",
      `At least one of --assets-raw or --shares-raw must be provided\n${usage}`,
    );
  }

  const { client, rpcUrl } = createReadClient(parsed);
  const previews = await withLendRpcHandling(
    `load Jupiter Earn preview for ${asset.toBase58()}`,
    () => client.lending.getPreviews(
      asset,
      assetsRaw ?? new BN(0),
      sharesRaw ?? new BN(0),
    ),
  );
  const normalized = {
    asset: asset.toBase58(),
    assetsRaw: (assetsRaw ?? new BN(0)).toString(10),
    sharesRaw: (sharesRaw ?? new BN(0)).toString(10),
    previewDeposit: previews.previewDeposit.toString(10),
    previewMint: previews.previewMint.toString(10),
    previewWithdraw: previews.previewWithdraw.toString(10),
    previewRedeem: previews.previewRedeem.toString(10),
  };

  return {
    code: "lend.earn.preview",
    data: {
      rpcUrl,
      ...normalized,
    },
    human: renderPreview(normalized, `Jupiter Earn preview for ${normalized.asset}`),
  };
}

async function handleEarnBuild(parsed: ParsedArgs, operation: "deposit" | "withdraw" | "mint" | "redeem"): Promise<CommandResult> {
  const usage = `Usage: deu lend earn ${operation} build ${getEarnBuildUsageTail(operation)} [--json]`;
  const source = resolveEarnBuildSource(parsed);
  const format = resolveEarnBuildFormat(parsed, source);
  const asset = parsePublicKeyFlag(parsed, "asset", usage);
  const owner = await resolveOwner(parsed, {
    commandLabel: `lend earn ${operation} build`,
    usage,
    allowImplicitCurrent: true,
  });

  if (source === "api") {
    const response = await fetchJupiterApi(`earn/${format === "transaction" ? operation : `${operation}-instructions`}`, {
      apiKey: requireApiKey(parsed),
      method: "POST",
      body: buildEarnApiRequestBody(parsed, operation, asset.toBase58(), owner.address, usage),
    });

    const data = {
      source,
      format,
      asset: asset.toBase58(),
      signer: owner.address,
      ownerSource: owner.source,
      response,
    };

    return {
      code: `lend.earn.${operation}.build`,
      data,
      human: renderBuildResult(`Jupiter Earn ${operation} build (${source}/${format})`, [
        ["Field", "Value"],
        ["Asset", data.asset],
        ["Signer", data.signer],
        ["Format", data.format],
      ], response),
    };
  }

  const { client, connection, rpcUrl } = createReadClient(parsed);
  const token = await withLendRpcHandling(
    `load Jupiter Earn token metadata for ${asset.toBase58()}`,
    () => findEarnToken(client, asset),
  );
  const input = getEarnAmountInput(parsed, operation, usage);
  const rawAmount = parseDisplayAmountToRaw(input.value, token.decimals, input.flagName);

  if (rawAmount.isZero()) {
    throw new CliError("cli.flag_invalid", `Flag --${input.flagName} must be greater than 0`);
  }

  const builderParams = {
    asset,
    signer: owner.publicKey,
    connection,
  };
  const instructions = await withLendRpcHandling(
    `build Jupiter Earn ${operation} instructions`,
    () => buildEarnSdkInstructions(operation, builderParams, rawAmount),
  );
  const serializedInstructions = instructions.map(serializeInstruction);
  const transactionBase64 =
    format === "transaction"
      ? await withLendRpcHandling(
        `build Jupiter Earn ${operation} transaction`,
        () => buildUnsignedTransactionBase64(connection, owner.publicKey, instructions),
      )
      : undefined;

  const data = {
    source,
    format,
    rpcUrl,
    asset: asset.toBase58(),
    signer: owner.address,
    ownerSource: owner.source,
    tokenDecimals: token.decimals,
    input: {
      [input.flagName]: input.value,
      [`${input.flagName}Raw`]: rawAmount.toString(10),
    },
    instructions: serializedInstructions,
    transaction: transactionBase64,
  };

  return {
    code: `lend.earn.${operation}.build`,
    data,
    human: renderBuildResult(`Jupiter Earn ${operation} build (${source}/${format})`, [
      ["Field", "Value"],
      ["Asset", data.asset],
      ["Signer", data.signer],
      ["Token Decimals", String(data.tokenDecimals)],
      [`Input --${input.flagName}`, input.value],
      [`Resolved ${input.flagName} raw`, rawAmount.toString(10)],
      ["Format", format],
    ], format === "transaction" ? { transaction: transactionBase64 } : { instructions: serializedInstructions }),
  };
}

async function handleBorrowVaults(parsed: ParsedArgs): Promise<CommandResult> {
  const { client, rpcUrl } = createReadClient(parsed);
  const normalized = await withBorrowReadNormalization(
    "load borrow vault list",
    () => readBorrowVaultSummaries(client),
  );

  return {
    code: "lend.borrow.vaults",
    data: {
      rpcUrl,
      items: normalized,
    },
    human: renderBorrowVaults(normalized, "Jupiter Borrow vaults"),
  };
}

async function handleBorrowVault(parsed: ParsedArgs): Promise<CommandResult> {
  const usage = "Usage: deu lend borrow vault --vault-id <id> [--rpc <url>] [--json]";
  const vaultId = parseIntegerFlag(parsed, "vault-id", usage, { minimum: 1 });
  const { client, rpcUrl } = createReadClient(parsed);
  const detail = await withBorrowReadNormalization(
    `load borrow vault ${vaultId}`,
    () => readBorrowVaultDetail(client, vaultId),
  );

  return {
    code: "lend.borrow.vault",
    data: {
      rpcUrl,
      vault: detail.summary,
      raw: detail.raw,
    },
    human: renderBorrowVaults([detail.summary], `Jupiter Borrow vault ${vaultId}`),
  };
}

async function handleBorrowPositions(parsed: ParsedArgs): Promise<CommandResult> {
  const owner = await resolveOwner(parsed, {
    commandLabel: "lend borrow positions",
    usage:
      "Usage: deu lend borrow positions [--owner <address> | --current] [--rpc <url>] [--json]",
    allowImplicitCurrent: true,
  });
  const { client, rpcUrl } = createReadClient(parsed);
  const normalized = await withBorrowReadNormalization(
    `load borrow positions for ${owner.address}`,
    () => readBorrowPositionSummaries(client, owner),
  );

  return {
    code: "lend.borrow.positions",
    data: {
      rpcUrl,
      owner: owner.address,
      ownerSource: owner.source,
      items: normalized,
    },
    human: renderBorrowPositions(normalized, `Jupiter Borrow positions for ${owner.address}`),
  };
}

async function handleBorrowPosition(parsed: ParsedArgs): Promise<CommandResult> {
  const usage =
    "Usage: deu lend borrow position --vault-id <id> --position-id <nft_id> [--rpc <url>] [--json]";
  const vaultId = parseIntegerFlag(parsed, "vault-id", usage, { minimum: 1 });
  const positionId = parseIntegerFlag(parsed, "position-id", usage, { minimum: 1 });
  const { client, connection, rpcUrl } = createReadClient(parsed);
  const detail = await withBorrowReadNormalization(
    `load borrow position ${vaultId}/${positionId}`,
    () => readBorrowPositionDetail(client, connection, vaultId, positionId),
  );

  return {
    code: "lend.borrow.position",
    data: {
      rpcUrl,
      position: detail.summary,
      raw: detail.raw,
    },
    human: renderBorrowPositions([detail.summary], `Jupiter Borrow position ${vaultId}/${positionId}`),
  };
}

async function handleBorrowBuild(
  parsed: ParsedArgs,
  operation: "create-position" | "deposit" | "borrow" | "repay" | "withdraw" | "liquidate",
): Promise<CommandResult> {
  const usage = `Usage: deu lend borrow ${operation} build ${getBorrowBuildUsageTail(operation)} [--json]`;
  const owner = await resolveOwner(parsed, {
    commandLabel: `lend borrow ${operation} build`,
    usage,
    allowImplicitCurrent: true,
  });
  const { connection, rpcUrl } = createReadClient(parsed);

  if (operation === "create-position") {
    const vaultId = parseIntegerFlag(parsed, "vault-id", usage, { minimum: 1 });
    const result = await withLendRpcHandling(
      `build Jupiter Borrow ${operation} instructions`,
      () => getInitPositionIx({
        vaultId,
        connection,
        signer: owner.publicKey,
      }),
    );
    const instructions = [result.ix];
    const serializedInstructions = instructions.map(serializeInstruction);
    const transaction = await withLendRpcHandling(
      `build Jupiter Borrow ${operation} transaction`,
      () => buildUnsignedTransactionBase64(connection, owner.publicKey, instructions),
    );

    return {
      code: "lend.borrow.create_position.build",
      data: {
        rpcUrl,
        signer: owner.address,
        ownerSource: owner.source,
        vaultId,
        nftId: result.nftId,
        instructions: serializedInstructions,
        transaction,
      },
      human: renderBuildResult("Jupiter Borrow create-position build", [
        ["Field", "Value"],
        ["Vault ID", String(vaultId)],
        ["Signer", owner.address],
        ["NFT ID", String(result.nftId)],
      ], { transaction, instructions: serializedInstructions }),
    };
  }

  if (operation === "liquidate") {
    const vaultId = parseIntegerFlag(parsed, "vault-id", usage, { minimum: 1 });
    const debtAmount = parseBnFlag(parsed, "debt-amount-raw", usage);
    if (debtAmount.isNeg() || debtAmount.isZero()) {
      throw new CliError("cli.flag_invalid", "Flag --debt-amount-raw must be greater than 0");
    }
    const to = parseOptionalPublicKeyFlag(parsed, "to");
    const result = await withLendRpcHandling(
      `build Jupiter Borrow ${operation} instructions`,
      () => getLiquidateIx({
        vaultId,
        debtAmount,
        to: to ?? owner.publicKey,
        signer: owner.publicKey,
        connection,
      }),
    );
    const serializedInstructions = result.ixs.map(serializeInstruction);
    const transaction = await withLendRpcHandling(
      `build Jupiter Borrow ${operation} transaction`,
      () => buildUnsignedTransactionBase64(
        connection,
        owner.publicKey,
        result.ixs,
        result.addressLookupTableAccounts,
      ),
    );

    return {
      code: "lend.borrow.liquidate.build",
      data: {
        rpcUrl,
        signer: owner.address,
        ownerSource: owner.source,
        vaultId,
        debtAmountRaw: debtAmount.toString(10),
        to: (to ?? owner.publicKey).toBase58(),
        instructions: serializedInstructions,
        transaction,
        lookupTables: serializeLookupTables(result.addressLookupTableAccounts),
      },
      human: renderBuildResult("Jupiter Borrow liquidate build", [
        ["Field", "Value"],
        ["Vault ID", String(vaultId)],
        ["Signer", owner.address],
        ["Debt Amount Raw", debtAmount.toString(10)],
        ["To", (to ?? owner.publicKey).toBase58()],
      ], { transaction, instructions: serializedInstructions }),
    };
  }

  const vaultId = parseIntegerFlag(parsed, "vault-id", usage, { minimum: 1 });
  const positionId = parseIntegerFlag(parsed, "position-id", usage, { minimum: operation === "deposit" ? 0 : 1 });
  if (positionId === 0 && operation !== "deposit") {
    throw new CliError(
      "cli.flag_invalid",
      "Only borrow deposit build supports --position-id 0 for create-position + first deposit",
    );
  }

  const amountRaw = parseBnFlag(parsed, "amount-raw", usage);
  if (amountRaw.isNeg() || amountRaw.isZero()) {
    throw new CliError("cli.flag_invalid", "Flag --amount-raw must be greater than 0");
  }

  const { colAmount, debtAmount } = mapBorrowOperationToAmounts(operation, amountRaw);
  const result = await withLendRpcHandling(
    `build Jupiter Borrow ${operation} instructions`,
    () => getOperateIx({
      vaultId,
      positionId,
      colAmount,
      debtAmount,
      connection,
      signer: owner.publicKey,
    }),
  );
  const serializedInstructions = result.ixs.map(serializeInstruction);
  const transaction = await withLendRpcHandling(
    `build Jupiter Borrow ${operation} transaction`,
    () => buildUnsignedTransactionBase64(
      connection,
      owner.publicKey,
      result.ixs,
      result.addressLookupTableAccounts,
    ),
  );

  return {
    code: `lend.borrow.${operation}.build`,
    data: {
      rpcUrl,
      signer: owner.address,
      ownerSource: owner.source,
      vaultId,
      positionId,
      nftId: result.nftId,
      amountRaw: amountRaw.toString(10),
      colAmountRaw: colAmount.toString(10),
      debtAmountRaw: debtAmount.toString(10),
      instructions: serializedInstructions,
      transaction,
      lookupTables: serializeLookupTables(result.addressLookupTableAccounts),
    },
    human: renderBuildResult(`Jupiter Borrow ${operation} build`, [
      ["Field", "Value"],
      ["Vault ID", String(vaultId)],
      ["Requested Position ID", String(positionId)],
      ["Resolved NFT ID", String(result.nftId)],
      ["Signer", owner.address],
      ["Amount Raw", amountRaw.toString(10)],
      ["Collateral Delta", colAmount.toString(10)],
      ["Debt Delta", debtAmount.toString(10)],
    ], { transaction, instructions: serializedInstructions }),
  };
}

function createReadClient(parsed: ParsedArgs): {
  rpcUrl: string;
  connection: Connection;
  client: Client;
} {
  const rpcUrl = getStringFlag(parsed, "rpc") ?? process.env.SOLANA_RPC_URL ?? DEFAULT_RPC_URL;
  // const connection = new Connection(rpcUrl, "confirmed");
  const connection = new Connection(rpcUrl, {
    commitment: "confirmed",
    fetchMiddleware: (info, init, next) => {
      next(info, {
        ...init,
        signal: mergeAbortSignals(init?.signal, AbortSignal.timeout(LEND_RPC_TIMEOUT_MS)),
      });
    },
  });
  const client = new Client(connection);
  return { rpcUrl, connection, client };
}

async function withLendRpcHandling<T>(label: string, operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof CliError) {
      throw error;
    }

    if (isTimeoutLikeError(error)) {
      throw new CliError(
        "lend.rpc_timeout",
        `Timed out while trying to ${label}. Check --rpc or SOLANA_RPC_URL, then try again.`,
        {
          timeoutMs: LEND_RPC_TIMEOUT_MS,
          cause: error instanceof Error ? error.message : String(error),
        },
      );
    }

    if (isRetryableRpcError(error)) {
      throw new CliError(
        "lend.rpc_request_failed",
        `Failed to ${label}`,
        error instanceof Error ? { cause: error.message } : undefined,
      );
    }

    throw error;
  }
}

async function withBorrowReadNormalization<T>(
  label: string,
  operation: () => Promise<T>,
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof CliError) {
      throw error;
    }

    if (isRetryableRpcError(error)) {
      throw new CliError(
        "lend.borrow.read_failed",
        `Failed to ${label}`,
        error instanceof Error ? { cause: error.message } : undefined,
      );
    }

    throw error;
  }
}

function resolveEarnReadSource(parsed: ParsedArgs): EarnReadSource {
  const source = getStringFlag(parsed, "source") ?? "auto";
  if (source === "api" || source === "sdk" || source === "auto") {
    return source;
  }

  throw new CliError(
    "cli.flag_invalid",
    "Flag --source must be one of api, sdk, auto",
  );
}

function resolveEarnBuildSource(parsed: ParsedArgs): EarnBuildSource {
  const source = getStringFlag(parsed, "source");
  if (!source) {
    return getApiKey(parsed) ? "api" : "sdk";
  }

  if (source === "api" || source === "sdk") {
    return source;
  }

  throw new CliError("cli.flag_invalid", "Flag --source must be one of api or sdk");
}

function resolveEarnBuildFormat(parsed: ParsedArgs, source: EarnBuildSource): EarnBuildFormat {
  const format = getStringFlag(parsed, "format") ?? (source === "api" ? "transaction" : "instructions");
  if (format === "transaction" || format === "instructions") {
    return format;
  }

  throw new CliError(
    "cli.flag_invalid",
    "Flag --format must be one of transaction or instructions",
  );
}

function getApiKey(parsed: ParsedArgs): string | undefined {
  return getStringFlag(parsed, "api-key") ?? process.env.JUP_API_KEY;
}

function requireApiKey(parsed: ParsedArgs): string {
  const apiKey = getApiKey(parsed);
  if (!apiKey) {
    throw new CliError(
      "lend.api_key_required",
      "Jupiter Lend API key is required. Pass --api-key <key> or set JUP_API_KEY.",
    );
  }

  return apiKey;
}

async function fetchJupiterApi(
  path: string,
  options: {
    apiKey?: string;
    method?: "GET" | "POST";
    query?: Record<string, string>;
    body?: Record<string, string>;
  },
): Promise<unknown> {
  const url = new URL(`${JUPITER_LEND_API_BASE_URL}/${path}`);
  if (options.query) {
    for (const [key, value] of Object.entries(options.query)) {
      url.searchParams.set(key, value);
    }
  }

  const timeoutSignal = AbortSignal.timeout(JUPITER_API_TIMEOUT_MS);
  let response: Response;

  try {
    response = await fetch(url, {
      method: options.method ?? "GET",
      headers: {
        "content-type": "application/json",
        ...(options.apiKey ? { "x-api-key": options.apiKey } : {}),
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
      signal: timeoutSignal,
    });
  } catch (error) {
    if (isTimeoutLikeError(error)) {
      throw new CliError(
        "lend.api_request_timeout",
        `Jupiter Lend API request timed out after ${JUPITER_API_TIMEOUT_MS}ms`,
        {
          path,
          timeoutMs: JUPITER_API_TIMEOUT_MS,
        },
      );
    }

    throw new CliError(
      "lend.api_request_failed",
      "Failed to reach Jupiter Lend API",
      {
        path,
        cause: error instanceof Error ? error.message : String(error),
      },
    );
  }

  if (!response.ok) {
    const text = await response.text();
    throw new CliError(
      "lend.api_request_failed",
      `Jupiter Lend API request failed with status ${response.status}`,
      {
        path,
        status: response.status,
        body: text,
      },
    );
  }

  return response.json();
}

async function resolveOwner(
  parsed: ParsedArgs,
  options: {
    commandLabel: string;
    usage: string;
    allowImplicitCurrent: boolean;
  },
): Promise<ResolvedOwner> {
  const ownerFlag = getStringFlag(parsed, "owner");
  const currentFlag = hasFlag(parsed, "current");

  if (ownerFlag && currentFlag) {
    throw new CliError(
      "cli.flag_conflict",
      `Only one of --owner or --current may be provided\n${options.usage}`,
    );
  }

  if (ownerFlag) {
    return {
      publicKey: parsePublicKey(ownerFlag, "owner"),
      address: ownerFlag,
      source: "owner",
    };
  }

  if (currentFlag || options.allowImplicitCurrent) {
    const context = await getCurrentWalletContext().catch((error) => {
      throw new CliError(
        "wallet.context_missing",
        `A current Solana wallet context is required for ${options.commandLabel}. Use --owner <address> or run deu wallet switch first.`,
        error instanceof Error ? { cause: error.message } : undefined,
      );
    });

    if (context.chain !== "solana") {
      throw new CliError(
        "lend.owner_requires_solana_context",
        `Current wallet context must be Solana for ${options.commandLabel}. Active chain: ${context.chain}`,
      );
    }

    return {
      publicKey: new PublicKey(context.address),
      address: context.address,
      source: currentFlag ? "current" : "implicit-current",
    };
  }

  throw new CliError(
    "cli.flag_required",
    `This command requires --owner <address> or --current\n${options.usage}`,
  );
}

function parseIntegerFlag(
  parsed: ParsedArgs,
  flagName: string,
  usage: string,
  options?: { minimum?: number },
): number {
  const raw = requireStringFlag(parsed, flagName, usage);
  const value = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(value) || String(value) !== raw) {
    throw new CliError("cli.flag_invalid", `Flag --${flagName} must be a safe integer`);
  }
  if (options?.minimum !== undefined && value < options.minimum) {
    throw new CliError(
      "cli.flag_invalid",
      `Flag --${flagName} must be >= ${options.minimum}`,
    );
  }

  return value;
}

function parseBnFlag(parsed: ParsedArgs, flagName: string, usage: string): BN {
  const raw = requireStringFlag(parsed, flagName, usage);
  if (!/^-?\d+$/.test(raw)) {
    throw new CliError("cli.flag_invalid", `Flag --${flagName} must be an integer`);
  }

  return new BN(raw, 10);
}

function parseOptionalBnFlag(parsed: ParsedArgs, flagName: string): BN | undefined {
  const raw = getStringFlag(parsed, flagName);
  if (!raw) {
    return undefined;
  }
  if (!/^-?\d+$/.test(raw)) {
    throw new CliError("cli.flag_invalid", `Flag --${flagName} must be an integer`);
  }

  return new BN(raw, 10);
}

function parsePublicKeyFlag(parsed: ParsedArgs, flagName: string, usage: string): PublicKey {
  return parsePublicKey(requireStringFlag(parsed, flagName, usage), flagName);
}

function parseOptionalPublicKeyFlag(parsed: ParsedArgs, flagName: string): PublicKey | undefined {
  const raw = getStringFlag(parsed, flagName);
  return raw ? parsePublicKey(raw, flagName) : undefined;
}

function parsePublicKey(value: string, flagName: string): PublicKey {
  try {
    return new PublicKey(value);
  } catch {
    throw new CliError("cli.flag_invalid", `Flag --${flagName} must be a valid Solana address`);
  }
}

function buildEarnApiRequestBody(
  parsed: ParsedArgs,
  operation: "deposit" | "withdraw" | "mint" | "redeem",
  asset: string,
  signer: string,
  usage: string,
): Record<string, string> {
  const body: Record<string, string> = {
    asset,
    signer,
  };

  if (operation === "deposit" || operation === "withdraw") {
    body.amount = requireStringFlag(parsed, "amount", usage);
  } else {
    body.shares = requireStringFlag(parsed, "shares", usage);
  }

  return body;
}

function getEarnAmountInput(
  parsed: ParsedArgs,
  operation: "deposit" | "withdraw" | "mint" | "redeem",
  usage: string,
): { flagName: "amount" | "shares"; value: string } {
  if (operation === "deposit" || operation === "withdraw") {
    return {
      flagName: "amount",
      value: requireStringFlag(parsed, "amount", usage),
    };
  }

  return {
    flagName: "shares",
    value: requireStringFlag(parsed, "shares", usage),
  };
}

async function findEarnToken(client: Client, asset: PublicKey): Promise<any> {
  const allTokens = await client.lending.getAllJlTokenDetails();
  const assetAddress = asset.toBase58();
  const match = allTokens.find((item: any) => {
    return (
      item.underlyingAddress.toBase58() === assetAddress ||
      item.tokenAddress.toBase58() === assetAddress
    );
  });

  if (!match) {
    throw new CliError(
      "lend.earn.asset_not_found",
      `Asset ${assetAddress} is not available in Jupiter Earn`,
    );
  }

  return match;
}

async function buildEarnSdkInstructions(
  operation: "deposit" | "withdraw" | "mint" | "redeem",
  context: {
    asset: PublicKey;
    signer: PublicKey;
    connection: Connection;
  },
  rawAmount: BN,
): Promise<TransactionInstruction[]> {
  switch (operation) {
    case "deposit":
      return (await getDepositIxs({ ...context, amount: rawAmount })).ixs;
    case "withdraw":
      return (await getWithdrawIxs({ ...context, amount: rawAmount })).ixs;
    case "mint":
      return (await getMintIxs({ ...context, shares: rawAmount })).ixs;
    case "redeem":
      return (await getRedeemIxs({ ...context, shares: rawAmount })).ixs;
  }
}

function parseDisplayAmountToRaw(value: string, decimals: number, flagName: string): BN {
  const normalized = value.trim();
  if (!/^\d+(\.\d+)?$/.test(normalized)) {
    throw new CliError(
      "cli.flag_invalid",
      `Flag --${flagName} must be a positive integer or decimal token amount`,
    );
  }

  const [whole, fraction = ""] = normalized.split(".");
  if (fraction.length > decimals) {
    throw new CliError(
      "cli.flag_invalid",
      `Flag --${flagName} exceeds the token precision of ${decimals} decimals`,
    );
  }

  const digits = `${whole}${fraction.padEnd(decimals, "0")}`.replace(/^0+(?=\d)/, "");
  return new BN(digits || "0", 10);
}

function mapBorrowOperationToAmounts(
  operation: "deposit" | "borrow" | "repay" | "withdraw",
  amountRaw: BN,
): { colAmount: BN; debtAmount: BN } {
  switch (operation) {
    case "deposit":
      return { colAmount: amountRaw, debtAmount: new BN(0) };
    case "borrow":
      return { colAmount: new BN(0), debtAmount: amountRaw };
    case "repay":
      return { colAmount: new BN(0), debtAmount: amountRaw.neg() };
    case "withdraw":
      return { colAmount: amountRaw.neg(), debtAmount: new BN(0) };
  }
}

async function buildUnsignedTransactionBase64(
  connection: Connection,
  payer: PublicKey,
  instructions: TransactionInstruction[],
  lookupTables: AddressLookupTableAccount[] = [],
): Promise<string> {
  const { blockhash } = await connection.getLatestBlockhash("confirmed");
  const message = new TransactionMessage({
    payerKey: payer,
    recentBlockhash: blockhash,
    instructions,
  }).compileToV0Message(lookupTables);
  const transaction = new VersionedTransaction(message);
  return Buffer.from(transaction.serialize()).toString("base64");
}

function serializeInstruction(ix: TransactionInstruction): Record<string, unknown> {
  return {
    programId: ix.programId.toBase58(),
    keys: ix.keys.map((key) => ({
      pubkey: key.pubkey.toBase58(),
      isSigner: key.isSigner,
      isWritable: key.isWritable,
    })),
    data: Buffer.from(ix.data).toString("base64"),
  };
}

function serializeLookupTables(tables: AddressLookupTableAccount[]): Array<Record<string, unknown>> {
  return tables.map((table) => ({
    key: table.key.toBase58(),
    addresses: table.state.addresses.map((address) => address.toBase58()),
  }));
}

function normalizeApiEarnToken(item: any): EarnTokenSummary {
  return {
    tokenAddress: String(item.address),
    underlyingAddress: String(item.assetAddress ?? item.address),
    symbol: String(item.symbol ?? item.asset?.symbol ?? ""),
    name: String(item.name ?? item.asset?.name ?? ""),
    decimals: Number(item.decimals ?? item.asset?.decimals ?? 0),
    totalAssets: String(item.totalAssets ?? "0"),
    totalSupply: String(item.totalSupply ?? "0"),
    rewardsRate: item.rewardsRate !== undefined ? String(item.rewardsRate) : undefined,
    supplyRate: item.supplyRate !== undefined ? String(item.supplyRate) : undefined,
    totalRate: item.totalRate !== undefined ? String(item.totalRate) : undefined,
    userSupplyData: item.liquiditySupplyData,
  };
}

function normalizeSdkEarnToken(item: any): EarnTokenSummary {
  return {
    tokenAddress: item.tokenAddress.toBase58(),
    underlyingAddress: item.underlyingAddress.toBase58(),
    symbol: item.symbol,
    name: item.name,
    decimals: item.decimals,
    totalAssets: item.totalAssets.toString(10),
    totalSupply: item.totalSupply.toString(10),
    rewardsRate: item.rewardsRate.toString(10),
    supplyRate: item.supplyRate.toString(10),
    totalRate: item.rewardsRate.add(item.supplyRate).toString(10),
    userSupplyData: toPlainJson(item.userSupplyData),
  };
}

function normalizeApiEarnPosition(item: any): EarnPositionSummary {
  return {
    tokenAddress: String(item.token?.address ?? ""),
    symbol: String(item.token?.symbol ?? ""),
    name: String(item.token?.name ?? ""),
    decimals: Number(item.token?.decimals ?? 0),
    ownerAddress: String(item.ownerAddress),
    shares: String(item.shares ?? "0"),
    underlyingAssets: String(item.underlyingAssets ?? "0"),
    underlyingBalance: String(item.underlyingBalance ?? "0"),
    allowance: String(item.allowance ?? "0"),
  };
}

function normalizeSdkEarnPosition(item: any, ownerAddress: string): EarnPositionSummary {
  return {
    tokenAddress: item.jlTokenDetails.tokenAddress.toBase58(),
    underlyingAddress: item.jlTokenDetails.underlyingAddress.toBase58(),
    symbol: item.jlTokenDetails.symbol,
    name: item.jlTokenDetails.name,
    decimals: item.jlTokenDetails.decimals,
    ownerAddress,
    shares: item.userPosition.jlTokenShares.toString(10),
    underlyingAssets: item.userPosition.underlyingAssets.toString(10),
    underlyingBalance: item.userPosition.underlyingBalance.toString(10),
    allowance: item.userPosition.allowance.toString(10),
  };
}

function normalizeApiEarnEarning(item: any): EarnEarningsSummary {
  return {
    address: String(item.address),
    ownerAddress: String(item.ownerAddress),
    earnings: String(item.earnings),
    slot: Number(item.slot),
  };
}

function normalizeBorrowVault(
  vaultConfig: BorrowVaultConfigRaw,
  vaultState: BorrowVaultStateRaw,
  vaultAddress: string,
): BorrowVaultSummary {
  return {
    vaultId: numberFromUnknown(vaultConfig.vaultId),
    vaultAddress,
    supplyToken: vaultConfig.supplyToken.toBase58(),
    borrowToken: vaultConfig.borrowToken.toBase58(),
    collateralFactor: numberFromUnknown(vaultConfig.collateralFactor),
    liquidationThreshold: numberFromUnknown(vaultConfig.liquidationThreshold),
    withdrawable: bnLikeToString(vaultState.totalSupply),
    borrowable: bnLikeToString(vaultState.totalBorrow),
    totalSupply: bnLikeToString(vaultState.totalSupply),
    totalBorrow: bnLikeToString(vaultState.totalBorrow),
  };
}

function normalizeBorrowPosition(
  owner: string,
  snapshot: BorrowPositionSnapshot,
  rawPosition: BorrowRawPosition,
  liquidationThreshold?: number,
  warning?: string,
): BorrowPositionSummary {
  return {
    vaultId: numberFromUnknown(rawPosition.vaultId),
    nftId: numberFromUnknown(rawPosition.nftId),
    owner,
    supply: bnLikeToString(snapshot.state.colRaw),
    borrow: bnLikeToString(snapshot.state.debtRaw),
    tick: numberFromUnknown(snapshot.state.tick),
    isLiquidated: Boolean(snapshot.state.userLiquidationStatus ?? false),
    stateSource: snapshot.stateSource,
    warning: mergeWarnings(snapshot.warning, warning),
    liquidationThreshold,
  };
}

async function readBorrowVaultSummaries(client: Client): Promise<BorrowVaultSummary[]> {
  const program = getBorrowProgram(client);
  const pda = client.vault.getPda();
  const vaultConfigs: Array<{ publicKey: PublicKey; account: BorrowVaultConfigRaw }> =
    (await withRpcRetry(
      () => program.account.vaultConfig.all(),
      "load borrow vault configs",
    )) as Array<{ publicKey: PublicKey; account: BorrowVaultConfigRaw }>;
  const vaultStateAddresses = vaultConfigs.map((entry: any) =>
    pda.deriveVaultState({
      vaultId: numberFromUnknown(entry.account.vaultId),
    }),
  );
  const vaultStates: Array<BorrowVaultStateRaw | null> =
    (await withRpcRetry(
      () => program.account.vaultState.fetchMultiple(vaultStateAddresses),
      "load borrow vault states",
    )) as Array<BorrowVaultStateRaw | null>;
  const stateByVaultId = new Map<number, BorrowVaultStateRaw>();

  vaultStates.forEach((state, index: number) => {
    if (!state) {
      return;
    }

    stateByVaultId.set(numberFromUnknown(vaultConfigs[index].account.vaultId), state);
  });

  return vaultConfigs
    .map((entry: any) => {
      const vaultId = numberFromUnknown(entry.account.vaultId);
      const state = stateByVaultId.get(vaultId);
      if (!state) {
        return null;
      }

      return normalizeBorrowVault(entry.account, state, entry.publicKey.toBase58());
    })
    .filter((item: BorrowVaultSummary | null): item is BorrowVaultSummary => item !== null)
    .sort((left: BorrowVaultSummary, right: BorrowVaultSummary) => left.vaultId - right.vaultId);
}

async function readBorrowVaultDetail(
  client: Client,
  vaultId: number,
): Promise<BorrowVaultDetail> {
  const program = getBorrowProgram(client);
  const pda = client.vault.getPda();
  const vaultConfigAddress = pda.deriveVaultConfig({ vaultId });
  const vaultStateAddress = pda.deriveVaultState({ vaultId });
  const [vaultConfig, vaultState] = await Promise.all([
    fetchBorrowAccountViaMultiple<BorrowVaultConfigRaw>(
      program.account.vaultConfig,
      vaultConfigAddress,
      `vault ${vaultId} config`,
    ),
    fetchBorrowAccountViaMultiple<BorrowVaultStateRaw>(
      program.account.vaultState,
      vaultStateAddress,
      `vault ${vaultId} state`,
    ),
  ]);
  const vaultAddress = vaultConfigAddress.toBase58();

  return {
    summary: normalizeBorrowVault(vaultConfig, vaultState, vaultAddress),
    config: vaultConfig,
    state: vaultState,
    raw: {
      vaultAddress,
      config: toPlainJson(vaultConfig),
      state: toPlainJson(vaultState),
    },
  };
}

async function readBorrowPositionSummaries(
  client: Client,
  owner: ResolvedOwner,
): Promise<BorrowPositionSummary[]> {
  const program = getBorrowProgram(client);
  const mintedPositionNfts = await listOwnerPositionMints(program.provider.connection, owner.publicKey);

  if (mintedPositionNfts.length === 0) {
    return [];
  }

  const positionAccounts = (await Promise.all(
    mintedPositionNfts.map((mint) =>
      withRpcRetry(
        () =>
          program.account.position.all([
            {
              memcmp: {
                bytes: mint,
                offset: 14,
              },
            },
          ]),
        `load borrow positions for mint ${mint}`,
      ),
    ),
  )) as Array<Array<{ publicKey: PublicKey; account: BorrowRawPosition }>>;

  const flattenedPositionAccounts = positionAccounts
    .flat()
    .sort(
      (left, right) => numberFromUnknown(right.account.nftId) - numberFromUnknown(left.account.nftId),
    );

  const vaultDetails = new Map<number, Promise<BorrowVaultDetail>>();

  const positions = await Promise.all(
    flattenedPositionAccounts.map(async (entry) => {
      const vaultId = numberFromUnknown(entry.account.vaultId);
      let vaultDetailPromise = vaultDetails.get(vaultId);
      if (!vaultDetailPromise) {
        vaultDetailPromise = readBorrowVaultDetail(client, vaultId);
        vaultDetails.set(vaultId, vaultDetailPromise);
      }

      const [vaultDetailResult, snapshot] = await Promise.all([
        readBorrowVaultDetailOptional(client, vaultId, vaultDetailPromise),
        readBorrowCurrentPositionSnapshot(client, vaultId, entry.account),
      ]);

      return normalizeBorrowPosition(
        owner.address,
        snapshot,
        entry.account,
        vaultDetailResult.detail?.summary.liquidationThreshold,
        vaultDetailResult.warning,
      );
    }),
  );

  return positions;
}

async function readBorrowPositionDetail(
  client: Client,
  connection: Connection,
  vaultId: number,
  positionId: number,
): Promise<{
  summary: BorrowPositionSummary;
  raw: {
    owner: string;
    position: unknown;
    currentPosition: unknown;
    stateSource: "current-state" | "raw-fallback";
    warning?: string;
  };
}> {
  const program = getBorrowProgram(client);
  const positionAddress = client.vault.getPda().derivePosition({
    vaultId,
    positionId,
  });
  const rawPosition = await fetchBorrowAccountViaMultiple<BorrowRawPosition>(
    program.account.position,
    positionAddress,
    `position ${vaultId}/${positionId}`,
    "lend.borrow.position_not_found",
  );

  const [vaultDetailResult, snapshot, ownerResult] = await Promise.all([
    readBorrowVaultDetailOptional(client, vaultId),
    readBorrowCurrentPositionSnapshot(client, vaultId, rawPosition),
    resolvePositionOwnerOptional(connection, rawPosition.positionMint),
  ]);
  const warning = mergeWarnings(snapshot.warning, vaultDetailResult.warning, ownerResult.warning);

  return {
    summary: normalizeBorrowPosition(
      ownerResult.owner,
      snapshot,
      rawPosition,
      vaultDetailResult.detail?.summary.liquidationThreshold,
      warning,
    ),
    raw: {
      owner: ownerResult.owner,
      position: toPlainJson(rawPosition),
      currentPosition: toPlainJson(snapshot.state),
      stateSource: snapshot.stateSource,
      warning,
    },
  };
}

async function readBorrowVaultDetailOptional(
  client: Client,
  vaultId: number,
  pendingDetail?: Promise<BorrowVaultDetail>,
): Promise<{ detail?: BorrowVaultDetail; warning?: string }> {
  try {
    return {
      detail: await (pendingDetail ?? readBorrowVaultDetail(client, vaultId)),
    };
  } catch (error) {
    return {
      warning: formatBorrowSoftWarning(`Failed to read vault ${vaultId} metadata`, error),
    };
  }
}

async function resolvePositionOwnerOptional(
  connection: Connection,
  mint: PublicKey,
): Promise<{ owner: string; warning?: string }> {
  try {
    return {
      owner: await resolvePositionOwner(connection, mint),
    };
  } catch (error) {
    return {
      owner: "unknown",
      warning: formatBorrowSoftWarning(`Failed to resolve owner for ${mint.toBase58()}`, error),
    };
  }
}

async function readBorrowCurrentPositionSnapshot(
  client: Client,
  vaultId: number,
  position: BorrowRawPosition,
): Promise<BorrowPositionSnapshot> {
  try {
    return {
      state: await readBorrowCurrentPositionState(client, vaultId, position),
      stateSource: "current-state",
    };
  } catch (error) {
    if (error instanceof CliError && error.code === "lend.borrow.read_failed") {
      return {
        state: buildBorrowRawFallbackState(position),
        stateSource: "raw-fallback",
        warning: `${error.message}; using raw position fallback`,
      };
    }

    throw error;
  }
}

async function readBorrowCurrentPositionState(
  client: Client,
  vaultId: number,
  position: BorrowRawPosition,
): Promise<BorrowCurrentPositionState> {
  try {
    return await withRpcRetry(
      () =>
        client.vault.getCurrentPositionState({
          vaultId,
          position,
        }),
      `compute borrow position state for ${vaultId}/${numberFromUnknown(position.nftId)}`,
    );
  } catch (error) {
    throw new CliError(
      "lend.borrow.read_failed",
      `Failed to compute borrow position state for ${vaultId}/${numberFromUnknown(position.nftId)}`,
      error instanceof Error ? { cause: error.message } : undefined,
    );
  }
}

function buildBorrowRawFallbackState(position: BorrowRawPosition): BorrowCurrentPositionState {
  const supplyAmount = position.supplyAmount.clone();
  const dustDebtAmount = position.dustDebtAmount.clone();
  const isSupplyOnlyPosition = Boolean(position.isSupplyOnlyPosition);
  let debtRaw = new BN(0);

  if (!isSupplyOnlyPosition) {
    debtRaw = getRatioAtTick(numberFromUnknown(position.tick)).mul(supplyAmount).shrn(48);
    debtRaw = debtRaw.gt(dustDebtAmount) ? debtRaw.sub(dustDebtAmount) : new BN(0);
  }

  return {
    tick: numberFromUnknown(position.tick),
    tickId: numberFromUnknown(position.tickId),
    colRaw: supplyAmount,
    debtRaw,
    dustDebtRaw: dustDebtAmount,
    finalAmount: supplyAmount.clone(),
    isSupplyOnlyPosition,
    userLiquidationStatus: false,
    postLiquidationBranchId: undefined,
  };
}

function getBorrowProgram(client: Client): any {
  return (client.vault as any).program;
}

async function fetchBorrowAccountViaMultiple<T>(
  accountClient: { fetchMultiple: (addresses: PublicKey[]) => Promise<Array<T | null>> },
  address: PublicKey,
  label: string,
  notFoundCode = "lend.borrow.vault_not_found",
): Promise<T> {
  try {
    const [account] = await withRpcRetry(
      () => accountClient.fetchMultiple([address]),
      `load borrow ${label}`,
    );
    if (!account) {
      throw new CliError(
        notFoundCode,
        `Borrow ${label} was not found on the connected RPC`,
      );
    }

    return account;
  } catch (error) {
    if (error instanceof CliError) {
      throw error;
    }

    throw new CliError(
      "lend.borrow.read_failed",
      `Failed to read borrow ${label} from RPC`,
      error instanceof Error ? { cause: error.message } : undefined,
    );
  }
}

async function listOwnerPositionMints(connection: Connection, owner: PublicKey): Promise<string[]> {
  const accounts = await withRpcRetry(
    () =>
      connection.getParsedTokenAccountsByOwner(owner, {
        programId: TOKEN_PROGRAM_PUBLIC_KEY,
      }),
    `load borrow position token accounts for ${owner.toBase58()}`,
  );
  const mints = new Set<string>();

  for (const account of accounts.value) {
    const parsed = extractParsedTokenAccountInfo(account.account.data);
    if (!parsed) {
      continue;
    }

    if (parsed.amount === "1") {
      mints.add(parsed.mint);
    }
  }

  return [...mints];
}

async function resolvePositionOwner(connection: Connection, mint: PublicKey): Promise<string> {
  const largestAccounts = await withRpcRetry(
    () => connection.getTokenLargestAccounts(mint),
    `load token largest accounts for ${mint.toBase58()}`,
  );
  const tokenAccount = largestAccounts.value.find((item) => item.amount === "1") ?? largestAccounts.value[0];
  if (!tokenAccount) {
    return "unknown";
  }

  const parsedInfo = await withRpcRetry(
    () => connection.getParsedAccountInfo(tokenAccount.address),
    `load parsed token account ${tokenAccount.address.toBase58()}`,
  );
  const parsed = extractParsedTokenAccountInfo(parsedInfo.value?.data);
  return parsed?.owner ?? "unknown";
}

async function withRpcRetry<T>(operation: () => Promise<T>, label: string): Promise<T> {
  let lastError: unknown;

  for (let attempt = 0; attempt <= RPC_RETRY_DELAYS_MS.length; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (!isRetryableRpcError(error) || attempt === RPC_RETRY_DELAYS_MS.length) {
        break;
      }

      await delay(RPC_RETRY_DELAYS_MS[attempt]);
    }
  }

  throw lastError;
}

function mergeWarnings(...warnings: Array<string | undefined>): string | undefined {
  const filtered = warnings.filter((warning): warning is string => Boolean(warning?.trim()));
  return filtered.length > 0 ? filtered.join("; ") : undefined;
}

function formatBorrowSoftWarning(context: string, error: unknown): string {
  if (error instanceof CliError) {
    return `${context}: ${error.message}`;
  }

  if (error instanceof Error) {
    return `${context}: ${error.message}`;
  }

  return `${context}: unknown error`;
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function mergeAbortSignals(primary: AbortSignal | null | undefined, secondary: AbortSignal): AbortSignal {
  if (!primary) {
    return secondary;
  }

  return typeof AbortSignal.any === "function"
    ? AbortSignal.any([primary, secondary])
    : primary;
}

function getPositiveIntegerEnv(name: string): number | undefined {
  const raw = process.env[name];
  if (!raw) {
    return undefined;
  }

  const value = Number.parseInt(raw, 10);
  return Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function extractParsedTokenAccountInfo(data: unknown): { mint: string; amount: string; owner?: string } | undefined {
  if (!data || typeof data !== "object" || !("parsed" in data)) {
    return undefined;
  }

  const parsed = (data as { parsed?: { info?: unknown } }).parsed;
  if (!parsed || typeof parsed !== "object" || !("info" in parsed)) {
    return undefined;
  }

  const info = parsed.info as {
    mint?: unknown;
    owner?: unknown;
    tokenAmount?: { amount?: unknown };
  };
  if (typeof info.mint !== "string" || typeof info.tokenAmount?.amount !== "string") {
    return undefined;
  }

  return {
    mint: info.mint,
    amount: info.tokenAmount.amount,
    owner: typeof info.owner === "string" ? info.owner : undefined,
  };
}

function bnLikeToString(value: unknown): string {
  if (BN.isBN(value)) {
    return value.toString(10);
  }

  if (typeof value === "bigint") {
    return value.toString(10);
  }

  return String(value ?? "0");
}

function numberFromUnknown(value: unknown): number {
  if (BN.isBN(value)) {
    return value.toNumber();
  }

  return Number(value);
}

function isMissingAccountError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  return /account does not exist|not found|could not find/i.test(error.message);
}

function isRetryableRpcError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  return /429|Too Many Requests|fetch failed|ETIMEDOUT|ECONNRESET|ENOTFOUND|socket hang up|aborted|timeout/i.test(
    error.message,
  );
}

function isTimeoutLikeError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  return /aborted|timeout/i.test(error.message) || error.name === "AbortError";
}

function renderEarnTokens(items: EarnTokenSummary[], title: string): string {
  if (items.length === 0) {
    return `${title}\nNo earn tokens found.`;
  }

  return `${title}\n${renderTable([
    ["Symbol", "Underlying", "jlToken", "Total Assets", "Total Supply"],
    ...items.map((item) => [
      item.symbol,
      item.underlyingAddress,
      item.tokenAddress,
      item.totalAssets,
      item.totalSupply,
    ]),
  ])}`;
}

function renderEarnPositions(items: EarnPositionSummary[], title: string): string {
  if (items.length === 0) {
    return `${title}\nNo earn positions found.`;
  }

  return `${title}\n${renderTable([
    ["Symbol", "Owner", "Shares", "Underlying Assets", "Wallet Balance"],
    ...items.map((item) => [
      item.symbol,
      item.ownerAddress,
      item.shares,
      item.underlyingAssets,
      item.underlyingBalance,
    ]),
  ])}`;
}

function renderEarnEarnings(items: EarnEarningsSummary[], title: string): string {
  if (items.length === 0) {
    return `${title}\nNo earnings found.`;
  }

  return `${title}\n${renderTable([
    ["Address", "Owner", "Earnings", "Slot"],
    ...items.map((item) => [item.address, item.ownerAddress, item.earnings, String(item.slot)]),
  ])}`;
}

function renderPreview(
  preview: {
    asset: string;
    assetsRaw: string;
    sharesRaw: string;
    previewDeposit: string;
    previewMint: string;
    previewWithdraw: string;
    previewRedeem: string;
  },
  title: string,
): string {
  return `${title}\n${renderTable([
    ["Field", "Value"],
    ["Asset", preview.asset],
    ["Assets Raw", preview.assetsRaw],
    ["Shares Raw", preview.sharesRaw],
    ["Preview Deposit", preview.previewDeposit],
    ["Preview Mint", preview.previewMint],
    ["Preview Withdraw", preview.previewWithdraw],
    ["Preview Redeem", preview.previewRedeem],
  ])}`;
}

function renderBorrowVaults(items: BorrowVaultSummary[], title: string): string {
  if (items.length === 0) {
    return `${title}\nNo borrow vaults found.`;
  }

  return `${title}\n${renderTable([
    ["Vault ID", "Supply Token", "Borrow Token", "Borrowable", "Withdrawable"],
    ...items.map((item) => [
      String(item.vaultId),
      item.supplyToken,
      item.borrowToken,
      item.borrowable,
      item.withdrawable,
    ]),
  ])}`;
}

function renderBorrowPositions(items: BorrowPositionSummary[], title: string): string {
  if (items.length === 0) {
    return `${title}\nNo borrow positions found.`;
  }

  return `${title}\n${renderTable([
    ["Vault ID", "NFT ID", "Owner", "Supply", "Borrow", "Tick", "Liquidated", "State"],
    ...items.map((item) => [
      String(item.vaultId),
      String(item.nftId),
      item.owner,
      item.supply,
      item.borrow,
      String(item.tick),
      String(item.isLiquidated),
      item.stateSource,
    ]),
  ])}`;
}

function renderBuildResult(title: string, summaryRows: string[][], payload: unknown): string {
  return `${title}\n${renderTable(summaryRows)}\n\n${JSON.stringify(payload, null, 2)}`;
}

function getEarnBuildUsageTail(operation: "deposit" | "withdraw" | "mint" | "redeem"): string {
  if (operation === "deposit" || operation === "withdraw") {
    return "--asset <mint> --amount <value> [--owner <address> | --current] [--source <api|sdk>] [--api-key <key>] [--rpc <url>] [--format <transaction|instructions>]";
  }

  return "--asset <mint> --shares <value> [--owner <address> | --current] [--source <api|sdk>] [--api-key <key>] [--rpc <url>] [--format <transaction|instructions>]";
}

function getBorrowBuildUsageTail(
  operation: "create-position" | "deposit" | "borrow" | "repay" | "withdraw" | "liquidate",
): string {
  switch (operation) {
    case "create-position":
      return "--vault-id <id> [--owner <address> | --current] [--rpc <url>]";
    case "liquidate":
      return "--vault-id <id> --debt-amount-raw <int> [--to <address>] [--owner <address> | --current] [--rpc <url>]";
    default:
      return "--vault-id <id> --position-id <nft_id|0> --amount-raw <int> [--owner <address> | --current] [--rpc <url>]";
  }
}

function toPlainJson(value: unknown): unknown {
  if (value instanceof PublicKey) {
    return value.toBase58();
  }
  if (BN.isBN(value)) {
    return value.toString(10);
  }
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    return Buffer.from(value).toString("base64");
  }
  if (Array.isArray(value)) {
    return value.map((item) => toPlainJson(item));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entry]) => [key, toPlainJson(entry)]),
    );
  }

  return value;
}