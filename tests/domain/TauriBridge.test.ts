import { afterEach, describe, expect, it, vi } from "vitest";

const tauriCoreMocks = vi.hoisted(() => ({
  isTauri: vi.fn<() => boolean>(() => false),
  invoke: vi.fn<(cmd: string, args?: Record<string, unknown>) => Promise<unknown>>(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  isTauri: tauriCoreMocks.isTauri,
  invoke: tauriCoreMocks.invoke,
}));

import {
  appendEvidence,
  clearEvidence,
  exportEvidence,
  importEvidence,
  listEvidence,
  verifyEvidence,
} from "../../src/domain/evidenceJournal";
import { isTauriRuntime } from "../../src/domain/tauriBridge";

afterEach(async () => {
  tauriCoreMocks.isTauri.mockReturnValue(false);
  tauriCoreMocks.invoke.mockReset();
  localStorage.clear();
  await clearEvidence();
});

describe("Tauri IPC evidence bridge", () => {
  it("falls back cleanly to local SHA-256 journal when not running in Tauri", async () => {
    expect(isTauriRuntime()).toBe(false);
    const record = await appendEvidence("preview_created", { mode: "mock", symbol: "AAPL" });
    expect(record.sequence).toBe(1);
    expect(tauriCoreMocks.invoke).not.toHaveBeenCalled();
  });

  it("routes append, list, verify, export, import, and clear through Rust Ed25519 commands in Tauri runtime", async () => {
    tauriCoreMocks.isTauri.mockReturnValue(true);
    expect(isTauriRuntime()).toBe(true);

    const signedRecord = {
      schemaVersion: 1,
      eventId: "FH-EVENT-000001",
      sequence: 1,
      occurredAtUtc: "2026-08-10T16:00:00.000Z",
      appVersion: "0.1.0-mock",
      kind: "preview_created",
      rustKind: "preview_received",
      accountRef: "acct_local_mock",
      intentId: "intent-000001",
      payload: { mode: "mock", symbol: "AAPL" },
      previousHash: "0".repeat(64),
      payloadHash: "a".repeat(64),
      entryHash: "b".repeat(64),
      signerPublicKey: "c".repeat(64),
      signature: "d".repeat(128),
    };

    tauriCoreMocks.invoke.mockImplementation(async (command) => {
      switch (command) {
        case "evidence_append":
          return signedRecord;
        case "evidence_list":
          return [signedRecord];
        case "evidence_verify":
          return {
            valid: true,
            sequence: 1,
            headHash: signedRecord.entryHash,
            signerPublicKey: signedRecord.signerPublicKey,
            reason: null,
          };
        case "evidence_export":
          return JSON.stringify({ format: "foliohelm-signed-evidence", schemaVersion: 1, mode: "mock", records: [signedRecord] });
        case "evidence_import":
          return {
            valid: true,
            sequence: 1,
            headHash: signedRecord.entryHash,
            signerPublicKey: signedRecord.signerPublicKey,
            reason: null,
          };
        case "evidence_clear":
          return true;
        default:
          throw new Error(`Unexpected command: ${command}`);
      }
    });

    const appended = await appendEvidence("preview_created", { mode: "mock", symbol: "AAPL" }, "0.1.0-mock", "2026-08-10T16:00:00Z");
    expect(appended.signature).toBe("d".repeat(128));
    expect(appended.signerPublicKey).toBe("c".repeat(64));
    expect(appended.rustKind).toBe("preview_received");
    expect(tauriCoreMocks.invoke).toHaveBeenCalledWith("evidence_append", {
      request: {
        kind: "preview_created",
        payload: { mode: "mock", symbol: "AAPL" },
        appVersion: "0.1.0-mock",
        occurredAtUtc: "2026-08-10T16:00:00.000Z",
      },
    });

    const listed = await listEvidence();
    expect(listed).toHaveLength(1);
    expect(listed[0]?.signature).toBe("d".repeat(128));

    const verified = await verifyEvidence();
    expect(verified).toEqual({
      valid: true,
      sequence: 1,
      headHash: "b".repeat(64),
      signerPublicKey: "c".repeat(64),
      reason: undefined,
    });

    const exported = await exportEvidence();
    expect(exported).toContain("foliohelm-signed-evidence");

    const imported = await importEvidence(exported);
    expect(imported.valid).toBe(true);
    expect(imported.sequence).toBe(1);

    const cleared = await clearEvidence();
    expect(cleared).toBe(true);
    expect(tauriCoreMocks.invoke).toHaveBeenCalledWith("evidence_clear");
  });

  it("rejects sensitive payloads before invoking Tauri IPC", async () => {
    tauriCoreMocks.isTauri.mockReturnValue(true);
    await expect(appendEvidence("order_intent", { api_key: "secret-123" })).rejects.toThrow(/sensitive/i);
    expect(tauriCoreMocks.invoke).not.toHaveBeenCalled();
  });
});
