pub mod csv_import;
pub mod evidence;
pub mod quotes;
pub mod storage;
pub mod vault;

use std::{
    collections::BTreeMap,
    fs,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

use chrono::{SecondsFormat, Utc};
use csv_import::{parse_and_preview_csv, CsvCommitResultDto, CsvImportPreviewDto, MAX_CSV_BYTES};
use evidence::{
    AppendEvidenceRequest, EvidenceJournal, EvidenceVerificationDto, SignedEvidenceRecordDto,
};
use quotes::{fetch_public_quotes, PublicQuoteBatchResponseDto, PublicQuoteProvider};
use serde::Serialize;
use storage::{
    CachedPublicQuote, EncryptedVaultDb, PortfolioSaveOutcome, StoredPaperOrder,
    StoredPortfolioSnapshot, VaultBackupPayload, VaultRestoreSummaryDto, VaultStatusDto,
    STORAGE_SCHEMA_VERSION,
};
use tauri::{AppHandle, Manager, State};
use tauri_plugin_dialog::DialogExt;
use vault::{
    decrypt_fhvault_backup, encrypt_fhvault_backup, verify_app_lock_passphrase, AppLockVerifier,
    KeyStore, OsKeyringStore, MAX_FHVAULT_BYTES,
};
use zeroize::Zeroizing;

pub const MAX_EXPORT_BYTES: usize = 20 * 1024 * 1024;
const MAX_BACKOFF_SECS: u64 = 300;

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
        lock_verifier: Option<AppLockVerifier>,
    },
    UserLocked {
        reason: String,
        lock_verifier: Option<AppLockVerifier>,
        failed_attempts: u32,
        locked_until: Option<Instant>,
    },
    ErrorLocked {
        reason: String,
    },
}

pub struct VaultRuntimeState {
    db_path: PathBuf,
    key_store: Arc<dyn KeyStore>,
    key_provider: String,
    session: Mutex<VaultSession>,
}

fn compute_backoff_seconds(failed_attempts: u32) -> u64 {
    let shift = failed_attempts.saturating_sub(1).min(8);
    1_u64
        .checked_shl(shift)
        .unwrap_or(256)
        .min(MAX_BACKOFF_SECS)
}

fn remaining_backoff_seconds(locked_until: Option<Instant>) -> u64 {
    let Some(until) = locked_until else {
        return 0;
    };
    let now = Instant::now();
    if now >= until {
        0
    } else {
        until.saturating_duration_since(now).as_secs().max(1)
    }
}

impl VaultRuntimeState {
    pub fn open_with_store(
        db_path: &Path,
        key_store: Arc<dyn KeyStore>,
        key_provider: impl Into<String>,
    ) -> Self {
        let provider = key_provider.into();
        let session = Self::open_session(db_path, key_store.as_ref(), &provider);
        Self {
            db_path: db_path.to_path_buf(),
            key_store,
            key_provider: provider,
            session: Mutex::new(session),
        }
    }

    pub fn open(db_path: &Path, key_store: &dyn KeyStore, key_provider: impl Into<String>) -> Self {
        let provider = key_provider.into();
        let session = Self::open_session(db_path, key_store, &provider);
        Self {
            db_path: db_path.to_path_buf(),
            key_store: Arc::new(OsKeyringStore),
            key_provider: provider,
            session: Mutex::new(session),
        }
    }

    pub fn locked(reason: impl Into<String>, key_provider: impl Into<String>) -> Self {
        Self {
            db_path: PathBuf::new(),
            key_store: Arc::new(OsKeyringStore),
            key_provider: key_provider.into(),
            session: Mutex::new(VaultSession::ErrorLocked {
                reason: reason.into(),
            }),
        }
    }

