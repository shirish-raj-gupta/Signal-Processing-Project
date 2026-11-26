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

## 2026-11-26 — Web UI (Leakage Explorer, Window Comparison)

- **Problem: plots froze while a slider moved.** Dragging the tone from 10.00 to 10.50 bins
  updated the read-out tiles, but the spectrum still showed the on-bin picture. The plots were
  updated with uPlot's `setData(data, false)` (to keep the user's zoom), and that call skips
  uPlot's own redraw. **Fix:** call `redraw()` after `setData(…, false)`. Checked by screenshot
  at 10.5 bins and with a Kaiser β sweep in the comparison view.
- **Problem: on-bin DFT samples were invisible.** For an on-bin tone the N-point DFT samples
  land exactly on the window's nulls (−∞ dB), below the plot. **Fix:** DFT dots below the plot
  floor are pinned to −140 dB and the legend reads "≤ −140 dB", so the "single spectral line"
  of an on-bin tone can be seen.
- **Problem: hidden controls reappeared.** The Kaiser β slider showed for every window because
  the `.field { display: grid }` rule overrode the HTML `hidden` attribute. **Fix:** a global
  `[hidden] { display: none !important }` rule.
- **Phone layout.** At 390 px the 2 px traces of a 32-lobe spectrum merged into a solid comb.
  Traces are 1.25 px on narrow screens, and plots come before the controls.
- **Test environment quirk.** happy-dom 21 ignores `<option selected>` in some `<select>`s
  (16/32/[64] reports 32), which made the DOM test compare at the wrong N. The test now applies
  the `selected` option explicitly; the app itself was correct in Chromium.

## 2026-11-26 — Cross-check against SciPy

- `npm run metrics` exports the engine's figures of merit (7 windows plus a Kaiser β sweep,
  N = 256). `scripts/validate_scipy.py` recomputes every metric with SciPy windows and a
  brute-force 2²¹-point FFT (a different algorithm from the app's DTFT refinement).
  **Result:** largest differences are 1.1e-8 bins (−3/−6 dB widths), 1.8e-7 dB (peak side lobe),
  5.7e-5 bins (Kaiser null, limited by the reference grid) and ~1e-14 for the closed-form
  quantities — all within tolerance.
- The same script lists the published Harris (1978) Table I values next to ours. Beyond the
  Blackman/Blackman–Harris widths found earlier, Table I's Hamming scalloping loss (1.78 dB vs
  1.75 dB) and Hann side-lobe level (−32 dB vs −31.5 dB, more than rounding) also differ.

## 2026-11-26 — Demo video

- **Capture.** `scripts/record_demo.py` drives the real app with a visible cursor. Frames come from
  Chrome's screencast at 1.5x scale, so text stays sharp at 1920x1080. Captions are white on a black
  band under the app, so they never cover it. A rehearsal run first checks every number a caption
  quotes against what the app shows.
- **Problem: the video ran about 17 % long.** A 28.8 s capture became a 33.6 s video, which would
  have pushed every caption out of sync. Timing frames by arrival instead of Chrome's frame
  timestamps made no difference. The cause was ffmpeg's concat demuxer: it gives each still image a
  1/25 s time base, so frames arriving less than 40 ms apart were pushed later.
  **Fix:** the script now writes a constant 30 frame/s stream itself (for every 1/30 s tick it sends
  the latest captured frame to ffmpeg), and the captions use the same clock. The video length now
  matches the capture exactly.
