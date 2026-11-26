"""Cross-check the app's window metrics against SciPy and build the report's tables and figure.

Independent of the app's algorithm: SciPy generates the windows, and every frequency-domain
metric is read off a brute-force 2^21-point FFT grid (no golden-section or bisection steps).

Run after `npm run metrics`:   python scripts/validate_scipy.py
Exits with status 1 if any metric differs from the SciPy reference by more than its tolerance.
"""

import json
import sys
from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402
import numpy as np  # noqa: E402
from scipy.signal import get_window  # noqa: E402

ROOT = Path(__file__).resolve().parents[1]
DATA, TABLES, FIGURES = ROOT / "report" / "data", ROOT / "report" / "tables", ROOT / "report" / "figures"

SCIPY_NAME = {
    "rect": "boxcar",
    "hann": "hann",
    "hamming": "hamming",
    "blackman": "blackman",
    "blackmanHarris": "blackmanharris",
    "flattop": "flattop",
}
# Same colours as the app (src/plots.ts).
COLOR = {
    "rect": "#2a78d6",
    "hann": "#eb6834",
    "hamming": "#1baf7a",
    "blackman": "#eda100",
    "blackmanHarris": "#e87ba4",
    "flattop": "#008300",
    "kaiser": "#6250d6",
}
# Largest accepted |app - SciPy| per metric (grid step of the reference is 1.2e-4 bins).
TOLERANCE = {
    "nullToNull": 1e-3,
    "bw3": 1e-3,
    "bw6": 1e-3,
    "psl": 0.01,
    "coherentGain": 1e-9,
    "enbw": 1e-9,
    "scallopLoss": 1e-6,
    "wcpl": 1e-6,
}
METRIC_NAME = {
    "nullToNull": "Main-lobe width, null-to-null (bins)",
    "bw3": "$-3$ dB width (bins)",
    "bw6": "$-6$ dB width (bins)",
    "psl": "Peak side-lobe level (dB)",
    "coherentGain": "Coherent gain",
    "enbw": "ENBW (bins)",
    "scallopLoss": "Scalloping loss (dB)",
    "wcpl": "Worst-case processing loss (dB)",
}
# Harris (1978), Table I, as published: PSL, ENBW, 3.0-dB BW, scallop loss, WCPL, 6.0-dB BW.
HARRIS = {
    "rect": (-13, 1.00, 0.89, 3.92, 3.92, 1.21),
    "hann": (-32, 1.50, 1.44, 1.42, 3.18, 2.00),
    "hamming": (-43, 1.36, 1.30, 1.78, 3.10, 1.81),
    "blackman": (-58, 1.73, 1.68, 1.10, 3.47, 2.35),
    "blackmanHarris": (-92, 2.00, 1.90, 0.83, 3.85, 2.72),
}
HARRIS_KEYS = ("psl", "enbw", "bw3", "scallopLoss", "wcpl", "bw6")


def reference(w: np.ndarray, m: int = 2**21) -> dict:
    """Figures of merit of window w read off an m-point zero-padded FFT."""
    n = w.size
    mag = np.abs(np.fft.rfft(w, m))
    mag /= mag[0]
    nu = np.arange(mag.size) * n / m
    db = 20 * np.log10(np.maximum(mag, 1e-300))
    inner = mag[1:-1]
    k = np.flatnonzero((inner < 0.1) & (inner <= mag[:-2]) & (inner <= mag[2:]))[0] + 1  # first null

    def width(level: float) -> float:
        j = int(np.argmax(db[:k] < -level))  # first grid point below -level
        x0, x1, y0, y1 = nu[j - 1], nu[j], db[j - 1], db[j]
        return 2 * (x0 + (-level - y0) * (x1 - x0) / (y1 - y0))

    enbw = n * np.sum(w**2) / w.sum() ** 2
    scallop = -20 * np.log10(abs(np.sum(w * np.exp(-1j * np.pi * np.arange(n) / n))) / w.sum())
    return {
        "nullToNull": 2 * nu[k],
        "bw3": width(3.0),
        "bw6": width(6.0),
        "psl": float(db[k:].max()),
        "coherentGain": w.sum() / n,
        "enbw": enbw,
        "scallopLoss": scallop,
        "wcpl": scallop + 10 * np.log10(enbw),
    }


def tex_num(v: float, digits: int) -> str:
    return f"{v:.{digits}f}".replace("-", "$-$")


def tex_label(win: dict, beta: float) -> str:
    return f"Kaiser ($\\beta = {beta:g}$)" if win["id"] == "kaiser" else win["label"].replace("\u2013", "--")


