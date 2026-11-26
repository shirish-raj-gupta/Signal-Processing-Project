import { describe, expect, it } from 'vitest';
import { fft, nextPow2 } from './fft.ts';
import { besselI0, COSINE_SUM, makeWindow, WINDOWS } from './windows.ts';
import type { WindowId } from './windows.ts';
import { synthTones, windowedSpectrum } from './signal.ts';
import { windowMetrics } from './metrics.ts';

const near = (actual: number, expected: number, tol: number) =>
  expect(Math.abs(actual - expected), `${actual} vs ${expected} (tol ${tol})`).toBeLessThanOrEqual(tol);

function naiveDft(x: Float64Array) {
  const n = x.length;
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  for (let k = 0; k < n; k++) {
    for (let i = 0; i < n; i++) {
      const a = (-2 * Math.PI * k * i) / n;
      re[k] += x[i] * Math.cos(a);
      im[k] += x[i] * Math.sin(a);
    }
  }
  return { re, im };
}

const sinc = (x: number) => (x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x));

/** Large-N closed form of |W(ν)|/|W(0)| for a cosine-sum window (sum of shifted sincs). */
function cosineSumRel(a: readonly number[], nu: number): number {
  let s = a[0] * sinc(nu);
  for (let k = 1; k < a.length; k++) s += (a[k] / 2) * (sinc(nu - k) + sinc(nu + k));
  return Math.abs(s) / a[0];
}

/** Full main-lobe width (bins) where the closed form falls to −db dB; first null is at K+1 bins. */
function closedFormWidth(a: readonly number[], db: number): number {
  const target = 10 ** (-db / 20);
  let lo = 0;
  let hi = a.length;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (cosineSumRel(a, mid) > target) lo = mid;
    else hi = mid;
  }
  const halfWidth = (lo + hi) / 2;
  return 2 * halfWidth;
}

describe('fft', () => {
  it('matches a naive DFT', () => {
    const n = 64;
    const x = Float64Array.from({ length: n }, (_, i) => Math.sin(0.3 * i) + 0.5 * Math.cos(1.7 * i) + (i % 5) * 0.1);
    const re = x.slice();
    const im = new Float64Array(n);
    fft(re, im);
    const ref = naiveDft(x);
    for (let k = 0; k < n; k++) {
      near(re[k], ref.re[k], 1e-9);
      near(im[k], ref.im[k], 1e-9);
    }
  });

  it('rejects lengths that are not powers of two', () => {
    expect(() => fft(new Float64Array(6), new Float64Array(6))).toThrow();
  });

  it('nextPow2', () => {
    expect([1, 2, 65, 128].map(nextPow2)).toEqual([1, 2, 128, 128]);
  });
});

describe('windows', () => {
  it('symmetric definitions are symmetric with unit peak', () => {
    for (const { id } of WINDOWS) {
      const w = makeWindow(id, 65, { periodic: false });
      for (let i = 0; i < 65; i++) near(w[i], w[64 - i], 1e-12);
      near(w[32], 1, 1e-6);
    }
  });

  it('periodic window = symmetric (N+1)-point window without its last sample', () => {
    for (const { id } of WINDOWS) {
      const p = makeWindow(id, 64);
      const s = makeWindow(id, 65, { periodic: false });
      for (let i = 0; i < 64; i++) near(p[i], s[i], 1e-12);
    }
  });

  it('Kaiser with β = 0 is rectangular', () => {
    expect(Array.from(makeWindow('kaiser', 32, { beta: 0 }))).toEqual(new Array(32).fill(1));
  });

  it('I0 matches reference values', () => {
    expect(besselI0(0)).toBe(1);
    near(besselI0(1), 1.2660658777520082, 1e-13);
    near(besselI0(10), 2815.716628466254, 1e-8);
  });

  it('rejects invalid lengths', () => {
    expect(() => makeWindow('hann', 0)).toThrow();
    expect(() => makeWindow('hann', 2.5)).toThrow();
  });
});

