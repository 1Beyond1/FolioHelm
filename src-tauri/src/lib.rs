pub mod csv_import;
pub mod evidence;
pub mod quotes;
pub mod storage;
pub mod vault;

use std::{
    collections::BTreeMap,
    fs,
    future::Future,
    io::Read,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};

use chrono::{SecondsFormat, Utc};
use csv_import::{parse_and_preview_csv, CsvCommitResultDto, CsvImportPreviewDto, MAX_CSV_BYTES};
use evidence::{
    AppendEvidenceRequest, EvidenceJournal, EvidenceVerificationDto, SignedEvidenceRecordDto,
};
use quotes::{
    fetch_public_quotes_partial, PublicQuoteBatchOutcome, PublicQuoteBatchResponseDto,
    PublicQuoteProvider, QuoteError,
};
use serde::Serialize;
use storage::{
    atomic_write_bytes, AppLockBackoffState, CachedPublicQuote, EncryptedVaultDb,
    PortfolioSaveOutcome, StoredPaperOrder, StoredPortfolioSnapshot, VaultBackupPayload,
    VaultRestoreSummaryDto, VaultStatusDto, STORAGE_SCHEMA_VERSION,
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
        locked_until_unix: Option<i64>,
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
    unlock_in_flight: AtomicBool,
}

struct AtomicFlagGuard<'a>(&'a AtomicBool);

impl Drop for AtomicFlagGuard<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Release);
    }
}

fn compute_backoff_seconds(failed_attempts: u32) -> u64 {
    let shift = failed_attempts.saturating_sub(1).min(8);
    1_u64
        .checked_shl(shift)
        .unwrap_or(256)
        .min(MAX_BACKOFF_SECS)
}

fn compute_backoff_until_unix(backoff_secs: u64) -> i64 {
    let now = Utc::now();
    let base = now.timestamp().saturating_add(backoff_secs as i64);
    if now.timestamp_subsec_millis() > 0 {
        base.saturating_add(1)
    } else {
        base
    }
}

