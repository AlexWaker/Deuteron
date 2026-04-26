import { createHash, randomInt } from "node:crypto";

import { HDKey } from "@scure/bip32";
import { generateMnemonic, mnemonicToSeedSync, validateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";
import { Keypair } from "@solana/web3.js";
import * as bitcoin from "bitcoinjs-lib";
import bs58 from "bs58";
import { derivePath } from "ed25519-hd-key";
import { SigningKey, Wallet } from "ethers";
// import * as wif from "wif";

// import { deleteSecret, readSecret, startAgent, storeSecret } from "./agent.js";
import { deleteSecret, readSecret, storeSecret } from "./secrets.js";
import {
  DEFAULT_HD_CHAINS,
  getChainSpec,
  resolveChain,
  type SupportedChain,
} from "./chains.js";
import { CliError } from "./output.js";
import {
  assertAliasAvailable,
  createUniqueAlias,
  getMnemonicGroupOrThrow,
  getWalletOrThrow,
  loadState,
  makeId,
  normalizeAlias,
  saveState,
} from "./state.js";
import type {
  CurrentContext,
  HdWalletRecord,
  MnemonicGroupRecord,
  PrivateKeyWalletRecord,
  WalletAddressMap,
  WalletContextView,
  WalletListRow,
  WalletState,
} from "./types.js";

const ALIAS_WORDS = [
  "atlas",
  "aurora",
  "brisk",
  "cinder",
  "cobalt",
  "ember",
  "falcon",
  "harbor",
  "iris",
  "jade",
  "kepler",
  "lumen",
  "maple",
  "nova",
  "onyx",
  "orchid",
  "pulse",
  "quartz",
  "raven",
  "sable",
  "tidal",
  "vector",
  "willow",
  "zephyr",
] as const;

export interface HdWalletView {
  alias: string;
  type: "HD";
  accountIndex: number;
  addresses: WalletAddressMap;
}

export interface PrivateKeyWalletView {
  alias: string;
  type: "PK";
  chain: SupportedChain;
  address: string;
}

export interface WalletRemovalView {
  alias: string;
  removed: true;
  kind: "HD" | "PK";
  deletedSecret: boolean;
}

export interface WalletRenameView {
  alias: string;
  newAlias: string;
}

export interface WalletExportView {
  alias: string;
  kind: "mnemonic" | "private-key";
  chain?: SupportedChain;
  value: string;
}

export async function createHdWallet(alias?: string): Promise<HdWalletView> {
  const state = await loadState();
  const resolvedAlias = resolveRequestedAlias(state, alias);
  const mnemonic = generateMnemonic(wordlist, 128);
  const groupId = makeId("mnemonic");
  const secretId = makeId("secret");
  const now = timestamp();
  const addresses = deriveHdAddresses(mnemonic, 0);

  await storeSecret(secretId, mnemonic);

  const wallet: HdWalletRecord = {
    alias: resolvedAlias,
    kind: "hd",
    groupId,
    accountIndex: 0,
    addresses,
    createdAt: now,
    updatedAt: now,
  };
  const group: MnemonicGroupRecord = {
    id: groupId,
    secretId,
    nextAccountIndex: 1,
    aliases: [resolvedAlias],
    createdAt: now,
    updatedAt: now,
  };

  state.wallets[resolvedAlias] = wallet;
  state.mnemonicGroups[groupId] = group;
  await saveState(state);

  return toHdView(wallet);
}

export async function importMnemonicWallet(
  rawMnemonic: string,
  alias?: string,
): Promise<HdWalletView> {
  const state = await loadState();
  const resolvedAlias = resolveRequestedAlias(state, alias);
  const mnemonic = normalizeMnemonic(rawMnemonic);

  if (!validateMnemonic(mnemonic, wordlist)) {
    throw new CliError(
      "wallet.mnemonic_invalid",
      "Mnemonic must contain a valid 12 or 24 word BIP39 phrase",
    );
  }

  const groupId = makeId("mnemonic");
  const secretId = makeId("secret");
  const now = timestamp();
  const addresses = deriveHdAddresses(mnemonic, 0);

  await storeSecret(secretId, mnemonic);

  const wallet: HdWalletRecord = {
    alias: resolvedAlias,
    kind: "hd",
    groupId,
    accountIndex: 0,
    addresses,
    createdAt: now,
    updatedAt: now,
  };
  const group: MnemonicGroupRecord = {
    id: groupId,
    secretId,
    nextAccountIndex: 1,
    aliases: [resolvedAlias],
    createdAt: now,
    updatedAt: now,
  };

  state.wallets[resolvedAlias] = wallet;
  state.mnemonicGroups[groupId] = group;
  await saveState(state);

  return toHdView(wallet);
}

export async function importPrivateKeyWallet(
  rawPrivateKey: string,
  chainValue: string,
  alias?: string,
): Promise<PrivateKeyWalletView> {
  const state = await loadState();
  const resolvedAlias = resolveRequestedAlias(state, alias);
  const chain = resolveChainSafely(chainValue);
  const normalized = normalizePrivateKey(rawPrivateKey, chain);
  const now = timestamp();
  const secretId = makeId("secret");

  await storeSecret(secretId, normalized.secret);

  const wallet: PrivateKeyWalletRecord = {
    alias: resolvedAlias,
    kind: "private-key",
    chain: chain.id,
    ecosystem: chain.ecosystem,
    secretId,
    address: normalized.address,
    createdAt: now,
    updatedAt: now,
  };

  state.wallets[resolvedAlias] = wallet;
  await saveState(state);

  return {
    alias: wallet.alias,
    type: "PK",
    chain: wallet.chain,
    address: wallet.address,
  };
}

export async function deriveWallet(fromAlias: string, alias?: string): Promise<HdWalletView> {
  const state = await loadState();
  const source = getWalletOrThrow(state, normalizeAlias(fromAlias));

  if (source.kind !== "hd") {
    throw new CliError("wallet.derive_unsupported", "Only mnemonic wallets can derive child wallets");
  }

  const group = getMnemonicGroupOrThrow(state, source.groupId);
  const resolvedAlias = resolveRequestedAlias(state, alias);
  const mnemonic = await loadGroupMnemonic(group);
  const nextAccountIndex = group.nextAccountIndex;
  const now = timestamp();

  const wallet: HdWalletRecord = {
    alias: resolvedAlias,
    kind: "hd",
    groupId: group.id,
    accountIndex: nextAccountIndex,
    addresses: deriveHdAddresses(mnemonic, nextAccountIndex),
    createdAt: now,
    updatedAt: now,
  };

  group.nextAccountIndex += 1;
  group.aliases.push(resolvedAlias);
  group.updatedAt = now;
  state.wallets[resolvedAlias] = wallet;
  await saveState(state);

  return toHdView(wallet);
}

export async function listWallets(chainValue?: string): Promise<WalletListRow[]> {
  const state = await loadState();
  const wallets = Object.values(state.wallets);
  const rows = chainValue
    ? listWalletsForChain(wallets, resolveChainSafely(chainValue).id)
    : listWalletsDefault(wallets);

  return rows.sort((left, right) => {
    if (left.alias === right.alias) {
      return left.chain.localeCompare(right.chain);
    }

    return left.alias.localeCompare(right.alias);
  });
}

export async function switchWallet(alias: string, chainValue?: string): Promise<WalletContextView> {
  const state = await loadState();
  const wallet = getWalletOrThrow(state, normalizeAlias(alias));
  const chain = resolveSwitchChain(wallet, chainValue);
  const context: CurrentContext = {
    alias: wallet.alias,
    chain,
  };

  state.currentContext = context;
  await saveState(state);
  return resolveContextView(state, context);
}

export async function getCurrentWalletContext(): Promise<WalletContextView> {
  const state = await loadState();

  if (!state.currentContext) {
    throw new CliError("wallet.context_missing", "No wallet context is currently active");
  }

  return resolveContextView(state, state.currentContext);
}

export async function renameWallet(alias: string, newAlias: string): Promise<WalletRenameView> {
  const state = await loadState();
  const currentAlias = normalizeAlias(alias);
  const nextAlias = normalizeAlias(newAlias);

  if (currentAlias === nextAlias) {
    throw new CliError("wallet.rename_noop", "New alias must be different from the current alias");
  }

  const wallet = getWalletOrThrow(state, currentAlias);
  assertAliasAvailable(state, nextAlias);

  if (wallet.kind === "hd") {
    const group = getMnemonicGroupOrThrow(state, wallet.groupId);
    group.aliases = group.aliases.map((value) => (value === currentAlias ? nextAlias : value));
    group.updatedAt = timestamp();
  }

  delete state.wallets[currentAlias];
  const updatedWallet = {
    ...wallet,
    alias: nextAlias,
    updatedAt: timestamp(),
  };
  state.wallets[nextAlias] = updatedWallet;

  if (state.currentContext?.alias === currentAlias) {
    state.currentContext.alias = nextAlias;
  }

  await saveState(state);
  return { alias: currentAlias, newAlias: nextAlias };
}

export async function removeWallet(alias: string): Promise<WalletRemovalView> {
  const state = await loadState();
  const wallet = getWalletOrThrow(state, normalizeAlias(alias));
  const now = timestamp();

  if (wallet.kind === "private-key") {
    const deletedSecret = await deleteSecret(wallet.secretId);
    delete state.wallets[wallet.alias];
    clearContextIfMatches(state, wallet.alias);
    await saveState(state);

    return {
      alias: wallet.alias,
      removed: true,
      kind: "PK",
      deletedSecret,
    };
  }

  const group = getMnemonicGroupOrThrow(state, wallet.groupId);
  group.aliases = group.aliases.filter((item) => item !== wallet.alias);
  group.updatedAt = now;
  delete state.wallets[wallet.alias];
  clearContextIfMatches(state, wallet.alias);

  let deletedSecret = false;
  if (group.aliases.length === 0) {
    deletedSecret = await deleteSecret(group.secretId);
    delete state.mnemonicGroups[group.id];
  }

  await saveState(state);
  return {
    alias: wallet.alias,
    removed: true,
    kind: "HD",
    deletedSecret,
  };
}

export async function exportMnemonic(alias: string): Promise<WalletExportView> {
  const state = await loadState();
  const wallet = getWalletOrThrow(state, normalizeAlias(alias));

  if (wallet.kind !== "hd") {
    throw new CliError("wallet.export_mnemonic_unsupported", "Only mnemonic wallets can export a mnemonic");
  }

  const group = getMnemonicGroupOrThrow(state, wallet.groupId);
  const value = await loadGroupMnemonic(group);

  return {
    alias: wallet.alias,
    kind: "mnemonic",
    value,
  };
}

export async function exportPrivateKey(
  alias: string,
  chainValue?: string,
): Promise<WalletExportView> {
  const state = await loadState();
  const wallet = getWalletOrThrow(state, normalizeAlias(alias));

  if (wallet.kind === "private-key") {
    const chain = chainValue ? resolveChainSafely(chainValue).id : wallet.chain;

    if (chain !== wallet.chain) {
      throw new CliError(
        "wallet.export_chain_mismatch",
        `Wallet ${wallet.alias} only supports ${wallet.chain}`,
      );
    }

    const value = await readSecret(wallet.secretId);
    return {
      alias: wallet.alias,
      kind: "private-key",
      chain,
      value,
    };
  }

  if (!chainValue) {
    throw new CliError(
      "wallet.export_chain_required",
      "Mnemonic wallet private-key export requires --chain",
    );
  }

  const chain = resolveChainSafely(chainValue);
  const group = getMnemonicGroupOrThrow(state, wallet.groupId);
  const mnemonic = await loadGroupMnemonic(group);

  return {
    alias: wallet.alias,
    kind: "private-key",
    chain: chain.id,
    value: deriveHdPrivateKey(mnemonic, wallet.accountIndex, chain.id),
  };
}

export async function getWalletCounts(): Promise<{
  total: number;
  hd: number;
  privateKey: number;
}> {
  const state = await loadState();
  const wallets = Object.values(state.wallets);

  return {
    total: wallets.length,
    hd: wallets.filter((wallet) => wallet.kind === "hd").length,
    privateKey: wallets.filter((wallet) => wallet.kind === "private-key").length,
  };
}

function resolveRequestedAlias(state: WalletState, alias?: string): string {
  if (alias) {
    const normalized = normalizeAlias(alias);
    assertAliasAvailable(state, normalized);
    return normalized;
  }

  const fallback = ALIAS_WORDS[randomInt(ALIAS_WORDS.length)] ?? "wallet";
  return createUniqueAlias(state, fallback);
}

function deriveHdAddresses(mnemonic: string, accountIndex: number): WalletAddressMap {
  const seed = mnemonicToSeedSync(mnemonic);
  const rootKey = HDKey.fromMasterSeed(seed);
  const ethereumNode = rootKey.derive(`m/44'/60'/${accountIndex}'/0/0`);
  const bitcoinNode = rootKey.derive(`m/84'/0'/${accountIndex}'/0/0`);
  const solanaNode = derivePath(`m/44'/501'/${accountIndex}'/0'`, Buffer.from(seed).toString("hex"));

  if (!ethereumNode.privateKey) {
    throw new CliError("wallet.derive_failed", "Failed to derive Ethereum private key");
  }

  if (!bitcoinNode.privateKey || !bitcoinNode.publicKey) {
    throw new CliError("wallet.derive_failed", "Failed to derive Bitcoin private key");
  }

  const ethereumWallet = new Wallet(toHexPrefixed(ethereumNode.privateKey));
  const bitcoinPayment = bitcoin.payments.p2wpkh({
    pubkey: Buffer.from(bitcoinNode.publicKey),
    network: bitcoin.networks.bitcoin,
  });

  if (!bitcoinPayment.address) {
    throw new CliError("wallet.derive_failed", "Failed to derive Bitcoin address");
  }

  const solanaWallet = Keypair.fromSeed(Uint8Array.from(solanaNode.key));

  return {
    ethereum: ethereumWallet.address,
    solana: solanaWallet.publicKey.toBase58(),
    bitcoin: bitcoinPayment.address,
  };
}

function normalizeMnemonic(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .join(" ");
}

function normalizePrivateKey(
  rawPrivateKey: string,
  chain: ReturnType<typeof resolveChain>,
): {
  secret: string;
  address: string;
} {
  const value = rawPrivateKey.trim();

  switch (chain.ecosystem) {
    case "ethereum": {
      const secret = normalizeHexPrivateKey(value);
      const wallet = new Wallet(secret);
      return {
        secret,
        address: wallet.address,
      };
    }
    case "solana": {
      const keypair = parseSolanaKeypair(value);
      return {
        secret: bs58.encode(keypair.secretKey),
        address: keypair.publicKey.toBase58(),
      };
    }
    case "bitcoin": {
      const parsed = parseBitcoinPrivateKey(value);
      const publicKey = Buffer.from(
        SigningKey.computePublicKey(toHexPrefixed(parsed.privateKey), true).slice(2),
        "hex",
      );
      const payment = bitcoin.payments.p2wpkh({
        pubkey: publicKey,
        network: bitcoin.networks.bitcoin,
      });

      if (!payment.address) {
        throw new CliError("wallet.private_key_invalid", "Failed to derive Bitcoin address");
      }

      return {
        secret: parsed.wif,
        address: payment.address,
      };
    }
  }

  throw new CliError("wallet.chain_unsupported", "Unsupported chain ecosystem");
}

function parseSolanaKeypair(value: string): Keypair {
  try {
    if (value.startsWith("[")) {
      const bytes = JSON.parse(value) as number[];
      const secretKey = Uint8Array.from(bytes);
      return secretKey.length === 32
        ? Keypair.fromSeed(secretKey)
        : Keypair.fromSecretKey(secretKey);
    }

    const decoded = bs58.decode(value);
    return decoded.length === 32
      ? Keypair.fromSeed(decoded)
      : Keypair.fromSecretKey(decoded);
  } catch {
    throw new CliError(
      "wallet.private_key_invalid",
      "Solana private key must be base58 or a JSON byte array",
    );
  }
}

function parseBitcoinPrivateKey(value: string): {
  privateKey: Uint8Array;
  wif: string;
} {
  try {
    const decoded = decodeBitcoinWif(value);
    return {
      privateKey: decoded.privateKey,
      wif: value,
    };
  } catch {
    const hex = normalizeHexPrivateKey(value).slice(2);
    const privateKey = Uint8Array.from(Buffer.from(hex, "hex"));

    return {
      privateKey,
      wif: encodeBitcoinWif({
        version: 0x80,
        privateKey,
        compressed: true,
      }),
    };
  }
}

function normalizeHexPrivateKey(value: string): string {
  const normalized = value.startsWith("0x") ? value : `0x${value}`;

  if (!/^0x[0-9a-fA-F]{64}$/.test(normalized)) {
    throw new CliError(
      "wallet.private_key_invalid",
      "Private key must be a 32-byte hex string",
    );
  }

  return normalized.toLowerCase();
}

function deriveHdPrivateKey(
  mnemonic: string,
  accountIndex: number,
  chain: SupportedChain,
): string {
  const seed = mnemonicToSeedSync(mnemonic);
  const rootKey = HDKey.fromMasterSeed(seed);
  const chainSpec = getChainSpec(chain);

  switch (chainSpec.ecosystem) {
    case "ethereum": {
      const node = rootKey.derive(`m/44'/60'/${accountIndex}'/0/0`);

      if (!node.privateKey) {
        throw new CliError("wallet.export_failed", "Failed to derive Ethereum private key");
      }

      return toHexPrefixed(node.privateKey);
    }
    case "solana": {
      const derived = derivePath(`m/44'/501'/${accountIndex}'/0'`, Buffer.from(seed).toString("hex"));
      const keypair = Keypair.fromSeed(Uint8Array.from(derived.key));
      return bs58.encode(keypair.secretKey);
    }
    case "bitcoin": {
      const node = rootKey.derive(`m/84'/0'/${accountIndex}'/0/0`);

      if (!node.privateKey) {
        throw new CliError("wallet.export_failed", "Failed to derive Bitcoin private key");
      }

      return encodeBitcoinWif({
        version: 0x80,
        privateKey: node.privateKey,
        compressed: true,
      });
    }
    default:
      throw new CliError("wallet.chain_unsupported", `Unsupported chain: ${chain}`);
  }
}

function resolveSwitchChain(
  wallet: HdWalletRecord | PrivateKeyWalletRecord,
  chainValue?: string,
): SupportedChain {
  if (wallet.kind === "private-key") {
    if (!chainValue) {
      return wallet.chain;
    }

    const chain = resolveChainSafely(chainValue).id;
    if (chain !== wallet.chain) {
      throw new CliError(
        "wallet.switch_chain_mismatch",
        `Wallet ${wallet.alias} only supports ${wallet.chain}`,
      );
    }

    return chain;
  }

  if (!chainValue) {
    throw new CliError(
      "wallet.switch_chain_required",
      "Mnemonic wallets require --chain when switching context",
    );
  }

  return resolveChainSafely(chainValue).id;
}

function resolveContextView(state: WalletState, context: CurrentContext): WalletContextView {
  const wallet = getWalletOrThrow(state, context.alias);

  if (wallet.kind === "private-key") {
    return {
      alias: wallet.alias,
      type: "PK",
      chain: wallet.chain,
      address: wallet.address,
    };
  }

  const chainSpec = getChainSpec(context.chain);
  return {
    alias: wallet.alias,
    type: "HD",
    chain: context.chain,
    address: wallet.addresses[chainSpec.ecosystem],
  };
}

function listWalletsDefault(wallets: Array<HdWalletRecord | PrivateKeyWalletRecord>): WalletListRow[] {
  const rows: WalletListRow[] = [];

  for (const wallet of wallets) {
    if (wallet.kind === "private-key") {
      rows.push({
        alias: wallet.alias,
        type: "PK",
        chain: wallet.chain,
        address: wallet.address,
      });
      continue;
    }

    for (const chain of DEFAULT_HD_CHAINS) {
      rows.push({
        alias: wallet.alias,
        type: "HD",
        chain,
        address: wallet.addresses[getChainSpec(chain).ecosystem],
      });
    }
  }

  return rows;
}

function listWalletsForChain(
  wallets: Array<HdWalletRecord | PrivateKeyWalletRecord>,
  chain: SupportedChain,
): WalletListRow[] {
  const rows: WalletListRow[] = [];

  for (const wallet of wallets) {
    if (wallet.kind === "private-key") {
      if (wallet.chain === chain) {
        rows.push({
          alias: wallet.alias,
          type: "PK",
          chain: wallet.chain,
          address: wallet.address,
        });
      }

      continue;
    }

    rows.push({
      alias: wallet.alias,
      type: "HD",
      chain,
      address: wallet.addresses[getChainSpec(chain).ecosystem],
    });
  }

  return rows;
}

function clearContextIfMatches(state: WalletState, alias: string): void {
  if (state.currentContext?.alias === alias) {
    delete state.currentContext;
  }
}

async function loadGroupMnemonic(group: MnemonicGroupRecord): Promise<string> {
  return readSecret(group.secretId);
}

function toHdView(wallet: HdWalletRecord): HdWalletView {
  return {
    alias: wallet.alias,
    type: "HD",
    accountIndex: wallet.accountIndex,
    addresses: {
      ethereum: wallet.addresses.ethereum,
      solana: wallet.addresses.solana,
      bitcoin: wallet.addresses.bitcoin,
    },
  };
}

function resolveChainSafely(value: string) {
  try {
    return resolveChain(value);
  } catch (error) {
    throw new CliError(
      "wallet.chain_unsupported",
      error instanceof Error ? error.message : String(error),
    );
  }
}

function encodeBitcoinWif(options: {
  version: number;
  privateKey: Uint8Array;
  compressed: boolean;
}): string {
  const payload = Buffer.concat([
    Buffer.from([options.version]),
    Buffer.from(options.privateKey),
    ...(options.compressed ? [Buffer.from([0x01])] : []),
  ]);
  const checksum = sha256d(payload).subarray(0, 4);

  return bs58.encode(Buffer.concat([payload, checksum]));
}

function decodeBitcoinWif(value: string): {
  privateKey: Uint8Array;
  compressed: boolean;
  version: number;
} {
  const decoded = Buffer.from(bs58.decode(value));

  if (decoded.length !== 37 && decoded.length !== 38) {
    throw new CliError("wallet.private_key_invalid", "Bitcoin private key must be WIF or hex");
  }

  const payload = decoded.subarray(0, decoded.length - 4);
  const checksum = decoded.subarray(decoded.length - 4);
  const expected = sha256d(payload).subarray(0, 4);

  if (!checksum.equals(expected)) {
    throw new CliError("wallet.private_key_invalid", "Bitcoin WIF checksum is invalid");
  }

  const version = payload[0] ?? 0;
  const compressed = payload.length === 34 && payload[payload.length - 1] === 0x01;
  const privateKey = payload.subarray(1, compressed ? 33 : payload.length);

  if (privateKey.length !== 32) {
    throw new CliError("wallet.private_key_invalid", "Bitcoin private key must be 32 bytes");
  }

  return {
    privateKey: Uint8Array.from(privateKey),
    compressed,
    version,
  };
}

function sha256d(value: Uint8Array): Buffer {
  const first = createHash("sha256").update(value).digest();
  return createHash("sha256").update(first).digest();
}

function toHexPrefixed(bytes: Uint8Array): string {
  return `0x${Buffer.from(bytes).toString("hex")}`;
}

function timestamp(): string {
  return new Date().toISOString();
}