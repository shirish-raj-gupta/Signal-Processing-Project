// Export the engine's window metrics for the report and the SciPy cross-check.
// Run with `npm run metrics` (Node's built-in TypeScript type stripping, no build step).
import { mkdirSync, writeFileSync } from 'node:fs';
import { DEFAULT_KAISER_BETA, makeWindow, WINDOWS } from '../src/dsp/windows.ts';
import { windowMetrics } from '../src/dsp/metrics.ts';

const N = 256; // large enough for figures of merit to sit at their asymptotic (large-N) values
const OUT = 'report/data/app_metrics.json';

const windows = WINDOWS.map(({ id, label }) => ({
  id,
  label,
  ...windowMetrics(makeWindow(id, N, { beta: DEFAULT_KAISER_BETA })),
}));

const kaiserSweep = Array.from({ length: 29 }, (_, i) => {
  const beta = i * 0.5;
  const m = windowMetrics(makeWindow('kaiser', N, { beta }));
  return { beta, nullToNull: m.nullToNull, bw3: m.bw3, psl: m.psl, enbw: m.enbw, scallopLoss: m.scallopLoss };
});

mkdirSync('report/data', { recursive: true });
writeFileSync(OUT, `${JSON.stringify({ N, periodic: true, kaiserBeta: DEFAULT_KAISER_BETA, windows, kaiserSweep }, null, 2)}\n`);
console.log(`Wrote ${OUT}: ${windows.length} windows and ${kaiserSweep.length} Kaiser β values at N = ${N}`);
