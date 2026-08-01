// NVIDIA NIM client (OpenAI-compatible API at integrate.api.nvidia.com)
const BASE = 'https://integrate.api.nvidia.com/v1';

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

function apiKey() {
  return process.env.NVIDIA_API_KEY || '';
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function chat({ model = DEFAULT_MODEL, messages, maxTokens = 1024, temperature = 0.6, timeoutMs = 60000, retries = 2 }) {
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
        if (attempt < retries) { await sleep(800 * (attempt + 1)); continue; }
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
        await sleep(800 * (attempt + 1));
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
      retries: 0
    });
    return {
      id,
      ok: true,
      latencyMs: Date.now() - started,
      sample: (r.content || r.reasoning || '').slice(0, 60)
    };
  } catch (e) {
    return { id, ok: false, latencyMs: Date.now() - started, error: String(e.message || e).slice(0, 200) };
  }
}

async function listRemoteModels() {
  const res = await fetch(`${BASE}/models`, {
    headers: { Authorization: `Bearer ${apiKey()}` }
  });
  if (!res.ok) throw new Error(`NIM ${res.status}`);
  const data = await res.json();
  return data.data.map((m) => m.id);
}

module.exports = { chat, pingModel, listRemoteModels, MODELS, DEFAULT_MODEL, VISION_MODEL };
