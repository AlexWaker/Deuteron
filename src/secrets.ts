import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

import keytar from "keytar";

const KEYCHAIN_SERVICE = "dev.solgent.wallet.secret";
const LOGIN_KEYCHAIN_PATH = path.join(
  os.userInfo().homedir,
  "Library",
  "Keychains",
  "login.keychain-db",
);

export async function storeSecret(key: string, value: string): Promise<void> {
  if (process.platform === "darwin") {
    await runSecurityCommand([
      "add-generic-password",
      "-U",
      "-s",
      KEYCHAIN_SERVICE,
      "-a",
      key,
      "-w",
      value,
      LOGIN_KEYCHAIN_PATH,
    ]);
    return;
  }

  await keytar.setPassword(KEYCHAIN_SERVICE, key, value);
}

export async function readSecret(key: string): Promise<string> {
  if (process.platform === "darwin") {
    try {
      return await runSecurityCommand([
        "find-generic-password",
        "-s",
        KEYCHAIN_SERVICE,
        "-a",
        key,
        "-w",
        LOGIN_KEYCHAIN_PATH,
      ]);
    } catch (error) {
      if (isMissingSecurityItem(error)) {
        throw new Error(`Secret not found: ${key}`);
      }

      throw error;
    }
  }

  const value = await keytar.getPassword(KEYCHAIN_SERVICE, key);

  if (value === null) {
    throw new Error(`Secret not found: ${key}`);
  }

  return value;
}

export async function deleteSecret(key: string): Promise<boolean> {
  if (process.platform === "darwin") {
    try {
      await runSecurityCommand([
        "delete-generic-password",
        "-s",
        KEYCHAIN_SERVICE,
        "-a",
        key,
        LOGIN_KEYCHAIN_PATH,
      ]);
      return true;
    } catch (error) {
      if (isMissingSecurityItem(error)) {
        return false;
      }

      throw error;
    }
  }

  return keytar.deletePassword(KEYCHAIN_SERVICE, key);
}

async function runSecurityCommand(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("security", args, {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    child.stdout.on("data", (chunk) => {
      stdoutChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });

    child.stderr.on("data", (chunk) => {
      stderrChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });

    child.on("error", reject);
    child.on("close", (code) => {
      const stdout = Buffer.concat(stdoutChunks).toString("utf8").trim();
      const stderr = Buffer.concat(stderrChunks).toString("utf8").trim();

      if (code === 0) {
        resolve(stdout);
        return;
      }

      reject(
        Object.assign(new Error(stderr || `security exited with code ${code ?? -1}`), {
          code,
          stderr,
        }),
      );
    });
  });
}

function isMissingSecurityItem(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (("code" in error && error.code === 44) ||
      ("stderr" in error &&
        typeof error.stderr === "string" &&
        error.stderr.includes("could not be found in the keychain")))
  );
}