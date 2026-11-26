export type WindowId = 'rect' | 'hann' | 'hamming' | 'blackman' | 'blackmanHarris' | 'flattop' | 'kaiser';

export interface WindowInfo {
  id: WindowId;
  label: string;
}

/** Windows available in the mid-term build. */
export const WINDOWS: readonly WindowInfo[] = [
  { id: 'rect', label: 'Rectangular' },
  { id: 'hann', label: 'Hann' },
  { id: 'hamming', label: 'Hamming' },
  { id: 'blackman', label: 'Blackman' },
  { id: 'blackmanHarris', label: 'Blackman–Harris' },
  { id: 'flattop', label: 'Flat-top' },
  { id: 'kaiser', label: 'Kaiser' },
];

/** Cosine-sum coefficients a_k for w[n] = Σ (−1)^k · a_k · cos(2πkn/D). Same values as SciPy. */
export const COSINE_SUM: Readonly<Record<Exclude<WindowId, 'kaiser'>, readonly number[]>> = {
  rect: [1],
  hann: [0.5, 0.5],
  hamming: [0.54, 0.46],
  blackman: [0.42, 0.5, 0.08],
  blackmanHarris: [0.35875, 0.48829, 0.14128, 0.01168],
  flattop: [0.21557895, 0.41663158, 0.277263158, 0.083578947, 0.006947368],
};

export const DEFAULT_KAISER_BETA = 8.6;

export interface WindowOptions {
  /**
   * Periodic ("DFT-even", D = N) definition for spectral analysis — the convention of
   * Harris (1978) and SciPy's get_window. Set false for the symmetric (D = N − 1) definition
   * used in FIR filter design. Default true.
   */
  periodic?: boolean;
  /** Kaiser shape parameter β (ignored by other windows). */
  beta?: number;
}

export function makeWindow(id: WindowId, n: number, opts: WindowOptions = {}): Float64Array {
  if (!Number.isInteger(n) || n < 1) throw new Error(`Window length must be a positive integer (got ${n})`);
  const w = new Float64Array(n);
  if (n === 1) {
    w[0] = 1;
    return w;
  }
  const d = opts.periodic === false ? n - 1 : n;

  if (id === 'kaiser') {
    const beta = opts.beta ?? DEFAULT_KAISER_BETA;
    const norm = besselI0(beta);
    for (let i = 0; i < n; i++) {
      const r = (2 * i) / d - 1;
      w[i] = besselI0(beta * Math.sqrt(Math.max(0, 1 - r * r))) / norm;
    }
    return w;
  }

  const a = COSINE_SUM[id];
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let k = 0; k < a.length; k++) {
      s += (k % 2 ? -a[k] : a[k]) * Math.cos((2 * Math.PI * k * i) / d);
    }
    w[i] = s;
  }
  return w;
}

/** Modified Bessel function of the first kind, order 0: I₀(x) = Σ ((x/2)^k / k!)². */
export function besselI0(x: number): number {
  const q = (x * x) / 4;
  let term = 1;
  let sum = 1;
  for (let k = 1; k < 500 && term > sum * 1e-17; k++) {
    term *= q / (k * k);
    sum += term;
  }
  return sum;
}
