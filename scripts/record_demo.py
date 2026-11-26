"""Record the silent mid-term demo: the live app, with black-and-white captions.

Needs the built app being served:   npm run build && npx vite preview --port 4173
    python scripts/record_demo.py --rehearse   fast run, no video: checks every selector and
                                               every number a caption quotes against the app
    python scripts/record_demo.py --smoke      first scenes only, to test capture and encoding
    python scripts/record_demo.py              full demo -> deliverables/SP09_MidTerm_Demo.mp4

Frames come from Chrome's screencast at 1.5x device scale (sharper than Playwright's built-in
VP8 recorder). ffmpeg adds a black band under the app and burns the captions into it in white,
so they never cover the UI. The video has no audio track.
"""

import argparse
import base64
import json
import re
import subprocess
import sys
import tempfile
import time
from pathlib import Path

from playwright.sync_api import Page, sync_playwright

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "deliverables" / "SP09_MidTerm_Demo.mp4"
URL = "http://localhost:4173/"
VIEW_W, VIEW_H, SCALE = 1280, 640, 1.5  # CSS viewport x device scale = 1920x960 frames
W, H, BAND, FPS = 1920, 960, 120, 30  # 120 px caption band below -> 1920x1080 video

OVERLAY_JS = r"""
() => {
  const style = document.createElement('style');
  style.textContent = `
    #demo-cursor { position: fixed; z-index: 2147483647; left: -60px; top: -60px; width: 24px; height: 24px;
      pointer-events: none; transition: left .06s linear, top .06s linear;
      filter: drop-shadow(1px 2px 2px rgba(0, 0, 0, .35)); }
    #demo-card { position: fixed; inset: 0; z-index: 2147483646; display: none; flex-direction: column;
      align-items: center; justify-content: center; gap: 12px; padding: 48px; background: #000; color: #fff;
      font-family: "Segoe UI", system-ui, sans-serif; text-align: center; }
    #demo-card.on { display: flex; }
    #demo-card .eyebrow { font-size: 16px; letter-spacing: .16em; text-transform: uppercase; opacity: .8; }
    #demo-card h1 { margin: 0; font-size: 36px; font-weight: 650; line-height: 1.25; }
    #demo-card h2 { margin: 0 0 4px; font-size: 22px; font-weight: 650; }
    #demo-card p { margin: 0; font-size: 19px; line-height: 1.55; max-width: 1040px; }
    #demo-card .rule { width: 120px; height: 2px; margin: 10px 0; background: #fff; }
    #demo-card .cols { display: flex; gap: 80px; text-align: left; }
    #demo-card ul { margin: 0; padding-left: 22px; font-size: 19px; line-height: 1.75; text-align: left; }
    #demo-phone { position: fixed; inset: 0; z-index: 2147483645; display: none; align-items: center;
      justify-content: center; gap: 72px; background: #000; }
    #demo-phone.on { display: flex; }
    #demo-phone .slot { width: 286px; height: 599px; }
    #demo-phone .device { width: 390px; height: 844px; border: 12px solid #2a2a2a; border-radius: 44px;
      overflow: hidden; background: #fff; transform: scale(.69); transform-origin: top left; }
    #demo-phone iframe { width: 390px; height: 844px; border: 0; display: block; }
  `;
  document.head.appendChild(style);
  const cursor = document.createElement('div');
  cursor.id = 'demo-cursor';
  cursor.innerHTML = '<svg viewBox="0 0 24 24" width="24" height="24"><path d="M5 3l14 9-7 1-3 7z" ' +
    'fill="#fff" stroke="#000" stroke-width="1.5" stroke-linejoin="round"/></svg>';
  document.body.appendChild(cursor);
  document.addEventListener('mousemove', (e) => {
    cursor.style.left = `${e.clientX}px`;
    cursor.style.top = `${e.clientY}px`;
  }, true);
  const card = document.createElement('div');
  card.id = 'demo-card';
  document.body.appendChild(card);
  const phone = document.createElement('div');
  phone.id = 'demo-phone';
  document.body.appendChild(phone);
  window.demo = {
    card(html) { card.innerHTML = html || ''; card.classList.toggle('on', Boolean(html)); },
    phone(url) {
      phone.innerHTML = url ? [0, 1].map(() =>
        `<div class="slot"><div class="device"><iframe src="${url}"></iframe></div></div>`).join('') : '';
      phone.classList.toggle('on', Boolean(url));
    },
  };
}
"""

