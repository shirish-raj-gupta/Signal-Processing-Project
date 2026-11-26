import uPlot from 'uplot';
import type { WindowId } from './dsp/windows.ts';

/**
 * Categorical slots 1–7 of the validated reference palette, fixed per window so a window
 * keeps its colour in every view, whatever else is selected.
 */
export const WINDOW_COLOR: Readonly<Record<WindowId, string>> = {
  rect: '#2a78d6',
  hann: '#eb6834',
  hamming: '#1baf7a',
  blackman: '#eda100',
  blackmanHarris: '#e87ba4',
  flattop: '#008300',
  kaiser: '#6250d6',
};

export const INK = {
  secondary: '#52514e',
  muted: '#898781',
  grid: '#e1e0d9',
  axis: '#c3c2b7',
  surface: '#fcfcfb',
} as const;

const FONT = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';

export function withAlpha(hex: string, alpha: number): string {
  return hex + Math.round(alpha * 255).toString(16).padStart(2, '0');
}

/** Recessive axis: hairline grid one shade off the surface, secondary-ink labels. */
export function axis(label: string, extra: uPlot.Axis = {}): uPlot.Axis {
  return {
    label,
    stroke: INK.secondary,
    font: `11px ${FONT}`,
    labelFont: `500 12px ${FONT}`,
    labelSize: 18,
    grid: { stroke: INK.grid, width: 1 },
    ticks: { stroke: INK.axis, width: 1, size: 4 },
    ...extra,
  };
}

export interface Marker {
  at: number;
  label: string;
}

/** Draw hook: thin vertical annotation lines (tone frequencies), labelled at the top. */
export function markerHook(get: () => readonly Marker[]) {
  return (u: uPlot) => {
    const { ctx, bbox } = u;
    const px = uPlot.pxRatio;
    ctx.save();
    ctx.strokeStyle = INK.muted;
    ctx.fillStyle = INK.secondary;
    ctx.lineWidth = px;
    ctx.font = `${11 * px}px ${FONT}`;
    for (const m of get()) {
      const x = Math.round(u.valToPos(m.at, 'x', true)) + 0.5;
      if (x < bbox.left || x > bbox.left + bbox.width) continue;
      ctx.beginPath();
      ctx.moveTo(x, bbox.top);
      ctx.lineTo(x, bbox.top + bbox.height);
      ctx.stroke();
      ctx.fillText(m.label, x + 4 * px, bbox.top + 13 * px);
    }
    ctx.restore();
  };
}

const disposers = new WeakMap<HTMLElement, () => void>();

/**
 * Mount a uPlot in `el`, replacing any plot already there. Width tracks the container;
 * height comes from `height()` so it can follow the viewport.
 */
export function mountPlot(
  el: HTMLElement,
  opts: Omit<uPlot.Options, 'width' | 'height'>,
  data: uPlot.AlignedData,
  height: () => number,
): uPlot {
  disposers.get(el)?.();
  const u = new uPlot({ ...opts, width: el.clientWidth || 640, height: height() }, data, el);
  let lastWidth = el.clientWidth;
  const resize = () => {
    lastWidth = el.clientWidth;
    if (lastWidth > 0) u.setSize({ width: lastWidth, height: height() });
  };
  // Width changes only: setSize changes the container's height, which must not re-trigger.
  const ro = new ResizeObserver(() => {
    if (el.clientWidth !== lastWidth) resize();
  });
  ro.observe(el);
  window.addEventListener('resize', resize);
  disposers.set(el, () => {
    ro.disconnect();
    window.removeEventListener('resize', resize);
    u.destroy();
  });
  return u;
}
