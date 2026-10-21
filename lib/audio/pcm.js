const clamp16 = (value) => Math.max(-32768, Math.min(32767, Math.round(value)));

const readSample = (buffer, index) => buffer.readInt16LE(index * 2);

/*
 * Resample mono signed PCM16 without changing the sample-rate metadata.
 * For the laboratory's 24 kHz -> 8 kHz path, averaging each three-sample
 * group is a simple anti-aliasing low-pass before decimation. The generic
 * interpolation path keeps the helper useful for other configured rates.
 */
const resamplePcm16Mono = (input, sourceRate, targetRate) => {
  if (!Buffer.isBuffer(input) || input.length % 2 !== 0) throw new TypeError('PCM16 input must contain complete samples');
  if (!Number.isInteger(sourceRate) || !Number.isInteger(targetRate) || sourceRate <= 0 || targetRate <= 0) {
    throw new RangeError('sample rates must be positive integers');
  }
  if (sourceRate === targetRate) return Buffer.from(input);

  const inputSamples = input.length / 2;
  const outputSamples = Math.max(1, Math.round(inputSamples * targetRate / sourceRate));
  const output = Buffer.alloc(outputSamples * 2);

  if (sourceRate % targetRate === 0) {
    const factor = sourceRate / targetRate;
    for (let out = 0; out < outputSamples; out++) {
      const start = out * factor;
      const end = Math.min(inputSamples, start + factor);
      let sum = 0;
      for (let index = start; index < end; index++) sum += readSample(input, index);
      output.writeInt16LE(clamp16(sum / Math.max(1, end - start)), out * 2);
    }
    return output;
  }

  for (let out = 0; out < outputSamples; out++) {
    const position = out * sourceRate / targetRate;
    const left = Math.floor(position);
    const right = Math.min(inputSamples - 1, left + 1);
    const fraction = position - left;
    const value = readSample(input, left) * (1 - fraction) + readSample(input, right) * fraction;
    output.writeInt16LE(clamp16(value), out * 2);
  }
  return output;
};

const createWavPcm16Mono = (pcm, sampleRate) => {
  if (!Buffer.isBuffer(pcm) || pcm.length % 2 !== 0) throw new TypeError('WAV payload must contain PCM16 samples');
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
};

const parseWavPcm16Mono = (wav) => {
  if (!Buffer.isBuffer(wav) || wav.length < 44 || wav.toString('ascii', 0, 4) !== 'RIFF' || wav.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('provider did not return a RIFF/WAV file');
  }

  let offset = 12;
  let sampleRate;
  let channels;
  let bitsPerSample;
  let audioFormat;
  let pcm;
  while (offset + 8 <= wav.length) {
    const chunkId = wav.toString('ascii', offset, offset + 4);
    const chunkSize = wav.readUInt32LE(offset + 4);
    const dataStart = offset + 8;
    // Some providers use 0xffffffff for a RIFF/data chunk whose final size
    // was not known while the audio stream was being produced.
    const dataEnd = chunkSize === 0xffffffff ? wav.length : dataStart + chunkSize;
    if (dataEnd > wav.length) throw new Error('provider returned a truncated WAV file');
    if (chunkId === 'fmt ' && chunkSize >= 16) {
      audioFormat = wav.readUInt16LE(dataStart);
      channels = wav.readUInt16LE(dataStart + 2);
      sampleRate = wav.readUInt32LE(dataStart + 4);
      bitsPerSample = wav.readUInt16LE(dataStart + 14);
    } else if (chunkId === 'data') {
      pcm = wav.subarray(dataStart, dataEnd);
    }
    offset = chunkSize === 0xffffffff ? wav.length : dataEnd + (chunkSize % 2);
  }

  if (audioFormat !== 1 || channels !== 1 || bitsPerSample !== 16 || !sampleRate || !pcm || pcm.length % 2 !== 0) {
    throw new Error('provider WAV is not mono PCM16');
  }
  return {pcm: Buffer.from(pcm), sampleRate};
};

module.exports = {resamplePcm16Mono, createWavPcm16Mono, parseWavPcm16Mono};
