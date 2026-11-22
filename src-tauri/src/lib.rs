pub mod csv_import;
pub mod evidence;
pub mod quotes;
pub mod storage;
pub mod vault;

use std::{collections::BTreeMap, fs, path::Path, sync::Mutex};

use csv_import::{parse_and_preview_csv, CsvCommitResultDto, CsvImportPreviewDto, MAX_CSV_BYTES};
use evidence::{
    AppendEvidenceRequest, EvidenceJournal, EvidenceVerificationDto, SignedEvidenceRecordDto,
};
use quotes::{fetch_public_quotes, PublicQuoteBatchResponseDto, PublicQuoteProvider};
use serde::Serialize;
use storage::{
    CachedPublicQuote, EncryptedVaultDb, PortfolioSaveOutcome, StoredPaperOrder,
    StoredPortfolioSnapshot, VaultStatusDto, STORAGE_SCHEMA_VERSION,
};
use tauri::{AppHandle, Manager, State};
use tauri_plugin_dialog::DialogExt;
use vault::{KeyStore, OsKeyringStore};

const MAX_EXPORT_BYTES: usize = 20 * 1024 * 1024;

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
struct OpenedTextFileDto {
    file_name: String,
    content: String,
}

enum VaultSession {
    Unlocked {
        db: Box<EncryptedVaultDb>,
        journal: Box<EvidenceJournal>,
    },
    Locked {
        reason: String,
        key_provider: String,
    },
}

pub struct VaultRuntimeState(Mutex<VaultSession>);

impl VaultRuntimeState {
    pub fn open(db_path: &Path, key_store: &dyn KeyStore, key_provider: impl Into<String>) -> Self {
        let provider = key_provider.into();
        let session = match EncryptedVaultDb::open(db_path, key_store, provider.clone()) {
            Ok(db) => match db.load_evidence_entries() {
                Ok(entries) => match EvidenceJournal::from_persisted(db.signing_key(), entries) {
                    Ok(journal) => VaultSession::Unlocked {
                        db: Box::new(db),
                        journal: Box::new(journal),
                    },
                    Err(error) => VaultSession::Locked {
                        reason: format!(
                            "persisted evidence chain failed verification; vault locked to preserve ciphertext ({error})"
                        ),
                        key_provider: provider,
                    },
                },
                Err(error) => VaultSession::Locked {
                    reason: format!(
                        "encrypted evidence entries failed decryption; vault locked to preserve ciphertext ({error})"
                    ),
                    key_provider: provider,
                },
            },
            Err(error) => VaultSession::Locked {
                reason: error.to_string(),
                key_provider: provider,
            },
        };
        Self(Mutex::new(session))
    }

    pub fn locked(reason: impl Into<String>, key_provider: impl Into<String>) -> Self {
        Self(Mutex::new(VaultSession::Locked {
            reason: reason.into(),
            key_provider: key_provider.into(),
        }))
    }

    fn with_unlocked<T>(
        &self,
        op: impl FnOnce(&mut EncryptedVaultDb, &mut EvidenceJournal) -> Result<T, String>,
    ) -> Result<T, String> {
        let mut guard = self
            .0
            .lock()
            .map_err(|_| "vault state lock is poisoned".to_string())?;
        match &mut *guard {
            VaultSession::Unlocked { db, journal } => op(db, journal),
            VaultSession::Locked { reason, .. } => Err(format!("Vault is locked: {reason}")),
        }
    }

    pub fn status(&self) -> Result<VaultStatusDto, String> {
        let guard = self
            .0
            .lock()
            .map_err(|_| "vault state lock is poisoned".to_string())?;
        match &*guard {
            VaultSession::Unlocked { db, .. } => db.status().map_err(|error| error.to_string()),
            VaultSession::Locked {
                reason,
                key_provider,
            } => Ok(VaultStatusDto {
                unlocked: false,
                cipher: "AES-256-GCM + Ed25519".to_string(),
                schema_version: STORAGE_SCHEMA_VERSION,
                key_provider: key_provider.clone(),
                signer_public_key: None,
                evidence_count: 0,
                has_local_portfolio: false,
                locked_reason: Some(reason.clone()),
            }),
        }
    }
}

