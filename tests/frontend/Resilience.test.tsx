import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppErrorBoundary } from "../../src/components/AppErrorBoundary";
import { Modal } from "../../src/components/Modal";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("shared resilience primitives", () => {
  it("traps focus, closes on Escape, and closes from the backdrop", () => {
    const onClose = vi.fn();
    render(
      <Modal
        className="test-dialog"
        backdropClassName="test-backdrop"
        ariaLabel="Test dialog"
        testId="test-dialog"
        onClose={onClose}
      >
        <button type="button">First</button>
        <button type="button">Last</button>
      </Modal>,
    );

    const first = screen.getByRole("button", { name: "First" });
    const last = screen.getByRole("button", { name: "Last" });
    expect(document.activeElement).toBe(first);

    fireEvent.keyDown(last, { key: "Tab" });
    expect(document.activeElement).toBe(first);

    fireEvent.keyDown(first, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(last);

    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);

    fireEvent.mouseDown(screen.getByTestId("test-dialog-backdrop"));
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("renders a recovery screen instead of leaking a component error", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    function BrokenView(): never {
      throw new Error("test render failure");
    }

    render(
      <AppErrorBoundary>
        <BrokenView />
      </AppErrorBoundary>,
    );

    expect(screen.getByTestId("app-error-boundary")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent(/error|错误/i);
    expect(screen.getByRole("button", { name: /Reload app|重新加载应用/i })).toBeInTheDocument();
    expect(errorSpy).toHaveBeenCalled();
  });
});

