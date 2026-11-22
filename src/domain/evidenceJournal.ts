import { readStored, removeStored, writeStored } from "../platform/storage";
import {
  invokeEvidenceAppend,
  invokeEvidenceClear,
  invokeEvidenceExport,
  invokeEvidenceImport,
  invokeEvidenceList,
  invokeEvidenceVerify,
  isTauriRuntime,
  type TauriEvidenceVerification,
  type TauriSignedEvidenceRecord,
} from "./tauriBridge";

const SCHEMA_VERSION = 1;
const GENESIS_HASH = "0".repeat(64);
const STORAGE_KEY = "evidence-journal";
export const MAX_EVIDENCE_IMPORT_BYTES = 20 * 1024 * 1024;
const EVIDENCE_KINDS = [
  "order_intent",
  "user_confirmation",
  "preview_created",
  "mock_response",
  "state_changed",
  "reconciliation",
  "automation_run",
  "safety_setting_changed",
  "portfolio_import",
  "session_locked",
] as const;
const HASH_RE = /^[0-9a-f]{64}$/;
const EVIDENCE_RECORD_KEYS = [
  "schemaVersion",
  "eventId",
  "sequence",
  "occurredAtUtc",
  "appVersion",
  "kind",
  "payload",
  "previousHash",
  "entryHash",
] as const;
const EVIDENCE_BUNDLE_KEYS = ["format", "schemaVersion", "mode", "exportedAtUtc", "records"] as const;
const RFC3339_TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

const SENSITIVE_KEY_TOKENS = new Set([
  "secret",
  "token",
  "password",
  "passwd",
  "passphrase",
  "cookie",
  "bearer",
  "credential",
  "credentials",
  "authorization",
]);

const SENSITIVE_KEY_COMPACT_SUBSTRINGS = [
  "secret",
  "token",
  "password",
  "passwd",
  "passphrase",
  "cookie",
  "bearer",
  "credential",
  "apikey",
  "appkey",
  "privatekey",
  "clientid",
  "clientsecret",
  "accountnumber",
  "accounthash",
  "authheader",
  "authcode",
  "oauthcode",
  "sessionid",
] as const;

const SENSITIVE_VALUE_PATTERNS = [
  /-----begin\s+[a-z0-9 ]*private key-----/i,
  /\bbearer\s+[a-z0-9._~+/=-]{6,}/i,
  /\bbasic\s+[a-z0-9+/=]{12,}/i,
  /\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\b/,
  /\b(?:api[_-]?key|app[_-]?key|client[_-]?secret|access[_-]?token|refresh[_-]?token|private[_-]?key|account[_-]?number|account[_-]?hash|authorization|credential|passphrase|password|passwd|secret|cookie|token)\s*[:=]\s*\S+/i,
  /\b(?:sk-[A-Za-z0-9]{17,}|ghp_[A-Za-z0-9]{20,}|AIza[0-9A-Za-z_-]{20,})\b/,
] as const;

export type LocalEvidenceKind =
  | "order_intent"
  | "user_confirmation"
  | "preview_created"
  | "mock_response"
  | "state_changed"
  | "reconciliation"
  | "automation_run"
  | "safety_setting_changed"
  | "portfolio_import"
  | "session_locked";

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
  payloadHash?: string;
  signerPublicKey?: string;
  signature?: string;
  rustKind?: string;
}

export interface EvidenceVerification {
  valid: boolean;
  sequence: number;
  headHash: string;
  signerPublicKey?: string;
  reason?: string;
}

export interface EvidenceExportBundle {
  format: "foliohelm-local-evidence";
  schemaVersion: number;
  mode: "mock";
  exportedAtUtc: string;
  records: LocalEvidenceRecord[];
}

let appendQueue: Promise<void> = Promise.resolve();

function enqueueJournalOperation<T>(operation: () => Promise<T>): Promise<T> {
  const next = appendQueue.then(operation);
  appendQueue = next.then(() => undefined, () => undefined);
  return next;
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => compareCodeUnits(left, right))
        .map(([key, nested]) => [key, stableValue(nested)]),
    );
  }
  return value;
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(stableValue(value));
}

function normalizeUtcTimestamp(value: unknown): string | undefined {
  if (typeof value !== "string" || !RFC3339_TIMESTAMP_RE.test(value)) return undefined;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return undefined;

  try {
    return new Date(parsed).toISOString();
  } catch {
    return undefined;
  }
}

function isCanonicalUtcTimestamp(value: unknown): value is string {
  return normalizeUtcTimestamp(value) === value;
}