#[tauri::command]
fn evidence_append(
    state: State<'_, VaultRuntimeState>,
    request: AppendEvidenceRequest,
) -> Result<SignedEvidenceRecordDto, String> {
    state.with_unlocked(|db, journal| {
        let (signed, dto) = journal
            .prepare_append(request)
            .map_err(|error| error.to_string())?;
        db.insert_evidence_entry(&signed)
            .map_err(|error| error.to_string())?;
        journal.commit_prepared(signed);
        Ok(dto)
    })
}

#[tauri::command]
fn evidence_list(
    state: State<'_, VaultRuntimeState>,
) -> Result<Vec<SignedEvidenceRecordDto>, String> {
    state.with_unlocked(|_, journal| Ok(journal.list()))
}

#[tauri::command]
fn evidence_verify(state: State<'_, VaultRuntimeState>) -> Result<EvidenceVerificationDto, String> {
    state.with_unlocked(|_, journal| Ok(journal.verify()))
}

#[tauri::command]
fn evidence_export(state: State<'_, VaultRuntimeState>) -> Result<String, String> {
    state.with_unlocked(|_, journal| journal.export().map_err(|error| error.to_string()))
}

#[tauri::command]
fn evidence_import(
    state: State<'_, VaultRuntimeState>,
    serialized: String,
) -> Result<EvidenceVerificationDto, String> {
    state.with_unlocked(|db, journal| {
        let (entries, verification) = journal
            .parse_import_bundle(&serialized)
            .map_err(|error| error.to_string())?;
        db.replace_evidence_entries(&entries)
            .map_err(|error| error.to_string())?;
        journal.replace_entries(entries);
        Ok(verification)
    })
}

#[tauri::command]
fn evidence_clear(state: State<'_, VaultRuntimeState>) -> Result<bool, String> {
    state.with_unlocked(|db, journal| {
        db.clear_evidence_entries()
            .map_err(|error| error.to_string())?;
        Ok(journal.clear())
    })
}

#[tauri::command]
fn vault_status(state: State<'_, VaultRuntimeState>) -> Result<VaultStatusDto, String> {
    state.status()
}

#[tauri::command]
fn vault_save_portfolio(
    state: State<'_, VaultRuntimeState>,
    snapshot: StoredPortfolioSnapshot,
) -> Result<PortfolioSaveOutcome, String> {
    state.with_unlocked(|db, _| {
        db.save_portfolio_snapshot(&snapshot)
            .map_err(|error| error.to_string())
    })
}

#[tauri::command]
fn vault_load_portfolio(
    state: State<'_, VaultRuntimeState>,
) -> Result<Option<StoredPortfolioSnapshot>, String> {
    state.with_unlocked(|db, _| {
        db.load_latest_portfolio_snapshot()
            .map_err(|error| error.to_string())
    })
}

#[tauri::command]
fn vault_clear_portfolio(state: State<'_, VaultRuntimeState>) -> Result<bool, String> {
    state.with_unlocked(|db, _| {
        db.clear_portfolio_snapshots()
            .map_err(|error| error.to_string())?;
        Ok(true)
    })
}

#[tauri::command]
fn vault_save_paper_order(
    state: State<'_, VaultRuntimeState>,
    order: StoredPaperOrder,
) -> Result<bool, String> {
    state.with_unlocked(|db, _| {
        db.save_paper_order(&order)
            .map_err(|error| error.to_string())?;
        Ok(true)
    })
}

#[tauri::command]
fn vault_load_paper_orders(
    state: State<'_, VaultRuntimeState>,
    workspace_mode: String,
) -> Result<Vec<StoredPaperOrder>, String> {
    if !matches!(workspace_mode.as_str(), "mock" | "local-csv") {
        return Err("unsupported workspace_mode".to_string());
    }
    state.with_unlocked(|db, _| {
        db.load_paper_orders(&workspace_mode)
            .map_err(|error| error.to_string())
    })
}

