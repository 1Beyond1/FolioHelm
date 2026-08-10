import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { App } from "../../src/App";
import { detectInitialLanguage } from "../../src/i18n";
import { MOCK_PORTFOLIO } from "../../src/mocks/portfolio";

afterEach(() => {
  document.body.innerHTML = "";
});

describe("FolioHelm demo home", () => {
  it("shows an explicit fictional-data and no-brokerage-connection state", () => {
    render(<App />);

    expect(screen.getByTestId("demo-status")).toHaveTextContent("Demo data · No brokerage connection");
    expect(screen.getByText("FolioHelm demo · Fictional data only · Apache-2.0")).toBeInTheDocument();
  });

  it("falls back to English for an unknown system language", () => {
    expect(detectInitialLanguage(["fr-FR", "de-DE"])).toBe("en");
    expect(detectInitialLanguage(["zh-CN", "en-US"])).toBe("zh");
  });

  it("switches the heatmap from activity to daily return and then USD", () => {
    const { container } = render(<App />);

    fireEvent.click(screen.getByTestId("heatmap-mode-return"));

    expect(screen.getByTestId("heatmap-mode-return")).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByTestId("heatmap-unit-control")).toBeInTheDocument();

    const percentLevels = Array.from(
      container.querySelectorAll(".heatmap-frame.return-mode .heat-cell"),
      (cell) => cell.getAttribute("data-level"),
    );

    fireEvent.click(screen.getByTestId("heatmap-unit-usd"));

    expect(screen.getByTestId("heatmap-unit-usd")).toHaveAttribute("aria-pressed", "true");
    const usdLevels = Array.from(
      container.querySelectorAll(".heatmap-frame.return-mode .heat-cell"),
      (cell) => cell.getAttribute("data-level"),
    );
    expect(usdLevels).toEqual(percentLevels);

    const firstCell = screen.getByRole("button", { name: /Jan 1, 2026/ });
    fireEvent.mouseEnter(firstCell);
    expect(screen.getByRole("status")).toHaveTextContent(/[+-]/);
  });

  it("inspects the home chart and adjusts its time span with the wheel", () => {
    render(<App />);

    fireEvent.pointerMove(screen.getByTestId("portfolio-chart-hit-area"), { clientX: 320 });
    expect(screen.getByTestId("portfolio-chart-tooltip")).toHaveTextContent("$");

    const wrap = screen.getByTestId("portfolio-chart-wrap");
    const initialPath = screen.getByTestId("portfolio-chart-line").getAttribute("d");
    fireEvent.wheel(wrap, { deltaY: 240 });

    expect(Number(wrap.getAttribute("data-chart-zoom"))).toBeGreaterThan(2);
    expect(screen.getByTestId("portfolio-chart-line").getAttribute("d")).not.toBe(initialPath);
  });

  it("contains exactly the real 2026 dates and ends on December 31", () => {
    expect(MOCK_PORTFOLIO.heatmap).toHaveLength(365);
    expect(MOCK_PORTFOLIO.heatmap[0]?.date).toBe("2026-01-01");
    expect(MOCK_PORTFOLIO.heatmap.at(-1)?.date).toBe("2026-12-31");
    expect(MOCK_PORTFOLIO.heatmap.some((entry) => entry.date.startsWith("2027-"))).toBe(false);
  });
});
