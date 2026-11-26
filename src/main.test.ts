// @vitest-environment happy-dom
import { beforeAll, describe, expect, it } from 'vitest';
import html from '../index.html?raw';

/** uPlot draws on <canvas>; happy-dom has no 2D context or Path2D, so hand it no-op ones. */
function stubCanvas() {
  const noop = () => undefined;
  const ctx = new Proxy({} as Record<string | symbol, unknown>, {
    get: (target, key) => (key in target ? target[key] : key === 'measureText' ? () => ({ width: 10 }) : noop),
    set: (target, key, value) => {
      target[key] = value;
      return true;
    },
  });
  HTMLCanvasElement.prototype.getContext = (() => ctx) as unknown as HTMLCanvasElement['getContext'];
  (globalThis as Record<string, unknown>).Path2D = class {
    constructor() {
      return new Proxy(this, { get: (target, key) => (key in target ? Reflect.get(target, key) : noop) });
    }
  };
}

const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
const el = <T extends HTMLElement>(selector: string) => document.querySelector(selector) as T;
const tiles = () => Array.from(document.querySelectorAll('#l-tiles .tile-value'), (t) => t.textContent);

async function setValue(selector: string, value: string) {
  const input = el<HTMLInputElement | HTMLSelectElement>(selector);
  input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  await frame();
}

beforeAll(async () => {
  stubCanvas();
  document.body.innerHTML = html.slice(html.indexOf('<body>') + '<body>'.length, html.indexOf('<script'));
  // happy-dom 21 can ignore <option selected> (reports "32" for 16/32/[64]); apply it explicitly.
  for (const select of document.querySelectorAll('select')) {
    const chosen = select.querySelector<HTMLOptionElement>('option[selected]');
    if (chosen) select.value = chosen.value;
  }
  await import('./main.ts');
});

describe('Leakage Explorer', () => {
  it('reads an on-bin tone at its true level with the rectangular window', () => {
    expect(tiles()).toEqual(['10.00 bins', '0.00 dB', '2.00 bins', '−13.3 dB']);
    expect(el('#l-beta-row').hidden).toBe(true);
  });

  it('shows the scalloping loss of a half-bin tone', async () => {
    await setValue('#l-f1', '10.5');
    expect(tiles()[1]).toBe('−3.79 dB');
  });

  it('reports Blackman–Harris main-lobe width and side-lobe level', async () => {
    await setValue('#l-win', 'blackmanHarris');
    expect(tiles().slice(1)).toEqual(['−0.83 dB', '8.00 bins', '−92.0 dB']);
  });

  it('shows the β control only for the Kaiser window', async () => {
    await setValue('#l-win', 'kaiser');
    expect(el('#l-beta-row').hidden).toBe(false);
  });
});

describe('Window Comparison', () => {
  const rows = () => Array.from(document.querySelectorAll('#c-table tbody tr'));
  const cell = (row: Element, col: number) => row.querySelectorAll('td')[col];

  it('lists the default windows and highlights the best value in each column', () => {
    el<HTMLButtonElement>('#tab-cmp').click();
    expect(el('#view-cmp').hidden).toBe(false);
    expect(rows().map((r) => r.querySelector('th')?.textContent)).toEqual([
      'Rectangular',
      'Hann',
      'Hamming',
      'Blackman',
      'Blackman–Harris',
    ]);
    const [rect, , , , bh] = rows();
    expect(cell(rect, 0).textContent).toBe('2.00'); // null-to-null width
    expect(cell(rect, 0).classList.contains('best')).toBe(true); // narrowest main lobe
    expect(cell(bh, 3).textContent).toBe('−92.0'); // peak side lobe
    expect(cell(bh, 3).classList.contains('best')).toBe(true); // lowest side lobes
  });

  it('adds Kaiser and follows the β slider', async () => {
    const kaiser = el<HTMLInputElement>('#c-wins input[value="kaiser"]');
    kaiser.checked = true;
    kaiser.dispatchEvent(new Event('input', { bubbles: true }));
    await frame();
    await setValue('#c-beta', '3');
    const row = rows().at(-1)!;
    expect(row.querySelector('th')?.textContent).toBe('Kaiser, β = 3.0');
    expect(cell(row, 0).textContent).toBe('2.77'); // 2·√(1 + (β/π)²)
  });
});
