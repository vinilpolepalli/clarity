// NVIDIA NIM client (OpenAI-compatible API at integrate.api.nvidia.com)
const BASE = 'https://integrate.api.nvidia.com/v1';
// Browsable catalogue of every model NIM offers.
const CATALOG_URL = 'https://build.nvidia.com/models';

const DEFAULT_MODEL = 'thinkingmachines/inkling';

// Curated roster shown on the model dashboard. Any NIM model id works for chat.
const MODELS = [
  { id: 'thinkingmachines/inkling', label: 'Inkling (Thinking Machines)', kind: 'reasoning' },
  { id: 'meta/llama-3.3-70b-instruct', label: 'Llama 3.3 70B', kind: 'chat' },
  { id: 'meta/llama-3.1-8b-instruct', label: 'Llama 3.1 8B', kind: 'chat' },
  { id: 'deepseek-ai/deepseek-v4-pro', label: 'DeepSeek V4 Pro', kind: 'chat' },
  { id: 'deepseek-ai/deepseek-v4-flash', label: 'DeepSeek V4 Flash', kind: 'chat' },
  { id: 'google/gemma-4-31b-it', label: 'Gemma 4 31B', kind: 'chat' },
  { id: 'meta/llama-3.2-90b-vision-instruct', label: 'Llama 3.2 90B Vision', kind: 'vision' },
  { id: 'meta/llama-3.2-11b-vision-instruct', label: 'Llama 3.2 11B Vision', kind: 'vision' }
];

const VISION_MODEL = 'meta/llama-3.2-11b-vision-instruct';
// Used when the chosen model stalls or errors. Small, fast and consistently
// available — the point is to answer at all, not to answer best.
const FALLBACK_MODEL = 'meta/llama-3.1-8b-instruct';

/**
 * Interactive wrapper. A meeting copilot has to fail fast: a model that hangs
 * is worse than a weaker model that replies, because the moment to say
 * something passes. So the primary gets one short attempt, then we fall back.
 */
async function chatOrFallback(opts) {
  try {
    return await chat({ ...opts, timeoutMs: opts.timeoutMs || 20000, retries: 0 });
  } catch (primaryErr) {
    if (opts.model === FALLBACK_MODEL) throw primaryErr;
    const r = await chat({ ...opts, model: FALLBACK_MODEL, timeoutMs: 25000, retries: 1 });
    return { ...r, fellBackFrom: opts.model, fallbackReason: String(primaryErr.message || primaryErr).slice(0, 120) };
  }
}

function apiKey() {
  return process.env.NVIDIA_API_KEY || '';
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Exponential backoff with jitter: bursts of parallel calls (the model
// dashboard pings eight at once) reliably trip NIM's rate limiter.
const backoff = (attempt) => Math.min(1000 * 2 ** attempt, 12000) * (0.75 + Math.random() * 0.5);

async function chat({ model = DEFAULT_MODEL, messages, maxTokens = 1024, temperature = 0.6, timeoutMs = 60000, retries = 4 }) {
  const started = Date.now();
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(`${BASE}/chat/completions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey()}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, messages, max_tokens: maxTokens, temperature }),
        signal: ctrl.signal
      });
      clearTimeout(timer);
      // Retry transient rate-limit / server errors with backoff.
      if (res.status === 429 || res.status >= 500) {
        lastErr = new Error(`NIM ${res.status}`);
        if (attempt < retries) { await sleep(backoff(attempt)); continue; }
        const body = await res.text();
        throw new Error(`NIM ${res.status}: ${body.slice(0, 300)}`);
      }
      if (!res.ok) {
        const body = await res.text();
        throw new Error(`NIM ${res.status}: ${body.slice(0, 300)}`);
      }
      const out = finalize(await res.json(), model, started);
      // Reasoning ran past the budget before producing an answer — give it
      // more room once rather than surfacing a half-finished scratchpad.
      if (out.truncated && attempt < retries) {
        maxTokens = Math.min(maxTokens * 3, 6000);
        lastErr = new Error('reasoning truncated');
        continue;
      }
      return out;
    } catch (e) {
      clearTimeout(timer);
      lastErr = e.name === 'AbortError' ? new Error(`NIM timeout after ${timeoutMs}ms`) : e;
      if (attempt < retries && (e.name === 'AbortError' || /NIM 5|NIM 429/.test(String(e.message)))) {
        await sleep(backoff(attempt));
        continue;
      }
      throw lastErr;
    }
  }
  throw lastErr;
}

function finalize(data, model, started) {
  const choice = data.choices?.[0] || {};
  const msg = choice.message || {};
  // Reasoning models (e.g. inkling) put thoughts in reasoning_content; the
  // answer only lands in content once the model finishes thinking. If it runs
  // out of budget mid-thought, content is empty and reasoning holds a partial
  // scratchpad — which must never be shown as though it were the answer.
  return {
    model,
    content: msg.content || '',
    reasoning: msg.reasoning_content || '',
    finishReason: choice.finish_reason || '',
    truncated: !msg.content && choice.finish_reason === 'length',
    usage: data.usage || null,
    latencyMs: Date.now() - started
  };
}

async function pingModel(id) {
  const started = Date.now();
  try {
    const r = await chat({
      model: id,
      messages: [{ role: 'user', content: 'Reply with the single word: pong' }],
      maxTokens: id === DEFAULT_MODEL ? 256 : 16,
      temperature: 0,
      timeoutMs: 25000,
      retries: 1
    });
    return {
      id,
      ok: true,
      latencyMs: Date.now() - started,
      sample: (r.content || r.reasoning || '').slice(0, 60)
    };
  } catch (e) {
    const msg = String(e.message || e);
    // A 429 means our own request budget ran out, not that the model is down.
    // Reporting it as unreachable would tell you a healthy model is offline.
    const limited = /NIM 429/.test(msg);
    return {
      id,
      ok: false,
      limited,
      latencyMs: Date.now() - started,
      error: msg.slice(0, 200)
    };
  }
}

async function listRemoteModels() {
  const res = await fetch(`${BASE}/models`, {
    headers: { Authorization: `Bearer ${apiKey()}` }
  });
  if (!res.ok) throw new Error(`NIM ${res.status}`);
  const data = await res.json();
  return data.data.map((m) => m.id).sort();
}

const KIND = (id) =>
  /vision|vlm|vila|image/.test(id) ? 'vision'
  : /embed|rerank/.test(id) ? 'embed'
  : /inkling|reason|think|r1/.test(id) ? 'reasoning'
  : 'chat';

const label = (id) =>
  id.split('/').pop().replace(/-instruct$/, '').replace(/[-_]/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());

/** Describe every model the key can actually reach, not a hardcoded subset. */
async function catalog() {
  const ids = await listRemoteModels();
  return ids.map((id) => ({ id, label: label(id), kind: KIND(id) }));
}

/**
 * Health-check many models without tripping the rate limiter. NIM throttles
 * bursts hard, so this runs a bounded number at a time rather than all at once.
 */
async function pingAll(ids, { concurrency = 4, onProgress } = {}) {
  const out = [];
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, ids.length) }, async () => {
    while (next < ids.length) {
      const i = next++;
      const r = await pingModel(ids[i]);
      out.push(r);
      if (onProgress) onProgress(out.length, ids.length);
    }
  });
  await Promise.all(workers);
  return out;
}

module.exports = { chat, chatOrFallback, FALLBACK_MODEL, pingModel, listRemoteModels, catalog, pingAll, MODELS, DEFAULT_MODEL, VISION_MODEL, CATALOG_URL };