describe('window metrics (periodic, N = 256)', () => {
  const N = 256;
  const m = (id: WindowId) => windowMetrics(makeWindow(id, N));

  it('coherent gain and ENBW equal their closed forms', () => {
    for (const id of ['rect', 'hann', 'hamming', 'blackman', 'blackmanHarris', 'flattop'] as const) {
      const a = COSINE_SUM[id];
      const r = m(id);
      near(r.coherentGain, a[0], 1e-12);
      near(r.enbw, (a[0] ** 2 + a.slice(1).reduce((s, v) => s + v * v, 0) / 2) / a[0] ** 2, 1e-12);
    }
  });

  it('first nulls of cosine-sum windows fall at K+1 bins (K = number of cosine terms)', () => {
    near(m('rect').nullToNull, 2, 1e-6);
    near(m('hann').nullToNull, 4, 1e-6);
    near(m('hamming').nullToNull, 4, 1e-6);
    near(m('blackman').nullToNull, 6, 1e-6);
    near(m('blackmanHarris').nullToNull, 8, 1e-6);
  });

  it('scalloping loss matches the large-N sinc closed form', () => {
    for (const id of ['rect', 'hann', 'hamming', 'blackman', 'blackmanHarris'] as const) {
      near(m(id).scallopLoss, -20 * Math.log10(cosineSumRel(COSINE_SUM[id], 0.5)), 1e-3);
    }
  });

  it('peak side-lobe levels match published values', () => {
    near(m('rect').psl, -13.26, 0.02);
    near(m('hann').psl, -31.47, 0.02);
    near(m('hamming').psl, -42.7, 0.1);
    near(m('blackman').psl, -58.1, 0.1);
    near(m('blackmanHarris').psl, -92.0, 0.1);
  });

  it('−3 dB and −6 dB widths match the large-N sinc closed form', () => {
    // Not Harris (1978) Table I: it lists 1.68 / 2.35 bins for Blackman and 2.72 bins (−6 dB) for
    // Blackman–Harris, but exact computation (here and SciPy brute force) gives 1.641 / 2.295 / 2.662.
    for (const id of ['rect', 'hann', 'hamming', 'blackman', 'blackmanHarris'] as const) {
      const r = m(id);
      near(r.bw3, closedFormWidth(COSINE_SUM[id], 3), 2e-3);
      near(r.bw6, closedFormWidth(COSINE_SUM[id], 6), 2e-3);
    }
  });

  it('Kaiser main lobe half-width follows √(1 + (β/π)²)', () => {
    for (const beta of [2, 6, 10]) {
      const r = windowMetrics(makeWindow('kaiser', N, { beta }));
      near(r.nullToNull / 2, Math.sqrt(1 + (beta / Math.PI) ** 2), 0.01);
    }
  });
});

describe('signal spectrum', () => {
  const N = 64;
  const rect = makeWindow('rect', N);

  it('an on-bin tone reads its amplitude', () => {
    const s = windowedSpectrum(synthTones(N, [{ bins: 10, levelDb: -6, phaseDeg: 30 }]), rect, 1);
    near(s.db[10], -6, 1e-9);
  });

  it('a half-bin tone shows the rectangular scalloping loss (≈3.92 dB)', () => {
    const s = windowedSpectrum(synthTones(N, [{ bins: 10.5, levelDb: 0, phaseDeg: 0 }]), rect, 1);
    near(Math.max(s.db[10], s.db[11]), -3.92, 0.25); // the −10.5-bin image leaks in slightly
  });

  it('zero-padding keeps the DFT samples and interpolates between them', () => {
    const x = synthTones(N, [{ bins: 7.3, levelDb: 0, phaseDeg: 0 }]);
    const s1 = windowedSpectrum(x, rect, 1);
    const s8 = windowedSpectrum(x, rect, 8);
    expect(s8.pad).toBe(8);
    for (let k = 0; k <= N / 2; k++) near(s8.db[8 * k], s1.db[k], 1e-9);
  });
});
