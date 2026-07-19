import { spawn, spawnSync } from "node:child_process";
import { join } from "node:path";

const packagePath = join(import.meta.dirname, "..", "native", "ClarityCapture");
const build = spawnSync("swift", ["build", "--package-path", packagePath], { encoding: "utf8", stdio: "pipe" });
if (build.status !== 0) {
  process.stderr.write(build.stderr || build.stdout);
  process.exit(build.status ?? 1);
}

const executable = join(packagePath, ".build", "debug", "ClarityCapture");
const helper = spawn(executable, [], { stdio: ["pipe", "pipe", "pipe"] });
let stdout = "";
let stderr = "";
helper.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
helper.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
helper.stdin.end(`${JSON.stringify({ protocolVersion: 1, requestId: "native-smoke", command: "hello" })}\n`);

const exitCode = await new Promise((resolve) => {
  const timeout = setTimeout(() => { helper.kill("SIGKILL"); resolve(124); }, 5_000);
  helper.on("exit", (code) => { clearTimeout(timeout); resolve(code ?? 1); });
});
if (exitCode !== 0) throw new Error(`Capture helper exited ${exitCode}: ${stderr}`);
const line = stdout.trim().split("\n")[0];
const reply = JSON.parse(line);
if (!reply.ok || reply.type !== "hello" || reply.protocolVersion !== 1 || !reply.capabilities.includes("system-audio")) {
  throw new Error(`Unexpected capture helper handshake: ${line}`);
}
process.stdout.write(`Native capture handshake passed (${reply.capabilities.join(", ")})\n`);
