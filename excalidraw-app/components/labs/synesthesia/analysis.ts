export type Features = {
  rms: number;
  low: number;
  mid: number;
  high: number;
  onset: boolean;
  pitch: number | null;
};
export type AnalysisState = {
  energy: number;
  onsetAt: number;
  spectrum?: Uint8Array;
};
const finite = (n: number) => (Number.isFinite(n) ? n : 0);

/** No browser objects or implicit clock: synthetic inputs can exercise the DSP. */
export const analyse = (
  waveform: Float32Array,
  spectrum: Uint8Array,
  sampleRate: number,
  fftSize: number,
  time: number,
  previous: AnalysisState = { energy: 0, onsetAt: -Infinity },
): { features: Features; state: AnalysisState } => {
  const rms = Math.min(
    1,
    Math.sqrt(
      waveform.reduce((s, n) => s + finite(n) ** 2, 0) / (waveform.length || 1),
    ),
  );
  const band = (from: number, to: number) => {
    const start = Math.max(0, Math.ceil((from * fftSize) / sampleRate));
    const end = Math.min(
      spectrum.length,
      Math.ceil((to * fftSize) / sampleRate),
    );
    let sum = 0;
    for (let i = start; i < end; i++) {
      sum += (spectrum[i] / 255) ** 2;
    }
    return Math.sqrt(sum / Math.max(1, end - start));
  };
  const low = band(20, 250);
  const mid = band(250, 2000);
  const high = band(2000, Math.min(12000, sampleRate / 2));
  let flux = 0;
  for (let i = 0; i < spectrum.length; i++) {
    flux += Math.max(0, (spectrum[i] - (previous.spectrum?.[i] ?? 0)) / 255);
  }
  const energy = flux / (spectrum.length || 1);
  const onset =
    rms > 0.025 &&
    energy > previous.energy * 1.5 + 0.04 &&
    time - previous.onsetAt >= 180;
  let pitch: number | null = null;
  let best = 0.8;
  if (rms > 0.025) {
    const mean =
      waveform.reduce((s, n) => s + finite(n), 0) / (waveform.length || 1);
    for (
      let lag = Math.max(1, Math.floor(sampleRate / 1200));
      lag <= Math.min(waveform.length / 2, sampleRate / 80);
      lag++
    ) {
      let cross = 0;
      let a = 0;
      let b = 0;
      for (let i = 0; i < waveform.length - lag; i += 2) {
        const x = finite(waveform[i]) - mean;
        const y = finite(waveform[i + lag]) - mean;
        cross += x * y;
        a += x * x;
        b += y * y;
      }
      const correlation = cross / (Math.sqrt(a * b) || 1);
      if (correlation > best) {
        best = correlation;
        pitch = sampleRate / lag;
      }
    }
  }
  return {
    features: { rms, low, mid, high, onset, pitch },
    state: {
      energy: previous.energy * 0.85 + energy * 0.15,
      onsetAt: onset ? time : previous.onsetAt,
      spectrum: spectrum.slice(),
    },
  };
};
