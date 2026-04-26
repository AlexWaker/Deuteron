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

export type SupportedChain = (typeof SUPPORTED_CHAINS)[number]["id"];
export type Ecosystem = (typeof SUPPORTED_CHAINS)[number]["ecosystem"];
export type ChainSpec = (typeof SUPPORTED_CHAINS)[number];

export const DEFAULT_HD_CHAINS: SupportedChain[] = ["ethereum", "solana", "bitcoin"];

export function resolveChain(value: string): ChainSpec {
  const normalized = value.trim().toLowerCase();
  const match = SUPPORTED_CHAINS.find(
    (chain) => chain.id === normalized || chain.aliases.some((alias) => alias === normalized),
  );

  if (!match) {
    throw new Error(`Unsupported chain: ${value}`);
  }

  return match;
}

export function getChainSpec(chain: SupportedChain): ChainSpec {
  const match = SUPPORTED_CHAINS.find((item) => item.id === chain);

  if (!match) {
    throw new Error(`Unsupported chain: ${chain}`);
  }

  return match;
}

export function getDisplayChain(chain: SupportedChain): string {
  return getChainSpec(chain).displayName;
}