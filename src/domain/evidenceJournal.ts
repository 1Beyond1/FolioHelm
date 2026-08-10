import { readStored, removeStored, writeStored } from "../platform/storage";

const SCHEMA_VERSION = 1;
const GENESIS_HASH = "0".repeat(64);
const STORAGE_KEY = "evidence-journal";

export type LocalEvidenceKind =
  | "order_intent"
  | "user_confirmation"
  | "preview_created"
  | "mock_response"
  | "state_changed"
  | "reconciliation"
  | "automation_run"
  | "safety_setting_changed";

export interface LocalEvidenceRecord {
  schemaVersion: number;
  eventId: string;
  sequence: number;
  occurredAtUtc: string;
  appVersion: string;
  kind: LocalEvidenceKind;
  payload: Record<string, string>;
  previousHash: string;
  entryHash: string;
}

export interface EvidenceVerification {
  valid: boolean;
  sequence: number;
  headHash: string;
  reason?: string;
}

export interface EvidenceExportBundle {
  format: "foliohelm-local-evidence";
  schemaVersion: number;
  mode: "mock";
  exportedAtUtc: string;
  records: LocalEvidenceRecord[];
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, stableValue(nested)]),
    );
  }
  return value;
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(stableValue(value));
}

async function sha256Hex(value: string): Promise<string> {
  if (!globalThis.crypto?.subtle) {
    throw new Error("Web Crypto SHA-256 is unavailable; evidence is locked for safety");
  }
  const bytes = new TextEncoder().encode(value);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function storedRecords(): LocalEvidenceRecord[] {
  const records = readStored<unknown>(STORAGE_KEY, []);
  return Array.isArray(records) ? records as LocalEvidenceRecord[] : [];
}

function rejectSensitiveFields(payload: Record<string, string>): void {
  const forbidden = /(secret|token|authorization|cookie|password|private.?key|app.?key|client.?id)/i;
  for (const [key, value] of Object.entries(payload)) {
    if (forbidden.test(key) || forbidden.test(value)) {
      throw new Error(`Sensitive evidence field rejected: ${key}`);
    }
  }
}

function entryMaterial(record: Omit<LocalEvidenceRecord, "entryHash">): string {
  return canonicalJson({
    schemaVersion: record.schemaVersion,
    eventId: record.eventId,
    sequence: record.sequence,
    occurredAtUtc: record.occurredAtUtc,
    appVersion: record.appVersion,
    kind: record.kind,
    payload: record.payload,
    previousHash: record.previousHash,
  });
}

export async function verifyEvidence(records: readonly LocalEvidenceRecord[] = storedRecords()): Promise<EvidenceVerification> {
  let previousHash = GENESIS_HASH;

  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (!record || record.schemaVersion !== SCHEMA_VERSION) {
      return { valid: false, sequence: index, headHash: previousHash, reason: "Unsupported evidence schema" };
    }
    if (record.sequence !== index + 1) {
      return { valid: false, sequence: index + 1, headHash: previousHash, reason: "Sequence gap or reorder detected" };
    }
    if (record.previousHash !== previousHash) {
      return { valid: false, sequence: record.sequence, headHash: previousHash, reason: "Previous hash mismatch" };
    }
    try {
      rejectSensitiveFields(record.payload);
      const expectedHash = await sha256Hex(entryMaterial(record));
      if (expectedHash !== record.entryHash) {
        return { valid: false, sequence: record.sequence, headHash: previousHash, reason: "Entry hash mismatch" };
      }
    } catch (error) {
      return { valid: false, sequence: record.sequence, headHash: previousHash, reason: error instanceof Error ? error.message : "Evidence verification failed" };
    }
    previousHash = record.entryHash;
  }

  return { valid: true, sequence: records.length, headHash: previousHash };
}

export async function appendEvidence(
  kind: LocalEvidenceKind,
  payload: Record<string, string>,
  appVersion = "0.1.0-mock",
  occurredAtUtc = new Date().toISOString(),
): Promise<LocalEvidenceRecord> {
  rejectSensitiveFields(payload);
  const records = storedRecords();
  const verification = await verifyEvidence(records);
  if (!verification.valid) throw new Error(`Evidence journal is invalid: ${verification.reason ?? "unknown error"}`);

  const sequence = records.length + 1;
  const unsigned: Omit<LocalEvidenceRecord, "entryHash"> = {
    schemaVersion: SCHEMA_VERSION,
    eventId: `FH-EVENT-${String(sequence).padStart(6, "0")}`,
    sequence,
    occurredAtUtc,
    appVersion,
    kind,
    payload: { ...payload },
    previousHash: verification.headHash,
  };
  const record: LocalEvidenceRecord = { ...unsigned, entryHash: await sha256Hex(entryMaterial(unsigned)) };
  writeStored(STORAGE_KEY, [...records, record]);
  return record;
}

export async function exportEvidence(): Promise<string> {
  const records = storedRecords();
  const verification = await verifyEvidence(records);
  if (!verification.valid) throw new Error(`Evidence journal is invalid: ${verification.reason ?? "unknown error"}`);

  const bundle: EvidenceExportBundle = {
    format: "foliohelm-local-evidence",
    schemaVersion: SCHEMA_VERSION,
    mode: "mock",
    exportedAtUtc: new Date().toISOString(),
    records: [...records],
  };
  return JSON.stringify(bundle, null, 2);
}

export async function importEvidence(serialized: string): Promise<EvidenceVerification> {
  const parsed = JSON.parse(serialized) as Partial<EvidenceExportBundle>;
  if (parsed.format !== "foliohelm-local-evidence" || parsed.schemaVersion !== SCHEMA_VERSION || parsed.mode !== "mock" || !Array.isArray(parsed.records)) {
    throw new Error("Unsupported FolioHelm evidence bundle");
  }
  const verification = await verifyEvidence(parsed.records);
  if (!verification.valid) throw new Error(`Imported evidence is invalid: ${verification.reason ?? "unknown error"}`);
  writeStored(STORAGE_KEY, parsed.records);
  return verification;
}

export function clearEvidence(): void {
  removeStored(STORAGE_KEY);
}

export function evidenceCount(): number {
  return storedRecords().length;
}