#[tauri::command]
fn vault_save_setting(
    state: State<'_, VaultRuntimeState>,
    key: String,
    value_json: String,
) -> Result<bool, String> {
    state.with_unlocked(|db, _| {
        db.save_setting(&key, &value_json)
            .map_err(|error| error.to_string())?;
        Ok(true)
    })
}

#[tauri::command]
fn vault_load_setting(
    state: State<'_, VaultRuntimeState>,
    key: String,
) -> Result<Option<String>, String> {
    state.with_unlocked(|db, _| db.load_setting(&key).map_err(|error| error.to_string()))
}

#[tauri::command]
fn csv_preview_import(
    state: State<'_, VaultRuntimeState>,
    raw_csv: String,
    source_label: String,
) -> Result<CsvImportPreviewDto, String> {
    let mut preview =
        parse_and_preview_csv(&raw_csv, &source_label, false).map_err(|error| error.to_string())?;
    let already_imported = state.with_unlocked(|db, _| {
        db.has_portfolio_fingerprint(&preview.snapshot.fingerprint)
            .map_err(|error| error.to_string())
    })?;
    preview.already_imported = already_imported;
    Ok(preview)
}

#[tauri::command]
fn csv_commit_import(
    state: State<'_, VaultRuntimeState>,
    raw_csv: String,
    source_label: String,
) -> Result<CsvCommitResultDto, String> {
    let preview =
        parse_and_preview_csv(&raw_csv, &source_label, false).map_err(|error| error.to_string())?;
    state.with_unlocked(|db, journal| {
        let outcome = db
            .save_portfolio_snapshot(&preview.snapshot)
            .map_err(|error| error.to_string())?;
        if outcome.deduplicated {
            return Ok(CsvCommitResultDto {
                deduplicated: true,
                evidence_sequence: None,
                snapshot: outcome.snapshot,
            });
        }

        let fp_prefix: String = outcome.snapshot.fingerprint.chars().take(16).collect();
        let (signed, dto) = journal
            .prepare_append(AppendEvidenceRequest {
                kind: "portfolio_import".to_string(),
                payload: BTreeMap::from([
                    ("mode".to_string(), "local-csv".to_string()),
                    (
                        "sourceFormat".to_string(),
                        outcome.snapshot.source_format.clone(),
                    ),
                    (
                        "holdingsCount".to_string(),
                        outcome.snapshot.holdings.len().to_string(),
                    ),
                    (
                        "transactionsCount".to_string(),
                        outcome.snapshot.transactions.len().to_string(),
                    ),
                    ("currency".to_string(), outcome.snapshot.currency.clone()),
                    ("fingerprintPrefix".to_string(), fp_prefix),
                ]),
                app_version: Some(env!("CARGO_PKG_VERSION").to_string()),
                occurred_at_utc: None,
                account_ref: Some("acct_local_csv".to_string()),
                intent_id: Some(outcome.snapshot.id.clone()),
            })
            .map_err(|error| error.to_string())?;
        db.insert_evidence_entry(&signed)
            .map_err(|error| error.to_string())?;
        journal.commit_prepared(signed);

        Ok(CsvCommitResultDto {
            deduplicated: false,
            evidence_sequence: Some(dto.sequence),
            snapshot: outcome.snapshot,
        })
    })
}