ASS_HEADER = """[Script Info]
ScriptType: v4.00+
PlayResX: 1920
PlayResY: 1080
WrapStyle: 2
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, \
Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, \
MarginV, Encoding
Style: Caption,Segoe UI,38,&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,0,0,2,40,40,38,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
"""


class StopEarly(Exception):
    """Raised by the storyboard in --smoke mode after the first scenes."""


class Demo:
    """Drives the page at a human pace and logs caption timings."""

    def __init__(self, page: Page, fast: bool, smoke: bool):
        self.page, self.fast, self.smoke = page, fast, smoke
        self.captions: list[list] = []  # [start, end, text] in wall-clock seconds

    def wait(self, ms: float) -> None:
        self.page.wait_for_timeout(ms * (0.03 if self.fast else 1))

    def say(self, text: str | None, hold: float = 0) -> None:
        now = time.time()
        if self.captions and self.captions[-1][1] is None:
            self.captions[-1][1] = now
        if text:
            self.captions.append([now, None, text])
        if hold:
            self.wait(hold)

    def card(self, html: str | None) -> None:
        self.page.evaluate("html => demo.card(html)", html)

    def box(self, selector: str) -> dict:
        el = self.page.locator(selector).first
        el.scroll_into_view_if_needed()
        b = el.bounding_box()
        if b is None:
            raise RuntimeError(f"not visible: {selector}")
        return b

    def point(self, selector: str, fx: float = 0.5, fy: float = 0.5, steps: int = 22) -> None:
        b = self.box(selector)
        self.page.mouse.move(b["x"] + b["width"] * fx, b["y"] + b["height"] * fy, steps=steps)
        self.wait(350)

    def click(self, selector: str) -> None:
        self.point(selector)
        self.page.locator(selector).first.click()
        self.wait(700)

    def choose(self, selector: str, value: str) -> None:
        self.point(selector)
        self.page.select_option(selector, value)  # native popups are not captured, so pick directly
        self.page.evaluate("document.activeElement && document.activeElement.blur()")
        self.wait(700)

    def slide(self, selector: str, to: float, ms: float) -> None:
        """Move a range input to `to` in small steps, with the cursor riding on the thumb."""
        el = self.page.locator(selector).first
        lo, hi, start = float(el.get_attribute("min")), float(el.get_attribute("max")), float(el.input_value())
        b = self.box(selector)
        y = b["y"] + b["height"] / 2

        def x_of(v: float) -> float:
            return b["x"] + 8 + (v - lo) / (hi - lo) * (b["width"] - 16)

        self.page.mouse.move(x_of(start), y, steps=14)
        steps = max(3, int(ms / 40))
        for i in range(1, steps + 1):
            v = start + (to - start) * (1 - (1 - i / steps) ** 2)  # ease out
            el.evaluate("(el, v) => { el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); }",
                        f"{v:.2f}")
            self.page.mouse.move(x_of(v), y)
            self.wait(40)
        self.wait(400)

    def scroll(self, top: int) -> None:
        self.page.evaluate("top => window.scrollTo({ top, behavior: 'smooth' })", top)
        self.wait(900)

    def text(self, selector: str) -> str:
        return self.page.locator(selector).first.inner_text()

    def expect(self, selector: str, *parts: str) -> None:
        """A caption may only quote what the app actually shows."""
        shown = self.text(selector)
        missing = [p for p in parts if p not in shown]
        if missing:
            raise AssertionError(f"{selector} shows {shown!r}; the caption needs {missing}")


def tile(n: int) -> str:
    return f"#l-tiles .tile:nth-child({n}) .tile-value"


def row(name: str) -> str:
    return f'#c-table tbody tr:has(th:has-text("{name}"))'


