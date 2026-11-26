import { fft, nextPow2 } from './fft.ts';

export interface WindowMetrics {
  /** Main-lobe width between the first nulls, DFT bins. */
  nullToNull: number;
  /** Full main-lobe width at −3.0 dB, bins. */
  bw3: number;
  /** Full main-lobe width at −6.0 dB, bins. */
  bw6: number;
  /** Highest side-lobe level relative to the main-lobe peak, dB (negative). */
  psl: number;
  /** Frequency of the highest side lobe, bins. */
  pslAt: number;
  /** Coherent gain Σw / N. */
  coherentGain: number;
  /** Equivalent noise bandwidth N·Σw² / (Σw)², bins. */
  enbw: number;
  /** Amplitude loss for a tone half-way between two bins, dB (positive = loss). */
  scallopLoss: number;
  /** Worst-case processing loss = scalloping loss + 10·log10(ENBW), dB. */
  wcpl: number;
}

/** |W(ν)|: exact DTFT magnitude of the window at ν DFT bins (ω = 2πν/N). */
export function dtftMag(w: Float64Array, nu: number): number {
  const n = w.length;
  const om = (2 * Math.PI * nu) / n;
  let re = 0;
  let im = 0;
  for (let i = 0; i < n; i++) {
    re += w[i] * Math.cos(om * i);
    im -= w[i] * Math.sin(om * i);
  }
  return Math.hypot(re, im);
}

export interface WindowResponse {
  /** Frequency in DFT bins, 0 … N/2. */
  bins: Float64Array;
  /** |W(ν)| / |W(0)|, linear. */
  mag: Float64Array;
}

/** Window magnitude response sampled `oversample` times per bin (zero-padded FFT). */
export function windowResponse(w: Float64Array, oversample = 32): WindowResponse {
  const n = w.length;
  const m = nextPow2(n * oversample);
  const re = new Float64Array(m);
  const im = new Float64Array(m);
  re.set(w);
  fft(re, im);
  const half = m >> 1;
  const bins = new Float64Array(half + 1);
  const mag = new Float64Array(half + 1);
  const dc = Math.abs(re[0]);
  for (let k = 0; k <= half; k++) {
    bins[k] = (k * n) / m;
    mag[k] = Math.hypot(re[k], im[k]) / dc;
  }
  return { bins, mag };
}

/** A main-lobe null must lie below −20 dB, so pass-band ripple (flat-top) is not taken for one. */
const NULL_THRESHOLD = 0.1;

/**
 * Main-lobe and side-lobe figures of merit. A 16×-oversampled FFT brackets each feature;
 * the exact DTFT then refines it (golden-section for the null and side-lobe peak,
 * bisection for the −3/−6 dB crossings), so results do not depend on the FFT grid.
 */
export function windowMetrics(w: Float64Array): WindowMetrics {
  const n = w.length;
  const { bins, mag } = windowResponse(w, 16);
  const step = bins[1];
  const w0 = dtftMag(w, 0);
  const rel = (nu: number) => dtftMag(w, nu) / w0;

  // First null: first grid local minimum below −20 dB.
  let k0 = -1;
  for (let k = 1; k < mag.length - 1; k++) {
    if (mag[k] < NULL_THRESHOLD && mag[k] <= mag[k - 1] && mag[k] <= mag[k + 1]) {
      k0 = k;
      break;
    }
  }
  if (k0 < 0) throw new Error(`No main-lobe null below −20 dB within N/2 bins (N = ${n})`);
  const nullAt = golden(rel, bins[k0] - step, bins[k0] + step, false);

  // −3 dB / −6 dB points: |W| falls monotonically from DC to the first null.
  const crossing = (db: number) => {
    const target = 10 ** (-db / 20);
    let k = 1;
    while (k < k0 && mag[k] > target) k++;
    return bisect((nu) => rel(nu) - target, bins[k - 1], bins[k]);
  };

  // Highest side lobe anywhere beyond the first null (up to N/2).
  let kp = k0;
  for (let k = k0 + 1; k < mag.length; k++) if (mag[k] > mag[kp]) kp = k;
  const pslAt = golden(rel, Math.max(nullAt, bins[kp] - step), Math.min(n / 2, bins[kp] + step), true);

  let sum = 0;
  let sum2 = 0;
  for (const v of w) {
    sum += v;
    sum2 += v * v;
  }
  const enbw = (n * sum2) / (sum * sum);
  const scallopLoss = -20 * Math.log10(rel(0.5));

  return {
    nullToNull: 2 * nullAt,
    bw3: 2 * crossing(3),
    bw6: 2 * crossing(6),
    psl: 20 * Math.log10(rel(pslAt)),
    pslAt,
    coherentGain: sum / n,
    enbw,
    scallopLoss,
    wcpl: scallopLoss + 10 * Math.log10(enbw),
  };
}

/** Golden-section search for the minimum (or maximum) of a unimodal f on [a, b]. */
function golden(f: (x: number) => number, a: number, b: number, maximize: boolean): number {
  const g = (Math.sqrt(5) - 1) / 2;
  const s = maximize ? -1 : 1;
  let c = b - g * (b - a);
  let d = a + g * (b - a);
  let fc = s * f(c);
  let fd = s * f(d);
  for (let i = 0; i < 48; i++) {
    if (fc < fd) {
      b = d;
      d = c;
      fd = fc;
      c = b - g * (b - a);
      fc = s * f(c);
    } else {
      a = c;
      c = d;
      fc = fd;
      d = a + g * (b - a);
      fd = s * f(d);
    }
  }
  return (a + b) / 2;
}

/** Bisection for the root of f on [a, b], given f(a) > 0 ≥ f(b). */
function bisect(f: (x: number) => number, a: number, b: number): number {
  for (let i = 0; i < 48; i++) {
    const mid = (a + b) / 2;
    if (f(mid) > 0) a = mid;
    else b = mid;
  }
  return (a + b) / 2;
}