#[tauri::command]
async fn quotes_fetch_public(
    state: State<'_, VaultRuntimeState>,
    symbols: Vec<String>,
    provider: Option<String>,
) -> Result<PublicQuoteBatchResponseDto, String> {
    let provider_choice = PublicQuoteProvider::parse(provider.as_deref().unwrap_or("stooq"))
        .map_err(|error| error.to_string())?;
    let valid_symbols =
        quotes::validate_quote_symbols(&symbols).map_err(|error| error.to_string())?;

    match fetch_public_quotes(&valid_symbols, provider_choice).await {
        Ok(fetched) => {
            // Persist fetched quotes to the encrypted cache best-effort; if vault is locked,
            // still return the read-only quote payload without failing the view.
            let _ = state.with_unlocked(|db, _| {
                db.upsert_quote_cache(&fetched)
                    .map_err(|error| error.to_string())
            });
            Ok(PublicQuoteBatchResponseDto {
                quotes: fetched,
                from_cache: false,
                degraded_reason: None,
                provider: provider_choice.code().to_string(),
            })
        }
        Err(fetch_error) => {
            let cached = state
                .with_unlocked(|db, _| db.load_quote_cache().map_err(|error| error.to_string()))
                .unwrap_or_default();
            let filtered: Vec<CachedPublicQuote> = cached
                .into_iter()
                .filter(|item| valid_symbols.contains(&item.symbol))
                .collect();
            Ok(PublicQuoteBatchResponseDto {
                quotes: filtered,
                from_cache: true,
                degraded_reason: Some(fetch_error.to_string()),
                provider: provider_choice.code().to_string(),
            })
        }
    }
}

#[tauri::command]
fn quotes_load_cached(
    state: State<'_, VaultRuntimeState>,
) -> Result<Vec<CachedPublicQuote>, String> {
    state.with_unlocked(|db, _| db.load_quote_cache().map_err(|error| error.to_string()))
}

#[tauri::command]
async fn dialog_open_csv_file(app: AppHandle) -> Result<Option<OpenedTextFileDto>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let picked = app
            .dialog()
            .file()
            .add_filter("Brokerage CSV", &["csv", "txt"])
            .blocking_pick_file();

        let Some(file_path) = picked else {
            return Ok(None);
        };
        let path = file_path
            .into_path()
            .map_err(|_| "selected CSV path is not a local filesystem path".to_string())?;
        let meta = fs::metadata(&path).map_err(|error| error.to_string())?;
        if meta.len() as usize > MAX_CSV_BYTES {
            return Err(format!(
                "Selected CSV exceeds the 5 MB safety limit ({} bytes)",
                meta.len()
            ));
        }
        let content = fs::read_to_string(&path).map_err(|error| error.to_string())?;
        let file_name = path
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("imported.csv")
            .to_string();
        Ok(Some(OpenedTextFileDto { file_name, content }))
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn dialog_save_json_file(
    app: AppHandle,
    default_file_name: String,
    content: String,
) -> Result<Option<String>, String> {
    if content.len() > MAX_EXPORT_BYTES {
        return Err("Export payload exceeds the 20 MB safety limit".to_string());
    }
    let safe_name: String = default_file_name
        .chars()
        .filter(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '.' | '-' | '_'))
        .take(80)
        .collect();
    let final_name = if safe_name.is_empty() {
        "foliohelm-export.json".to_string()
    } else if safe_name.ends_with(".json") {
        safe_name
    } else {
        format!("{safe_name}.json")
    };

    tauri::async_runtime::spawn_blocking(move || {
        let picked = app
            .dialog()
            .file()
            .set_file_name(&final_name)
            .add_filter("JSON files", &["json"])
            .blocking_save_file();

        let Some(file_path) = picked else {
            return Ok(None);
        };
        let path = file_path
            .into_path()
            .map_err(|_| "selected save destination is not a local filesystem path".to_string())?;
        fs::write(&path, content.as_bytes()).map_err(|error| error.to_string())?;
        Ok(Some(path.to_string_lossy().into_owned()))
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
fn vault_clear_all(state: State<'_, VaultRuntimeState>) -> Result<bool, String> {
    state.with_unlocked(|db, journal| {
        db.clear_all_workspace_data()
            .map_err(|error| error.to_string())?;
        journal.clear();
        Ok(true)
    })
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let key_provider = if cfg!(target_os = "windows") {
                "Windows Credential Manager"
            } else if cfg!(target_os = "macos") {
                "macOS Keychain"
            } else {
                "OS Keyring"
            };

            let runtime_state = match app.path().app_data_dir() {
                Ok(dir) => {
                    let db_path = dir.join("foliohelm-vault.sqlite");
                    VaultRuntimeState::open(&db_path, &OsKeyringStore, key_provider)
                }
                Err(error) => VaultRuntimeState::locked(
                    format!("app data directory is unavailable: {error}"),
                    key_provider,
                ),
            };
            app.manage(runtime_state);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            evidence_append,
            evidence_list,
            evidence_verify,
            evidence_export,
            evidence_import,
            evidence_clear,
            vault_status,
            vault_save_portfolio,
            vault_load_portfolio,
            vault_clear_portfolio,
            vault_save_paper_order,
            vault_load_paper_orders,
            vault_save_setting,
            vault_load_setting,
            csv_preview_import,
            csv_commit_import,
            quotes_fetch_public,
            quotes_load_cached,
            dialog_open_csv_file,
            dialog_save_json_file,
            vault_clear_all,
        ])
        .run(tauri::tauri_build_context!())
        .expect("error while running FolioHelm application");
}

