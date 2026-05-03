import { Connection, LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";

import { getChainSpec } from "./chains.js";
import { CliError } from "./output.js";
import type { WalletContextView } from "./types.js";

const DEFAULT_SOLANA_RPC_URL = "https://api.mainnet-beta.solana.com";
const SOLANA_TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const SOLANA_TOKEN_2022_PROGRAM_ID = new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLCrL3tR5uNb1a5G4t");

export interface NativeAssetBalance {
  symbol: string;
  amount: string;
  decimals: number;
  rawAmount: string;
}

export interface TokenAssetBalance {
  tokenAccount: string;
  mint: string;
  amount: string;
  decimals: number;
  rawAmount: string;
}

export interface WalletAssetsView {
  alias: string;
  type: WalletContextView["type"];
  chain: string;
  address: string;
  rpcUrl: string;
  native: NativeAssetBalance;
  tokens: TokenAssetBalance[];
}

export async function getWalletAssets(
  context: WalletContextView,
  options: {
    rpcUrl?: string;
  } = {},
): Promise<WalletAssetsView> {
  const chain = getChainSpec(context.chain);

  if (chain.ecosystem !== "solana") {
    throw new CliError(
      "wallet.assets_chain_unsupported",
      `wallet assets currently supports Solana wallets only. Active chain: ${context.chain}`,
      { chain: context.chain, ecosystem: chain.ecosystem },
    );
  }

  return getSolanaAssets(context, options.rpcUrl ?? process.env.SOLANA_RPC_URL ?? DEFAULT_SOLANA_RPC_URL);
}

async function getSolanaAssets(context: WalletContextView, rpcUrl: string): Promise<WalletAssetsView> {
  const owner = new PublicKey(context.address);
  const connection = new Connection(rpcUrl, "confirmed");
  const lamports = await connection.getBalance(owner);

  const splPromise = connection.getParsedTokenAccountsByOwner(owner, {
    programId: SOLANA_TOKEN_PROGRAM_ID,
  });
  const token2022Promise = connection.getParsedTokenAccountsByOwner(owner, {
    programId: SOLANA_TOKEN_2022_PROGRAM_ID,
  });

  const splResult = await splPromise;
  let token2022Result: typeof splResult | undefined;
  try {
    token2022Result = await token2022Promise;
  } catch {
    token2022Result = undefined;
  }

  const mapToken = (account: (typeof splResult.value)[number]) => {
    const info = account.account.data.parsed.info;
    const amount = info.tokenAmount;

    return {
      tokenAccount: account.pubkey.toBase58(),
      mint: info.mint,
      amount: amount.uiAmountString,
      decimals: amount.decimals,
      rawAmount: amount.amount,
    };
  };

  const merged = [...splResult.value.map(mapToken), ...(token2022Result?.value ?? []).map(mapToken)].filter(
    (token) => token.rawAmount !== "0",
  );

  return {
    alias: context.alias,
    type: context.type,
    chain: context.chain,
    address: owner.toBase58(),
    rpcUrl: connection.rpcEndpoint,
    native: {
      symbol: "SOL",
      amount: formatSol(lamports),
      decimals: 9,
      rawAmount: String(lamports),
    },
    tokens: merged,
  };
}

function formatSol(lamports: number): string {
  return (lamports / LAMPORTS_PER_SOL).toString();
}