function hasExactKeys(value: object, expectedKeys: readonly string[]): boolean {
  const actualKeys = Object.keys(value);
  return actualKeys.length === expectedKeys.length
    && expectedKeys.every((key) => Object.prototype.hasOwnProperty.call(value, key));
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

function isEvidenceKind(value: unknown): value is LocalEvidenceKind {
  return typeof value === "string" && EVIDENCE_KINDS.includes(value as LocalEvidenceKind);
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return value !== null
    && typeof value === "object"
    && !Array.isArray(value)
    && Object.values(value as Record<string, unknown>).every((item) => typeof item === "string");
}

function isSensitiveKey(key: string): boolean {
  const lower = key.toLowerCase();
  const tokens = lower.split(/[^a-z0-9]+/).filter(Boolean);
  if (tokens.some((token) => SENSITIVE_KEY_TOKENS.has(token))) return true;

  const compact = lower.replace(/[^a-z0-9]+/g, "");
  return SENSITIVE_KEY_COMPACT_SUBSTRINGS.some((pattern) => compact.includes(pattern));
}

function containsSensitiveValue(value: string): boolean {
  return SENSITIVE_VALUE_PATTERNS.some((pattern) => pattern.test(value));
}

function rejectSensitiveFields(payload: Record<string, string>): void {
  if (!isStringRecord(payload)) throw new Error("Evidence payload must be a flat string map");
  for (const [key, value] of Object.entries(payload)) {
    if (isSensitiveKey(key) || containsSensitiveValue(value)) {
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

function fromTauriRecord(record: TauriSignedEvidenceRecord): LocalEvidenceRecord {
  const kind: LocalEvidenceKind = isEvidenceKind(record.kind) ? record.kind : "state_changed";
  return {
    schemaVersion: record.schemaVersion,
    eventId: record.eventId,
    sequence: record.sequence,
    occurredAtUtc: record.occurredAtUtc,
    appVersion: record.appVersion,
    kind,
    payload: { ...record.payload },
    previousHash: record.previousHash,
    entryHash: record.entryHash,
    payloadHash: record.payloadHash,
    signerPublicKey: record.signerPublicKey,
    signature: record.signature,
    rustKind: record.rustKind,
  };
}

function fromTauriVerification(result: TauriEvidenceVerification): EvidenceVerification {
  return {
    valid: result.valid,
    sequence: result.sequence,
    headHash: result.headHash,
    signerPublicKey: result.signerPublicKey ?? undefined,
    reason: result.reason ?? undefined,
  };
}

async function verifyEvidenceNow(records: readonly LocalEvidenceRecord[]): Promise<EvidenceVerification> {
  let previousHash = GENESIS_HASH;

  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (
      !record
      || typeof record !== "object"
      || Array.isArray(record)
      || !hasExactKeys(record, EVIDENCE_RECORD_KEYS)
      || record.schemaVersion !== SCHEMA_VERSION
    ) {
      return { valid: false, sequence: index, headHash: previousHash, reason: "Unsupported evidence schema" };
    }
    if (
      typeof record.eventId !== "string"
      || record.eventId.trim() === ""
      || typeof record.occurredAtUtc !== "string"
      || !isCanonicalUtcTimestamp(record.occurredAtUtc)
      || typeof record.appVersion !== "string"
      || record.appVersion.trim() === ""
      || !isEvidenceKind(record.kind)
      || !isStringRecord(record.payload)
      || !HASH_RE.test(record.previousHash)
      || !HASH_RE.test(record.entryHash)
    ) {
      return { valid: false, sequence: index + 1, headHash: previousHash, reason: "Invalid evidence record shape" };
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

/** Serialize verification with writes so a caller never verifies a half-written chain. */
export function verifyEvidence(records?: readonly LocalEvidenceRecord[]): Promise<EvidenceVerification> {
  return enqueueJournalOperation(async () => {
    if (records === undefined && isTauriRuntime()) {
      return fromTauriVerification(await invokeEvidenceVerify());
    }
    return verifyEvidenceNow(records ?? storedRecords());
  });
}

export function listEvidence(): Promise<LocalEvidenceRecord[]> {
  return enqueueJournalOperation(async () => {
    if (isTauriRuntime()) {
      const records = await invokeEvidenceList();
      return records.map(fromTauriRecord);
    }
    return storedRecords();
  });
}

async function appendEvidenceNow(
  kind: LocalEvidenceKind,
  payload: Record<string, string>,
  appVersion = "0.1.0-mock",
  occurredAtUtc = new Date().toISOString(),
): Promise<LocalEvidenceRecord> {
  rejectSensitiveFields(payload);
  if (!isEvidenceKind(kind)) throw new Error("Unsupported evidence kind");
  if (typeof appVersion !== "string" || appVersion.trim() === "") throw new Error("Evidence app version is required");
  const normalizedOccurredAt = normalizeUtcTimestamp(occurredAtUtc);
  if (!normalizedOccurredAt) throw new Error("Evidence timestamp must be canonical UTC");

  if (isTauriRuntime()) {
    const signed = await invokeEvidenceAppend({
      kind,
      payload: { ...payload },
      appVersion,
      occurredAtUtc: normalizedOccurredAt,
    });
    return fromTauriRecord(signed);
  }

  const records = storedRecords();
  const verification = await verifyEvidenceNow(records);
  if (!verification.valid) throw new Error(`Evidence journal is invalid: ${verification.reason ?? "unknown error"}`);

  const sequence = records.length + 1;
  const unsigned: Omit<LocalEvidenceRecord, "entryHash"> = {
    schemaVersion: SCHEMA_VERSION,
    eventId: `FH-EVENT-${String(sequence).padStart(6, "0")}`,
    sequence,
    occurredAtUtc: normalizedOccurredAt,
    appVersion,
    kind,
    payload: { ...payload },
    previousHash: verification.headHash,
  };
  const record: LocalEvidenceRecord = { ...unsigned, entryHash: await sha256Hex(entryMaterial(unsigned)) };
  if (!writeStored(STORAGE_KEY, [...records, record])) {
    throw new Error("Evidence journal could not be persisted; operation aborted");
  }
  return record;
}

/** Serialize appends in this process so concurrent UI actions cannot fork the chain. */
export function appendEvidence(
  kind: LocalEvidenceKind,
  payload: Record<string, string>,
  appVersion = "0.1.0-mock",
  occurredAtUtc = new Date().toISOString(),
): Promise<LocalEvidenceRecord> {
  return enqueueJournalOperation(() => appendEvidenceNow(kind, payload, appVersion, occurredAtUtc));
}

async function exportEvidenceNow(): Promise<string> {
  if (isTauriRuntime()) {
    return invokeEvidenceExport();
  }

  const records = storedRecords();
  const verification = await verifyEvidenceNow(records);
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

/** Wait for pending appends before taking an evidence snapshot for export. */
export function exportEvidence(): Promise<string> {
  return enqueueJournalOperation(exportEvidenceNow);
}

async function importEvidenceNow(serialized: string): Promise<EvidenceVerification> {
  const byteSize = new TextEncoder().encode(serialized).byteLength;
  if (byteSize > MAX_EVIDENCE_IMPORT_BYTES) {
    throw new Error("Evidence import file exceeds the 20 MB safety limit");
  }
  if (isTauriRuntime()) {
    return fromTauriVerification(await invokeEvidenceImport(serialized));
  }

  const parsed = JSON.parse(serialized) as Partial<EvidenceExportBundle>;
  if (
    !parsed
    || typeof parsed !== "object"
    || Array.isArray(parsed)
    || !hasExactKeys(parsed, EVIDENCE_BUNDLE_KEYS)
    || parsed.format !== "foliohelm-local-evidence"
    || parsed.schemaVersion !== SCHEMA_VERSION
    || (parsed.mode !== "mock" && parsed.mode !== "local-csv")
    || !isCanonicalUtcTimestamp(parsed.exportedAtUtc)
    || !Array.isArray(parsed.records)
  ) {
    throw new Error("Unsupported FolioHelm evidence bundle");
  }
  const verification = await verifyEvidenceNow(parsed.records);
  if (!verification.valid) throw new Error(`Imported evidence is invalid: ${verification.reason ?? "unknown error"}`);
  if (!writeStored(STORAGE_KEY, parsed.records)) {
    throw new Error("Evidence journal could not be persisted; import aborted");
  }
  return verification;
}

/** Serialize imports with appends so an imported chain cannot be overwritten by a queued append. */
export function importEvidence(serialized: string): Promise<EvidenceVerification> {
  return enqueueJournalOperation(() => importEvidenceNow(serialized));
}

/**
 * Clear only after earlier journal work settles, preventing a queued append
 * from resurrecting data. An optional synchronized cleanup hook runs inside
 * the same barrier so local preferences and the journal clear atomically.
 */
export function clearEvidence(afterEvidenceCleared?: () => boolean): Promise<boolean> {
  return enqueueJournalOperation(async () => {
    const tauriCleared = isTauriRuntime() ? await invokeEvidenceClear() : true;
    const localCleared = removeStored(STORAGE_KEY);
    const extraCleared = afterEvidenceCleared ? afterEvidenceCleared() : true;
    return tauriCleared && localCleared && extraCleared;
  });
}

export function evidenceCount(): number {
  return storedRecords().length;
}
