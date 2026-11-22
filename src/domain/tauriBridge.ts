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

export interface TauriVaultStatus {
  unlocked: boolean;
  cipher: string;
  schemaVersion: number;
  keyProvider: string;
  signerPublicKey?: string | null;
  evidenceCount: number;
  hasLocalPortfolio: boolean;
  lockedReason?: string | null;
}

export interface TauriStoredPortfolioHolding {
  symbol: string;
  company: string;
  quantity: string;
  averageCost: string;
  lastPrice: string;
  currency: string;
}

export interface TauriStoredPortfolioTransaction {
  date: string;
  action: string;
  symbol: string;
  quantity: string;
  price: string;
  amount: string;
  fees: string;
  currency: string;
}

export interface TauriStoredPortfolioSnapshot {
  id: string;
  fingerprint: string;
  sourceFormat: string;
  sourceLabel: string;
  importedAtUtc: string;
  accountLabel: string;
  currency: string;
  cash: string;
  cashByCurrency?: Record<string, string>;
  currencies?: string[];
  isMultiCurrency?: boolean;
  holdings: TauriStoredPortfolioHolding[];
  transactions: TauriStoredPortfolioTransaction[];
  warnings: string[];
}

export interface TauriCsvColumnMapping {
  canonicalField: string;
  sourceHeader: string;
}

export interface TauriCsvCurrencySubtotal {
  currency: string;
  holdingsValue: string;
  cash: string;
  totalValue: string;
  holdingsCount: number;
}

export interface TauriCsvImportPreview {
  detectedFormat: string;
  formatLabelEn: string;
  formatLabelZh: string;
  columnMappings: TauriCsvColumnMapping[];
  rowCount: number;
  skippedRows: number;
  alreadyImported: boolean;
  warnings: string[];
  currencySubtotals?: TauriCsvCurrencySubtotal[];
  snapshot: TauriStoredPortfolioSnapshot;
}

export interface TauriCsvCommitResult {
  deduplicated: boolean;
  evidenceSequence?: number | null;
  snapshot: TauriStoredPortfolioSnapshot;
}

export interface TauriPublicQuote {
  symbol: string;
  price: string;
  change: string;
  changePct: string;
  currency: string;
  provider: string;
  asOfUtc: string;
  delayed: boolean;
}

export interface TauriPublicQuoteBatchResponse {
  quotes: TauriPublicQuote[];
  fromCache: boolean;
  degradedReason?: string | null;
  provider: string;
}

export interface TauriOpenedTextFile {
  fileName: string;
  content: string;
}

/**
 * Returns true only inside an active Tauri desktop WebView where IPC commands
 * can reach the Rust backend. Browser previews and Vitest return false and
 * cleanly fall back to deterministic browser-local implementations.
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

export function invokeVaultStatus(): Promise<TauriVaultStatus> {
  return invoke<TauriVaultStatus>("vault_status");
}

export function invokeVaultLoadPortfolio(): Promise<TauriStoredPortfolioSnapshot | null> {
  return invoke<TauriStoredPortfolioSnapshot | null>("vault_load_portfolio");
}

export function invokeVaultClearPortfolio(): Promise<boolean> {
  return invoke<boolean>("vault_clear_portfolio");
}

export function invokeVaultClearAll(): Promise<boolean> {
  return invoke<boolean>("vault_clear_all");
}

export function invokeVaultSaveSetting(key: string, valueJson: string): Promise<boolean> {
  return invoke<boolean>("vault_save_setting", { key, valueJson });
}

export function invokeVaultLoadSetting(key: string): Promise<string | null> {
  return invoke<string | null>("vault_load_setting", { key });
}

export function invokeCsvPreviewImport(
  rawCsv: string,
  sourceLabel: string,
): Promise<TauriCsvImportPreview> {
  return invoke<TauriCsvImportPreview>("csv_preview_import", { rawCsv, sourceLabel });
}

export function invokeCsvCommitImport(
  rawCsv: string,
  sourceLabel: string,
): Promise<TauriCsvCommitResult> {
  return invoke<TauriCsvCommitResult>("csv_commit_import", { rawCsv, sourceLabel });
}

export function invokeQuotesFetchPublic(
  symbols: string[],
  provider: "yahoo" | "stooq" = "stooq",
): Promise<TauriPublicQuoteBatchResponse> {
  return invoke<TauriPublicQuoteBatchResponse>("quotes_fetch_public", { symbols, provider });
}

export function invokeQuotesLoadCached(): Promise<TauriPublicQuote[]> {
  return invoke<TauriPublicQuote[]>("quotes_load_cached");
}

export function invokeDialogOpenCsvFile(): Promise<TauriOpenedTextFile | null> {
  return invoke<TauriOpenedTextFile | null>("dialog_open_csv_file");
}

export function invokeDialogSaveJsonFile(
  defaultFileName: string,
  content: string,
): Promise<string | null> {
  return invoke<string | null>("dialog_save_json_file", { defaultFileName, content });
}
