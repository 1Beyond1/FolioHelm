import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { App } from "../../src/App";
import { detectInitialLanguage } from "../../src/i18n";
import { MOCK_PORTFOLIO } from "../../src/mocks/portfolio";
import { STORAGE_PREFIX } from "../../src/platform/storage";

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

  it("falls back to the system theme when a stored theme is invalid", () => {
    window.localStorage.setItem(`${STORAGE_PREFIX}theme`, JSON.stringify("neon"));

    render(<App />);

    expect(document.documentElement.dataset.themeMode).toBe("system");
    expect(["dark", "light"]).toContain(document.documentElement.dataset.theme);
  });

  it("keeps document language and browser theme color in sync", () => {
    window.localStorage.setItem(`${STORAGE_PREFIX}theme`, JSON.stringify("light"));
    render(<App />);

    expect(document.documentElement.lang).toBe("en");
    expect(document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')?.content).toBe("#f4f5f0");

    fireEvent.click(screen.getByTestId("language-toggle"));

    expect(document.documentElement.lang).toBe("zh-CN");
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

  it("renders an explicit no-data summary for an empty account", () => {
    render(<App />);

    fireEvent.click(screen.getByRole("button", { name: /Settings|设置/i }));
    fireEvent.change(screen.getByRole("combobox", { name: /Mock scenario|Mock 场景/i }), { target: { value: "empty-account" } });
    fireEvent.click(within(screen.getByRole("navigation", { name: /Primary navigation|主导航/i })).getByRole("button", { name: /Home|首页/i }));
    fireEvent.click(screen.getByTestId("heatmap-mode-return"));

    expect(screen.getByTestId("heatmap-best-day")).toHaveTextContent(/No data|暂无数据/i);
    expect(screen.getByTestId("heatmap-best-day")).not.toHaveTextContent(/Infinity|∞/i);
    expect(within(screen.getByTestId("activity-card")).getByTestId("data-state-no-data")).toBeInTheDocument();
  });

  it("hides and restores the portfolio value without pretending USD or the year are controls", () => {
    const { container } = render(<App />);

    const hideBalance = screen.getByRole("button", { name: /Hide portfolio value|隐藏组合金额/i });
    fireEvent.click(hideBalance);

    expect(screen.getByText("••••••")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Show portfolio value|显示组合金额/i })).toHaveAttribute("aria-pressed", "true");
    expect(screen.queryByRole("button", { name: /^USD$/ })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Show portfolio value|显示组合金额/i }));
    expect(screen.queryByText("••••••")).not.toBeInTheDocument();
    expect(screen.getByText("USD")).toBeInTheDocument();
    expect(container.querySelector(".year-label")).toHaveTextContent("2026");
    expect(container.querySelector(".year-label")?.tagName).toBe("SPAN");
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
