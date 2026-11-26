import 'uplot/dist/uPlot.min.css';
import './style.css';
import type uPlot from 'uplot';
import { DEFAULT_KAISER_BETA, makeWindow, WINDOWS } from './dsp/windows.ts';
import type { WindowId } from './dsp/windows.ts';
import { synthTones, toDb, windowedSpectrum } from './dsp/signal.ts';
import type { Tone } from './dsp/signal.ts';
import { windowMetrics, windowResponse } from './dsp/metrics.ts';
import type { WindowMetrics } from './dsp/metrics.ts';
import { axis, INK, markerHook, mountPlot, WINDOW_COLOR, withAlpha } from './plots.ts';
import type { Marker } from './plots.ts';

// ---------------------------------------------------------------- helpers

function byId<T extends HTMLElement = HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} is missing from index.html`);
  return el as T;
}

const windowLabel = (id: WindowId) => WINDOWS.find((w) => w.id === id)?.label ?? id;

/** Fixed-point with a true minus sign; never prints "−0.00". */
function fmt(v: number, digits = 2): string {
  const s = v.toFixed(digits);
  return (/^-0\.?0*$/.test(s) ? s.slice(1) : s).replace('-', '−');
}

/** Number from an input field, or `fallback` when empty/invalid, clamped to [lo, hi]. */
function readNumber(el: HTMLInputElement, fallback: number, lo = -Infinity, hi = Infinity): number {
  const v = el.valueAsNumber;
  return Math.min(hi, Math.max(lo, Number.isFinite(v) ? v : fallback));
}

/** Coalesce bursts of input events (slider drags) into one render per animation frame. */
function perFrame(fn: () => void): () => void {
  let queued = false;
  return () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      fn();
    });
  };
}

/** Bottom of the dB plots. DFT dots below it (exact nulls) are pinned here so they stay visible. */
const FLOOR_DB = -140;
const dbValue = (_u: uPlot, v: number | null) =>
  v == null ? '—' : v <= FLOOR_DB ? `≤ ${fmt(FLOOR_DB, 0)} dB` : `${fmt(v, 1)} dB`;
const binValue = (_u: uPlot, v: number | null) => (v == null ? '—' : `${fmt(v)} bins`);
const plainValue = (_u: uPlot, v: number | null) => (v == null ? '—' : fmt(v, 3));
/** 2 px lines; thinner on phones, where dense side-lobe combs would otherwise fill solid. */
const lineWidth = () => (window.matchMedia('(max-width: 640px)').matches ? 1.25 : 2);
const plotHeight = (share: number, min: number, max: number) => () =>
  Math.round(Math.min(max, Math.max(min, window.innerHeight * share)));

const metricsCache = new Map<string, WindowMetrics | null>();

function metricsFor(id: WindowId, n: number, periodic: boolean, beta: number): WindowMetrics | null {
  const key = `${id}|${n}|${periodic}|${id === 'kaiser' ? beta : ''}`;
  if (!metricsCache.has(key)) {
    try {
      metricsCache.set(key, windowMetrics(makeWindow(id, n, { periodic, beta })));
    } catch (err) {
      console.warn(`Metrics unavailable for ${id} (N = ${n}):`, err);
      metricsCache.set(key, null);
    }
  }
  return metricsCache.get(key) ?? null;
}

// ---------------------------------------------------------------- tabs

const tabs = [
  { tab: byId('tab-leak'), view: byId('view-leak'), render: () => renderLeak() },
  { tab: byId('tab-cmp'), view: byId('view-cmp'), render: () => renderCompare() },
];

function selectTab(i: number) {
  tabs.forEach((t, j) => {
    t.tab.setAttribute('aria-selected', String(i === j));
    t.tab.tabIndex = i === j ? 0 : -1;
    t.view.hidden = i !== j;
  });
  tabs[i].render();
}

tabs.forEach((t, i) => {
  t.tab.addEventListener('click', () => selectTab(i));
  t.tab.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    const j = (i + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length;
    selectTab(j);
    tabs[j].tab.focus();
  });
});

// ---------------------------------------------------------------- Leakage Explorer

const L = {
  form: byId<HTMLFormElement>('leak-form'),
  n: byId<HTMLSelectElement>('l-n'),
  fs: byId<HTMLInputElement>('l-fs'),
  f1: byId<HTMLInputElement>('l-f1'),
  f1Out: byId<HTMLOutputElement>('l-f1-out'),
  a1: byId<HTMLInputElement>('l-a1'),
  t2: byId<HTMLInputElement>('l-t2'),
  f2: byId<HTMLInputElement>('l-f2'),
  a2: byId<HTMLInputElement>('l-a2'),
  win: byId<HTMLSelectElement>('l-win'),
  betaRow: byId('l-beta-row'),
  beta: byId<HTMLInputElement>('l-beta'),
  betaOut: byId<HTMLOutputElement>('l-beta-out'),
  pad: byId<HTMLSelectElement>('l-pad'),
  ref: byId<HTMLInputElement>('l-ref'),
  tiles: byId('l-tiles'),
  spec: byId('p-spec'),
  time: byId('p-time'),
};
L.win.innerHTML = WINDOWS.map((w) => `<option value="${w.id}">${w.label}</option>`).join('');

let specPlot: uPlot | null = null;
let timePlot: uPlot | null = null;
let leakLayout = '';
let leakMarkers: Marker[] = [];

function tile(label: string, value: string, sub: string): string {
  return `<div class="tile"><p class="tile-label">${label}</p><p class="tile-value">${value}</p><p class="tile-sub">${sub}</p></div>`;
}

function renderLeak() {
  const n = Number(L.n.value);
  const half = n / 2;
  const fs = readNumber(L.fs, 1000, 1e-6);
  L.f1.max = String(half - 1);
  const f1 = readNumber(L.f1, 10, 0, half - 1);
  const a1 = readNumber(L.a1, 0, -120, 20);
  const tone2 = L.t2.checked;
  L.f2.disabled = L.a2.disabled = !tone2;
  const f2 = readNumber(L.f2, 16, 0, half);
  const a2 = readNumber(L.a2, -60, -120, 20);
  const win = L.win.value as WindowId;
  L.betaRow.hidden = win !== 'kaiser';
  const beta = readNumber(L.beta, DEFAULT_KAISER_BETA, 0, 30);
  const pad = Number(L.pad.value);
  L.f1Out.value = `${fmt(f1)} bins · ${fmt((f1 * fs) / n, 1)} Hz`;
  L.betaOut.value = fmt(beta, 1);

  const tones: Tone[] = [{ bins: f1, levelDb: a1, phaseDeg: 0 }];
  if (tone2) tones.push({ bins: f2, levelDb: a2, phaseDeg: 0 });
  const x = synthTones(n, tones);
  const w = makeWindow(win, n, { beta });
  const spec = windowedSpectrum(x, w, pad);
  const showRef = L.ref.checked && win !== 'rect';
  const showDots = spec.pad > 1 && n <= 128;
  leakMarkers = tone2 ? [{ at: f1, label: 'f₁' }, { at: f2, label: 'f₂' }] : [{ at: f1, label: 'f₁' }];

  // Spectrum: selected window, optional rectangular reference, optional DFT-bin dots
  const specData: (Float64Array | (number | null)[])[] = [spec.bins, spec.db];
  const specSeries: uPlot.Series[] = [
    { label: 'Frequency', value: binValue },
    { label: `${windowLabel(win)} window`, stroke: WINDOW_COLOR[win], width: lineWidth(), value: dbValue },
  ];
  if (showRef) {
    specData.push(windowedSpectrum(x, makeWindow('rect', n), pad).db);
    specSeries.push({ label: 'Rectangular (reference)', stroke: withAlpha(WINDOW_COLOR.rect, 0.5), width: 1.5, value: dbValue });
  }
  if (showDots) {
    // every pad-th point of the zero-padded spectrum is an actual N-point DFT bin
    specData.push(Array.from(spec.db, (v, k) => (k % spec.pad === 0 ? Math.max(v, FLOOR_DB) : null)));
    specSeries.push({
      label: 'DFT bins',
      stroke: WINDOW_COLOR[win],
      paths: () => null,
      points: { show: true, size: 8, width: 2, stroke: INK.surface, fill: WINDOW_COLOR[win] },
      value: dbValue,
    });
  }

  // Time domain: record, window envelope, windowed record
  const amp = tones.reduce((s, t) => s + 10 ** (t.levelDb / 20), 0);
  const timeData: uPlot.AlignedData = [
    Float64Array.from({ length: n }, (_, i) => i),
    x,
    Float64Array.from(w, (v) => amp * v),
    Float64Array.from(x, (v, i) => v * w[i]),
  ];

  const layout = `${n}|${pad}|${win}|${showRef}|${showDots}`;
  if (layout !== leakLayout || !specPlot || !timePlot) {
    leakLayout = layout;
    specPlot = mountPlot(
      L.spec,
      {
        scales: { x: { time: false }, y: { range: [FLOOR_DB - 5, 10] } },
        axes: [axis('Frequency (DFT bins)'), axis('Magnitude (dB)', { size: 50 })],
        series: specSeries,
        cursor: { drag: { x: true, y: false } },
        hooks: { draw: [markerHook(() => leakMarkers)] },
      },
      specData as uPlot.AlignedData,
      plotHeight(0.34, 220, 380),
    );
    timePlot = mountPlot(
      L.time,
      {
        scales: {
          x: { time: false },
          y: {
            range: (_u, min, max) => {
              const a = Math.max(Math.abs(min), Math.abs(max), 1e-6) * 1.12;
              return [-a, a];
            },
          },
        },
        axes: [axis('Sample n'), axis('Amplitude', { size: 50 })],
        series: [
          { label: 'n', value: (_u, v) => (v == null ? '—' : String(v)) },
          { label: 'x[n]', stroke: INK.axis, width: 1.5, value: plainValue, points: { show: false } },
          { label: 'A·w[n]', stroke: INK.muted, width: 1.5, value: plainValue, points: { show: false } },
          {
            label: 'x[n]·w[n]',
            stroke: WINDOW_COLOR[win],
            width: lineWidth(),
            value: plainValue,
            points: { show: n <= 64, size: 6, width: 1, stroke: INK.surface, fill: WINDOW_COLOR[win] },
          },
        ],
      },
      timeData,
      plotHeight(0.2, 140, 260),
    );
  } else {
    // setData(…, false) keeps any drag-zoom but skips uPlot's redraw, so redraw explicitly
    specPlot.setData(specData as uPlot.AlignedData, false);
    specPlot.redraw();
    timePlot.setData(timeData, true);
  }

  // Read-outs: the strongest of the two DFT bins around f1 shows the scalloping loss
  const m = metricsFor(win, n, true, beta);
  const reading = Math.max(spec.db[Math.floor(f1) * spec.pad], spec.db[Math.min(half, Math.ceil(f1)) * spec.pad]);
  L.tiles.innerHTML = [
    tile('Tone 1', `${fmt(f1)} bins`, `${fmt((f1 * fs) / n, 1)} Hz · ${fmt(Math.abs(f1 - Math.round(f1)))} bin off the DFT grid`),
    tile('Strongest DFT bin', `${fmt(reading)} dB`, `true level ${fmt(a1, 1)} dB · error ${fmt(reading - a1)} dB`),
    tile('Main-lobe width', m ? `${fmt(m.nullToNull)} bins` : '—', m ? `null-to-null · −3 dB width ${fmt(m.bw3)} bins` : 'not available'),
    tile('Peak side lobe', m ? `${fmt(m.psl, 1)} dB` : '—', `${windowLabel(win)} window`),
  ].join('');
}

const scheduleLeak = perFrame(renderLeak);
L.form.addEventListener('input', scheduleLeak);
L.form.addEventListener('change', scheduleLeak);
L.form.addEventListener('submit', (e) => e.preventDefault());

// ---------------------------------------------------------------- Window Comparison

const C = {
  form: byId<HTMLFormElement>('cmp-form'),
  wins: byId('c-wins'),
  betaRow: byId('c-beta-row'),
  beta: byId<HTMLInputElement>('c-beta'),
  betaOut: byId<HTMLOutputElement>('c-beta-out'),
  n: byId<HTMLSelectElement>('c-n'),
  range: byId<HTMLSelectElement>('c-range'),
  sym: byId<HTMLInputElement>('c-sym'),
  table: byId<HTMLTableElement>('c-table'),
  note: byId('c-note'),
  resp: byId('p-resp'),
  shape: byId('p-shape'),
};

const DEFAULT_ON = new Set<WindowId>(['rect', 'hann', 'hamming', 'blackman', 'blackmanHarris']);
C.wins.innerHTML = WINDOWS.map(
  (w) =>
    `<label class="check"><input type="checkbox" value="${w.id}"${DEFAULT_ON.has(w.id) ? ' checked' : ''} />` +
    `<span class="swatch" style="--swatch:${WINDOW_COLOR[w.id]}"></span>${w.label}</label>`,
).join('');

interface Column {
  key: keyof WindowMetrics;
  head: string;
  unit: string;
  digits: number;
  best: 'min' | 'max';
}

const COLUMNS: Column[] = [
  { key: 'nullToNull', head: 'Main lobe, null-to-null', unit: 'bins', digits: 2, best: 'min' },
  { key: 'bw3', head: '−3 dB width', unit: 'bins', digits: 3, best: 'min' },
  { key: 'bw6', head: '−6 dB width', unit: 'bins', digits: 3, best: 'min' },
  { key: 'psl', head: 'Peak side lobe', unit: 'dB', digits: 1, best: 'min' },
  { key: 'coherentGain', head: 'Coherent gain', unit: '', digits: 3, best: 'max' },
  { key: 'enbw', head: 'ENBW', unit: 'bins', digits: 3, best: 'min' },
  { key: 'scallopLoss', head: 'Scalloping loss', unit: 'dB', digits: 2, best: 'min' },
  { key: 'wcpl', head: 'Worst-case proc. loss', unit: 'dB', digits: 2, best: 'min' },
];

let respPlot: uPlot | null = null;
let shapePlot: uPlot | null = null;
let cmpLayout = '';

function renderCompare() {
  const ids = Array.from(C.wins.querySelectorAll<HTMLInputElement>('input:checked'), (el) => el.value as WindowId);
  const n = Number(C.n.value);
  const periodic = !C.sym.checked;
  const beta = readNumber(C.beta, DEFAULT_KAISER_BETA, 0, 30);
  const zoom = C.range.value === 'zoom';
  C.betaOut.value = fmt(beta, 1);
  C.betaRow.classList.toggle('is-off', !ids.includes('kaiser'));

  const windows = ids.map((id) => ({ id, w: makeWindow(id, n, { periodic, beta }) }));
  // Two-sided response on a grid of `os` points per bin (|W| is even for a real window)
  const os = Math.max(16, 4096 / n);
  const kMax = Math.round((zoom ? Math.min(8, n / 2) : n / 2) * os);
  const nu = Float64Array.from({ length: 2 * kMax + 1 }, (_, i) => (i - kMax) / os);
  const respData = [
    nu,
    ...windows.map(({ w }) => {
      const { mag } = windowResponse(w, os);
      return Float64Array.from(nu, (_, i) => toDb(mag[Math.abs(i - kMax)]));
    }),
  ] as uPlot.AlignedData;
  const shapeData = [Float64Array.from({ length: n }, (_, i) => i), ...windows.map((x) => x.w)] as uPlot.AlignedData;

  const layout = `${ids.join(',')}|${n}|${zoom}|${periodic}`;
  if (layout !== cmpLayout || !respPlot || !shapePlot) {
    cmpLayout = layout;
    const lines = (value: uPlot.Series['value']): uPlot.Series[] =>
      windows.map(({ id }) => ({ label: windowLabel(id), stroke: WINDOW_COLOR[id], width: lineWidth(), value }));
    respPlot = mountPlot(
      C.resp,
      {
        scales: { x: { time: false }, y: { range: [FLOOR_DB, 5] } },
        axes: [axis('Frequency ν (DFT bins)'), axis('Magnitude (dB)', { size: 50 })],
        series: [{ label: 'ν', value: binValue }, ...lines(dbValue)],
        cursor: { drag: { x: true, y: false } },
      },
      respData,
      plotHeight(0.36, 220, 360),
    );
    shapePlot = mountPlot(
      C.shape,
      {
        scales: { x: { time: false }, y: { range: [-0.1, 1.05] } },
        axes: [axis('Sample n'), axis('w[n]', { size: 44 })],
        series: [{ label: 'n', value: (_u, v) => (v == null ? '—' : String(v)) }, ...lines(plainValue)],
      },
      shapeData,
      plotHeight(0.36, 220, 360),
    );
  } else {
    respPlot.setData(respData, false);
    respPlot.redraw();
    shapePlot.setData(shapeData, false);
    shapePlot.redraw();
  }
  renderTable(ids, n, periodic, beta);
}

function renderTable(ids: WindowId[], n: number, periodic: boolean, beta: number) {
  const rows = ids.map((id) => ({ id, m: metricsFor(id, n, periodic, beta) }));
  const best = new Map<keyof WindowMetrics, number>();
  for (const c of COLUMNS) {
    const vals = rows.flatMap((r) => (r.m ? [r.m[c.key]] : []));
    if (vals.length > 1) best.set(c.key, c.best === 'min' ? Math.min(...vals) : Math.max(...vals));
  }

  const head = COLUMNS.map((c) => `<th scope="col">${c.head}${c.unit ? ` <span class="unit">(${c.unit})</span>` : ''}</th>`).join('');
  const body = rows.length
    ? rows
        .map(({ id, m }) => {
          const name = id === 'kaiser' ? `Kaiser, β = ${fmt(beta, 1)}` : windowLabel(id);
          const cells = COLUMNS.map((c) => {
            if (!m) return '<td>—</td>';
            const b = best.get(c.key);
            const isBest = b !== undefined && Math.abs(m[c.key] - b) < 1e-9;
            return `<td${isBest ? ' class="best"' : ''}>${fmt(m[c.key], c.digits)}</td>`;
          }).join('');
          return `<tr><th scope="row"><span class="swatch" style="--swatch:${WINDOW_COLOR[id]}"></span>${name}</th>${cells}</tr>`;
        })
        .join('')
    : `<tr><td class="empty" colspan="${COLUMNS.length + 1}">Select at least one window.</td></tr>`;

  C.table.innerHTML =
    '<caption class="sr-only">Figures of merit for the selected windows</caption>' +
    `<thead><tr><th scope="col">Window</th>${head}</tr></thead><tbody>${body}</tbody>`;
  C.note.textContent =
    `N = ${n}, ${periodic ? 'periodic (DFT-even)' : 'symmetric'} definition · ` +
    'computed from the exact DTFT of each window · best value per column highlighted';
}

const scheduleCompare = perFrame(renderCompare);
C.form.addEventListener('input', scheduleCompare);
C.form.addEventListener('change', scheduleCompare);
C.form.addEventListener('submit', (e) => e.preventDefault());

selectTab(0);