def storyboard(d: Demo, facts: dict) -> None:
    p = d.page
    d.wait(7000)  # title card is already up
    d.card(None)
    d.wait(500)

    # --- Leakage Explorer overview
    d.say("Leakage Explorer: a finite record of a sinusoid, a window, and the resulting spectrum")
    d.point("#leak-form fieldset:nth-of-type(1)", 0.5, 0.3)
    d.wait(1600)
    d.point("#l-tiles", 0.5, 0.5)
    d.wait(1600)
    d.point("#p-spec", 0.5, 0.5)
    d.wait(1200)
    d.say("Controls on the left, live read-outs on top, the spectrum in dB in the centre")
    d.point("#l-n")
    d.point("#l-win")
    d.wait(3200)

    # --- On-bin tone
    d.expect("#l-f1-out", "10.00 bins")
    d.say("The tone sits exactly on DFT bin 10; rectangular window, N = 64 samples")
    d.point("#p-spec", 0.33, 0.22)
    d.wait(3800)
    d.say("The DFT samples (dots) land on the window's nulls: one clean spectral line")
    d.point("#p-spec", 0.6, 0.9)
    d.wait(4600)
    if d.smoke:
        raise StopEarly

    # --- Off-bin tone: leakage and scalloping
    d.say("Now move the tone half a bin off the DFT grid")
    d.slide("#l-f1", 10.5, 4000)
    d.expect("#l-f1-out", "10.50 bins")
    d.say("At 10.5 bins every DFT bin picks up energy: this is spectral leakage")
    d.point("#p-spec", 0.62, 0.45)
    d.wait(4600)
    d.expect(tile(2), "−3.79 dB")
    d.say("The strongest bin now reads −3.79 dB instead of 0 dB: the scalloping loss")
    d.point("#l-tiles .tile:nth-child(2)")
    d.wait(4600)

    # Each caption goes up as its action starts (the previous one must not linger over a new
    # action); the numbers it quotes are checked right after the action completes.

    # --- Windows
    d.say("Hann window: side lobes drop to −31.5 dB, and the main lobe widens to 4 bins")
    d.choose("#l-win", "hann")
    d.expect(tile(3), "4.00 bins")
    d.expect(tile(4), "−31.5 dB")
    d.point("#p-spec", 0.8, 0.55)
    d.wait(4200)
    d.say("Light blue is the rectangular window, kept as a reference")
    d.point("#p-spec", 0.9, 0.3)
    d.wait(3800)
    d.say("Blackman–Harris: side lobes near −92 dB, but a main lobe 8 bins wide")
    d.choose("#l-win", "blackmanHarris")
    d.expect(tile(3), "8.00 bins")
    d.expect(tile(4), "−92.0 dB")
    d.point("#l-tiles .tile:nth-child(4)")
    d.wait(4200)
    d.expect(tile(2), "−0.83 dB")
    d.say("Scalloping falls to 0.83 dB, so the amplitude is read far more accurately")
    d.point("#l-tiles .tile:nth-child(2)")
    d.wait(4600)

    # --- Weak tone masked by leakage
    d.say("Add a weak second tone: 60 dB lower, at 16 bins")
    d.click("#l-t2")
    d.wait(3200)
    d.say("Rectangular window: the weak tone is buried under leakage")
    d.choose("#l-win", "rect")
    d.point("#p-spec", 0.52, 0.3)
    d.wait(4400)
    d.say("Blackman–Harris: its low side lobes reveal the weak tone clearly")
    d.choose("#l-win", "blackmanHarris")
    d.point("#p-spec", 0.52, 0.48)
    d.wait(4600)

    # --- Zero-padding
    d.say("Without zero-padding the plot shows only the 64 DFT samples")
    d.choose("#l-pad", "1")
    d.wait(4200)
    d.say("Zero-padding ×16 interpolates the DTFT: more detail, not more resolution")
    d.choose("#l-pad", "16")
    d.wait(4600)

    # --- Time domain
    d.say("Time domain: the window tapers both ends of the record, x[n]·w[n]")
    d.scroll(420)
    d.point("#p-time", 0.12, 0.55)
    d.wait(2000)
    d.point("#p-time", 0.5, 0.4)
    d.wait(2800)
    d.say(None)
    d.scroll(0)

    # --- Window Comparison
    d.say("Window Comparison: normalised responses, window shapes and measured figures of merit")
    d.click("#tab-cmp")
    d.point("#p-resp", 0.5, 0.45)
    d.wait(2000)
    d.point("#p-shape", 0.5, 0.55)
    d.wait(2800)
    d.say("Narrow main lobe or low side lobes: each window makes a different trade-off")
    d.point("#p-resp", 0.6, 0.55, steps=30)
    d.wait(2200)
    d.point("#p-resp", 0.72, 0.8)
    d.wait(2400)
    d.say("Eight figures of merit per window, measured on the exact DTFT")
    d.scroll(330)
    d.point("#c-table thead", 0.5, 0.5)
    d.wait(4600)
    d.expect(f"{row('Rectangular')} td.best", "2.00")
    d.expect(f"{row('Blackman–Harris')} td.best", "−92.0")
    d.say("Highlighted: narrowest main lobe (rectangular), lowest side lobes (Blackman–Harris)")
    d.point(f"{row('Rectangular')} td:nth-of-type(1)")
    d.wait(2600)
    d.point(f"{row('Blackman–Harris')} td:nth-of-type(4)")
    d.wait(2600)
    d.scroll(0)

    # --- Flat-top
    d.say("Flat-top: only 0.01 dB scalloping, at the cost of a 10-bin main lobe")
    d.click('#c-wins input[value="flattop"]')
    d.expect(f"{row('Flat-top')} td:nth-of-type(1)", "10.00")
    d.expect(f"{row('Flat-top')} td:nth-of-type(7)", "0.01")
    d.scroll(330)
    d.point(f"{row('Flat-top')} td:nth-of-type(7)")
    d.wait(4200)
    d.say(None)
    d.scroll(0)

    # --- Kaiser beta sweep
    d.say("Kaiser window: one parameter, β, trades main-lobe width for side-lobe level")
    d.click('#c-wins input[value="kaiser"]')
    d.wait(3800)
    d.say("Small β: narrow main lobe but high side lobes, close to rectangular")
    d.slide("#c-beta", 2, 3000)
    d.expect(row("Kaiser"), "β = 2.0")
    d.wait(3600)
    d.say("Large β: side lobes below −100 dB, and a much wider main lobe")
    d.slide("#c-beta", 14, 5000)
    psl = float(d.text(f"{row('Kaiser')} td:nth-of-type(4)").replace("−", "-"))
    if psl >= -100:
        raise AssertionError(f"Kaiser β = 14 PSL is {psl} dB; the caption says below −100 dB")
    d.scroll(330)
    d.point(f"{row('Kaiser')} td:nth-of-type(4)")
    d.wait(4200)
    d.say(None)
    d.scroll(0)

    # --- Symmetric definition (left on for the rest of the comparison scenes)
    d.say("Symmetric (filter-design) definition: e.g. Hann ENBW becomes 1.524 bins at N = 64")
    d.click("#c-sym")
    d.expect(f"{row('Hann')} td:nth-of-type(6)", "1.524")
    d.scroll(330)
    d.point(f"{row('Hann')} td:nth-of-type(6)")
    d.wait(4200)
    d.say(None)
    d.scroll(0)

    # --- Full frequency range
    d.say("Full range: Hann and Blackman side lobes decay fast, Hamming's decay slowly")
    d.choose("#c-range", "full")
    d.point("#p-resp", 0.85, 0.6)
    d.wait(5000)

    # --- Phone layout
    d.say(None)
    p.mouse.move(VIEW_W - 10, VIEW_H - 10, steps=10)
    p.evaluate("url => demo.phone(url)", URL)
    phones = [p.frame_locator(f"#demo-phone .slot:nth-child({i}) iframe") for i in (1, 2)]
    for f in phones:
        f.locator("#p-spec canvas").first.wait_for()
    phones[1].locator("#tab-cmp").click()
    d.say("Responsive layout: the same app on phone-sized screens (Android/iOS builds are next)")
    d.wait(2600)
    for f, top in zip(phones, (560, 820)):
        f.locator("html").evaluate("(el, top) => el.ownerDocument.defaultView.scrollTo({ top, behavior: 'smooth' })", top)
    d.wait(3600)
    phones[0].locator("html").evaluate("el => el.ownerDocument.defaultView.scrollTo({ top: 0, behavior: 'smooth' })")
    d.wait(2600)

    # --- Closing cards
    d.say(None)
    d.card(VERIFIED.format(**facts))
    d.wait(8000)
    d.card(STATUS.format(**facts))
    d.wait(10000)


