import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  sendAndConfirmTransaction,
  SystemProgram,
  Transaction,
} from "@solana/web3.js";
import {
  createAssociatedTokenAccountInstruction,
  createTransferInstruction,
  getAccount,
  getAssociatedTokenAddressSync,
  getMint,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import * as bitcoin from "bitcoinjs-lib";
import bs58 from "bs58";
import { ECPairFactory } from "ecpair";
import { Contract, isAddress, JsonRpcProvider, parseEther, parseUnits, Wallet } from "ethers";
import * as ecc from "tiny-secp256k1";

import { getChainSpec, type ChainSpec } from "./chains.js";
import { CliError } from "./output.js";
import { exportPrivateKey } from "./wallet.js";
import type { WalletContextView } from "./types.js";

const DEFAULT_SOLANA_RPC_URL = "https://api.mainnet-beta.solana.com";
const DEFAULT_BITCOIN_API_URL = "https://mempool.space/api";
const BITCOIN_DUST_SATS = 546n;
const ECPair = ECPairFactory(ecc);

bitcoin.initEccLib(ecc);

const EVM_DEFAULT_RPC_URLS: Record<string, string> = {
  ethereum: "https://ethereum.publicnode.com",
  bsc: "https://bsc-dataseed.binance.org",
  polygon: "https://polygon-rpc.com",
  base: "https://mainnet.base.org",
  arbitrum: "https://arb1.arbitrum.io/rpc",
  optimism: "https://mainnet.optimism.io",
};

export interface TransferOptions {
  to: string;
  amount: string;
  rpcUrl?: string;
  dryRun?: boolean;
  feeRate?: string;
  /** `native` | `spl` | `erc20` — default `native` */
  asset?: string;
  /** SPL mint address (base58) */
  mint?: string;
  /** ERC-20 contract address */
  token?: string;
}

export interface TransferResult {
  alias: string;
  type: WalletContextView["type"];
  chain: string;
  from: string;
  to: string;
  asset: string;
  amount: string;
  rawAmount: string;
  dryRun: boolean;
  rpcUrl?: string;
  txHash?: string;
  signature?: string;
  estimatedFee?: string;
  feeRate?: string;
  mint?: string;
  tokenContract?: string;
  decimals?: number;
  tokenProgram?: string;
}

export type Erc20ApproveOptions = {
  token: string;
  spender: string;
  unlimited?: boolean;
  amount?: string;
  rpcUrl?: string;
  dryRun?: boolean;
};

export type Erc20ApproveResult = {
  alias: string;
  type: WalletContextView["type"];
  chain: string;
  from: string;
  token: string;
  spender: string;
  rawAmount: string;
  dryRun: boolean;
  rpcUrl?: string;
  txHash?: string;
  estimatedFee?: string;
};

const ERC20_ABI = ["function transfer(address to, uint256 amount) returns (bool)", "function approve(address spender, uint256 amount) returns (bool)", "function decimals() view returns (uint8)", "function balanceOf(address owner) view returns (uint256)"];

export async function transferAsset(context: WalletContextView, options: TransferOptions): Promise<TransferResult> {
  const chain = getChainSpec(context.chain);
  const asset = options.asset ?? "native";

  if (asset === "native") {
    switch (chain.ecosystem) {
      case "solana":
        return transferSolana(context, options);
      case "ethereum":
        return transferEvm(context, chain, options);
      case "bitcoin":
        return transferBitcoin(context, options);
    }
  }

  if (asset === "spl") {
    if (chain.ecosystem !== "solana") {
      throw new CliError("wallet.transfer_spl_chain_invalid", "--asset spl is only valid on Solana", {
        chain: context.chain,
      });
    }
    if (!options.mint?.trim()) {
      throw new CliError("wallet.transfer_mint_required", "SPL transfer requires --mint <mint-address>");
    }
    return transferSplToken(context, options);
  }

  if (asset === "erc20") {
    if (chain.ecosystem !== "ethereum") {
      throw new CliError("wallet.transfer_erc20_chain_invalid", "--asset erc20 is only valid on EVM chains", {
        chain: context.chain,
      });
    }
    if (!options.token?.trim()) {
      throw new CliError("wallet.transfer_token_required", "ERC-20 transfer requires --token <contract-address>");
    }
    return transferErc20(context, chain, options);
  }

  throw new CliError("wallet.transfer_asset_unsupported", `Unknown --asset value: ${asset}`, { asset });
}

export async function transferNativeAsset(
  context: WalletContextView,
  options: TransferOptions,
): Promise<TransferResult> {
  return transferAsset(context, { ...options, asset: "native" });
}

export async function approveErc20(context: WalletContextView, options: Erc20ApproveOptions): Promise<Erc20ApproveResult> {
  const chain = getChainSpec(context.chain);
  if (chain.ecosystem !== "ethereum") {
    throw new CliError("wallet.approve_evm_only", "ERC-20 approve is only valid on EVM chains", { chain: context.chain });
  }

  const tokenAddress = options.token.trim();
  if (!isAddress(tokenAddress)) {
    throw new CliError("wallet.approve_token_invalid", `Invalid token contract: ${tokenAddress}`);
  }

  if (!isAddress(options.spender)) {
    throw new CliError("wallet.approve_spender_invalid", `Invalid spender address: ${options.spender}`);
  }

  const provider = new JsonRpcProvider(resolveEvmRpcUrl(chain, options.rpcUrl));
  const secret = await exportPrivateKey(context.alias, context.chain);
  const wallet = new Wallet(secret.value, provider);
  const contract = new Contract(tokenAddress, ERC20_ABI, wallet);
  const decimals = Number(await contract.decimals!());
  const allowanceAmount = options.unlimited
    ? (1n << 256n) - 1n
    : parseUnits(options.amount ?? "0", decimals);

  if (!options.unlimited && allowanceAmount <= 0n) {
    throw new CliError("wallet.approve_amount_invalid", "Approve amount must be positive unless --unlimited is set");
  }

  const data = contract.interface.encodeFunctionData("approve", [options.spender, allowanceAmount]);
  const estimatedGas = await withTransferError("wallet.approve_estimate_failed", "Failed to estimate ERC-20 approve gas", () =>
    provider.estimateGas({
      from: wallet.address,
      to: tokenAddress,
      data,
    }),
  );

  if (options.dryRun) {
    return {
      alias: context.alias,
      type: context.type,
      chain: context.chain,
      from: wallet.address,
      token: tokenAddress,
      spender: options.spender,
      rawAmount: allowanceAmount.toString(),
      dryRun: true,
      rpcUrl: provider._getConnection().url,
      estimatedFee: estimatedGas.toString(),
    };
  }

  const tx = await withTransferError("wallet.approve_broadcast_failed", "Failed to broadcast ERC-20 approve", () =>
    wallet.sendTransaction({
      to: tokenAddress,
      data,
    }),
  );

  return {
    alias: context.alias,
    type: context.type,
    chain: context.chain,
    from: wallet.address,
    token: tokenAddress,
    spender: options.spender,
    rawAmount: allowanceAmount.toString(),
    dryRun: false,
    rpcUrl: provider._getConnection().url,
    estimatedFee: estimatedGas.toString(),
    txHash: tx.hash,
  };
}

async function transferSplToken(
  context: WalletContextView,
  options: TransferOptions,
): Promise<TransferResult> {
  const recipient = new PublicKey(options.to);
  const mint = new PublicKey(options.mint!.trim());
  const secret = await exportPrivateKey(context.alias, context.chain);
  const owner = Keypair.fromSecretKey(Uint8Array.from(decodeBase58(secret.value)));
  const connection = new Connection(resolveSolanaRpcUrl(options.rpcUrl), "confirmed");

  const mintInfo = await connection.getAccountInfo(mint);
  if (!mintInfo) {
    throw new CliError("wallet.transfer_mint_missing", "Mint account not found on chain");
  }
  const tokenProgramId = mintInfo.owner.equals(TOKEN_2022_PROGRAM_ID) ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;

  const mintData = await getMint(connection, mint, undefined, tokenProgramId);
  const decimals = mintData.decimals;
  const tokenAmount = parseDecimalToUnits(options.amount, decimals, "SPL");
  assertPositiveAmount(tokenAmount, "SPL");

  const sourceAta = getAssociatedTokenAddressSync(mint, owner.publicKey, false, tokenProgramId);
  const destAta = getAssociatedTokenAddressSync(mint, recipient, false, tokenProgramId);

  let sourceAccount;
  try {
    sourceAccount = await getAccount(connection, sourceAta, undefined, tokenProgramId);
  } catch {
    throw new CliError("wallet.transfer_spl_no_source", "No SPL token account for this mint on the sender wallet");
  }
  if (sourceAccount.amount < tokenAmount) {
    throw new CliError("wallet.transfer_spl_insufficient", "Insufficient SPL token balance");
  }

  const transaction = new Transaction();
  let destInfo;
  try {
    destInfo = await getAccount(connection, destAta, undefined, tokenProgramId);
  } catch {
    destInfo = undefined;
  }

  if (!destInfo) {
    transaction.add(
      createAssociatedTokenAccountInstruction(
        owner.publicKey,
        destAta,
        recipient,
        mint,
        tokenProgramId,
      ),
    );
  }

  transaction.add(
    createTransferInstruction(
      sourceAta,
      destAta,
      owner.publicKey,
      tokenAmount,
      [],
      tokenProgramId,
    ),
  );

  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
  transaction.recentBlockhash = blockhash;
  transaction.feePayer = owner.publicKey;
  transaction.lastValidBlockHeight = lastValidBlockHeight;

  let signature: string | undefined;
  if (options.dryRun) {
    transaction.sign(owner);
    const simulation = await connection.simulateTransaction(transaction);
    if (simulation.value.err) {
      throw new CliError("wallet.transfer_spl_simulation_failed", "SPL transfer simulation failed", {
        err: simulation.value.err,
        logs: simulation.value.logs,
      });
    }
  } else {
    signature = await sendAndConfirmTransaction(connection, transaction, [owner], {
      commitment: "confirmed",
    });
  }

  const mintLabel = options.mint!.trim().slice(0, 8);

  return {
    alias: context.alias,
    type: context.type,
    chain: context.chain,
    from: owner.publicKey.toBase58(),
    to: recipient.toBase58(),
    asset: `spl:${mintLabel}`,
    amount: options.amount,
    rawAmount: tokenAmount.toString(),
    dryRun: Boolean(options.dryRun),
    rpcUrl: connection.rpcEndpoint,
    signature,
    txHash: signature,
    mint: mint.toBase58(),
    decimals,
    tokenProgram: tokenProgramId.toBase58(),
  };
}

async function transferErc20(
  context: WalletContextView,
  chain: ChainSpec,
  options: TransferOptions,
): Promise<TransferResult> {
  const tokenAddress = options.token!.trim();
  if (!isAddress(tokenAddress)) {
    throw new CliError("wallet.transfer_token_invalid", `Invalid ERC-20 contract: ${tokenAddress}`);
  }
  if (!isAddress(options.to)) {
    throw new CliError("wallet.transfer_recipient_invalid", `Invalid EVM recipient address: ${options.to}`);
  }

  const provider = new JsonRpcProvider(resolveEvmRpcUrl(chain, options.rpcUrl));
  const secret = await exportPrivateKey(context.alias, context.chain);
  const wallet = new Wallet(secret.value, provider);
  const contract = new Contract(tokenAddress, ERC20_ABI, wallet);
  const decimals = Number(await contract.decimals!());
  const units = parseUnits(options.amount, decimals);
  assertPositiveAmount(units, "ERC-20");

  const balance = await contract.balanceOf!(wallet.address);
  if (balance < units) {
    throw new CliError("wallet.transfer_erc20_insufficient", "Insufficient ERC-20 balance");
  }

  const populated = await contract.transfer!.populateTransaction(options.to, units);
  const estimatedGas = await withTransferError("wallet.transfer_estimate_failed", "Failed to estimate ERC-20 gas", () =>
    provider.estimateGas({
      from: wallet.address,
      to: tokenAddress,
      data: populated.data,
    }),
  );

  if (options.dryRun) {
    return {
      alias: context.alias,
      type: context.type,
      chain: context.chain,
      from: wallet.address,
      to: options.to,
      asset: `erc20:${tokenAddress.slice(0, 8)}`,
      amount: options.amount,
      rawAmount: units.toString(),
      dryRun: true,
      rpcUrl: provider._getConnection().url,
      estimatedFee: estimatedGas.toString(),
      tokenContract: tokenAddress,
      decimals,
    };
  }

  const response = await withTransferError("wallet.transfer_broadcast_failed", "Failed to send ERC-20 transfer", () =>
    wallet.sendTransaction({
      to: tokenAddress,
      data: populated.data,
    }),
  );

  return {
    alias: context.alias,
    type: context.type,
    chain: context.chain,
    from: wallet.address,
    to: options.to,
    asset: `erc20:${tokenAddress.slice(0, 8)}`,
    amount: options.amount,
    rawAmount: units.toString(),
    dryRun: false,
    rpcUrl: provider._getConnection().url,
    estimatedFee: estimatedGas.toString(),
    txHash: response.hash,
    tokenContract: tokenAddress,
    decimals,
  };
}

async function transferSolana(
  context: WalletContextView,
  options: TransferOptions,
): Promise<TransferResult> {
  const lamports = parseDecimalToUnits(options.amount, 9, "SOL");
  assertPositiveAmount(lamports, "SOL");

  if (lamports > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new CliError("wallet.transfer_amount_too_large", "SOL amount is too large for this client");
  }

  const recipient = new PublicKey(options.to);
  const secret = await exportPrivateKey(context.alias, context.chain);
  const keypair = Keypair.fromSecretKey(Uint8Array.from(decodeBase58(secret.value)));
  const connection = new Connection(resolveSolanaRpcUrl(options.rpcUrl), "confirmed");
  const transaction = new Transaction().add(
    SystemProgram.transfer({
      fromPubkey: keypair.publicKey,
      toPubkey: recipient,
      lamports: Number(lamports),
    }),
  );

  let signature: string | undefined;
  if (!options.dryRun) {
    signature = await sendAndConfirmTransaction(connection, transaction, [keypair], {
      commitment: "confirmed",
    });
  }

  return {
    alias: context.alias,
    type: context.type,
    chain: context.chain,
    from: keypair.publicKey.toBase58(),
    to: recipient.toBase58(),
    asset: "SOL",
    amount: options.amount,
    rawAmount: lamports.toString(),
    dryRun: Boolean(options.dryRun),
    rpcUrl: connection.rpcEndpoint,
    signature,
    txHash: signature,
  };
}

async function transferEvm(
  context: WalletContextView,
  chain: ChainSpec,
  options: TransferOptions,
): Promise<TransferResult> {
  if (!isAddress(options.to)) {
    throw new CliError("wallet.transfer_recipient_invalid", `Invalid EVM recipient address: ${options.to}`);
  }

  const wei = parseEther(options.amount);
  assertPositiveAmount(wei, "native EVM token");

  const provider = new JsonRpcProvider(resolveEvmRpcUrl(chain, options.rpcUrl));
  const secret = await exportPrivateKey(context.alias, context.chain);
  const wallet = new Wallet(secret.value, provider);
  const transaction = {
    to: options.to,
    value: wei,
  };
  const estimatedGas = await withTransferError("wallet.transfer_estimate_failed", "Failed to estimate EVM gas", () =>
    provider.estimateGas({
      ...transaction,
      from: wallet.address,
    }),
  );

  if (options.dryRun) {
    return {
      alias: context.alias,
      type: context.type,
      chain: context.chain,
      from: wallet.address,
      to: options.to,
      asset: getEvmNativeSymbol(chain.id),
      amount: options.amount,
      rawAmount: wei.toString(),
      dryRun: true,
      rpcUrl: provider._getConnection().url,
      estimatedFee: estimatedGas.toString(),
    };
  }

  const response = await withTransferError("wallet.transfer_broadcast_failed", "Failed to send EVM transaction", () =>
    wallet.sendTransaction(transaction),
  );

  return {
    alias: context.alias,
    type: context.type,
    chain: context.chain,
    from: wallet.address,
    to: options.to,
    asset: getEvmNativeSymbol(chain.id),
    amount: options.amount,
    rawAmount: wei.toString(),
    dryRun: false,
    rpcUrl: provider._getConnection().url,
    estimatedFee: estimatedGas.toString(),
    txHash: response.hash,
  };
}

async function transferBitcoin(
  context: WalletContextView,
  options: TransferOptions,
): Promise<TransferResult> {
  const satoshis = parseDecimalToUnits(options.amount, 8, "BTC");
  assertPositiveAmount(satoshis, "BTC");

  const network = bitcoin.networks.bitcoin;
  const recipientScript = bitcoin.address.toOutputScript(options.to, network);
  const secret = await exportPrivateKey(context.alias, context.chain);
  const keyPair = ECPair.fromWIF(secret.value, network);
  const payment = bitcoin.payments.p2wpkh({
    pubkey: Buffer.from(keyPair.publicKey),
    network,
  });

  if (!payment.address || !payment.output) {
    throw new CliError("wallet.transfer_sender_invalid", "Failed to derive Bitcoin sender address");
  }

  const apiUrl = resolveBitcoinApiUrl(options.rpcUrl);
  const feeRate = options.feeRate ? Number(options.feeRate) : await fetchBitcoinFeeRate(apiUrl);
  if (!Number.isFinite(feeRate) || feeRate <= 0) {
    throw new CliError("wallet.transfer_fee_rate_invalid", "Bitcoin fee rate must be a positive number");
  }

  const utxos = await fetchBitcoinUtxos(apiUrl, payment.address);
  const selected = selectBitcoinUtxos(utxos, satoshis, feeRate);
  const psbt = new bitcoin.Psbt({ network });

  for (const utxo of selected.utxos) {
    psbt.addInput({
      hash: utxo.txid,
      index: utxo.vout,
      witnessUtxo: {
        script: payment.output,
        value: BigInt(utxo.value),
      },
    });
  }

  psbt.addOutput({
    script: recipientScript,
    value: satoshis,
  });

  if (selected.change > BITCOIN_DUST_SATS) {
    psbt.addOutput({
      address: payment.address,
      value: selected.change,
    });
  }

  psbt.signAllInputs(keyPair);
  psbt.finalizeAllInputs();
  const transaction = psbt.extractTransaction();
  const hex = transaction.toHex();
  const txHash = transaction.getId();

  if (!options.dryRun) {
    await broadcastBitcoinTransaction(apiUrl, hex);
  }

  return {
    alias: context.alias,
    type: context.type,
    chain: context.chain,
    from: payment.address,
    to: options.to,
    asset: "BTC",
    amount: options.amount,
    rawAmount: satoshis.toString(),
    dryRun: Boolean(options.dryRun),
    rpcUrl: apiUrl,
    txHash,
    estimatedFee: selected.fee.toString(),
    feeRate: String(feeRate),
  };
}

function resolveSolanaRpcUrl(rpcUrl?: string): string {
  return rpcUrl ?? process.env.SOLANA_RPC_URL ?? DEFAULT_SOLANA_RPC_URL;
}

function resolveEvmRpcUrl(chain: ChainSpec, rpcUrl?: string): string {
  const envName = `${chain.id.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_RPC_URL`;
  const resolved = rpcUrl ?? process.env[envName] ?? EVM_DEFAULT_RPC_URLS[chain.id];

  if (!resolved) {
    throw new CliError(
      "wallet.transfer_rpc_required",
      `No default RPC is configured for ${chain.id}. Pass --rpc <url> or set ${envName}.`,
    );
  }

  return resolved;
}

function resolveBitcoinApiUrl(rpcUrl?: string): string {
  return (rpcUrl ?? process.env.BITCOIN_API_URL ?? DEFAULT_BITCOIN_API_URL).replace(/\/+$/, "");
}

function getEvmNativeSymbol(chainId: string): string {
  switch (chainId) {
    case "bsc":
      return "BNB";
    case "polygon":
      return "MATIC";
    default:
      return "ETH";
  }
}

function parseDecimalToUnits(value: string, decimals: number, symbol: string): bigint {
  const normalized = value.trim();
  if (!/^\d+(\.\d+)?$/.test(normalized)) {
    throw new CliError("wallet.transfer_amount_invalid", `${symbol} amount must be a positive decimal`);
  }

  const [whole, fraction = ""] = normalized.split(".");
  if (fraction.length > decimals) {
    throw new CliError(
      "wallet.transfer_amount_precision",
      `${symbol} amount supports at most ${decimals} decimal places`,
    );
  }

  return BigInt(whole) * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, "0") || "0");
}

