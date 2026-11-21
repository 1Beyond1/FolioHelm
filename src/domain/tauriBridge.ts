import { invoke, isTauri } from "@tauri-apps/api/core";

export interface TauriAppendEvidenceRequest {
  kind: string;
  payload: Record<string, string>;
  appVersion?: string;
  occurredAtUtc?: string;
  accountRef?: string;
  intentId?: string;
}

export interface TauriSignedEvidenceRecord {
  schemaVersion: number;
  eventId: string;
  sequence: number;
  occurredAtUtc: string;
  appVersion: string;
  kind: string;
  rustKind: string;
  accountRef: string;
  intentId: string;
  payload: Record<string, string>;
  previousHash: string;
  payloadHash: string;
  entryHash: string;
  signerPublicKey: string;
  signature: string;
}

export interface TauriEvidenceVerification {
  valid: boolean;
  sequence: number;
  headHash: string;
  signerPublicKey?: string | null;
  reason?: string | null;
}

/**
 * Returns true only inside an active Tauri desktop WebView where IPC commands
 * can reach the Rust Ed25519 evidence journal. Browser previews and Vitest
 * return false and transparently use the deterministic local SHA-256 journal.
 */
export function isTauriRuntime(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return isTauri();
  } catch {
    return false;
  }
}

export function invokeEvidenceAppend(
  request: TauriAppendEvidenceRequest,
): Promise<TauriSignedEvidenceRecord> {
  return invoke<TauriSignedEvidenceRecord>("evidence_append", { request });
}

export function invokeEvidenceList(): Promise<TauriSignedEvidenceRecord[]> {
  return invoke<TauriSignedEvidenceRecord[]>("evidence_list");
}

export function invokeEvidenceVerify(): Promise<TauriEvidenceVerification> {
  return invoke<TauriEvidenceVerification>("evidence_verify");
}

export function invokeEvidenceExport(): Promise<string> {
  return invoke<string>("evidence_export");
}

export function invokeEvidenceImport(serialized: string): Promise<TauriEvidenceVerification> {
  return invoke<TauriEvidenceVerification>("evidence_import", { serialized });
}

export function invokeEvidenceClear(): Promise<boolean> {
  return invoke<boolean>("evidence_clear");
}
