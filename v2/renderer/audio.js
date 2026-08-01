// Live audio capture -> VAD chunking -> Whisper worker.
//
// Design note: every audio source funnels through pushSamples(), which is the
// single ingestion point for the VAD + ASR pipeline. Microphone/system capture
// call it, and tests call it with known PCM, so the exact code path that runs
// in production is the one under test.

const TARGET_SR = 16000;

// VAD tuning (energy based).
const SPEECH_RMS = 0.008;      // above this = speech
const SILENCE_HANG_MS = 700;   // trailing silence that closes an utterance
const MIN_UTTERANCE_MS = 600;  // ignore blips
const MAX_UTTERANCE_MS = 12000; // force-flush long monologues

class AudioEngine {
  constructor() {
    this.worker = null;
    this.ready = false;
    this.capturing = false;
    this.ctx = null;
    this.streams = [];
    this.node = null;

    this.buf = [];            // Float32Array chunks of the current utterance
    this.bufLen = 0;
    this.speaking = false;
    this.silenceMs = 0;
    this.seq = 0;

    this.onTranscript = () => {};
    this.onStatus = () => {};
    this.onLoadProgress = () => {};
  }

  initWorker() {
    if (this.worker) return this.worker;
    this.worker = new Worker('asr-worker.js', { type: 'module' });
    this.worker.onmessage = (e) => {
      const m = e.data;
      if (m.type === 'ready') {
        this.ready = true;
        this.onStatus(`Speech model ready (${m.model})`);
      } else if (m.type === 'load-progress') {
        this.onLoadProgress(m.pct, m.file);
      } else if (m.type === 'transcript') {
        if (m.text) this.onTranscript(m.text, m.ms);
      } else if (m.type === 'error') {
        this.onStatus(`ASR error: ${m.error}`);
      }
    };
    this.worker.postMessage({ type: 'warmup' });
    return this.worker;
  }

  /** Feed 16 kHz mono PCM into the VAD + ASR pipeline. */
  pushSamples(samples) {
    this.initWorker();
    const frameMs = (samples.length / TARGET_SR) * 1000;
    let sum = 0;
    for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
    const rms = Math.sqrt(sum / samples.length);

    if (rms >= SPEECH_RMS) {
      this.speaking = true;
      this.silenceMs = 0;
      this.buf.push(samples);
      this.bufLen += samples.length;
    } else if (this.speaking) {
      // keep trailing silence so words aren't clipped
      this.buf.push(samples);
      this.bufLen += samples.length;
      this.silenceMs += frameMs;
      if (this.silenceMs >= SILENCE_HANG_MS) this.flush();
    }

    if ((this.bufLen / TARGET_SR) * 1000 >= MAX_UTTERANCE_MS) this.flush();
  }

  /** Close the current utterance and send it for transcription. */
  flush() {
    const ms = (this.bufLen / TARGET_SR) * 1000;
    if (this.bufLen === 0 || ms < MIN_UTTERANCE_MS) {
      this.buf = []; this.bufLen = 0; this.speaking = false; this.silenceMs = 0;
      return false;
    }
    const pcm = new Float32Array(this.bufLen);
    let o = 0;
    for (const c of this.buf) { pcm.set(c, o); o += c.length; }
    this.buf = []; this.bufLen = 0; this.speaking = false; this.silenceMs = 0;
    this.initWorker().postMessage({ type: 'transcribe', id: ++this.seq, pcm }, [pcm.buffer]);
    return true;
  }

  /** Resample arbitrary-rate mono Float32 to 16 kHz (linear interpolation). */
  static resample(src, srcRate) {
    if (srcRate === TARGET_SR) return src;
    const ratio = srcRate / TARGET_SR;
    const n = Math.floor(src.length / ratio);
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const p = i * ratio;
      const i0 = Math.floor(p);
      const frac = p - i0;
      out[i] = src[i0] * (1 - frac) + src[Math.min(i0 + 1, src.length - 1)] * frac;
    }
    return out;
  }

  /**
   * Start capturing the meeting: microphone plus (where the platform allows)
   * system/loopback audio, mixed into one stream.
   */
  async start() {
    if (this.capturing) return { mic: false, system: false, already: true };
    this.initWorker();
    const got = { mic: false, system: false };

    this.ctx = new AudioContext();
    const dest = this.ctx.createGain();

    try {
      const mic = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true }
      });
      this.streams.push(mic);
      this.ctx.createMediaStreamSource(mic).connect(dest);
      got.mic = true;
    } catch (e) {
      this.onStatus(`Mic unavailable: ${e.message}`);
    }

    // System/loopback audio (the other side of the call). Electron exposes this
    // via the desktop capture constraints; unavailable on some platforms.
    try {
      const sys = await navigator.mediaDevices.getUserMedia({
        audio: { mandatory: { chromeMediaSource: 'desktop' } },
        video: { mandatory: { chromeMediaSource: 'desktop' } }
      });
      sys.getVideoTracks().forEach((t) => t.stop());
      if (sys.getAudioTracks().length) {
        this.streams.push(sys);
        this.ctx.createMediaStreamSource(sys).connect(dest);
        got.system = true;
      }
    } catch (e) {
      this.onStatus('System audio unavailable (mic only)');
    }

    if (!got.mic && !got.system) {
      await this.stop();
      throw new Error('No audio input available');
    }

    const srcRate = this.ctx.sampleRate;
    const proc = this.ctx.createScriptProcessor(4096, 1, 1);
    proc.onaudioprocess = (ev) => {
      const input = ev.inputBuffer.getChannelData(0);
      this.pushSamples(AudioEngine.resample(new Float32Array(input), srcRate));
    };
    dest.connect(proc);
    proc.connect(this.ctx.destination);
    this.node = proc;
    this.capturing = true;
    return got;
  }

  async stop() {
    this.capturing = false;
    this.flush();
    if (this.node) { this.node.disconnect(); this.node = null; }
    this.streams.forEach((s) => s.getTracks().forEach((t) => t.stop()));
    this.streams = [];
    if (this.ctx) { await this.ctx.close().catch(() => {}); this.ctx = null; }
  }
}

window.AudioEngine = AudioEngine;
