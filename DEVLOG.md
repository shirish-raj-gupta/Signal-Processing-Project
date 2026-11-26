# Development log

Running log of design decisions, problems met and how they were fixed. Source for the
"Challenges" section of the reports.

## 2026-11-26 — Setup

- **Stack.** Web-first: TypeScript + Vite, uPlot for charts, Vitest for tests. FFT, windows and
  metric extraction are written from scratch (no DSP library) so every number can be traced to
  our own code. Android/iOS packaging (PWA + Capacitor) is planned for the second half.
- **Problem: LaTeX build hung.** Probing for the `booktabs` package made MiKTeX open its
  "install missing package" prompt, which blocks a non-interactive build (the check timed out
  after 120 s). Missing here: booktabs, siunitx, caption, float, fancyhdr, multirow, parskip,
  microtype.
  **Fix:** the report uses only installed packages (`tabular` + `\hline` instead of booktabs,
  `[htbp]` instead of float's `[H]`), and builds run with `pdflatex --disable-installer` so a
  missing file fails fast instead of waiting on a dialog.

## 2026-11-26 — DSP engine and unit tests

- **Problem: a unit test against the literature failed.** The Blackman −3 dB main-lobe width
  came out as 1.641 bins, but Harris (1978), Table I lists 1.68 bins.
  **Investigation:** (1) a hand-derived large-N closed form (the window response as a sum of
  shifted sinc functions) gives 1.641 bins; (2) an independent SciPy brute-force computation
  (`get_window`, N = 256, 2²¹-point FFT) gives 1.6409 bins. The same check shows that Table I's
  Blackman −6 dB width (2.35 vs 2.295 bins) and Blackman–Harris −6 dB width (2.72 vs 2.662 bins)
  are also off, while the rectangular, Hann and Hamming widths agree to within 0.01 bins.
  **Fix:** the width tests now compare against the closed form. Table I values are kept for
  discussion only; the SciPy cross-check (validation script) is the primary external reference.
- **Design decision: periodic vs symmetric windows.** Published figures of merit (Harris, SciPy
  `get_window`) use the periodic, "DFT-even" definition (period D = N). The symmetric
  definition (D = N − 1) used in FIR design gives slightly different numbers at small N
  (e.g. Hann ENBW = 1.5·N/(N−1) = 1.524 at N = 64 instead of 1.500). Periodic is the default;
  the comparison view has a toggle for the symmetric form.
