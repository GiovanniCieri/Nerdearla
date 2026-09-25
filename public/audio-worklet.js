class PcmCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.sourceRate = sampleRate;
    this.ratio = this.sourceRate / 16000;
    this.phase = 0;
    this.pending = [];
    this.packet = new Int16Array(1600);
    this.packetOffset = 0;
    this.lastMeterAt = 0;
    this.sumSquares = 0;
    this.meterSamples = 0;
  }

  process(inputs, outputs) {
    const channels = inputs[0] || [];
    const output = outputs[0] || [];
    for (const channel of output) channel.fill(0);
    if (!channels.length || !channels[0].length) return true;

    const frames = channels[0].length;
    for (let index = 0; index < frames; index += 1) {
      let mono = 0;
      for (const channel of channels) mono += channel[index] / channels.length;
      this.pending.push(mono);
    }

    while (this.phase + this.ratio <= this.pending.length) {
      const start = this.phase;
      const end = start + this.ratio;
      let weighted = 0;
      for (let sourceIndex = Math.floor(start); sourceIndex < Math.ceil(end); sourceIndex += 1) {
        const weight = Math.min(end, sourceIndex + 1) - Math.max(start, sourceIndex);
        if (weight > 0) weighted += this.pending[sourceIndex] * weight;
      }
      const sample = Math.max(-1, Math.min(1, weighted / this.ratio));
      const pcm = sample < 0 ? sample * 32768 : sample * 32767;
      this.packet[this.packetOffset++] = pcm;
      this.sumSquares += sample * sample;
      this.meterSamples += 1;
      this.phase = end;

      if (this.packetOffset === this.packet.length) {
        const buffer = this.packet.buffer;
        const rms = this.meterSamples ? Math.sqrt(this.sumSquares / this.meterSamples) : 0;
        this.port.postMessage({ type: 'pcm', buffer, rms }, [buffer]);
        this.packet = new Int16Array(1600);
        this.packetOffset = 0;
        this.sumSquares = 0;
        this.meterSamples = 0;
      }
    }

    const discard = Math.floor(this.phase);
    if (discard > 0) {
      this.pending = this.pending.slice(discard);
      this.phase -= discard;
    }
    return true;
  }
}

registerProcessor('nerdearla-pcm-capture', PcmCaptureProcessor);