TITLE = """<div class="eyebrow">EE4999 Signal Processing Project · Mid-Term Demo</div>
<h1>SP09 · Windowing Effects and Spectral Leakage Analyzer</h1>
<p>Compare common windows on finite sinusoids and measure main-lobe width and side-lobe levels</p>
<div class="rule"></div>
<p>{author}</p>
<p style="opacity:.75">Silent demo · the captions below describe each step</p>"""

VERIFIED = """<div class="eyebrow">Verification</div>
<h1>The numbers in this demo are checked</h1>
<div class="rule"></div>
<ul>
<li>{passed} of {total} automated tests pass (signal-processing engine and user interface)</li>
<li>Independent SciPy cross-check: widths agree to {width} bins, side lobes to {psl} dB</li>
<li>The check also exposed inaccurate entries in the classic Harris (1978) window table</li>
</ul>"""

STATUS = """<div class="eyebrow">Mid-term status</div>
<div class="rule"></div>
<div class="cols">
<div><h2>Done</h2><ul>
<li>Leakage Explorer and Window Comparison</li>
<li>7 windows, 8 measured figures of merit</li>
<li>Responsive layout for phones</li>
<li>{passed} automated tests and SciPy validation</li>
</ul></div>
<div><h2>Next</h2><ul>
<li>Bartlett, Tukey, Gaussian, Nuttall, Dolph–Chebyshev</li>
<li>Side-lobe roll-off and two-tone resolution analyser</li>
<li>Export, offline PWA, Android and iOS builds</li>
<li>Public live link</li>
</ul></div>
</div>"""


