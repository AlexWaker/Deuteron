import { spawn } from "node:child_process";
import fs from "node:fs";
import { promises as fsPromises } from "node:fs";
import net from "node:net";
import path from "node:path";

import {
  LOG_DIR,
  PID_PATH,
  RUNTIME_DIR,
  SOCKET_PATH,
  STAGED_BINARY_PATH,
} from "./config.js";

const START_TIMEOUT_MS = 3_000;
const REQUEST_TIMEOUT_MS = 1_500;

export type AgentEnvelope<T = Record<string, unknown>> = {
  ok: boolean;
  code: string;
  data?: T;
  error?: {
    message: string;
    details?: unknown;
  };
};

export type AgentRuntimeInfo = {
  reply: string;
  pid: number;
  version: string;
  started_at: number;
  socket: string;
};

export type AgentStatus = AgentEnvelope<AgentRuntimeInfo> & {
  running: boolean;
};

export async function ensureRuntimeDirs(): Promise<void> {
  await fsPromises.mkdir(RUNTIME_DIR, { recursive: true });
  await fsPromises.mkdir(LOG_DIR, { recursive: true });
}

export function hasStagedBinary(): boolean {
  try {
    fs.accessSync(STAGED_BINARY_PATH, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export async function getAgentStatus(): Promise<AgentStatus> {
  try {
    const response = await sendRequest<AgentRuntimeInfo>("status");

    if (!response.ok) {
      return {
        ...response,
        running: false,
      };
    }

    return { ...response, running: true };
  } catch (error) {
    return {
      ok: false,
      code: "agent.unreachable",
      error: { message: normalizeError(error) },
      running: false,
    };
  }
}

export async function pingAgent(): Promise<AgentStatus> {
  try {
    const response = await sendRequest<AgentRuntimeInfo>("ping");

    if (!response.ok) {
      return {
        ...response,
        running: false,
      };
    }

    return { ...response, running: true };
  } catch (error) {
    return {
      ok: false,
      code: "agent.unreachable",
      error: { message: normalizeError(error) },
      running: false,
    };
  }
}

export async function startAgent(): Promise<AgentStatus> {
  await ensureRuntimeDirs();

  if (!hasStagedBinary()) {
    throw new Error(
      `Bundled agent binary is not ready at ${STAGED_BINARY_PATH}. Run pnpm build:native first.`,
    );
  }

  const currentStatus = await getAgentStatus();
  if (currentStatus.running) {
    return currentStatus;
  }

  safeUnlink(SOCKET_PATH);
  safeUnlink(PID_PATH);

  const logPath = path.join(LOG_DIR, "agent.log");
  const logFd = fs.openSync(logPath, "a");

  try {
    const child = spawn(
      STAGED_BINARY_PATH,
      ["daemon", "--socket", SOCKET_PATH, "--pid-file", PID_PATH],
      {
        detached: true,
        stdio: ["ignore", logFd, logFd],
      },
    );

    child.unref();
  } finally {
    fs.closeSync(logFd);
  }

  await waitForAgent(START_TIMEOUT_MS);
  return getAgentStatus();
}

export async function stopAgent(): Promise<AgentStatus> {
  try {
    await sendRequest<AgentRuntimeInfo>("stop");
    await waitUntilStopped(START_TIMEOUT_MS);
    safeUnlink(PID_PATH);
    safeUnlink(SOCKET_PATH);

    return {
      ok: true,
      code: "agent.stopped",
      data: {
        pid: 0,
        reply: "agent stopped",
        socket: SOCKET_PATH,
        started_at: 0,
        version: "unknown",
      },
      running: false,
    };
  } catch {
    safeUnlink(PID_PATH);
    safeUnlink(SOCKET_PATH);

    return {
      ok: true,
      code: "agent.stopped",
      data: {
        pid: 0,
        reply: "agent already stopped",
        socket: SOCKET_PATH,
        started_at: 0,
        version: "unknown",
      },
      running: false,
    };
  }
}

export async function storeSecret(key: string, value: string): Promise<void> {
  const response = await sendRequest<{ key: string }>("store_secret", { key, value });
  assertAgentSuccess(response);
}

export async function readSecret(key: string): Promise<string> {
  const response = await sendRequest<{ key: string; value: string }>("read_secret", { key });
  return assertAgentSuccess(response).value;
}

export async function deleteSecret(key: string): Promise<boolean> {
  const response = await sendRequest<{ key: string; found: boolean }>("delete_secret", { key });
  return assertAgentSuccess(response).found;
}

async function waitForAgent(timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const status = await getAgentStatus();
    if (status.running) {
      return;
    }

    await sleep(150);
  }

  throw new Error(`Timed out waiting for agent socket at ${SOCKET_PATH}`);
}

async function waitUntilStopped(timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const status = await getAgentStatus();
    if (!status.running) {
      return;
    }

    await sleep(150);
  }
}

async function sendRequest<T>(action: string, params?: Record<string, unknown>): Promise<AgentEnvelope<T>> {
  await ensureRuntimeDirs();

  return new Promise<AgentEnvelope<T>>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let settled = false;

    const socket = net.createConnection(SOCKET_PATH);
    const timeout = setTimeout(() => {
      if (settled) {
        return;
      }

      settled = true;
      socket.destroy();
      reject(new Error(`Timed out waiting for agent response from ${SOCKET_PATH}`));
    }, REQUEST_TIMEOUT_MS);

    const finish = (callback: () => void): void => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timeout);
      callback();
    };

    socket.on("connect", () => {
      socket.write(`${JSON.stringify({ action, params })}\n`);
    });

    socket.on("data", (chunk) => {
      chunks.push(Buffer.from(chunk));
    });

    socket.on("end", () => {
      finish(() => {
        const text = Buffer.concat(chunks).toString("utf8").trim();

        if (!text) {
          reject(new Error("Agent returned an empty response"));
          return;
        }

        try {
          resolve(JSON.parse(text) as AgentEnvelope<T>);
        } catch {
          reject(new Error(`Agent returned invalid JSON: ${text}`));
        }
      });
    });

    socket.on("error", (error) => {
      finish(() => {
        reject(error);
      });
    });
  });
}

function assertAgentSuccess<T>(response: AgentEnvelope<T>): T {
  if (!response.ok || response.data === undefined) {
    throw new Error(response.error?.message ?? `Agent request failed: ${response.code}`);
  }

  return response.data;
}

function safeUnlink(targetPath: string): void {
  try {
    fs.unlinkSync(targetPath);
  } catch (error) {
    if (!isIgnorableFsError(error)) {
      throw error;
    }
  }
}

function isIgnorableFsError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error.code === "ENOENT" || error.code === "ENOTDIR")
  );
}

function normalizeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}