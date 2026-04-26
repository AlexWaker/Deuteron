import type { WalletContextView, WalletListRow } from "./types.js";

export interface CommandSuccess<T> {
  ok: true;
  code: string;
  data: T;
}

export interface CommandFailure {
  ok: false;
  code: string;
  error: {
    message: string;
    details?: unknown;
  };
}

export type CommandEnvelope<T> = CommandSuccess<T> | CommandFailure;

export class CliError extends Error {
  readonly code: string;
  readonly details?: unknown;
  readonly exitCode: number;

  constructor(code: string, message: string, details?: unknown, exitCode = 1) {
    super(message);
    this.code = code;
    this.details = details;
    this.exitCode = exitCode;
  }
}

export function success<T>(code: string, data: T): CommandSuccess<T> {
  return { ok: true, code, data };
}

export function failure(error: unknown): CommandFailure {
  if (error instanceof CliError) {
    return {
      ok: false,
      code: error.code,
      error: {
        message: error.message,
        details: error.details,
      },
    };
  }

  if (error instanceof Error) {
    return {
      ok: false,
      code: "unexpected_error",
      error: {
        message: error.message,
      },
    };
  }

  return {
    ok: false,
    code: "unexpected_error",
    error: {
      message: String(error),
    },
  };
}

export function renderListTable(rows: WalletListRow[]): string {
  if (rows.length === 0) {
    return "No wallets found.";
  }

  return renderTable([
    ["Alias", "Type", "Chain", "Address"],
    ...rows.map((row) => [row.alias, row.type, row.chain, row.address]),
  ]);
}

export function renderContextTable(context: WalletContextView): string {
  return renderTable([
    ["Alias", "Type", "Chain", "Address"],
    [context.alias, context.type, context.chain, context.address],
  ]);
}

export function renderTable(rows: string[][]): string {
  const widths = rows[0].map((_, columnIndex) => {
    return rows.reduce((current, row) => Math.max(current, row[columnIndex].length), 0);
  });

  return rows
    .map((row, rowIndex) => {
      const line = row
        .map((cell, columnIndex) => cell.padEnd(widths[columnIndex], " "))
        .join("  ")
        .trimEnd();

      if (rowIndex === 0) {
        const separator = widths.map((width) => "-".repeat(width)).join("  ");
        return `${line}\n${separator}`;
      }

      return line;
    })
    .join("\n");
}