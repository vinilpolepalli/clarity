import { spawn } from "node:child_process";
import process from "node:process";

const env = { ...process.env, CLARITY_RENDERER_URL: "http://127.0.0.1:5173", CLARITY_DEMO: process.env.CLARITY_DEMO ?? "1" };
const vite = spawn("pnpm", ["exec", "vite"], { stdio: "inherit", env });
let electron;

const timer = setTimeout(() => {
  electron = spawn("pnpm", ["exec", "electron", "."], { stdio: "inherit", env });
  electron.on("exit", (code) => {
    vite.kill("SIGTERM");
    process.exitCode = code ?? 0;
  });
}, 900);

function stop() {
  clearTimeout(timer);
  electron?.kill("SIGTERM");
  vite.kill("SIGTERM");
}

process.on("SIGINT", stop);
process.on("SIGTERM", stop);
