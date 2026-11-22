import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const tauriMocks = vi.hoisted(() => ({
  isTauri: vi.fn<() => boolean>(() => false),
  invoke: vi.fn<(cmd: string, args?: Record<string, unknown>) => Promise<unknown>>(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  isTauri: tauriMocks.isTauri,
  invoke: tauriMocks.invoke,
}));

import { MOCK_BROKER } from "../../src/domain/mockBroker";
import { refreshPublicQuotes, saveJsonWithDialogOrBlob } from "../../src/domain/publicQuotes";
import { clearEvidence } from "../../src/domain/evidenceJournal";
import { SettingsPage } from "../../src/features/settings/SettingsPage";

afterEach(async () => {
  cleanup();
  tauriMocks.isTauri.mockReturnValue(false);
  tauriMocks.invoke.mockReset();
  MOCK_BROKER.reset();
  await clearEvidence();
});

describe("Public read-only delayed quotes & Tauri native file dialogs", () => {
  it("keeps public quotes disabled by default and blocks refresh until explicitly opted in", async () => {
    expect(MOCK_BROKER.isPublicQuotesEnabled()).toBe(false);
    await expect(refreshPublicQuotes("stooq")).rejects.toThrow(/disabled/i);
    expect(tauriMocks.invoke).not.toHaveBeenCalled();
  });

  it("fetches delayed public quotes via Rust allowlisted backend in Tauri and handles offline cache fallback gracefully", async () => {
    tauriMocks.isTauri.mockReturnValue(true);
    MOCK_BROKER.setPublicQuotesEnabled(true);

    tauriMocks.invoke.mockResolvedValueOnce({
      quotes: [
        {
          symbol: "AAPL",
          price: "231.4500",
          change: "4.1000",
          changePct: "1.80",
          currency: "USD",
          provider: "stooq.com",
          asOfUtc: "2026-11-22T02:30:00.000Z",
          delayed: true,
        },
      ],
      fromCache: false,
      degradedReason: null,
      provider: "stooq.com",
    });

    const result = await refreshPublicQuotes("stooq");
    expect(result.updatedCount).toBe(1);
    expect(result.fromCache).toBe(false);
    expect(tauriMocks.invoke).toHaveBeenCalledWith(
      "quotes_fetch_public",
      expect.objectContaining({ provider: "stooq" }),
    );

    const aapl = MOCK_BROKER.getSnapshot().quotes.find((q) => q.symbol === "AAPL");
    expect(aapl?.price).toBe("231.45");
    expect(aapl?.source).toBe("public-delayed");
    expect(aapl?.delayed).toBe(true);

    // Offline / degraded fallback returns cached data without throwing.
    tauriMocks.invoke.mockResolvedValueOnce({
      quotes: [],
      fromCache: true,
      degradedReason: "network timeout",
      provider: "stooq.com",
    });
    const degraded = await refreshPublicQuotes("stooq");
    expect(degraded.fromCache).toBe(true);
    expect(degraded.degradedReason).toContain("timeout");
  });

  it("uses native Tauri save dialog on desktop and falls back to Blob download in browsers", async () => {
    tauriMocks.isTauri.mockReturnValue(true);
    tauriMocks.invoke.mockResolvedValueOnce("C:\\Users\\demo\\Documents\\foliohelm-evidence.json");

    const nativeResult = await saveJsonWithDialogOrBlob("foliohelm-evidence.json", "{}");
    expect(nativeResult).toEqual({
      kind: "native-saved",
      path: "C:\\Users\\demo\\Documents\\foliohelm-evidence.json",
    });
    expect(tauriMocks.invoke).toHaveBeenCalledWith("dialog_save_json_file", {
      defaultFileName: "foliohelm-evidence.json",
      content: "{}",
    });
  });

  it("renders read-only delayed quote disclaimer in SettingsPage and triggers native export path feedback", async () => {
    tauriMocks.isTauri.mockReturnValue(true);
    tauriMocks.invoke.mockImplementation(async (command) => {
      switch (command) {
        case "vault_status":
          return {
            unlocked: true,
            cipher: "AES-256-GCM + Ed25519",
            schemaVersion: 1,
            keyProvider: "Windows Credential Manager",
            signerPublicKey: "a".repeat(64),
            evidenceCount: 2,
            hasLocalPortfolio: false,
            lockedReason: null,
          };
        case "evidence_export":
          return JSON.stringify({ format: "foliohelm-signed-evidence", schemaVersion: 1, mode: "mock", records: [] });
        case "evidence_verify":
          return { valid: true, sequence: 0, headHash: "0".repeat(64), signerPublicKey: null, reason: null };
        case "dialog_save_json_file":
          return "D:\\Exports\\foliohelm-evidence-mock.json";
        case "evidence_append":
          return {
            schemaVersion: 1,
            eventId: "FH-EVENT-000001",
            sequence: 1,
            occurredAtUtc: "2026-11-22T02:30:00.000Z",
            appVersion: "0.1.0",
            kind: "safety_setting_changed",
            rustKind: "safety_setting_changed",
            accountRef: "acct_local_mock",
            intentId: "intent-000001",
            payload: {},
            previousHash: "0".repeat(64),
            payloadHash: "1".repeat(64),
            entryHash: "2".repeat(64),
            signerPublicKey: "a".repeat(64),
            signature: "b".repeat(128),
          };
        default:
          return null;
      }
    });

    render(<SettingsPage language="zh" onLanguageChange={() => undefined} />);

    await waitFor(() => expect(screen.getByTestId("vault-status-row")).toHaveTextContent("AES-256-GCM + Ed25519"));
    expect(screen.getByTestId("public-quotes-panel")).toHaveTextContent("延迟只读公开行情 · 不可用于真实下单");
    expect(screen.getByTestId("refresh-public-quotes")).toBeDisabled();

    fireEvent.click(screen.getByTestId("public-quotes-switch"));
    expect(screen.getByTestId("refresh-public-quotes")).toBeEnabled();

    fireEvent.click(screen.getByRole("button", { name: "导出" }));
    await waitFor(() =>
      expect(screen.getByTestId("export-path-note")).toHaveTextContent("D:\\Exports\\foliohelm-evidence-mock.json"),
    );
  });
});