    fn open_session(db_path: &Path, key_store: &dyn KeyStore, key_provider: &str) -> VaultSession {
        match EncryptedVaultDb::open(db_path, key_store, key_provider.to_string()) {
            Ok(db) => {
                let lock_verifier = match db.load_app_lock_verifier() {
                    Ok(verifier) => verifier,
                    Err(error) => {
                        return VaultSession::ErrorLocked {
                            reason: format!(
                                "app lock verifier failed to load; vault locked to preserve ciphertext ({error})"
                            ),
                        };
                    }
                };
                match db.load_evidence_entries() {
                    Ok(entries) => match EvidenceJournal::from_persisted(db.signing_key(), entries)
                    {
                        Ok(journal) => VaultSession::Unlocked {
                            db: Box::new(db),
                            journal: Box::new(journal),
                            lock_verifier,
                        },
                        Err(error) => VaultSession::ErrorLocked {
                            reason: format!(
                                "persisted evidence chain failed verification; vault locked to preserve ciphertext ({error})"
                            ),
                        },
                    },
                    Err(error) => VaultSession::ErrorLocked {
                        reason: format!(
                            "encrypted evidence entries failed decryption; vault locked to preserve ciphertext ({error})"
                        ),
                    },
                }
            }
            Err(error) => VaultSession::ErrorLocked {
                reason: error.to_string(),
            },
        }
    }

    fn with_unlocked<T>(
        &self,
        op: impl FnOnce(&mut EncryptedVaultDb, &mut EvidenceJournal) -> Result<T, String>,
    ) -> Result<T, String> {
        let mut guard = self
            .session
            .lock()
            .map_err(|_| "vault state lock is poisoned".to_string())?;
        match &mut *guard {
            VaultSession::Unlocked { db, journal, .. } => op(db, journal),
            VaultSession::UserLocked { reason, .. } | VaultSession::ErrorLocked { reason } => {
                Err(format!("Vault is locked: {reason}"))
            }
        }
    }

    pub fn status(&self) -> Result<VaultStatusDto, String> {
        let guard = self
            .session
            .lock()
            .map_err(|_| "vault state lock is poisoned".to_string())?;
        match &*guard {
            VaultSession::Unlocked { db, .. } => db.status().map_err(|error| error.to_string()),
            VaultSession::UserLocked {
                reason,
                lock_verifier,
                locked_until,
                ..
            } => Ok(VaultStatusDto {
                unlocked: false,
                lock_state: "user-locked".to_string(),
                has_lock_passphrase: lock_verifier.is_some(),
                retry_after_seconds: remaining_backoff_seconds(*locked_until),
                cipher: "AES-256-GCM + Ed25519".to_string(),
                schema_version: STORAGE_SCHEMA_VERSION,
                key_provider: self.key_provider.clone(),
                signer_public_key: None,
                evidence_count: 0,
                has_local_portfolio: false,
                locked_reason: Some(reason.clone()),
            }),
            VaultSession::ErrorLocked { reason } => Ok(VaultStatusDto {
                unlocked: false,
                lock_state: "error-locked".to_string(),
                has_lock_passphrase: false,
                retry_after_seconds: 0,
                cipher: "AES-256-GCM + Ed25519".to_string(),
                schema_version: STORAGE_SCHEMA_VERSION,
                key_provider: self.key_provider.clone(),
                signer_public_key: None,
                evidence_count: 0,
                has_local_portfolio: false,
                locked_reason: Some(reason.clone()),
            }),
        }
    }

    /// Lock the active session: writes an Ed25519-signed `EvidenceKind::SessionLocked`
    /// record first, then drops `EncryptedVaultDb` and `EvidenceJournal` so all
    /// in-memory `Zeroizing` session keys are immediately wiped.
    pub fn lock_session(
        &self,
        trigger: &str,
        workspace_mode: Option<&str>,
    ) -> Result<VaultStatusDto, String> {
        let normalized_trigger = match trigger.trim().to_ascii_lowercase().as_str() {
            "idle" => "idle",
            _ => "manual",
        };
        let normalized_mode = match workspace_mode.unwrap_or("mock") {
            "local-csv" => "local-csv",
            _ => "mock",
        };
        let locked_at_utc = Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true);

        let mut guard = self
            .session
            .lock()
            .map_err(|_| "vault state lock is poisoned".to_string())?;