def write_tables(app: dict, worst: dict) -> None:
    beta = app["kaiserBeta"]
    digits = (2, 3, 3, 2, 3, 3, 2, 2)
    keys = ("nullToNull", "bw3", "bw6", "psl", "coherentGain", "enbw", "scallopLoss", "wcpl")
    rows = [
        " & ".join([tex_label(w, beta)] + [tex_num(w[k], d) for k, d in zip(keys, digits)]) + r" \\"
        for w in app["windows"]
    ]
    (TABLES / "metrics.tex").write_text(
        "\\begin{tabular}{lrrrrrrrr}\n\\hline\n"
        "Window & Null-to-null & $-3$\\,dB & $-6$\\,dB & PSL & CG & ENBW & SL & WCPL \\\\\n"
        " & (bins) & (bins) & (bins) & (dB) & & (bins) & (dB) & (dB) \\\\\n\\hline\n"
        + "\n".join(rows)
        + "\n\\hline\n\\end{tabular}\n",
        encoding="utf-8",
    )

    val_rows = [
        f"{METRIC_NAME[k]} & {TOLERANCE[k]:.0e} & {worst[k]:.1e} \\\\".replace("e-0", "e-").replace("e+00", "")
        for k in TOLERANCE
    ]
    (TABLES / "validation.tex").write_text(
        "\\begin{tabular}{lrr}\n\\hline\n"
        "Metric & Tolerance & Largest $|\\text{app} - \\text{SciPy}|$ \\\\\n\\hline\n"
        + "\n".join(val_rows)
        + "\n\\hline\n\\end{tabular}\n",
        encoding="utf-8",
    )

    by_id = {w["id"]: w for w in app["windows"]}
    harris_rows = []
    for wid, published in HARRIS.items():
        cells = [tex_label(by_id[wid], beta)]
        for key, pub in zip(HARRIS_KEYS, published):
            ours = by_id[wid][key]
            rounding = 0.5 if key == "psl" else 0.005  # Table I rounds PSL to 1 dB, the rest to 0.01
            cell = f"{tex_num(ours, 1 if key == 'psl' else 2)} / {tex_num(pub, 0 if key == 'psl' else 2)}"
            cells.append(f"\\textbf{{{cell}}}" if abs(ours - pub) > rounding + 1e-3 else cell)
        harris_rows.append(" & ".join(cells) + r" \\")
    (TABLES / "harris.tex").write_text(
        "\\begin{tabular}{lrrrrrr}\n\\hline\n"
        "Window & PSL (dB) & ENBW (bins) & $-3$\\,dB (bins) & SL (dB) & WCPL (dB) & $-6$\\,dB (bins) \\\\\n\\hline\n"
        + "\n".join(harris_rows)
        + "\n\\hline\n\\end{tabular}\n",
        encoding="utf-8",
    )


def write_tradeoff_figure(app: dict) -> None:
    plt.rcParams.update({"font.family": "sans-serif", "font.size": 9, "axes.edgecolor": "#c3c2b7"})
    fig, ax = plt.subplots(figsize=(5.6, 3.3))
    sweep = app["kaiserSweep"]
    ax.plot([p["bw3"] for p in sweep], [p["psl"] for p in sweep], color=COLOR["kaiser"], lw=1.6, zorder=2)
    for p in sweep:
        if p["beta"] in (0, 2, 4, 6, 10, 12, 14):  # β = 8 would sit on the Blackman label
            ax.plot(p["bw3"], p["psl"], "o", ms=3.5, color=COLOR["kaiser"], zorder=3)
            text = "Kaiser β=14" if p["beta"] == 14 else f"β={p['beta']:g}"
            ax.annotate(text, (p["bw3"], p["psl"]), xytext=(5, 2), textcoords="offset points",
                        fontsize=7, color="#52514e")
    label_right = {"hann", "blackman"}  # left of these points runs the Kaiser curve
    for w in app["windows"]:
        if w["id"] == "kaiser":
            continue
        ax.plot(w["bw3"], w["psl"], "o", ms=6.5, color=COLOR[w["id"]], mec="#fcfcfb", mew=1.5, zorder=4)
        right = w["id"] in label_right
        ax.annotate(w["label"], (w["bw3"], w["psl"]), xytext=(7 if right else -7, -3), textcoords="offset points",
                    ha="left" if right else "right", fontsize=8, color="#0b0b0b")
    ax.set_xlabel("−3 dB main-lobe width (bins)")
    ax.set_ylabel("Peak side-lobe level (dB)")
    ax.grid(color="#e1e0d9", lw=0.6)
    ax.set_axisbelow(True)
    for side in ("top", "right"):
        ax.spines[side].set_visible(False)
    ax.set_xlim(0.6, 4.1)
    ax.set_ylim(-125, 0)
    fig.tight_layout()
    fig.savefig(FIGURES / "tradeoff.pdf")
    fig.savefig(FIGURES / "tradeoff.png", dpi=200)
    plt.close(fig)


def main() -> int:
    sys.stdout.reconfigure(encoding="utf-8")  # window labels contain an en dash; Windows consoles default to cp1252
    app = json.loads((DATA / "app_metrics.json").read_text(encoding="utf-8"))
    n, beta = app["N"], app["kaiserBeta"]
    worst = {k: 0.0 for k in TOLERANCE}
    failures = []
    print(f"N = {n}, periodic windows; |app - SciPy| per metric")
    print(f"{'window':16s}" + "".join(f"{k:>14s}" for k in TOLERANCE))
    for win in app["windows"]:
        spec = ("kaiser", beta) if win["id"] == "kaiser" else SCIPY_NAME[win["id"]]
        ref = reference(get_window(spec, n))
        diffs = {k: abs(win[k] - ref[k]) for k in TOLERANCE}
        print(f"{win['label']:16s}" + "".join(f"{d:14.2e}" for d in diffs.values()))
        for k, d in diffs.items():
            worst[k] = max(worst[k], d)
            if d > TOLERANCE[k]:
                failures.append(f"{win['label']} {k}: app {win[k]:.6f} vs SciPy {ref[k]:.6f}")

    TABLES.mkdir(parents=True, exist_ok=True)
    FIGURES.mkdir(parents=True, exist_ok=True)
    write_tables(app, worst)
    write_tradeoff_figure(app)
    (DATA / "validation.json").write_text(
        json.dumps({"N": n, "windows": len(app["windows"]), "tolerance": TOLERANCE, "maxAbsDiff": worst,
                    "pass": not failures}, indent=2) + "\n",
        encoding="utf-8",
    )
    print("\nFAIL:\n  " + "\n  ".join(failures) if failures else "\nPASS: every metric within tolerance")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
