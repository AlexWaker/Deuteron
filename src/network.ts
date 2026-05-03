import type { ChainSpec, Ecosystem } from "./chains.js";
import { SUPPORTED_ECOSYSTEMS, listSupportedChains } from "./chains.js";
import { CliError } from "./output.js";
import { loadState, saveState } from "./state.js";
import type { CustomChainRecord } from "./types.js";

export interface NetworkView {
  id: string;
  displayName: string;
  ecosystem: Ecosystem;
  aliases: string[];
  source: "builtin" | "custom";
}

export interface NetworkAddView extends NetworkView {
  added: true;
}

export async function addNetwork(options: {
  id: string;
  name: string;
  ecosystem: string;
  aliases?: string;
}): Promise<NetworkAddView> {
  const state = await loadState();
  const id = normalizeNetworkName(options.id, "id");
  const displayName = normalizeDisplayName(options.name);
  const ecosystem = normalizeEcosystem(options.ecosystem);
  const aliases = normalizeAliases(options.aliases, id);

  assertNetworkDoesNotConflict(id, aliases);

  const now = new Date().toISOString();
  const chain: CustomChainRecord = {
    id,
    displayName,
    ecosystem,
    aliases,
    createdAt: now,
    updatedAt: now,
  };

  state.customChains[id] = chain;
  await saveState(state);

  return {
    id: chain.id,
    displayName: chain.displayName,
    ecosystem: chain.ecosystem,
    aliases: chain.aliases,
    source: "custom",
    added: true,
  };
}

export async function listNetworks(ecosystemValue?: string): Promise<NetworkView[]> {
  const ecosystem = ecosystemValue ? normalizeEcosystem(ecosystemValue) : undefined;

  return listSupportedChains()
    .filter((chain) => !ecosystem || chain.ecosystem === ecosystem)
    .map(toNetworkView);
}

function assertNetworkDoesNotConflict(id: string, aliases: string[]): void {
  const allKeys = [id, ...aliases];
  const existingChains = listSupportedChains();

  for (const key of allKeys) {
    const conflict = findChainConflict(existingChains, key);
    if (conflict) {
      throw new CliError(
        "network.conflict",
        `Network key '${key}' conflicts with existing ${conflict.source} network ${conflict.id}`,
      );
    }
  }
}

function findChainConflict(chains: ChainSpec[], key: string): ChainSpec | undefined {
  return chains.find((chain) => chain.id === key || chain.aliases.includes(key));
}

function normalizeNetworkName(value: string, fieldName: "id" | "alias"): string {
  const normalized = value.trim().toLowerCase();
  if (!normalized) {
    throw new CliError("network.invalid_name", `Flag --${fieldName} cannot be empty`);
  }

  if (!/^[a-z0-9_-]+$/.test(normalized)) {
    throw new CliError(
      "network.invalid_name",
      `Flag --${fieldName} may only contain lowercase letters, numbers, '-' and '_'`,
    );
  }

  return normalized;
}

function normalizeDisplayName(value: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new CliError("network.invalid_display_name", "Flag --name cannot be empty");
  }

  return normalized;
}

function normalizeAliases(value: string | undefined, id: string): string[] {
  if (!value) {
    return [];
  }

  const aliases = value
    .split(",")
    .map((alias) => normalizeNetworkName(alias, "alias"))
    .filter((alias, index, items) => items.indexOf(alias) === index);

  if (aliases.includes(id)) {
    throw new CliError("network.alias_conflict", "Flag --aliases must not repeat the network id");
  }

  return aliases;
}

function normalizeEcosystem(value: string): Ecosystem {
  const normalized = value.trim().toLowerCase();
  const ecosystem = SUPPORTED_ECOSYSTEMS.find((item) => item === normalized);

  if (!ecosystem) {
    throw new CliError(
      "network.ecosystem_unsupported",
      `Flag --ecosystem must be one of ${SUPPORTED_ECOSYSTEMS.join(", ")}`,
    );
  }

  return ecosystem;
}

function toNetworkView(chain: ChainSpec): NetworkView {
  return {
    id: chain.id,
    displayName: chain.displayName,
    ecosystem: chain.ecosystem,
    aliases: [...chain.aliases],
    source: chain.source,
  };
}