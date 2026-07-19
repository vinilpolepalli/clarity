const INJECTION_PATTERNS = [
  /ignore (?:all|any|the) previous instructions/i,
  /reveal (?:the )?(?:system|developer) prompt/i,
  /send (?:the )?(?:transcript|meeting|secret|api key) to/i,
  /execute (?:this )?(?:command|script)/i
];

export function assessTranscriptText(text) {
  const normalized = String(text).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, " ").trim();
  return { text: normalized, untrusted: INJECTION_PATTERNS.some((pattern) => pattern.test(normalized)) };
}

export function selectContext(segments, { maxCharacters = 18_000, query = "" } = {}) {
  const terms = new Set(String(query).toLowerCase().split(/\W+/).filter((term) => term.length > 2));
  const ranked = segments.map((segment, index) => {
    const text = String(segment.text ?? "");
    const relevance = [...terms].reduce((score, term) => score + (text.toLowerCase().includes(term) ? 3 : 0), 0);
    return { ...segment, text, index, score: relevance + index / Math.max(segments.length, 1) };
  }).sort((a, b) => b.score - a.score);
  const chosen = [];
  let characters = 0;
  for (const segment of ranked) {
    if (characters + segment.text.length > maxCharacters && chosen.length) continue;
    chosen.push(segment); characters += segment.text.length;
    if (characters >= maxCharacters) break;
  }
  return chosen.sort((a, b) => a.index - b.index).map(({ score, index, ...segment }) => segment);
}

export function validateArtifact(value) {
  if (!value || typeof value !== "object") throw new TypeError("Artifact must be an object");
  const decisions = Array.isArray(value.decisions) ? value.decisions : [];
  const actions = Array.isArray(value.actions) ? value.actions : [];
  return {
    title: String(value.title ?? "Meeting notes").slice(0, 120),
    summary: String(value.summary ?? "").slice(0, 12_000),
    decisions: decisions.slice(0, 50).map((item) => ({ text: String(item.text ?? "").slice(0, 1_000), evidence: String(item.evidence ?? "").slice(0, 1_000) })),
    actions: actions.slice(0, 100).map((item) => ({ text: String(item.text ?? "").slice(0, 1_000), owner: item.owner ? String(item.owner).slice(0, 160) : null, due: item.due ? String(item.due).slice(0, 80) : null }))
  };
}

export class ResourceGovernor {
  constructor({ maxConcurrent = 1, maxQueued = 4 } = {}) { this.maxConcurrent = maxConcurrent; this.maxQueued = maxQueued; this.running = 0; this.queue = []; }
  run(task) {
    if (this.queue.length >= this.maxQueued) return Promise.reject(new Error("Local inference queue is full"));
    return new Promise((resolve, reject) => { this.queue.push({ task, resolve, reject }); this.drain(); });
  }
  drain() {
    while (this.running < this.maxConcurrent && this.queue.length) {
      const item = this.queue.shift(); this.running += 1;
      Promise.resolve().then(item.task).then(item.resolve, item.reject).finally(() => { this.running -= 1; this.drain(); });
    }
  }
}
