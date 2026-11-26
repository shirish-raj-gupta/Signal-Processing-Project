"""Capture the app screenshots used in the report (2x resolution PNGs in report/figures/).

Needs the built app being served:   npm run build && npx vite preview --port 4173
Then:                               python scripts/screenshots.py [base-url]
"""

import sys
from pathlib import Path

from playwright.sync_api import Page, sync_playwright

FIGURES = Path(__file__).resolve().parents[1] / "report" / "figures"
URL = sys.argv[1] if len(sys.argv) > 1 else "http://localhost:4173/"


def settle(page: Page) -> None:
    page.evaluate("document.activeElement && document.activeElement.blur()")  # no focus ring in figures
    page.wait_for_timeout(350)  # renders are batched per animation frame


def spectrum_plot(page: Page, name: str) -> None:
    page.locator("#p-spec").screenshot(path=FIGURES / name)  # plot and legend, no card header


def leakage_figures(page: Page) -> None:
    page.goto(URL)
    settle(page)
    spectrum_plot(page, "spec_onbin.png")  # rectangular window, tone on bin 10

    page.fill("#l-f1", "10.5")
    settle(page)
    spectrum_plot(page, "spec_halfbin.png")  # same tone moved half a bin

    page.check("#l-t2")  # second tone: 16 bins, -60 dB
    page.select_option("#l-win", "blackmanHarris")
    settle(page)
    spectrum_plot(page, "spec_twotone.png")

    page.uncheck("#l-t2")
    page.select_option("#l-win", "hann")
    settle(page)
    page.screenshot(path=FIGURES / "app_leakage.png")


def comparison_figure(page: Page) -> None:
    page.goto(URL)
    page.click("#tab-cmp")
    page.check("input[value=kaiser]")
    settle(page)
    page.screenshot(path=FIGURES / "app_compare.png", full_page=True)


def main() -> None:
    FIGURES.mkdir(parents=True, exist_ok=True)
    errors: list[str] = []
    with sync_playwright() as p:
        browser = p.chromium.launch()
        desktop = browser.new_page(viewport={"width": 1280, "height": 720}, device_scale_factor=2)
        desktop.on("pageerror", lambda e: errors.append(str(e)))
        leakage_figures(desktop)
        comparison_figure(desktop)

        phone = browser.new_page(viewport={"width": 390, "height": 844}, device_scale_factor=2, is_mobile=True)
        phone.on("pageerror", lambda e: errors.append(str(e)))
        phone.goto(URL)
        phone.fill("#l-f1", "10.5")
        settle(phone)
        phone.evaluate("window.scrollTo(0, 0)")  # fill() scrolled down to the slider
        phone.wait_for_timeout(200)
        phone.screenshot(path=FIGURES / "app_phone.png")
        browser.close()
    if errors:
        sys.exit("Page errors:\n  " + "\n  ".join(errors))
    print(f"Screenshots written to {FIGURES}")


if __name__ == "__main__":
    main()
