import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach } from "vitest";

function resetBrowserState(): void {
  window.history.replaceState(null, "", "#/home");
  document.body.style.overflow = "";
}

beforeEach(resetBrowserState);
afterEach(resetBrowserState);