#[cfg(test)]
mod tests {
    use std::{collections::BTreeMap, fs, path::PathBuf};

    use super::*;
    use crate::{evidence::encode_hex, vault::InMemoryKeyStore};

    fn temp_vault_path(label: &str) -> PathBuf {
        let mut nonce = [0_u8; 8];
        getrandom::fill(&mut nonce).expect("random");
        std::env::temp_dir()
            .join(format!("foliohelm-lib-test-{label}-{}", encode_hex(&nonce)))
            .join("vault.sqlite")
    }

    #[test]
    fn vault_runtime_state_persists_signed_evidence_and_recovers_after_restart() {
        let db_path = temp_vault_path("restart");
        let key_store = InMemoryKeyStore::new();

        {
            let state = VaultRuntimeState::open(&db_path, &key_store, "in-memory-test");
            assert!(state.status().expect("status").unlocked);
            let record = state
                .with_unlocked(|db, journal| {
                    let (signed, dto) = journal
                        .prepare_append(AppendEvidenceRequest {
                            kind: "safety_setting_changed".into(),
                            payload: BTreeMap::from([
                                ("mode".into(), "mock".into()),
                                ("setting".into(), "maxOrderValue".into()),
                                ("enabled".into(), "false".into()),
                            ]),
                            app_version: Some("0.1.0".into()),
                            occurred_at_utc: Some("2026-08-10T16:00:00Z".into()),
                            account_ref: None,
                            intent_id: None,
                        })
                        .map_err(|error| error.to_string())?;
                    db.insert_evidence_entry(&signed)
                        .map_err(|error| error.to_string())?;
                    journal.commit_prepared(signed);
                    Ok(dto)
                })
                .expect("append succeeds");
            assert_eq!(record.sequence, 1);
        }

        // Reopen and verify the evidence chain and signer key persisted intact.
        {
            let state = VaultRuntimeState::open(&db_path, &key_store, "in-memory-test");
            let status = state.status().expect("status");
            assert!(status.unlocked);
            assert_eq!(status.evidence_count, 1);
            let verified = state
                .with_unlocked(|_, journal| Ok(journal.verify()))
                .expect("verify");
            assert!(verified.valid);
            assert_eq!(verified.sequence, 1);
        }

        // Reopening with a missing keyring locks fail-closed instead of resetting.
        {
            let empty_store = InMemoryKeyStore::new();
            let locked = VaultRuntimeState::open(&db_path, &empty_store, "in-memory-test");
            let status = locked.status().expect("locked status");
            assert!(!status.unlocked);
            assert!(status.locked_reason.is_some());
            assert!(locked.with_unlocked(|_, _| Ok(())).is_err());
        }

        if let Some(parent) = db_path.parent() {
            let _ = fs::remove_dir_all(parent);
        }
    }
}
