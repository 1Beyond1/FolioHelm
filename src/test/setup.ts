import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach, beforeEach } from "vitest";
import { MOCK_BROKER } from "../domain/mockBroker";

function resetBrowserState(): void {
  MOCK_BROKER.reset();
  window.history.replaceState(null, "", "#/home");
  document.body.style.overflow = "";
  document.documentElement.dataset.theme = "";
  document.documentElement.dataset.themeMode = "";
  document.documentElement.scrollTop = 0;
  document.body.scrollTop = 0;
  document.title = "";
  window.localStorage.clear();
}

beforeEach(resetBrowserState);
afterEach(() => {
  cleanup();
  resetBrowserState();
});
