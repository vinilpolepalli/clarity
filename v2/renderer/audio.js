// Live audio capture -> per-speaker VAD chunking -> Whisper worker.
//
// Why this is not just dictation: dictation transcribes one microphone. A
// meeting copilot has to hear the *other* side too, and it has to know who
// said what — the advice you need is a reply to THEM, not a summary of you.
// So the microphone and the system/loopback stream are captured and
// segmented separately, and every utterance carries a speaker label.
//
// Design note: every audio source funnels through pushSamples(), the single
// ingestion point for the VAD + ASR pipeline. Live capture and tests both call
// it, so the code path under test is the one that runs in production.

const TARGET_SR = 16000;

// VAD tuning (energy based).
const SPEECH_RMS = 0.008;       // above this = speech
const SILENCE_HANG_MS = 700;    // trailing silence that closes an utterance
const MIN_UTTERANCE_MS = 600;   // ignore blips
const MAX_UTTERANCE_MS = 12000; // force-flush long monologues

const SPEAKER_YOU = 'You';
const SPEAKER_THEM = 'Them';

/** Independent VAD state for one speaker/stream. */
class Track {
  constructor(speaker, emit) {
    this.speaker = speaker;
    this.emit = emit;
    this.buf = [];
    this.bufLen = 0;
    this.speaking = false;
    this.silenceMs = 0;
  }

  push(samples) {
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
      if (this.silenceMs >= SILENCE_HANG_MS) return this.flush();
    }

    if ((this.bufLen / TARGET_SR) * 1000 >= MAX_UTTERANCE_MS) return this.flush();
    return false;
  }

  flush() {
    const ms = (this.bufLen / TARGET_SR) * 1000;
    if (this.bufLen === 0 || ms < MIN_UTTERANCE_MS) {
      this.reset();
      return false;
    }
    const pcm = new Float32Array(this.bufLen);
    let o = 0;
    for (const c of this.buf) { pcm.set(c, o); o += c.length; }
    this.reset();
    this.emit(pcm, this.speaker);
    return true;
  }

  reset() {
    this.buf = [];
    this.bufLen = 0;
    this.speaking = false;
    this.silenceMs = 0;
  }
}

class AudioEngine {
  constructor() {
    this.worker = null;
    this.ready = false;
    this.capturing = false;
    this.ctx = null;
    this.streams = [];
    this.nodes = [];
    this.seq = 0;
    this.pending = new Map(); // utterance id -> speaker

    const emit = (pcm, speaker) => this.transcribe(pcm, speaker);
    this.tracks = {
      [SPEAKER_YOU]: new Track(SPEAKER_YOU, emit),
      [SPEAKER_THEM]: new Track(SPEAKER_THEM, emit)
    };

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
        const speaker = this.pending.get(m.id) || SPEAKER_YOU;
        this.pending.delete(m.id);
        if (m.text) this.onTranscript(m.text, speaker, m.ms);
      } else if (m.type === 'error') {
        this.pending.delete(m.id);
        this.onStatus(`ASR error: ${m.error}`);
      }
    };
    this.worker.postMessage({ type: 'warmup' });
    return this.worker;
  }

  transcribe(pcm, speaker) {
    const id = ++this.seq;
    this.pending.set(id, speaker);
    this.initWorker().postMessage({ type: 'transcribe', id, pcm }, [pcm.buffer]);
  }

  /** Feed 16 kHz mono PCM for one speaker into the VAD + ASR pipeline. */
  pushSamples(samples, speaker = SPEAKER_YOU) {
    this.initWorker();
    const track = this.tracks[speaker] || this.tracks[SPEAKER_YOU];
    return track.push(samples);
  }

  /** Close open utterances. Pass a speaker to flush just that track. */
  flush(speaker) {
    if (speaker) return this.tracks[speaker].flush();
    return Object.values(this.tracks).map((t) => t.flush()).some(Boolean);
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

  /** Wire one MediaStream to its own VAD track. */
  tap(stream, speaker) {
    const srcRate = this.ctx.sampleRate;
    const src = this.ctx.createMediaStreamSource(stream);
    const proc = this.ctx.createScriptProcessor(4096, 1, 1);
    proc.onaudioprocess = (ev) => {
      const input = ev.inputBuffer.getChannelData(0);
      this.pushSamples(AudioEngine.resample(new Float32Array(input), srcRate), speaker);
    };
    src.connect(proc);
    // Keep the node pulling without echoing captured audio back to the speakers.
    const mute = this.ctx.createGain();
    mute.gain.value = 0;
    proc.connect(mute);
    mute.connect(this.ctx.destination);
    this.nodes.push(proc, mute);
  }

  /**
   * Start capturing the meeting: your microphone and (where the platform
   * allows) the system/loopback audio of everyone else, as separate tracks.
   */
  async start() {
    if (this.capturing) return { mic: false, system: false, already: true };
    this.initWorker();
    const got = { mic: false, system: false };
    this.ctx = new AudioContext();

    try {
      const mic = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true }
      });
      this.streams.push(mic);
      this.tap(mic, SPEAKER_YOU);
      got.mic = true;
    } catch (e) {
      this.onStatus(`Mic unavailable: ${e.message}`);
    }

    // System/loopback audio — the other side of the call.
    try {
      const sys = await navigator.mediaDevices.getUserMedia({
        audio: { mandatory: { chromeMediaSource: 'desktop' } },
        video: { mandatory: { chromeMediaSource: 'desktop' } }
      });
      sys.getVideoTracks().forEach((t) => t.stop());
      if (sys.getAudioTracks().length) {
        this.streams.push(sys);
        this.tap(sys, SPEAKER_THEM);
        got.system = true;
      }
    } catch (e) {
      this.onStatus('System audio unavailable — capturing your mic only');
    }

    if (!got.mic && !got.system) {
      await this.stop();
      throw new Error('No audio input available');
    }

    this.capturing = true;
    return got;
  }

  async stop() {
    this.capturing = false;
    this.flush();
    this.nodes.forEach((n) => n.disconnect());
    this.nodes = [];
    this.streams.forEach((s) => s.getTracks().forEach((t) => t.stop()));
    this.streams = [];
    if (this.ctx) { await this.ctx.close().catch(() => {}); this.ctx = null; }
  }
}

window.AudioEngine = AudioEngine;
window.SPEAKER_YOU = SPEAKER_YOU;
window.SPEAKER_THEM = SPEAKER_THEM;