        match &mut *guard {
            VaultSession::Unlocked {
                db,
                journal,
                lock_verifier,
            } => {
                let (signed, _) = journal
                    .prepare_append(AppendEvidenceRequest {
                        kind: "session_locked".to_string(),
                        payload: BTreeMap::from([
                            ("trigger".to_string(), normalized_trigger.to_string()),
                            ("mode".to_string(), normalized_mode.to_string()),
                            ("lockedAtUtc".to_string(), locked_at_utc.clone()),
                        ]),
                        app_version: Some(env!("CARGO_PKG_VERSION").to_string()),
                        occurred_at_utc: Some(locked_at_utc.clone()),
                        account_ref: Some(if normalized_mode == "local-csv" {
                            "acct_local_csv".to_string()
                        } else {
                            "acct_local_mock".to_string()
                        }),
                        intent_id: Some(format!("lock-{normalized_trigger}")),
                    })
                    .map_err(|error| error.to_string())?;
                db.insert_evidence_entry(&signed)
                    .map_err(|error| error.to_string())?;
                journal.commit_prepared(signed);

                let verifier_clone = lock_verifier.clone();
                let reason = if normalized_trigger == "idle" {
                    "Session locked automatically after idle timeout; session keys zeroized"
                        .to_string()
                } else {
                    "Session locked manually; session keys zeroized".to_string()
                };

                // Dropping the previous `VaultSession::Unlocked` immediately scrubs
                // `db_master_key`, `device_signing_seed`, and `SigningKey` from memory.
                *guard = VaultSession::UserLocked {
                    reason,
                    lock_verifier: verifier_clone,
                    failed_attempts: 0,
                    locked_until: None,
                };
            }
            VaultSession::UserLocked { .. } => {}
            VaultSession::ErrorLocked { reason } => {
                return Err(format!(
                    "Vault is locked in fail-closed error state: {reason}"
                ));
            }
        }
        drop(guard);
        self.status()
    }

    /// Unlock a `UserLocked` session. Verifies the configured Argon2id passphrase
    /// (if set) in constant time with exponential backoff anti-bruteforce protection,
    /// then reloads keys from OS keyring and verifies vault canary + evidence chain.
    pub fn unlock_session(&self, passphrase: Option<String>) -> Result<VaultStatusDto, String> {
        let candidate = Zeroizing::new(passphrase.unwrap_or_default());
        let mut guard = self
            .session
            .lock()
            .map_err(|_| "vault state lock is poisoned".to_string())?;

        match &mut *guard {
            VaultSession::Unlocked { .. } => {
                drop(guard);
                return self.status();
            }
            VaultSession::ErrorLocked { reason } => {
                return Err(format!(
                    "Vault cannot be unlocked because integrity/keyring check failed: {reason}"
                ));
            }
            VaultSession::UserLocked {
                lock_verifier,
                failed_attempts,
                locked_until,
                ..
            } => {
                let wait_secs = remaining_backoff_seconds(*locked_until);
                if wait_secs > 0 {
                    return Err(format!(
                        "Too many failed unlock attempts. Wait {wait_secs} seconds before retrying."
                    ));
                }

                if let Some(verifier) = lock_verifier.as_ref() {
                    let matched = verify_app_lock_passphrase(verifier, &candidate)
                        .map_err(|error| error.to_string())?;
                    if !matched {
                        *failed_attempts = failed_attempts.saturating_add(1);
                        let backoff = compute_backoff_seconds(*failed_attempts);
                        *locked_until = Some(Instant::now() + Duration::from_secs(backoff));
                        return Err(format!(
                            "Incorrect lock passphrase. Wait {backoff} seconds before retrying."
                        ));
                    }
                }

                let reopened =
                    Self::open_session(&self.db_path, self.key_store.as_ref(), &self.key_provider);
                match reopened {
                    VaultSession::Unlocked { .. } => {
                        *guard = reopened;
                    }
                    VaultSession::ErrorLocked { reason } => {
                        *guard = VaultSession::ErrorLocked {
                            reason: reason.clone(),
                        };
                        return Err(format!("Vault failed verification on unlock: {reason}"));
                    }
                    VaultSession::UserLocked { .. } => unreachable!(),
                }
            }
        }
        drop(guard);
        self.status()
    }

    pub fn set_lock_passphrase(
        &self,
        current_passphrase: Option<String>,
        new_passphrase: Option<String>,
    ) -> Result<VaultStatusDto, String> {
        self.set_lock_passphrase_internal(
            current_passphrase,
            new_passphrase,
            vault::ARGON2_MEMORY_KIB,
            vault::ARGON2_ITERATIONS,
            vault::ARGON2_PARALLELISM,
        )
    }

    fn set_lock_passphrase_internal(
        &self,
        current_passphrase: Option<String>,
        new_passphrase: Option<String>,
        memory_kib: u32,
        iterations: u32,
        parallelism: u32,
    ) -> Result<VaultStatusDto, String> {
        let current = Zeroizing::new(current_passphrase.unwrap_or_default());
        let next = new_passphrase.map(Zeroizing::new);

        let mut guard = self
            .session
            .lock()
            .map_err(|_| "vault state lock is poisoned".to_string())?;
        let VaultSession::Unlocked {
            db,
            journal,
            lock_verifier,
        } = &mut *guard
        else {
            return Err("Vault must be unlocked to update the lock passphrase".to_string());
        };

        if let Some(existing) = lock_verifier.as_ref() {
            let valid = verify_app_lock_passphrase(existing, &current)
                .map_err(|error| error.to_string())?;
            if !valid {
                return Err("Current lock passphrase is incorrect".to_string());
            }
        }

        let (updated_verifier, action_label) = match next {
            Some(ref new_pass) if !new_pass.is_empty() => {
                let verifier = vault::create_app_lock_verifier_with_params(
                    new_pass,
                    memory_kib,
                    iterations,
                    parallelism,
                )
                .map_err(|error| error.to_string())?;
                (Some(verifier), "configured")
            }
            _ => (None, "removed"),
        };

        db.save_app_lock_verifier(updated_verifier.as_ref())
            .map_err(|error| error.to_string())?;
        *lock_verifier = updated_verifier;

        let (signed, _) = journal
            .prepare_append(AppendEvidenceRequest {
                kind: "safety_setting_changed".to_string(),
                payload: BTreeMap::from([
                    ("setting".to_string(), "appLockPassphrase".to_string()),
                    ("action".to_string(), action_label.to_string()),
                ]),
                app_version: Some(env!("CARGO_PKG_VERSION").to_string()),
                occurred_at_utc: None,
                account_ref: None,
                intent_id: Some(format!("app-lock-{action_label}")),
            })
            .map_err(|error| error.to_string())?;
        db.insert_evidence_entry(&signed)
            .map_err(|error| error.to_string())?;
        journal.commit_prepared(signed);

        drop(guard);
        self.status()
    }

    pub fn export_fhvault_backup(&self, passphrase: String) -> Result<String, String> {
        let pass = Zeroizing::new(passphrase);
        let payload = self.with_unlocked(|db, _| {
            db.export_backup_payload()
                .map_err(|error| error.to_string())
        })?;
        let plaintext =
            Zeroizing::new(serde_json::to_vec(&payload).map_err(|error| error.to_string())?);
        encrypt_fhvault_backup(&pass, &plaintext).map_err(|error| error.to_string())
    }

    pub fn restore_fhvault_backup(
        &self,
        raw_backup: String,
        passphrase: String,
    ) -> Result<VaultRestoreSummaryDto, String> {
        let pass = Zeroizing::new(passphrase);
        let decrypted =
            decrypt_fhvault_backup(&pass, &raw_backup).map_err(|error| error.to_string())?;
        let payload: VaultBackupPayload = serde_json::from_slice(&decrypted)
            .map_err(|error| format!("decrypted .fhvault payload is malformed: {error}"))?;

        let mut guard = self
            .session
            .lock()
            .map_err(|_| "vault state lock is poisoned".to_string())?;
        let VaultSession::Unlocked { db, journal, .. } = &mut *guard else {
            return Err("Vault must be unlocked before restoring a .fhvault backup".to_string());
        };

        let (restored_journal, summary) = db
            .restore_from_backup_payload(payload, self.key_store.as_ref())
            .map_err(|error| error.to_string())?;
        **journal = restored_journal;
        Ok(summary)
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
    if serialized.len() > MAX_EXPORT_BYTES {
        return Err("Evidence import payload exceeds the 20 MB safety limit".to_string());
    }
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
fn vault_lock(
    state: State<'_, VaultRuntimeState>,
    trigger: Option<String>,
    workspace_mode: Option<String>,
) -> Result<VaultStatusDto, String> {
    state.lock_session(
        trigger.as_deref().unwrap_or("manual"),
        workspace_mode.as_deref(),
    )
}

#[tauri::command]
fn vault_unlock(
    state: State<'_, VaultRuntimeState>,
    passphrase: Option<String>,
) -> Result<VaultStatusDto, String> {
    state.unlock_session(passphrase)
}

#[tauri::command]
fn vault_set_lock_passphrase(
    state: State<'_, VaultRuntimeState>,
    current_passphrase: Option<String>,
    new_passphrase: Option<String>,
) -> Result<VaultStatusDto, String> {
    state.set_lock_passphrase(current_passphrase, new_passphrase)
}

#[tauri::command]
fn vault_export_backup(
    state: State<'_, VaultRuntimeState>,
    passphrase: String,
) -> Result<String, String> {
    state.export_fhvault_backup(passphrase)
}

#[tauri::command]
fn vault_restore_backup(
    state: State<'_, VaultRuntimeState>,
    raw_backup: String,
    passphrase: String,
) -> Result<VaultRestoreSummaryDto, String> {
    state.restore_fhvault_backup(raw_backup, passphrase)
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
async fn dialog_save_fhvault_file(
    app: AppHandle,
    default_file_name: String,
    content: String,
) -> Result<Option<String>, String> {
    if content.len() > MAX_FHVAULT_BYTES {
        return Err("Encrypted backup exceeds the 20 MB safety limit".to_string());
    }
    let safe_name: String = default_file_name
        .chars()
        .filter(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '.' | '-' | '_'))
        .take(80)
        .collect();
    let final_name = if safe_name.is_empty() {
        "foliohelm-backup.fhvault".to_string()
    } else if safe_name.ends_with(".fhvault") {
        safe_name
    } else {
        format!("{safe_name}.fhvault")
    };

    tauri::async_runtime::spawn_blocking(move || {
        let picked = app
            .dialog()
            .file()
            .set_file_name(&final_name)
            .add_filter("FolioHelm Encrypted Backup", &["fhvault"])
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
async fn dialog_open_fhvault_file(app: AppHandle) -> Result<Option<OpenedTextFileDto>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let picked = app
            .dialog()
            .file()
            .add_filter("FolioHelm Encrypted Backup", &["fhvault", "json"])
            .blocking_pick_file();

        let Some(file_path) = picked else {
            return Ok(None);
        };
        let path = file_path
            .into_path()
            .map_err(|_| "selected backup path is not a local filesystem path".to_string())?;
        let meta = fs::metadata(&path).map_err(|error| error.to_string())?;
        if meta.len() as usize > MAX_FHVAULT_BYTES {
            return Err(format!(
                "Selected .fhvault backup exceeds the 20 MB safety limit ({} bytes)",
                meta.len()
            ));
        }
        let content = fs::read_to_string(&path).map_err(|error| error.to_string())?;
        let file_name = path
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("backup.fhvault")
            .to_string();
        Ok(Some(OpenedTextFileDto { file_name, content }))
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
                    VaultRuntimeState::open_with_store(
                        &db_path,
                        Arc::new(OsKeyringStore),
                        key_provider,
                    )
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
            vault_lock,
            vault_unlock,
            vault_set_lock_passphrase,
            vault_export_backup,
            vault_restore_backup,
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
            dialog_save_fhvault_file,
            dialog_open_fhvault_file,
            vault_clear_all,
        ])
        .run(tauri::tauri_build_context!())
        .expect("error while running FolioHelm application");
}

#[cfg(test)]
mod tests {
    use std::{collections::BTreeMap, fs, path::PathBuf, sync::Arc};

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
            assert_eq!(status.lock_state, "error-locked");
            assert!(status.locked_reason.is_some());
            assert!(locked.with_unlocked(|_, _| Ok(())).is_err());
        }

        if let Some(parent) = db_path.parent() {
            let _ = fs::remove_dir_all(parent);
        }
    }

    #[test]
    fn manual_and_idle_lock_zeroize_session_write_signed_evidence_and_enforce_unlock_backoff() {
        let db_path = temp_vault_path("app-lock");
        let key_store = Arc::new(InMemoryKeyStore::new());
        let state = VaultRuntimeState::open_with_store(&db_path, key_store, "in-memory-test");

        let passphrase = "My-Strong-AppLock-Pass-2026";
        let status = state
            .set_lock_passphrase_internal(None, Some(passphrase.to_string()), 4096, 1, 1)
            .expect("set lock passphrase");
        assert!(status.has_lock_passphrase);

        // Locking writes signed SessionLocked evidence and drops DB + keys from memory.
        let locked_status = state
            .lock_session("idle", Some("local-csv"))
            .expect("lock succeeds");
        assert!(!locked_status.unlocked);
        assert_eq!(locked_status.lock_state, "user-locked");
        assert!(locked_status.has_lock_passphrase);
        assert!(state.with_unlocked(|_, _| Ok(())).is_err());

        // Wrong passphrase fails closed and activates exponential backoff without leaking secret.
        let wrong_err = state
            .unlock_session(Some("Wrong-Passphrase-12345".to_string()))
            .expect_err("wrong passphrase must fail");
        assert!(wrong_err.contains("Incorrect lock passphrase"));
        assert!(!wrong_err.contains("Wrong-Passphrase-12345"));

        // Immediate retry during backoff is blocked before KDF runs.
        let backoff_err = state
            .unlock_session(Some(passphrase.to_string()))
            .expect_err("backoff must block immediate retry");
        assert!(backoff_err.contains("Wait"));

        // Wait for 1-second initial backoff window to expire, then unlock cleanly.
        std::thread::sleep(Duration::from_millis(1100));
        let unlocked = state
            .unlock_session(Some(passphrase.to_string()))
            .expect("unlock succeeds after backoff");
        assert!(unlocked.unlocked);
        assert_eq!(unlocked.lock_state, "unlocked");

        let entries = state
            .with_unlocked(|_, journal| Ok(journal.list()))
            .expect("list evidence");
        assert!(entries.iter().any(|e| e.rust_kind == "session_locked"
            && e.payload.get("trigger").map(String::as_str) == Some("idle")));
        let verified = state
            .with_unlocked(|_, journal| Ok(journal.verify()))
            .expect("verify");
        assert!(verified.valid);

        // Passphrase must never appear in persisted SQLite file or evidence.
        let raw_db = fs::read(&db_path).expect("read sqlite");
        assert!(!String::from_utf8_lossy(&raw_db).contains(passphrase));

        if let Some(parent) = db_path.parent() {
            let _ = fs::remove_dir_all(parent);
        }
    }

    #[test]
    fn fhvault_backup_export_and_fail_closed_restore_roundtrip() {
        let src_path = temp_vault_path("fhvault-src");
        let dst_path = temp_vault_path("fhvault-dst");
        let src_store = Arc::new(InMemoryKeyStore::new());
        let dst_store = Arc::new(InMemoryKeyStore::new());

        let src = VaultRuntimeState::open_with_store(&src_path, src_store, "in-memory-test");
        src.with_unlocked(|db, _| {
            db.save_setting("workspace_preferences", r#"{"workspaceMode":"local-csv"}"#)
                .map_err(|e| e.to_string())
        })
        .expect("save pref");

        let backup_pass = "Backup-Migration-Secret-2026!";
        let backup_blob = src
            .export_fhvault_backup(backup_pass.to_string())
            .expect("export fhvault");
        assert!(!backup_blob.contains("local-csv"));
        assert!(!backup_blob.contains(backup_pass));

        let dst = VaultRuntimeState::open_with_store(&dst_path, dst_store, "in-memory-test");
        dst.with_unlocked(|db, _| {
            db.save_setting("keep_existing", r#""untouched""#)
                .map_err(|e| e.to_string())
        })
        .expect("save existing");

        // Wrong passphrase fails closed and preserves existing vault intact.
        assert!(dst
            .restore_fhvault_backup(backup_blob.clone(), "Wrong-Backup-Pass-9999".to_string())
            .is_err());
        let preserved = dst
            .with_unlocked(|db, _| db.load_setting("keep_existing").map_err(|e| e.to_string()))
            .expect("load preserved");
        assert_eq!(preserved, Some(r#""untouched""#.to_string()));

        // Valid passphrase restores cleanly.
        let summary = dst
            .restore_fhvault_backup(backup_blob, backup_pass.to_string())
            .expect("restore ok");
        assert_eq!(summary.setting_count, 1);
        let restored = dst
            .with_unlocked(|db, _| {
                db.load_setting("workspace_preferences")
                    .map_err(|e| e.to_string())
            })
            .expect("load restored");
        assert_eq!(
            restored,
            Some(r#"{"workspaceMode":"local-csv"}"#.to_string())
        );

        if let Some(parent) = src_path.parent() {
            let _ = fs::remove_dir_all(parent);
        }
        if let Some(parent) = dst_path.parent() {
            let _ = fs::remove_dir_all(parent);
        }
    }
}