fn remaining_backoff_from_unix(locked_until_unix: Option<i64>) -> u64 {
    let Some(until_unix) = locked_until_unix else {
        return 0;
    };
    let now_unix = Utc::now().timestamp();
    if until_unix <= now_unix {
        0
    } else {
        u64::try_from(until_unix - now_unix)
            .unwrap_or(MAX_BACKOFF_SECS)
            .min(MAX_BACKOFF_SECS)
    }
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
        let session = Self::open_session(db_path, key_store.as_ref(), &provider, false);
        Self {
            db_path: db_path.to_path_buf(),
            key_store,
            key_provider: provider,
            session: Mutex::new(session),
            unlock_in_flight: AtomicBool::new(false),
        }
    }

    pub fn open(
        db_path: &Path,
        key_store: Arc<dyn KeyStore>,
        key_provider: impl Into<String>,
    ) -> Self {
        Self::open_with_store(db_path, key_store, key_provider)
    }

    pub fn locked(reason: impl Into<String>, key_provider: impl Into<String>) -> Self {
        Self {
            db_path: PathBuf::new(),
            key_store: Arc::new(OsKeyringStore),
            key_provider: key_provider.into(),
            session: Mutex::new(VaultSession::ErrorLocked {
                reason: reason.into(),
            }),
            unlock_in_flight: AtomicBool::new(false),
        }
    }

    /// Open the encrypted SQLite vault and verify canary, verifier, backoff, and Ed25519 chain.
    ///
    /// Security invariant (P0-1):
    /// When `passphrase_verified` is `false` (cold start) and an `app_lock_verifier` is configured,
    /// `db` and `journal` are immediately dropped (zeroizing all key material) and the session
    /// MUST start in `VaultSession::UserLocked` with persisted backoff preserved across restarts.
    fn open_session(
        db_path: &Path,
        key_store: &dyn KeyStore,
        key_provider: &str,
        passphrase_verified: bool,
    ) -> VaultSession {
        match EncryptedVaultDb::open(db_path, key_store, key_provider.to_string()) {
            Ok(mut db) => {
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
                let backoff_state = match db.load_app_lock_backoff() {
                    Ok(state) => state,
                    Err(error) => {
                        return VaultSession::ErrorLocked {
                            reason: format!(
                                "app lock backoff state failed verification; vault locked to preserve ciphertext ({error})"
                            ),
                        };
                    }
                };
                match db.load_evidence_entries() {
                    Ok(entries) => match EvidenceJournal::from_persisted(db.signing_key(), entries)
                    {
                        Ok(journal) => {
                            if !passphrase_verified && lock_verifier.is_some() {
                                // Drop `db` and `journal` immediately so zero key material stays
                                // resident in memory until the user passes Argon2id verification.
                                drop(journal);
                                drop(db);
                                let rem_secs =
                                    remaining_backoff_from_unix(backoff_state.locked_until_unix);
                                let locked_until = if rem_secs > 0 {
                                    Some(Instant::now() + Duration::from_secs(rem_secs))
                                } else {
                                    None
                                };
                                return VaultSession::UserLocked {
                                    reason: "App Lock passphrase is configured; unlock required on startup"
                                        .to_string(),
                                    lock_verifier,
                                    failed_attempts: backoff_state.failed_attempts,
                                    locked_until,
                                    locked_until_unix: if rem_secs > 0 {
                                        backoff_state.locked_until_unix
                                    } else {
                                        None
                                    },
                                };
                            }

                            if passphrase_verified
                                && (backoff_state.failed_attempts > 0
                                    || backoff_state.locked_until_unix.is_some())
                            {
                                let _ = db.save_app_lock_backoff(&AppLockBackoffState::default());
                            }

                            VaultSession::Unlocked {
                                db: Box::new(db),
                                journal: Box::new(journal),
                                lock_verifier,
                            }
                        }
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

    fn persist_backoff_while_locked(&self, state: &AppLockBackoffState) {
        if self.db_path.as_os_str().is_empty() {
            return;
        }
        // Temporarily open the encrypted DB, persist AES-256-GCM backoff state, and drop
        // immediately so session keys are scrubbed before returning.
        if let Ok(mut db) =
            EncryptedVaultDb::open(&self.db_path, self.key_store.as_ref(), &self.key_provider)
        {
            if let Err(error) = db.save_app_lock_backoff(state) {
                eprintln!(
                    "[FolioHelm] warning: failed to persist encrypted app lock backoff: {error}"
                );
            }
        }
    }

    fn ensure_unlocked(&self) -> Result<(), String> {
        let guard = self
            .session
            .lock()
            .map_err(|_| "vault state lock is poisoned".to_string())?;
        match &*guard {
            VaultSession::Unlocked { .. } => Ok(()),
            VaultSession::UserLocked { reason, .. } | VaultSession::ErrorLocked { reason } => {
                Err(format!("Vault is locked: {reason}"))
            }
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

    /// Lock the active session (Fail-Closed P0-2):
    /// Attempts to write an Ed25519-signed `EvidenceKind::SessionLocked` record, then
    /// UNCONDITIONALLY drops `EncryptedVaultDb` and `EvidenceJournal` so all in-memory
    /// `Zeroizing` session keys are immediately wiped — even if evidence persistence fails.
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
                let verifier_clone = lock_verifier.clone();
                let evidence_warning = match journal.prepare_append(AppendEvidenceRequest {
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
                }) {
                    Ok((signed, _)) => match db.insert_evidence_entry(&signed) {
                        Ok(()) => {
                            journal.commit_prepared(signed);
                            None
                        }
                        Err(error) => Some(error.to_string()),
                    },
                    Err(error) => Some(error.to_string()),
                };

                let base_reason = if normalized_trigger == "idle" {
                    "Session locked automatically after idle timeout; session keys zeroized"
                } else {
                    "Session locked manually; session keys zeroized"
                };
                let reason = match evidence_warning {
                    Some(warning) => {
                        eprintln!(
                            "[FolioHelm] warning: failed to write SessionLocked evidence (session locked fail-closed): {warning}"
                        );
                        format!(
                            "{base_reason} (warning: SessionLocked evidence could not be written: {warning})"
                        )
                    }
                    None => base_reason.to_string(),
                };

                // UNCONDITIONALLY replace `VaultSession::Unlocked` so `db_master_key`,
                // `device_signing_seed`, and `SigningKey` are dropped & zeroized immediately.
                *guard = VaultSession::UserLocked {
                    reason,
                    lock_verifier: verifier_clone,
                    failed_attempts: 0,
                    locked_until: None,
                    locked_until_unix: None,
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

    fn finish_unlock_after_verification(&self, matched: bool) -> Result<VaultStatusDto, String> {
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
                failed_attempts,
                locked_until,
                locked_until_unix,
                ..
            } => {
                let wait_secs = remaining_backoff_seconds(*locked_until);
                if wait_secs > 0 {
                    return Err(format!(
                        "Too many failed unlock attempts. Wait {wait_secs} seconds before retrying."
                    ));
                }

                if !matched {
                    *failed_attempts = failed_attempts.saturating_add(1);
                    let backoff = compute_backoff_seconds(*failed_attempts);
                    let until_unix = compute_backoff_until_unix(backoff);
                    *locked_until = Some(Instant::now() + Duration::from_secs(backoff));
                    *locked_until_unix = Some(until_unix);
                    let persisted = AppLockBackoffState {
                        failed_attempts: *failed_attempts,
                        locked_until_unix: *locked_until_unix,
                    };
                    self.persist_backoff_while_locked(&persisted);
                    return Err(format!(
                        "Incorrect lock passphrase. Wait {backoff} seconds before retrying."
                    ));
                }

                let reopened = Self::open_session(
                    &self.db_path,
                    self.key_store.as_ref(),
                    &self.key_provider,
                    true,
                );
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

    fn prepare_unlock_check(&self) -> Result<Option<Option<AppLockVerifier>>, String> {
        let guard = self
            .session
            .lock()
            .map_err(|_| "vault state lock is poisoned".to_string())?;
        match &*guard {
            VaultSession::Unlocked { .. } => Ok(None),
            VaultSession::ErrorLocked { reason } => Err(format!(
                "Vault cannot be unlocked because integrity/keyring check failed: {reason}"
            )),
            VaultSession::UserLocked {
                lock_verifier,
                locked_until,
                ..
            } => {
                let wait_secs = remaining_backoff_seconds(*locked_until);
                if wait_secs > 0 {
                    return Err(format!(
                        "Too many failed unlock attempts. Wait {wait_secs} seconds before retrying."
                    ));
                }
                Ok(Some(lock_verifier.clone()))
            }
        }
    }

    /// Synchronous unlock helper (used in unit tests). Never holds the session mutex during Argon2id.
    pub fn unlock_session(&self, passphrase: Option<String>) -> Result<VaultStatusDto, String> {
        if self
            .unlock_in_flight
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .is_err()
        {
            return Err("Unlock verification is already in progress".to_string());
        }
        let _guard = AtomicFlagGuard(&self.unlock_in_flight);

        let candidate = Zeroizing::new(passphrase.unwrap_or_default());
        let Some(verifier_opt) = self.prepare_unlock_check()? else {
            return self.status();
        };
        let matched = match verifier_opt {
            Some(verifier) => verify_app_lock_passphrase(&verifier, &candidate)
                .map_err(|error| error.to_string())?,
            None => true,
        };
        self.finish_unlock_after_verification(matched)
    }

    /// Async unlock for Tauri IPC: executes Argon2id off the async/UI executor via
    /// `tokio::task::spawn_blocking` without holding `self.session` `Mutex`.
    pub async fn unlock_session_async(
        &self,
        passphrase: Option<String>,
    ) -> Result<VaultStatusDto, String> {
        if self
            .unlock_in_flight
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .is_err()
        {
            return Err("Unlock verification is already in progress".to_string());
        }
        let _guard = AtomicFlagGuard(&self.unlock_in_flight);

        let candidate = Zeroizing::new(passphrase.unwrap_or_default());
        let Some(verifier_opt) = self.prepare_unlock_check()? else {
            return self.status();
        };
        let matched = match verifier_opt {
            Some(verifier) => tokio::task::spawn_blocking(move || {
                verify_app_lock_passphrase(&verifier, &candidate).map_err(|e| e.to_string())
            })
            .await
            .map_err(|error| error.to_string())??,
            None => true,
        };
        self.finish_unlock_after_verification(matched)
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

    fn snapshot_existing_verifier_when_unlocked(&self) -> Result<Option<AppLockVerifier>, String> {
        let guard = self
            .session
            .lock()
            .map_err(|_| "vault state lock is poisoned".to_string())?;
        let VaultSession::Unlocked { lock_verifier, .. } = &*guard else {
            return Err("Vault must be unlocked to update the lock passphrase".to_string());
        };
        Ok(lock_verifier.clone())
    }

    fn commit_lock_passphrase_change(
        &self,
        expected_existing: &Option<AppLockVerifier>,
        updated_verifier: Option<AppLockVerifier>,
        action_label: &str,
    ) -> Result<VaultStatusDto, String> {
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
        if lock_verifier != expected_existing {
            return Err("Lock passphrase changed concurrently; please retry".to_string());
        }

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
        let existing = self.snapshot_existing_verifier_when_unlocked()?;

        if let Some(ref existing_verifier) = existing {
            let valid = verify_app_lock_passphrase(existing_verifier, &current)
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

        self.commit_lock_passphrase_change(&existing, updated_verifier, action_label)
    }

    /// Async passphrase configuration for Tauri IPC: runs Argon2id off-thread via
    /// `tokio::task::spawn_blocking` without holding `self.session` `Mutex`.
    pub async fn set_lock_passphrase_async(
        &self,
        current_passphrase: Option<String>,
        new_passphrase: Option<String>,
    ) -> Result<VaultStatusDto, String> {
        self.set_lock_passphrase_async_with_params(
            current_passphrase,
            new_passphrase,
            vault::ARGON2_MEMORY_KIB,
            vault::ARGON2_ITERATIONS,
            vault::ARGON2_PARALLELISM,
        )
        .await
    }

    async fn set_lock_passphrase_async_with_params(
        &self,
        current_passphrase: Option<String>,
        new_passphrase: Option<String>,
        memory_kib: u32,
        iterations: u32,
        parallelism: u32,
    ) -> Result<VaultStatusDto, String> {
        let current = Zeroizing::new(current_passphrase.unwrap_or_default());
        let next = new_passphrase.map(Zeroizing::new);
        let existing = self.snapshot_existing_verifier_when_unlocked()?;
        let existing_for_kdf = existing.clone();

        let (updated_verifier, action_label) = tokio::task::spawn_blocking(move || {
            if let Some(ref existing_verifier) = existing_for_kdf {
                let valid = verify_app_lock_passphrase(existing_verifier, &current)
                    .map_err(|error| error.to_string())?;
                if !valid {
                    return Err("Current lock passphrase is incorrect".to_string());
                }
            }
            match next {
                Some(ref new_pass) if !new_pass.is_empty() => {
                    let verifier = vault::create_app_lock_verifier_with_params(
                        new_pass,
                        memory_kib,
                        iterations,
                        parallelism,
                    )
                    .map_err(|error| error.to_string())?;
                    Ok((Some(verifier), "configured"))
                }
                _ => Ok((None, "removed")),
            }
        })
        .await
        .map_err(|error| error.to_string())??;

        self.commit_lock_passphrase_change(&existing, updated_verifier, action_label)
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

    pub async fn export_fhvault_backup_async(&self, passphrase: String) -> Result<String, String> {
        let pass = Zeroizing::new(passphrase);
        let payload = self.with_unlocked(|db, _| {
            db.export_backup_payload()
                .map_err(|error| error.to_string())
        })?;
        tokio::task::spawn_blocking(move || {
            let plaintext =
                Zeroizing::new(serde_json::to_vec(&payload).map_err(|error| error.to_string())?);
            encrypt_fhvault_backup(&pass, &plaintext).map_err(|error| error.to_string())
        })
        .await
        .map_err(|error| error.to_string())?
    }

    pub fn restore_fhvault_backup(
        &self,
        raw_backup: String,
        passphrase: String,
    ) -> Result<VaultRestoreSummaryDto, String> {
        self.ensure_unlocked()?;
        let pass = Zeroizing::new(passphrase);
        let decrypted =
            decrypt_fhvault_backup(&pass, &raw_backup).map_err(|error| error.to_string())?;
        let payload: VaultBackupPayload = serde_json::from_slice(&decrypted)
            .map_err(|error| format!("decrypted .fhvault payload is malformed: {error}"))?;

        self.apply_restored_payload(payload)
    }

    pub async fn restore_fhvault_backup_async(
        &self,
        raw_backup: String,
        passphrase: String,
    ) -> Result<VaultRestoreSummaryDto, String> {
        self.ensure_unlocked()?;
        let pass = Zeroizing::new(passphrase);
        let payload = tokio::task::spawn_blocking(move || {
            let decrypted =
                decrypt_fhvault_backup(&pass, &raw_backup).map_err(|error| error.to_string())?;
            serde_json::from_slice::<VaultBackupPayload>(&decrypted)
                .map_err(|error| format!("decrypted .fhvault payload is malformed: {error}"))
        })
        .await
        .map_err(|error| error.to_string())??;

        self.apply_restored_payload(payload)
    }

    fn apply_restored_payload(
        &self,
        payload: VaultBackupPayload,
    ) -> Result<VaultRestoreSummaryDto, String> {
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
async fn vault_unlock(
    state: State<'_, VaultRuntimeState>,
    passphrase: Option<String>,
) -> Result<VaultStatusDto, String> {
    state.unlock_session_async(passphrase).await
}

#[tauri::command]
async fn vault_set_lock_passphrase(
    state: State<'_, VaultRuntimeState>,
    current_passphrase: Option<String>,
    new_passphrase: Option<String>,
) -> Result<VaultStatusDto, String> {
    state
        .set_lock_passphrase_async(current_passphrase, new_passphrase)
        .await
}

#[tauri::command]
async fn vault_export_backup(
    state: State<'_, VaultRuntimeState>,
    passphrase: String,
) -> Result<String, String> {
    state.export_fhvault_backup_async(passphrase).await
}

#[tauri::command]
async fn vault_restore_backup(
    state: State<'_, VaultRuntimeState>,
    raw_backup: String,
    passphrase: String,
) -> Result<VaultRestoreSummaryDto, String> {
    state
        .restore_fhvault_backup_async(raw_backup, passphrase)
        .await
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
    if !matches!(order.workspace_mode.as_str(), "mock" | "local-csv") {
        return Err("unsupported workspace_mode".to_string());
    }
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

async fn fetch_public_quotes_with_vault_cache<F, Fut>(
    state: &VaultRuntimeState,
    symbols: Vec<String>,
    provider: Option<String>,
    fetcher: F,
) -> Result<PublicQuoteBatchResponseDto, String>
where
    F: FnOnce(Vec<String>, PublicQuoteProvider) -> Fut,
    Fut: Future<Output = Result<PublicQuoteBatchOutcome, QuoteError>>,
{
    // Fail-Closed: NEVER perform outbound public quote requests while the vault is locked.
    state.ensure_unlocked()?;

    let provider_choice = PublicQuoteProvider::parse(provider.as_deref().unwrap_or("stooq"))
        .map_err(|error| error.to_string())?;
    let valid_symbols =
        quotes::validate_quote_symbols(&symbols).map_err(|error| error.to_string())?;

    let fetch_result = fetcher(valid_symbols.clone(), provider_choice).await;

    // Re-check lock state after awaiting network I/O so locking mid-flight discards any results.
    state.ensure_unlocked()?;

    match fetch_result {
        Ok(outcome) => {
            if !outcome.quotes.is_empty() {
                state.with_unlocked(|db, _| {
                    db.upsert_quote_cache(&outcome.quotes)
                        .map_err(|error| error.to_string())
                })?;
            }

            if outcome.failed_symbols.is_empty() {
                return Ok(PublicQuoteBatchResponseDto {
                    quotes: outcome.quotes,
                    from_cache: false,
                    degraded_reason: None,
                    provider: provider_choice.code().to_string(),
                });
            }

            let cached = state
                .with_unlocked(|db, _| db.load_quote_cache().map_err(|error| error.to_string()))?;
            let mut merged_by_symbol: BTreeMap<String, CachedPublicQuote> = outcome
                .quotes
                .into_iter()
                .map(|quote| (quote.symbol.clone(), quote))
                .collect();
            let cached_by_symbol: BTreeMap<String, CachedPublicQuote> = cached
                .into_iter()
                .map(|quote| (quote.symbol.clone(), quote))
                .collect();

            let mut fallback_symbols = Vec::new();
            let mut missing_symbols = Vec::new();
            for sym in &outcome.failed_symbols {
                if let Some(cached_quote) = cached_by_symbol.get(sym) {
                    merged_by_symbol.insert(sym.clone(), cached_quote.clone());
                    fallback_symbols.push(sym.clone());
                } else {
                    missing_symbols.push(sym.clone());
                }
            }

            let ordered_quotes: Vec<CachedPublicQuote> = valid_symbols
                .iter()
                .filter_map(|sym| merged_by_symbol.remove(sym))
                .collect();

            let mut reasons = Vec::new();
            if outcome.timed_out {
                reasons.push("batch timeout".to_string());
            } else if let Some(err) = outcome.last_error {
                reasons.push(err);
            }
            if !fallback_symbols.is_empty() {
                reasons.push(format!(
                    "fallback to encrypted cache for: {}",
                    fallback_symbols.join(", ")
                ));
            }
            if !missing_symbols.is_empty() {
                reasons.push(format!(
                    "no cached quote available for: {}",
                    missing_symbols.join(", ")
                ));
            }

            Ok(PublicQuoteBatchResponseDto {
                quotes: ordered_quotes,
                from_cache: false,
                degraded_reason: Some(format!(
                    "Partial quote fetch failure ({}): {}",
                    outcome.failed_symbols.join(", "),
                    reasons.join("; ")
                )),
                provider: provider_choice.code().to_string(),
            })
        }
        Err(fetch_error) => {
            let cached = state
                .with_unlocked(|db, _| db.load_quote_cache().map_err(|error| error.to_string()))?;
            let mut cached_by_symbol: BTreeMap<String, CachedPublicQuote> = cached
                .into_iter()
                .map(|item| (item.symbol.clone(), item))
                .collect();
            let filtered: Vec<CachedPublicQuote> = valid_symbols
                .iter()
                .filter_map(|sym| cached_by_symbol.remove(sym))
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

/// Reads at most `max_bytes` from an open file descriptor via `File::take(max_bytes + 1)`,
/// eliminating TOCTOU races between `fs::metadata` size checks and `fs::read`.
fn read_bounded_file_bytes(path: &Path, max_bytes: usize, label: &str) -> Result<Vec<u8>, String> {
    let file = fs::File::open(path).map_err(|error| error.to_string())?;
    let mut limited = file.take((max_bytes as u64).saturating_add(1));
    let mut bytes = Vec::new();
    limited
        .read_to_end(&mut bytes)
        .map_err(|error| error.to_string())?;
    if bytes.len() > max_bytes {
        let mb = (max_bytes / (1024 * 1024)).max(1);
        return Err(format!("Selected {label} exceeds the {mb} MB safety limit"));
    }
    Ok(bytes)
}

/// Decodes brokerage CSV bytes supporting UTF-8 (with or without BOM), UTF-16LE/BE (BOM or
/// NUL-interleaved UTF-16LE), and GBK/GB18030 Chinese brokerage exports.
pub fn decode_csv_bytes(bytes: &[u8]) -> Result<String, String> {
    if let Some(rest) = bytes.strip_prefix(&[0xEF, 0xBB, 0xBF]) {
        return String::from_utf8(rest.to_vec())
            .map_err(|_| "Selected UTF-8 BOM CSV contains invalid UTF-8 bytes".to_string());
    }
    if let Some(rest) = bytes.strip_prefix(&[0xFF, 0xFE]) {
        return encoding_rs::UTF_16LE
            .decode_without_bom_handling_and_without_replacement(rest)
            .map(|cow| cow.into_owned())
            .ok_or_else(|| "Selected UTF-16LE CSV contains invalid byte sequences".to_string());
    }
    if let Some(rest) = bytes.strip_prefix(&[0xFE, 0xFF]) {
        return encoding_rs::UTF_16BE
            .decode_without_bom_handling_and_without_replacement(rest)
            .map(|cow| cow.into_owned())
            .ok_or_else(|| "Selected UTF-16BE CSV contains invalid byte sequences".to_string());
    }

    if let Ok(utf8) = std::str::from_utf8(bytes) {
        return Ok(utf8.strip_prefix('\u{feff}').unwrap_or(utf8).to_string());
    }

    // Detect BOM-less UTF-16LE (common in some Excel / brokerage exports): even length with NUL high bytes.
    if bytes.len() >= 4 && bytes.len().is_multiple_of(2) && bytes.contains(&0) {
        let odd_zeros = bytes.iter().skip(1).step_by(2).filter(|&&b| b == 0).count();
        let even_zeros = bytes.iter().step_by(2).filter(|&&b| b == 0).count();
        if odd_zeros > even_zeros {
            if let Some(decoded) =
                encoding_rs::UTF_16LE.decode_without_bom_handling_and_without_replacement(bytes)
            {
                return Ok(decoded
                    .strip_prefix('\u{feff}')
                    .unwrap_or(&decoded)
                    .to_string());
            }
        } else if even_zeros > odd_zeros {
            if let Some(decoded) =
                encoding_rs::UTF_16BE.decode_without_bom_handling_and_without_replacement(bytes)
            {
                return Ok(decoded
                    .strip_prefix('\u{feff}')
                    .unwrap_or(&decoded)
                    .to_string());
            }
        }
    }

    // Fallback to GBK / GB18030 for legacy Chinese brokerage CSV exports (e.g. Futu / A-share).
    if let Some(decoded) =
        encoding_rs::GBK.decode_without_bom_handling_and_without_replacement(bytes)
    {
        return Ok(decoded
            .strip_prefix('\u{feff}')
            .unwrap_or(&decoded)
            .to_string());
    }

    Err("Selected CSV file is not valid UTF-8, UTF-16, or GBK text".to_string())
}

#[tauri::command]
async fn quotes_fetch_public(
    state: State<'_, VaultRuntimeState>,
    symbols: Vec<String>,
    provider: Option<String>,
) -> Result<PublicQuoteBatchResponseDto, String> {
    fetch_public_quotes_with_vault_cache(
        &state,
        symbols,
        provider,
        |valid_symbols, provider_choice| async move {
            fetch_public_quotes_partial(&valid_symbols, provider_choice).await
        },
    )
    .await
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
        let raw_bytes = read_bounded_file_bytes(&path, MAX_CSV_BYTES, "CSV")?;
        let content = decode_csv_bytes(&raw_bytes)?;
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
        atomic_write_bytes(&path, content.as_bytes()).map_err(|error| error.to_string())?;
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
        atomic_write_bytes(&path, content.as_bytes()).map_err(|error| error.to_string())?;
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
        let raw_bytes = read_bounded_file_bytes(&path, MAX_FHVAULT_BYTES, ".fhvault backup")?;
        let content_raw = String::from_utf8(raw_bytes)
            .map_err(|_| "Selected .fhvault backup is not valid UTF-8".to_string())?;
        let content = content_raw
            .strip_prefix('\u{feff}')
            .unwrap_or(&content_raw)
            .to_string();
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
        let key_store: Arc<dyn KeyStore> = Arc::new(InMemoryKeyStore::new());

        {
            let state = VaultRuntimeState::open(&db_path, Arc::clone(&key_store), "in-memory-test");
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

        // Reopen and verify the evidence chain and signer key persisted intact (and open() retains key_store).
        {
            let state = VaultRuntimeState::open(&db_path, Arc::clone(&key_store), "in-memory-test");
            let status = state.status().expect("status");
            assert!(status.unlocked);
            assert_eq!(status.evidence_count, 1);
            let verified = state
                .with_unlocked(|_, journal| Ok(journal.verify()))
                .expect("verify");
            assert!(verified.valid);
            assert_eq!(verified.sequence, 1);
            // Lock & unlock through open() MUST use the injected InMemoryKeyStore, never host OS keyring.
            assert!(
                !state
                    .lock_session("manual", Some("mock"))
                    .expect("lock")
                    .unlocked
            );
            assert!(
                state
                    .unlock_session(None)
                    .expect("unlock with injected store")
                    .unlocked
            );
        }

        // Reopening with a missing keyring locks fail-closed instead of resetting.
        {
            let empty_store = Arc::new(InMemoryKeyStore::new());
            let locked = VaultRuntimeState::open(&db_path, empty_store, "in-memory-test");
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
        let key_store: Arc<dyn KeyStore> = Arc::new(InMemoryKeyStore::new());
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

    #[test]
    fn cold_start_enforces_app_lock_and_persists_exponential_backoff_across_restarts() {
        let db_path = temp_vault_path("cold-start-lock");
        let key_store: Arc<dyn KeyStore> = Arc::new(InMemoryKeyStore::new());
        let passphrase = "Cold-Start-AppLock-2026!";

        // Configure App Lock passphrase and shut down cleanly.
        {
            let state = VaultRuntimeState::open_with_store(
                &db_path,
                Arc::clone(&key_store),
                "in-memory-test",
            );
            assert!(state.status().expect("status").unlocked);
            let updated = state
                .set_lock_passphrase_internal(None, Some(passphrase.to_string()), 4096, 1, 1)
                .expect("set passphrase");
            assert!(updated.has_lock_passphrase);
        }

        // Cold restart MUST enter UserLocked immediately (cannot bypass App Lock by restarting).
        {
            let state = VaultRuntimeState::open_with_store(
                &db_path,
                Arc::clone(&key_store),
                "in-memory-test",
            );
            let status = state.status().expect("status");
            assert!(!status.unlocked);
            assert_eq!(status.lock_state, "user-locked");
            assert!(status.has_lock_passphrase);
            assert!(state.with_unlocked(|_, _| Ok(())).is_err());

            // Fail once to activate backoff, then drop state to simulate attacker restarting app.
            let err = state
                .unlock_session(Some("Wrong-Passphrase-111".to_string()))
                .expect_err("wrong passphrase fails");
            assert!(err.contains("Incorrect lock passphrase"));
        }

        // Immediate cold restart MUST still enforce the persisted backoff window!
        {
            let state = VaultRuntimeState::open_with_store(
                &db_path,
                Arc::clone(&key_store),
                "in-memory-test",
            );
            let status = state.status().expect("status");
            assert!(!status.unlocked);
            assert_eq!(status.lock_state, "user-locked");
            assert!(
                status.retry_after_seconds >= 1,
                "backoff must survive process restart"
            );
            let blocked = state
                .unlock_session(Some(passphrase.to_string()))
                .expect_err("backoff must still block correct passphrase after restart");
            assert!(blocked.contains("Wait"));

            // Wait for 1s backoff to expire, then fail a second time -> backoff escalates to 2s!
            std::thread::sleep(Duration::from_millis(2100));
            let second_err = state
                .unlock_session(Some("Wrong-Passphrase-222".to_string()))
                .expect_err("second wrong attempt");
            assert!(
                second_err.contains("Wait 2 seconds"),
                "failed_attempts must escalate across restarts, got: {second_err}"
            );

            // Wait for 2s backoff to expire, then unlock cleanly and verify backoff resets.
            std::thread::sleep(Duration::from_millis(2150));
            let unlocked = state
                .unlock_session(Some(passphrase.to_string()))
                .expect("unlock after backoff");
            assert!(unlocked.unlocked);
            assert_eq!(unlocked.retry_after_seconds, 0);
        }

        if let Some(parent) = db_path.parent() {
            let _ = fs::remove_dir_all(parent);
        }
    }

    #[test]
    fn lock_session_fails_closed_and_wipes_keys_even_when_evidence_insert_fails() {
        let db_path = temp_vault_path("lock-fail-closed");
        let key_store: Arc<dyn KeyStore> = Arc::new(InMemoryKeyStore::new());
        let state =
            VaultRuntimeState::open_with_store(&db_path, Arc::clone(&key_store), "in-memory-test");

        // Corrupt the tail in-memory so `journal.prepare_append` returns an error during lock_session.
        state
            .with_unlocked(|db, journal| {
                let (mut entry, _) = journal
                    .prepare_append(AppendEvidenceRequest {
                        kind: "state_changed".into(),
                        payload: BTreeMap::from([("phase".into(), "init".into())]),
                        app_version: Some("0.1.0".into()),
                        occurred_at_utc: Some("2026-11-22T02:00:00Z".into()),
                        account_ref: None,
                        intent_id: None,
                    })
                    .map_err(|e| e.to_string())?;
                db.insert_evidence_entry(&entry)
                    .map_err(|e| e.to_string())?;
                // Tamper with in-memory tail only so `prepare_append` in `lock_session` errors.
                entry.signature = [0_u8; 64];
                journal.commit_prepared(entry);
                Ok(())
            })
            .expect("setup");

        // `lock_session` MUST STILL unconditionally drop DB/journal and enter UserLocked!
        let locked_status = state
            .lock_session("manual", Some("local-csv"))
            .expect("lock_session must never leave vault unlocked");
        assert!(!locked_status.unlocked);
        assert_eq!(locked_status.lock_state, "user-locked");
        assert!(locked_status
            .locked_reason
            .as_deref()
            .unwrap_or("")
            .contains("warning"));
        assert!(state.with_unlocked(|_, _| Ok(())).is_err());

        if let Some(parent) = db_path.parent() {
            let _ = fs::remove_dir_all(parent);
        }
    }

    #[tokio::test]
    async fn async_argon2id_vault_commands_roundtrip_without_blocking_status() {
        let src_path = temp_vault_path("async-src");
        let dst_path = temp_vault_path("async-dst");
        let src_store = Arc::new(InMemoryKeyStore::new());
        let dst_store = Arc::new(InMemoryKeyStore::new());

        let src = VaultRuntimeState::open_with_store(&src_path, src_store, "in-memory-test");
        let pass = "Async-Argon2id-Pass-2026!";
        let status = src
            .set_lock_passphrase_async_with_params(None, Some(pass.to_string()), 4096, 1, 1)
            .await
            .expect("async set passphrase");
        assert!(status.has_lock_passphrase);

        let locked = src.lock_session("manual", Some("mock")).expect("lock");
        assert!(!locked.unlocked);
        let unlocked = src
            .unlock_session_async(Some(pass.to_string()))
            .await
            .expect("async unlock");
        assert!(unlocked.unlocked);

        src.with_unlocked(|db, _| {
            db.save_setting("async_marker", r#""verified""#)
                .map_err(|e| e.to_string())
        })
        .expect("save marker");

        let backup = src
            .export_fhvault_backup_async("Backup-Async-Pass-2026!".to_string())
            .await
            .expect("async export");

        // Atomic write helper writes cleanly without leaving sibling temp files.
        let export_file = src_path.with_file_name("export.fhvault");
        atomic_write_bytes(&export_file, backup.as_bytes()).expect("atomic write");
        assert_eq!(fs::read_to_string(&export_file).expect("read"), backup);
        let leftovers: Vec<_> = fs::read_dir(export_file.parent().expect("parent"))
            .expect("read dir")
            .filter_map(Result::ok)
            .filter(|e| e.file_name().to_string_lossy().contains(".tmp-"))
            .collect();
        assert!(leftovers.is_empty());

        let dst = VaultRuntimeState::open_with_store(&dst_path, dst_store, "in-memory-test");
        let summary = dst
            .restore_fhvault_backup_async(backup, "Backup-Async-Pass-2026!".to_string())
            .await
            .expect("async restore");
        assert_eq!(summary.setting_count, 1);
        assert_eq!(
            dst.with_unlocked(|db, _| db.load_setting("async_marker").map_err(|e| e.to_string()))
                .expect("load"),
            Some(r#""verified""#.to_string())
        );

        if let Some(parent) = src_path.parent() {
            let _ = fs::remove_dir_all(parent);
        }
        if let Some(parent) = dst_path.parent() {
            let _ = fs::remove_dir_all(parent);
        }
    }

    #[tokio::test]
    async fn quotes_fetch_blocks_network_when_locked_and_falls_back_to_cache_on_partial_failure() {
        let db_path = temp_vault_path("quotes-lock-partial");
        let key_store: Arc<dyn KeyStore> = Arc::new(InMemoryKeyStore::new());
        let state = VaultRuntimeState::open_with_store(&db_path, key_store, "in-memory-test");

        // Pre-populate encrypted cache for 00700.HK so partial failure can fall back to it.
        state
            .with_unlocked(|db, _| {
                db.upsert_quote_cache(&[CachedPublicQuote {
                    symbol: "00700.HK".into(),
                    price: "380.0000".into(),
                    change: "2.0000".into(),
                    change_pct: "0.53".into(),
                    currency: "HKD".into(),
                    provider: "stooq.com".into(),
                    as_of_utc: "2026-11-21T08:00:00.000Z".into(),
                    delayed: true,
                }])
                .map_err(|e| e.to_string())
            })
            .expect("seed cache");

        // Partial failure: AAPL succeeds, 00700.HK fails -> AAPL fresh, 00700.HK from cache, degraded_reason populated.
        let partial_resp = fetch_public_quotes_with_vault_cache(
            &state,
            vec!["AAPL".into(), "00700.HK".into()],
            Some("stooq".into()),
            |_syms, _prov| async {
                Ok(PublicQuoteBatchOutcome {
                    quotes: vec![CachedPublicQuote {
                        symbol: "AAPL".into(),
                        price: "230.0000".into(),
                        change: "0.0000".into(),
                        change_pct: "0.00".into(),
                        currency: "USD".into(),
                        provider: "stooq.com".into(),
                        as_of_utc: "2026-11-21T21:00:00.000Z".into(),
                        delayed: true,
                    }],
                    failed_symbols: vec!["00700.HK".into()],
                    last_error: Some("upstream timeout".into()),
                    timed_out: false,
                })
            },
        )
        .await
        .expect("partial fallback succeeds");

        assert!(!partial_resp.from_cache);
        assert_eq!(partial_resp.quotes.len(), 2);
        assert_eq!(partial_resp.quotes[0].symbol, "AAPL");
        assert_eq!(partial_resp.quotes[0].price, "230.0000");
        assert_eq!(partial_resp.quotes[1].symbol, "00700.HK");
        assert_eq!(partial_resp.quotes[1].price, "380.0000");
        assert!(partial_resp
            .degraded_reason
            .as_deref()
            .unwrap_or("")
            .contains("00700.HK"));

        // Lock vault -> outbound quote fetcher MUST NOT be called at all.
        state
            .lock_session("manual", Some("local-csv"))
            .expect("lock");
        let fetcher_called = Arc::new(AtomicBool::new(false));
        let called_flag = Arc::clone(&fetcher_called);
        let locked_err = fetch_public_quotes_with_vault_cache(
            &state,
            vec!["AAPL".into()],
            Some("stooq".into()),
            move |_syms, _prov| async move {
                called_flag.store(true, Ordering::SeqCst);
                Err(QuoteError::Network("should not be reached".into()))
            },
        )
        .await
        .expect_err("locked vault must reject outbound quotes");
        assert!(!fetcher_called.load(Ordering::SeqCst));
        assert!(locked_err.to_ascii_lowercase().contains("lock"));

        if let Some(parent) = db_path.parent() {
            let _ = fs::remove_dir_all(parent);
        }
    }

    #[test]
    fn bounded_file_read_enforces_limit_without_toctou_and_decodes_utf8_bom_utf16le_and_gbk() {
        let dir = temp_vault_path("bounded-read")
            .parent()
            .expect("parent")
            .to_path_buf();
        fs::create_dir_all(&dir).expect("mkdir");

        // Enforce strict byte cap via File::take(limit + 1)
        let cap_file = dir.join("capped.csv");
        fs::write(&cap_file, vec![b'A'; 65]).expect("write");
        assert!(read_bounded_file_bytes(&cap_file, 64, "CSV").is_err());
        assert_eq!(
            read_bounded_file_bytes(&cap_file, 65, "CSV")
                .expect("exact limit")
                .len(),
            65
        );

        // UTF-8 BOM
        let mut utf8_bom = vec![0xEF, 0xBB, 0xBF];
        utf8_bom.extend_from_slice("股票代码,持有数量\nHK.00700,100\n".as_bytes());
        let decoded_utf8 = decode_csv_bytes(&utf8_bom).expect("utf8 bom");
        assert!(decoded_utf8.starts_with("股票代码"));

        // UTF-16LE with BOM
        let sample = "Symbol,Quantity\nAAPL,10\n";
        let mut utf16le = vec![0xFF, 0xFE];
        for unit in sample.encode_utf16() {
            utf16le.extend_from_slice(&unit.to_le_bytes());
        }
        let decoded_utf16 = decode_csv_bytes(&utf16le).expect("utf16le");
        assert_eq!(decoded_utf16, sample);

        // GBK Chinese brokerage CSV
        let gbk_source = "股票代码,股票名称,持有数量,稀释成本价,现价,市值,币种\nHK.00700,腾讯控股,100,320,380,38000,港元\n";
        let (gbk_bytes, _, had_errors) = encoding_rs::GBK.encode(gbk_source);
        assert!(!had_errors);
        let decoded_gbk = decode_csv_bytes(&gbk_bytes).expect("gbk");
        assert_eq!(decoded_gbk, gbk_source);

        let _ = fs::remove_dir_all(&dir);
    }
}
