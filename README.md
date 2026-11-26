# SP09 · Window & Leakage Analyzer

Interactive tool for **windowing effects and spectral leakage**: compare common windows on
finite sinusoids and measure main-lobe width, side-lobe levels and related figures of merit.
EE4999 Signal Processing Project. Mid-term build (v0.5): web app; Android/iOS packaging comes in
the second half.

## What works now

- **Leakage Explorer** — one or two finite tones (length N, sample rate, frequency on or off the
  DFT grid, level), any window, zero-padding. Shows the zero-padded DTFT with the N-point DFT
  bins on top, the time-domain record, and read-outs for scalloping error, main-lobe width and
  peak side-lobe level.
- **Window Comparison** — overlaid normalised responses, window shapes, and a table of eight
  figures of merit (null-to-null, −3 dB and −6 dB width, peak side-lobe level, coherent gain,
  ENBW, scalloping loss, worst-case processing loss).
- Windows: rectangular, Hann, Hamming, Blackman, Blackman–Harris, flat-top, Kaiser (β),
  periodic or symmetric definition.
- All DSP (radix-2 FFT, windows, metric extraction) is in [`src/dsp`](src/dsp), with no DSP
  library. It is checked by 23 tests and an independent SciPy cross-check.

## Run it

```bash
npm install
npm run dev        # http://localhost:5173
npm test           # unit + DOM tests
npm run build      # type-check and production build
```

## Validation and report data

```bash
npm run metrics                       # engine metrics -> report/data/app_metrics.json
python scripts/validate_scipy.py      # SciPy cross-check, report tables and trade-off figure
python scripts/screenshots.py         # report screenshots (needs `npx vite preview --port 4173`)
```

The mid-term report source is in [`report/`](report) (build with
`pdflatex --disable-installer midterm.tex`, twice). Problems met during development and how they
were fixed are logged in [DEVLOG.md](DEVLOG.md).

## Planned for the final

More windows (Bartlett, Tukey, Gaussian, Nuttall, Dolph–Chebyshev), side-lobe roll-off,
two-tone resolution analyser, export and shareable settings, PWA with offline support,
Android and iOS builds, public deployment.
