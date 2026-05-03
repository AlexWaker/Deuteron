import type { Ecosystem, SupportedChain } from "./chains.js";

export type WalletKind = "hd" | "private-key";

export type WalletAddressMap = Record<Ecosystem, string>;

export interface CurrentContext {
  alias: string;
  chain: SupportedChain;
}

export interface MnemonicGroupRecord {
  id: string;
  secretId: string;
  nextAccountIndex: number;
  aliases: string[];
  createdAt: string;
  updatedAt: string;
}

export interface HdWalletRecord {
  alias: string;
  kind: "hd";
  groupId: string;
  accountIndex: number;
  addresses: WalletAddressMap;
  createdAt: string;
  updatedAt: string;
}

export interface PrivateKeyWalletRecord {
  alias: string;
  kind: "private-key";
  chain: SupportedChain;
  ecosystem: Ecosystem;
  secretId: string;
  address: string;
  createdAt: string;
  updatedAt: string;
}

export interface CustomChainRecord {
  id: SupportedChain;
  displayName: string;
  ecosystem: Ecosystem;
  aliases: string[];
  createdAt: string;
  updatedAt: string;
}

export type WalletRecord = HdWalletRecord | PrivateKeyWalletRecord;

export interface WalletState {
  version: 1;
  isInitialized?: boolean;
  currentContext?: CurrentContext;
  customChains: Record<string, CustomChainRecord>;
  mnemonicGroups: Record<string, MnemonicGroupRecord>;
  wallets: Record<string, WalletRecord>;
}

export interface WalletListRow {
  alias: string;
  type: "HD" | "PK";
  chain: SupportedChain;
  address: string;
}

export interface WalletContextView {
  alias: string;
  type: "HD" | "PK";
  chain: SupportedChain;
  address: string;
}