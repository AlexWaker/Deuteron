import { promises as fs } from "node:fs";
import { randomUUID } from "node:crypto";

import { DATA_DIR, STATE_PATH } from "./config.js";
import type { MnemonicGroupRecord, WalletRecord, WalletState } from "./types.js";

const DEFAULT_STATE: WalletState = {
  version: 1,
  isInitialized: false,
  customChains: {},
  mnemonicGroups: {},
  wallets: {},
};

const RESERVED_ALIASES = new Set(["help", "doctor", "agent", "wallet", "ping", "version", "init"]);

export async function ensureDataDirs(): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true, mode: 0o700 });
}

export async function loadState(): Promise<WalletState> {
  await ensureDataDirs();

  try {
    const content = await fs.readFile(STATE_PATH, "utf8");
    const parsed = JSON.parse(content) as Partial<WalletState>;

    return {
      version: 1,
      isInitialized: parsed.isInitialized ?? false,
      customChains: parsed.customChains ?? {},
      mnemonicGroups: parsed.mnemonicGroups ?? {},
      wallets: parsed.wallets ?? {},
      currentContext: parsed.currentContext,
    };
  } catch (error) {
    if (isMissingFileError(error)) {
      return structuredClone(DEFAULT_STATE);
    }

    throw error;
  }
}

export async function saveState(state: WalletState): Promise<void> {
  await ensureDataDirs();

  const payload = `${JSON.stringify(state, null, 2)}\n`;
  await fs.writeFile(STATE_PATH, payload, { encoding: "utf8", mode: 0o600 });
}

export function getWalletOrThrow(state: WalletState, alias: string): WalletRecord {
  const wallet = state.wallets[alias];

  if (!wallet) {
    throw new Error(`Wallet alias not found: ${alias}`);
  }

  return wallet;
}

export function getMnemonicGroupOrThrow(
  state: WalletState,
  groupId: string,
): MnemonicGroupRecord {
  const group = state.mnemonicGroups[groupId];

  if (!group) {
    throw new Error(`Mnemonic group not found: ${groupId}`);
  }

  return group;
}

export function assertAliasAvailable(state: WalletState, alias: string): void {
  if (state.wallets[alias]) {
    throw new Error(`Wallet alias already exists: ${alias}`);
  }

  if (RESERVED_ALIASES.has(alias)) {
    throw new Error(`Wallet alias is reserved: ${alias}`);
  }
}

export function normalizeAlias(input: string): string {
  const alias = input.trim().toLowerCase();

  if (!alias) {
    throw new Error("Wallet alias cannot be empty");
  }

  if (!/^[a-z0-9_-]+$/.test(alias)) {
    throw new Error("Wallet alias may only contain lowercase letters, numbers, '-' and '_'");
  }

  return alias;
}

export function createUniqueAlias(state: WalletState, baseAlias: string): string {
  let candidate = normalizeAlias(baseAlias);

  if (!state.wallets[candidate] && !RESERVED_ALIASES.has(candidate)) {
    return candidate;
  }

  let suffix = 2;
  while (state.wallets[`${candidate}-${suffix}`] || RESERVED_ALIASES.has(`${candidate}-${suffix}`)) {
    suffix += 1;
  }

  return `${candidate}-${suffix}`;
}

export function makeId(prefix: string): string {
  return `${prefix}-${randomUUID()}`;
}

function isMissingFileError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}