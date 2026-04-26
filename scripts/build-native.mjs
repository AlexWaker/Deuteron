import fs from "node:fs";
import { promises as fsPromises } from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const scriptDir = path.dirname(scriptPath);
const packageRoot = path.resolve(scriptDir, "..");
const cargoDir = path.join(packageRoot, "rust", "agent");
const platformKey = `${process.platform}-${process.arch}`;
const outputDir = path.join(packageRoot, "native", platformKey);
const binaryName = process.platform === "win32" ? "solgent-agent.exe" : "solgent-agent";
const sourceBinary = path.join(cargoDir, "target", "release", binaryName);
const packagedBinary = path.join(outputDir, binaryName);
// const lifecycleEvent = process.env.npm_lifecycle_event ?? "";
// const shouldAllowBundledFallback = lifecycleEvent === "prepare" || lifecycleEvent === "postinstall";
const shouldAllowBundledFallback = process.env.SOLGENT_REQUIRE_NATIVE_BUILD !== "1";

// const build = spawnSync("cargo", ["build", "--release"], {
//   cwd: cargoDir,
//   stdio: "inherit",
// });
//
// if (build.status !== 0) {
//   process.exit(build.status ?? 1);
// }
const build = spawnSync("cargo", ["build", "--release"], {
  cwd: cargoDir,
  stdio: "inherit",
});

if (build.error || build.status !== 0) {
  if (shouldAllowBundledFallback && fs.existsSync(packagedBinary)) {
    const reason = build.error?.message ?? `cargo exited with code ${build.status ?? 1}`;
    console.warn(
      `Skipping local Rust build and using bundled native agent at ${packagedBinary} because ${reason}.`,
    );
    const stats = fs.statSync(packagedBinary);
    console.log(`Bundled native agent: ${packagedBinary} (${stats.size} bytes)`);
    process.exit(0);
  }

  if (build.error) {
    throw build.error;
  }

  process.exit(build.status ?? 1);
}

await fsPromises.mkdir(outputDir, { recursive: true });
await fsPromises.copyFile(sourceBinary, packagedBinary);

if (process.platform !== "win32") {
  await fsPromises.chmod(packagedBinary, 0o755);
}

const stats = fs.statSync(packagedBinary);
console.log(`Bundled native agent: ${packagedBinary} (${stats.size} bytes)`);