function assertPositiveAmount(value: bigint, symbol: string): void {
  if (value <= 0n) {
    throw new CliError("wallet.transfer_amount_invalid", `${symbol} amount must be greater than zero`);
  }
}

function decodeBase58(value: string): Uint8Array {
  return Uint8Array.from(bs58.decode(value));
}

interface BitcoinUtxo {
  txid: string;
  vout: number;
  value: number;
}

async function fetchBitcoinUtxos(apiUrl: string, address: string): Promise<BitcoinUtxo[]> {
  const response = await fetch(`${apiUrl}/address/${address}/utxo`);
  if (!response.ok) {
    throw new CliError("wallet.transfer_bitcoin_utxo_failed", `Failed to fetch Bitcoin UTXOs: ${response.status}`);
  }

  return (await response.json()) as BitcoinUtxo[];
}

async function fetchBitcoinFeeRate(apiUrl: string): Promise<number> {
  const response = await fetch(`${apiUrl}/v1/fees/recommended`);
  if (!response.ok) {
    return 10;
  }

  const payload = (await response.json()) as { halfHourFee?: number; fastestFee?: number };
  return payload.halfHourFee ?? payload.fastestFee ?? 10;
}

function selectBitcoinUtxos(
  utxos: BitcoinUtxo[],
  amount: bigint,
  feeRate: number,
): {
  utxos: BitcoinUtxo[];
  fee: bigint;
  change: bigint;
} {
  const selected: BitcoinUtxo[] = [];
  let total = 0n;

  for (const utxo of [...utxos].sort((left, right) => right.value - left.value)) {
    selected.push(utxo);
    total += BigInt(utxo.value);

    const fee = estimateBitcoinFee(selected.length, 2, feeRate);
    if (total >= amount + fee) {
      let change = total - amount - fee;
      if (change <= BITCOIN_DUST_SATS) {
        const noChangeFee = estimateBitcoinFee(selected.length, 1, feeRate);
        if (total >= amount + noChangeFee) {
          change = 0n;
          return {
            utxos: selected,
            fee: total - amount,
            change,
          };
        }
      }

      return { utxos: selected, fee, change };
    }
  }

  throw new CliError("wallet.transfer_insufficient_funds", "Insufficient confirmed Bitcoin balance");
}

function estimateBitcoinFee(inputCount: number, outputCount: number, feeRate: number): bigint {
  const vbytes = 10 + inputCount * 68 + outputCount * 31;
  return BigInt(Math.ceil(vbytes * feeRate));
}

async function broadcastBitcoinTransaction(apiUrl: string, hex: string): Promise<void> {
  const response = await fetch(`${apiUrl}/tx`, {
    method: "POST",
    headers: { "content-type": "text/plain" },
    body: hex,
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new CliError(
      "wallet.transfer_broadcast_failed",
      `Failed to broadcast Bitcoin transaction: ${response.status}${text ? ` ${text}` : ""}`,
    );
  }
}

async function withTransferError<T>(
  code: string,
  message: string,
  action: () => Promise<T>,
): Promise<T> {
  try {
    return await action();
  } catch (error) {
    if (error instanceof CliError) {
      throw error;
    }

    throw new CliError(code, message, {
      cause: error instanceof Error ? error.message : String(error),
    });
  }
}
