import os from "node:os";
import { promises as fsPromises } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const scriptDir = path.dirname(scriptPath);
const packageRoot = path.resolve(scriptDir, "..");
const binaryName = process.platform === "win32" ? "solgent-agent.exe" : "solgent-agent";
const sourceBinary = path.join(
  packageRoot,
  "native",
  `${process.platform}-${process.arch}`,
  binaryName,
);
const stagedBinary = path.join(packageRoot, ".native", binaryName);
const zshrcPath = path.join(os.homedir(), ".zshrc");
const shellBlockStart = "# >>> deuteron wallet path >>>";
const shellBlockEnd = "# <<< deuteron wallet path <<<";

try {
  await fsPromises.access(sourceBinary);
} catch {
  console.warn(`Skipping native staging because ${sourceBinary} is not bundled yet.`);
  process.exit(0);
}

await fsPromises.mkdir(path.dirname(stagedBinary), { recursive: true });
await fsPromises.copyFile(sourceBinary, stagedBinary);

if (process.platform !== "win32") {
  await fsPromises.chmod(stagedBinary, 0o755);
}

console.log(`Staged Solgent agent at ${stagedBinary}`);

if (process.platform === "darwin" && process.env.npm_config_global === "true") {
  const binDir = resolveGlobalBinDirectory();

  if (binDir) {
    await ensureZshPath(binDir);
  }
}

// function resolveGlobalBinDirectory(): string | undefined {
function resolveGlobalBinDirectory() {
  const prefix = process.env.npm_config_prefix;
  if (!prefix) {
    return undefined;
  }

  const execPath = process.env.npm_execpath ?? "";
  if (execPath.includes("pnpm")) {
    return prefix;
  }

  return path.join(prefix, "bin");
}

// async function ensureZshPath(binDir: string): Promise<void> {
async function ensureZshPath(binDir) {
  const exportLine = `export PATH="${binDir}:$PATH"`;
  const block = `${shellBlockStart}\n${exportLine}\n${shellBlockEnd}`;

  let current = "";
  try {
    current = await fsPromises.readFile(zshrcPath, "utf8");
  } catch (error) {
    if (!(typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")) {
      throw error;
    }
  }

  if (current.includes(shellBlockStart) && current.includes(shellBlockEnd)) {
    const next = current.replace(
      new RegExp(`${escapeRegExp(shellBlockStart)}[\\s\\S]*?${escapeRegExp(shellBlockEnd)}`),
      block,
    );

    if (next !== current) {
      await fsPromises.writeFile(zshrcPath, next, "utf8");
      console.log(`Updated ${zshrcPath} with Deuteron PATH configuration.`);
    }

    return;
  }

  const prefix = current.trimEnd();
  const next = prefix ? `${prefix}\n\n${block}\n` : `${block}\n`;
  await fsPromises.writeFile(zshrcPath, next, "utf8");
  console.log(`Updated ${zshrcPath} with Deuteron PATH configuration.`);
}

// function escapeRegExp(value: string): string {
function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}