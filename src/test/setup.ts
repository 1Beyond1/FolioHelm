import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach, beforeEach } from "vitest";
import { AUTOMATION_CONTROLLER, DEFAULT_AUTOMATION_STATE } from "../domain/automation";
import { MOCK_BROKER } from "../domain/mockBroker";

function resetBrowserState(): void {
  MOCK_BROKER.reset();
  AUTOMATION_CONTROLLER.replaceState(DEFAULT_AUTOMATION_STATE);
  window.history.replaceState(null, "", "#/home");
  document.body.style.overflow = "";
  document.documentElement.dataset.theme = "";
  document.documentElement.dataset.themeMode = "";
  document.documentElement.lang = "en";
  document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')?.setAttribute("content", "#050505");
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
