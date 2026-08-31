import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AutomationPage } from "../../src/features/automation";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("automation evidence feedback", () => {
  it("does not claim a run is durable when local evidence persistence fails", async () => {
    render(<AutomationPage language="en" />);
    fireEvent.click(screen.getByRole("switch"));

    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("quota exceeded");
    });
    fireEvent.click(screen.getByRole("button", { name: /Run one local simulation/i }));

    await waitFor(() => expect(screen.getByTestId("automation-evidence-status")).toHaveAttribute("role", "alert"));
    expect(screen.getByTestId("automation-evidence-status")).toHaveTextContent(/visible in memory|could not be saved/i);
    expect(screen.getByTestId("automation-page")).toHaveTextContent(/AUTO-00001/);
  });
});
