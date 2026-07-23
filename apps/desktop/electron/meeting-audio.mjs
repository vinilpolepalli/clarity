export const PCM16_BYTES_PER_SAMPLE = 2;

export function pcmDurationMs(bytes, sampleRate = 16_000, channels = 1) {
  return Math.floor((bytes.length / (PCM16_BYTES_PER_SAMPLE * Math.max(1, channels) * Math.max(1, sampleRate))) * 1_000);
}

export function rmsPcm16(bytes) {
  if (!bytes?.length) return 0;
  let sum = 0;
  const sampleCount = Math.floor(bytes.length / PCM16_BYTES_PER_SAMPLE);
  for (let index = 0; index < sampleCount; index += 1) {
    const sample = bytes.readInt16LE(index * PCM16_BYTES_PER_SAMPLE) / 32_768;
    sum += sample * sample;
  }
  return Math.sqrt(sum / Math.max(sampleCount, 1)) * 32_768;
}

export function mixPcm16(left, right) {
  const length = Math.min(left.length, right.length) - (Math.min(left.length, right.length) % PCM16_BYTES_PER_SAMPLE);
  const mixed = Buffer.alloc(length);
  for (let index = 0; index < length; index += PCM16_BYTES_PER_SAMPLE) {
    mixed.writeInt16LE(Math.round((left.readInt16LE(index) + right.readInt16LE(index)) / 2), index);
  }
  return mixed;
}

export function takePcm(bytes, length) {
  return { head: bytes.subarray(0, length), tail: bytes.subarray(length) };
}
