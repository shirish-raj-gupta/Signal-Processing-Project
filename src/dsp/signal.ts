import { fft, nextPow2 } from './fft.ts';

export interface Tone {
  /** Frequency in DFT bins (cycles per record); f [Hz] = bins · fs / N. */
  bins: number;
  /** Amplitude in dB re 1. */
  levelDb: number;
  /** Phase in degrees. */
  phaseDeg: number;
}

/** Finite record x[n] = Σ A·cos(2π·k₀·n/N + φ), n = 0 … N−1. */
export function synthTones(n: number, tones: readonly Tone[]): Float64Array {
  const x = new Float64Array(n);
  for (const t of tones) {
    const amp = 10 ** (t.levelDb / 20);
    const w0 = (2 * Math.PI * t.bins) / n;
    const ph = (t.phaseDeg * Math.PI) / 180;
    for (let i = 0; i < n; i++) x[i] += amp * Math.cos(w0 * i + ph);
  }
  return x;
}

export interface Spectrum {
  /** Frequency axis in bins of the N-point DFT (0 … N/2). */
  bins: Float64Array;
  /** One-sided amplitude in dB re 1: an on-bin tone of amplitude A reads 20·log10(A). */
  db: Float64Array;
  /** Grid points per DFT bin (zero-padding factor actually used). */
  pad: number;
}

/** Lowest level reported, so log10(0) never reaches the plots. */
export const DB_FLOOR = -300;

export function toDb(mag: number): number {
  return mag > 0 ? Math.max(DB_FLOOR, 20 * Math.log10(mag)) : DB_FLOOR;
}

/**
 * Amplitude spectrum of x·w. The record is zero-padded so the DTFT is sampled `pad` times
 * per DFT bin; every pad-th point is an actual N-point DFT bin.
 */
export function windowedSpectrum(x: Float64Array, w: Float64Array, pad = 1): Spectrum {
  const n = x.length;
  if (w.length !== n) throw new Error(`Signal (${n}) and window (${w.length}) lengths differ`);
  const m = nextPow2(n * Math.max(1, pad));
  const re = new Float64Array(m);
  const im = new Float64Array(m);
  let sumW = 0;
  for (let i = 0; i < n; i++) {
    re[i] = x[i] * w[i];
    sumW += w[i];
  }
  fft(re, im);

  const half = m >> 1;
  const bins = new Float64Array(half + 1);
  const db = new Float64Array(half + 1);
  // shortcut: one-sided ×2 scaling is exact only for 0 < f < fs/2 (DC and Nyquist read +6 dB)
  const scale = 2 / sumW;
  for (let k = 0; k <= half; k++) {
    bins[k] = (k * n) / m;
    db[k] = toDb(scale * Math.hypot(re[k], im[k]));
  }
  return { bins, db, pad: m / n };
}
