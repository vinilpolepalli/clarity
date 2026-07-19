import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const SERVICE = "app.clarity.desktop.provider";
const ALLOWED_PROVIDERS = new Set(["openai", "anthropic", "nvidia"]);

function assertProvider(provider) {
  if (!ALLOWED_PROVIDERS.has(provider)) throw new Error("Unsupported provider");
}

export async function hasProviderKey(provider) {
  assertProvider(provider);
  if (process.platform !== "darwin") return false;
  try {
    await execFileAsync("/usr/bin/security", ["find-generic-password", "-s", SERVICE, "-a", provider]);
    return true;
  } catch {
    return false;
  }
}

export async function readProviderKey(provider) {
  assertProvider(provider);
  if (process.platform !== "darwin") throw new Error("macOS Keychain is required for provider keys");
  try {
    const { stdout } = await execFileAsync("/usr/bin/security", ["find-generic-password", "-w", "-s", SERVICE, "-a", provider]);
    return stdout.trim();
  } catch {
    throw new Error(`No ${provider} key is configured in macOS Keychain`);
  }
}

export async function saveProviderKey(provider, key) {
  assertProvider(provider);
  const normalized = String(key).trim();
  if (normalized.length < 8 || normalized.length > 512) throw new Error("The API key does not look valid");
  if (process.platform !== "darwin") throw new Error("macOS Keychain is required for provider keys");
  await execFileAsync("/usr/bin/security", ["add-generic-password", "-U", "-s", SERVICE, "-a", provider, "-w", normalized]);
}

export async function deleteProviderKey(provider) {
  assertProvider(provider);
  if (process.platform !== "darwin") return;
  try {
    await execFileAsync("/usr/bin/security", ["delete-generic-password", "-s", SERVICE, "-a", provider]);
  } catch {
    // Deleting an absent credential is idempotent.
  }
}
