import { readFileSync } from "node:fs";

import { STATE_PATH } from "./config.js";
import type { CustomChainRecord, WalletState } from "./types.js";

export const SUPPORTED_CHAINS = [
  {
    id: "ethereum",
    displayName: "Ethereum",
    ecosystem: "ethereum",
    aliases: ["eth", "ethereum", "evm", "mainnet"],
  },
  {
    id: "solana",
    displayName: "Solana",
    ecosystem: "solana",
    aliases: ["sol", "solana"],
  },
  {
    id: "bitcoin",
    displayName: "Bitcoin",
    ecosystem: "bitcoin",
    aliases: ["btc", "bitcoin"],
  },
  {
    id: "bsc",
    displayName: "BNB Smart Chain",
    ecosystem: "ethereum",
    aliases: ["bsc", "bnb", "binance-smart-chain"],
  },
  {
    id: "polygon",
    displayName: "Polygon",
    ecosystem: "ethereum",
    aliases: ["polygon", "matic"],
  },
  {
    id: "base",
    displayName: "Base",
    ecosystem: "ethereum",
    aliases: ["base"],
  },
  {
    id: "arbitrum",
    displayName: "Arbitrum",
    ecosystem: "ethereum",
    aliases: ["arbitrum", "arb"],
  },
  {
    id: "optimism",
    displayName: "Optimism",
    ecosystem: "ethereum",
    aliases: ["optimism", "op"],
  },
] as const;

export type BuiltinSupportedChain = (typeof SUPPORTED_CHAINS)[number]["id"];
// export type SupportedChain = (typeof SUPPORTED_CHAINS)[number]["id"];
export type SupportedChain = string;
export type Ecosystem = (typeof SUPPORTED_CHAINS)[number]["ecosystem"];
export interface ChainSpec {
  id: SupportedChain;
  displayName: string;
  ecosystem: Ecosystem;
  aliases: string[];
  source: "builtin" | "custom";
}

export const SUPPORTED_ECOSYSTEMS: Ecosystem[] = ["ethereum", "solana", "bitcoin"];

export const DEFAULT_HD_CHAINS: SupportedChain[] = ["ethereum", "solana", "bitcoin"];

export function listSupportedChains(): ChainSpec[] {
  const builtinChains: ChainSpec[] = SUPPORTED_CHAINS.map((chain) => ({
    ...chain,
    aliases: [...chain.aliases],
    source: "builtin",
  }));
  const customChains = loadCustomChainSpecs();

  return [...builtinChains, ...customChains].sort((left, right) => {
    if (left.source !== right.source) {
      return left.source === "builtin" ? -1 : 1;
    }

    return left.id.localeCompare(right.id);
  });
}

export function resolveChain(value: string): ChainSpec {
  const normalized = value.trim().toLowerCase();
  // const match = SUPPORTED_CHAINS.find(
  const match = listSupportedChains().find(
    (chain) => chain.id === normalized || chain.aliases.some((alias) => alias === normalized),
  );

  if (!match) {
    throw new Error(`Unsupported chain: ${value}`);
  }

  return match;
}

export function getChainSpec(chain: SupportedChain): ChainSpec {
  // const match = SUPPORTED_CHAINS.find((item) => item.id === chain);
  const match = listSupportedChains().find((item) => item.id === chain);

  if (!match) {
    throw new Error(`Unsupported chain: ${chain}`);
  }

  return match;
}

export function getDisplayChain(chain: SupportedChain): string {
  return getChainSpec(chain).displayName;
}

function loadCustomChainSpecs(): ChainSpec[] {
  try {
    const content = readFileSync(STATE_PATH, "utf8");
    const parsed = JSON.parse(content) as Partial<WalletState>;
    const customChains = parsed.customChains ?? {};

    return Object.values(customChains)
      .filter(isCustomChainRecord)
      .map((chain) => ({
        id: chain.id,
        displayName: chain.displayName,
        ecosystem: chain.ecosystem,
        aliases: [...chain.aliases],
        source: "custom" as const,
      }));
  } catch (error) {
    if (isMissingFileError(error)) {
      return [];
    }

    return [];
  }
}

function isCustomChainRecord(value: unknown): value is CustomChainRecord {
  return (
    typeof value === "object" &&
    value !== null &&
    "id" in value &&
    typeof value.id === "string" &&
    "displayName" in value &&
    typeof value.displayName === "string" &&
    "ecosystem" in value &&
    typeof value.ecosystem === "string" &&
    SUPPORTED_ECOSYSTEMS.includes(value.ecosystem as Ecosystem) &&
    "aliases" in value &&
    Array.isArray(value.aliases) &&
    value.aliases.every((alias) => typeof alias === "string")
  );
}

function isMissingFileError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}