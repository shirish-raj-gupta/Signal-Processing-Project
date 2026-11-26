/**
 * In-place iterative radix-2 Cooley–Tukey FFT (decimation in time).
 * Computes X[k] = Σ x[n]·e^(−j2πkn/M) for M = re.length, which must be a power of two.
 */
export function fft(re: Float64Array, im: Float64Array): void {
  const m = re.length;
  if (m !== im.length || m < 1 || (m & (m - 1)) !== 0) {
    throw new Error(`FFT length must be a power of two (got ${re.length} / ${im.length})`);
  }

  // Bit-reversal permutation
  for (let i = 1, j = 0; i < m; i++) {
    let bit = m >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      let t = re[i];
      re[i] = re[j];
      re[j] = t;
      t = im[i];
      im[i] = im[j];
      im[j] = t;
    }
  }

  // One twiddle table e^(−j2πt/M) serves every stage (stage of length L uses stride M/L).
  // Exact cos/sin per entry: a running-product recurrence drifts by ~M·eps at large M.
  const half = m >> 1;
  const cos = new Float64Array(half);
  const sin = new Float64Array(half);
  for (let t = 0; t < half; t++) {
    cos[t] = Math.cos((2 * Math.PI * t) / m);
    sin[t] = -Math.sin((2 * Math.PI * t) / m);
  }

  for (let len = 2; len <= m; len <<= 1) {
    const h = len >> 1;
    const stride = m / len;
    for (let start = 0; start < m; start += len) {
      for (let k = 0, t = 0; k < h; k++, t += stride) {
        const a = start + k;
        const b = a + h;
        const xr = re[b] * cos[t] - im[b] * sin[t];
        const xi = re[b] * sin[t] + im[b] * cos[t];
        re[b] = re[a] - xr;
        im[b] = im[a] - xi;
        re[a] += xr;
        im[a] += xi;
      }
    }
  }
}

/** Smallest power of two ≥ n. */
export function nextPow2(n: number): number {
  let p = 1;
  while (p < n) p <<= 1;
  return p;
}
