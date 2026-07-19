const encoder = new TextEncoder();
const decoder = new TextDecoder();

export async function createSyncKey() {
  return crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]);
}

export async function encryptEnvelope(value, key, metadata = {}) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = encoder.encode(JSON.stringify(value));
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plaintext));
  return { version: 1, algorithm: "AES-256-GCM", metadata: { ...metadata, encryptedAt: new Date().toISOString() }, iv: Buffer.from(iv).toString("base64"), ciphertext: Buffer.from(ciphertext).toString("base64") };
}

export async function decryptEnvelope(envelope, key) {
  if (envelope?.version !== 1 || envelope.algorithm !== "AES-256-GCM") throw new Error("Unsupported encrypted envelope");
  const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv: Buffer.from(envelope.iv, "base64") }, key, Buffer.from(envelope.ciphertext, "base64"));
  return JSON.parse(decoder.decode(plaintext));
}

export function syncPolicy(preferences, artifact) {
  if (!preferences.cloudEnabled) return { allowed: false, reason: "Cloud sync is disabled" };
  if (!artifact?.reviewed) return { allowed: false, reason: "Artifact must be reviewed before sync" };
  return { allowed: true, reason: "Explicitly enabled and reviewed" };
}