def sci_html(v: float) -> str:
    mantissa, exponent = f"{v:.1e}".split("e")
    return f"{mantissa} × 10<sup>−{abs(int(exponent))}</sup>" if int(exponent) < 0 else f"{v:g}"


def gather_facts() -> dict:
    """Everything the cards state is read from the repository at recording time."""
    tests = subprocess.run("npx vitest run --reporter=json", shell=True, cwd=ROOT, capture_output=True,
                           text=True, encoding="utf-8")
    result = json.loads(tests.stdout[tests.stdout.index("{"):])
    if result["numFailedTests"]:
        sys.exit(f"{result['numFailedTests']} tests fail; fix them before recording")
    diff = json.loads((ROOT / "report" / "data" / "validation.json").read_text(encoding="utf-8"))["maxAbsDiff"]
    author_tex = ROOT / "report" / "author.tex"  # untracked: keeps the roll number out of git
    tex = author_tex.read_text(encoding="utf-8") if author_tex.exists() else ""

    def macro(name: str) -> str:
        m = re.search(r"\\newcommand\{\\" + name + r"\}\{([^}]*)\}", tex)
        return m.group(1) if m else ""

    name, roll = macro("StudentName"), macro("RollNo")
    return {
        "passed": result["numPassedTests"],
        "total": result["numTotalTests"],
        "width": sci_html(max(diff["bw3"], diff["bw6"])),
        "psl": sci_html(diff["psl"]),
        "author": f"{name} ({roll})" if roll else name,
    }


def ass_time(t: float) -> str:
    t = max(0.0, t)
    return f"{int(t // 3600)}:{int(t % 3600 // 60):02d}:{t % 60:05.2f}"


