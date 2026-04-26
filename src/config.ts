import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MODULE_PATH = fileURLToPath(import.meta.url);
const MODULE_DIR = path.dirname(MODULE_PATH);

export const PACKAGE_ROOT = path.resolve(MODULE_DIR, "..");
export const RUNTIME_ROOT = path.join(os.homedir(), ".solgent");
export const DATA_DIR = path.join(RUNTIME_ROOT, "data");
export const RUNTIME_DIR = path.join(RUNTIME_ROOT, "run");
export const LOG_DIR = path.join(RUNTIME_ROOT, "logs");
export const SOCKET_PATH = path.join(RUNTIME_DIR, "agent.sock");
export const PID_PATH = path.join(RUNTIME_DIR, "agent.pid");
export const STATE_PATH = path.join(DATA_DIR, "state.json");
export const STAGED_BINARY_PATH = path.join(PACKAGE_ROOT, ".native", "solgent-agent");

export function getBundledBinaryPath(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): string {
  return path.join(PACKAGE_ROOT, "native", `${platform}-${arch}`, "solgent-agent");
}