def encode(folder: Path, frames: list[tuple[float, Path]], captions: list[list], end: float, out: Path) -> None:
    """Constant-rate encode: each 1/FPS tick shows the latest captured frame (the screencast only
    sends frames when the page changes). Captions share the same clock, so they stay in sync."""
    t0 = frames[0][0]
    events = [f"Dialogue: 0,{ass_time(s - t0)},{ass_time((e or end) - t0)},Caption,,0,0,0,,{text}"
              for s, e, text in captions]
    (folder / "captions.ass").write_text(ASS_HEADER + "\n".join(events) + "\n", encoding="utf-8")

    out.parent.mkdir(parents=True, exist_ok=True)
    vf = f"scale={W}:{H},pad={W}:{H + BAND}:0:0:black,subtitles=captions.ass,format=yuv420p"
    ffmpeg = subprocess.Popen(
        ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-f", "image2pipe", "-framerate", str(FPS),
         "-c:v", "mjpeg", "-i", "-", "-vf", vf, "-c:v", "libx264", "-preset", "slow", "-crf", "18", "-an",
         "-movflags", "+faststart", str(out)],
        cwd=folder, stdin=subprocess.PIPE)
    j, jpeg = 0, frames[0][1].read_bytes()
    for k in range(int((end - t0) * FPS) + 1):
        t = t0 + k / FPS
        if j + 1 < len(frames) and frames[j + 1][0] <= t:
            while j + 1 < len(frames) and frames[j + 1][0] <= t:
                j += 1
            jpeg = frames[j][1].read_bytes()
        ffmpeg.stdin.write(jpeg)
    ffmpeg.stdin.close()
    if ffmpeg.wait():
        sys.exit(f"ffmpeg failed with exit code {ffmpeg.returncode}")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--rehearse", action="store_true", help="fast run without recording")
    ap.add_argument("--smoke", action="store_true", help="record only the first scenes")
    args = ap.parse_args()
    sys.stdout.reconfigure(encoding="utf-8")
    facts = gather_facts()
    out = OUT.with_name("smoke_test.mp4") if args.smoke else OUT

    with sync_playwright() as pw, tempfile.TemporaryDirectory(prefix="sp09-frames-") as tmp:
        browser = pw.chromium.launch()
        page = browser.new_context(viewport={"width": VIEW_W, "height": VIEW_H},
                                   device_scale_factor=SCALE).new_page()
        errors: list[str] = []
        page.on("pageerror", lambda e: errors.append(str(e)))
        page.goto(URL)
        page.locator("#p-spec canvas").first.wait_for()
        page.evaluate(OVERLAY_JS)
        demo = Demo(page, fast=args.rehearse, smoke=args.smoke)
        demo.card(TITLE.format(**facts))

        frames: list[tuple[float, Path]] = []
        cdp = page.context.new_cdp_session(page)

        def on_frame(params: dict) -> None:
            path = Path(tmp) / f"{len(frames):06d}.jpg"
            path.write_bytes(base64.b64decode(params["data"]))
            # Receipt time, not Chrome's metadata timestamp: it shares the captions' clock, and the
            # first frame's metadata can carry an old paint time that stretched the video by ~5 s.
            frames.append((time.time(), path))
            cdp.send("Page.screencastFrameAck", {"sessionId": params["sessionId"]})

        if not args.rehearse:
            cdp.on("Page.screencastFrame", on_frame)
            cdp.send("Page.startScreencast", {"format": "jpeg", "quality": 92, "maxWidth": W, "maxHeight": H})
        try:
            storyboard(demo, facts)
        except StopEarly:
            pass
        demo.say(None)
        end = time.time()
        if errors:
            sys.exit("Page errors:\n  " + "\n  ".join(errors))
        if args.rehearse:
            print(f"REHEARSAL PASSED: {len(demo.captions)} captions, every quoted number matches the app")
            return
        cdp.send("Page.stopScreencast")
        browser.close()
        print(f"Captured {len(frames)} frames over {end - frames[0][0]:.1f} s; encoding...")
        encode(Path(tmp), frames, demo.captions, end, out)
    print(f"Wrote {out}")


if __name__ == "__main__":
    main()
