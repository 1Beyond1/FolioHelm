//! Encrypted SQLite vault storage for FolioHelm.
//!
//! All financial records (evidence entries, imported portfolio snapshots, paper
//! orders, cached public quotes, and safety settings) are encrypted at rest
//! with AES-256-GCM using a 256-bit key stored in the OS credential manager.
//! Each record binds `(schema_version, table, record_id)` as AEAD AAD.
//!
//! Fail-closed guarantees:
//! - Opening an existing DB without its OS keyring key fails immediately and
//!   never creates a fresh key or truncates existing ciphertext.
//! - Opening an existing DB whose canary or records fail GCM authentication
//!   fails immediately and preserves the untouched file for forensics/recovery.

use std::{
    collections::{BTreeMap, BTreeSet},
    fmt, fs,
    io::Write,
    path::{Path, PathBuf},
};

use chrono::{NaiveDate, SecondsFormat, Utc};
use ed25519_dalek::SigningKey;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use thiserror::Error;
use zeroize::Zeroizing;

use crate::{
    evidence::{encode_hex, EvidenceJournal, SignedEvidenceEntry},
    vault::{
        build_aad, decode_signing_key_hex, decrypt_record, encrypt_record,
        validate_app_lock_verifier, AppLockVerifier, KeyStore, VaultError, VaultKeyMaterial,
        VAULT_CRYPTO_VERSION,
    },
};

pub const STORAGE_SCHEMA_VERSION: u16 = 1;
pub const DEFAULT_ACCOUNT_ID: &str = "acct_default";
const CANARY_PLAINTEXT: &[u8] = b"foliohelm-vault-canary-v1";
const CANARY_RECORD_ID: &str = "canary";
const APP_LOCK_VERIFIER_META_KEY: &str = "app_lock_verifier";
const APP_LOCK_BACKOFF_META_KEY: &str = "app_lock_backoff";
const RESTORE_INTENT_AAD_TABLE: &str = "restore_intent";
const RESTORE_INTENT_RECORD_ID: &str = "active";

fn default_order_currency() -> String {
    "USD".to_string()
}

pub fn default_account_id() -> String {
    DEFAULT_ACCOUNT_ID.to_string()
}

pub mod i128_string_serde {
    use std::fmt;

    use serde::{
        de::{self, Visitor},
        Deserializer, Serializer,
    };

    pub fn serialize<S>(value: &i128, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_str(&value.to_string())
    }

    pub fn deserialize<'de, D>(deserializer: D) -> Result<i128, D::Error>
    where
        D: Deserializer<'de>,
    {
        struct I128Visitor;

        impl Visitor<'_> for I128Visitor {
            type Value = i128;

            fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
                formatter.write_str("a base-10 integer string or integer representing i128")
            }

            fn visit_i64<E>(self, v: i64) -> Result<Self::Value, E> {
                Ok(i128::from(v))
            }

            fn visit_u64<E>(self, v: u64) -> Result<Self::Value, E> {
                Ok(i128::from(v))
            }

            fn visit_i128<E>(self, v: i128) -> Result<Self::Value, E> {
                Ok(v)
            }

            fn visit_u128<E>(self, v: u128) -> Result<Self::Value, E>
            where
                E: de::Error,
            {
                i128::try_from(v).map_err(|_| E::custom("u128 out of i128 range"))
            }

            fn visit_str<E>(self, v: &str) -> Result<Self::Value, E>
            where
                E: de::Error,
            {
                v.trim()
                    .parse::<i128>()
                    .map_err(|_| E::custom(format!("invalid i128 string: {v}")))
            }
        }

        deserializer.deserialize_any(I128Visitor)
    }
}

mod zeroizing_string_serde {
    use serde::{Deserialize, Deserializer, Serializer};
    use zeroize::Zeroizing;

    pub fn serialize<S>(value: &Zeroizing<String>, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_str(value.as_str())
    }

    pub fn deserialize<'de, D>(deserializer: D) -> Result<Zeroizing<String>, D::Error>
    where
        D: Deserializer<'de>,
    {
        String::deserialize(deserializer).map(Zeroizing::new)
    }
}

/// Atomically write bytes to `dest` via a sibling temporary file + `sync_all` + `rename`.
///
/// Using the same parent directory guarantees same-filesystem atomic replacement and
/// prevents partially written `.fhvault` backups or recovery intent files on crash.
pub fn atomic_write_bytes(dest: &Path, data: &[u8]) -> Result<(), std::io::Error> {
    let parent = dest
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    fs::create_dir_all(parent)?;

    let base_name = dest
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("foliohelm-file");
    let mut nonce = [0_u8; 8];
    getrandom::fill(&mut nonce)
        .map_err(|_| std::io::Error::other("OS CSPRNG unavailable for temp file"))?;
    let tmp_path = parent.join(format!(".{base_name}.tmp-{}", encode_hex(&nonce)));

    let write_result = (|| -> Result<(), std::io::Error> {
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&tmp_path)?;
        file.write_all(data)?;
        file.sync_all()?;
        Ok(())
    })();

    if let Err(error) = write_result {
        let _ = fs::remove_file(&tmp_path);
        return Err(error);
    }

    if let Err(error) = fs::rename(&tmp_path, dest) {
        let _ = fs::remove_file(&tmp_path);
        return Err(error);
    }

    Ok(())
}

#[derive(Debug, Error)]
pub enum StorageError {
    #[error("{0}")]
    Vault(#[from] VaultError),
    #[error("SQLite storage error: {0}")]
    Sqlite(#[from] rusqlite::Error),
    #[error("I/O error while accessing encrypted vault: {0}")]
    Io(#[from] std::io::Error),
    #[error("serialization error inside encrypted vault: {0}")]
    Serialization(#[from] serde_json::Error),
    #[error("encrypted vault integrity check failed: {0}")]
    Integrity(String),
    #[error("invalid storage input: {0}")]
    InvalidInput(String),
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredPortfolioHolding {
    pub symbol: String,
    pub company: String,
    /// Exact decimal string (never IEEE-754 float).
    pub quantity: String,
    /// Exact decimal string (never IEEE-754 float).
    pub average_cost: String,
    /// Exact decimal string from CSV import (used as fallback when public quotes are off/unavailable).
    pub last_price: String,
    pub currency: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredPortfolioTransaction {
    pub date: String,
    pub action: String,
    pub symbol: String,
    pub quantity: String,
    pub price: String,
    pub amount: String,
    pub fees: String,
    pub currency: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredAccount {
    pub id: String,
    pub name: String,
    pub broker: String,
    pub account_type: String,
    pub base_currency: String,
    pub created_at: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredNavSnapshot {
    /// YYYY-MM-DD
    pub date: String,
    #[serde(default = "default_account_id")]
    pub account_id: String,
    pub currency: String,
    #[serde(with = "i128_string_serde")]
    pub net_value_micros: i128,
    #[serde(with = "i128_string_serde")]
    pub cash_micros: i128,
    #[serde(with = "i128_string_serde")]
    pub positions_micros: i128,
    #[serde(default, with = "i128_string_serde")]
    pub external_cash_flow_micros: i128,
    pub source: String,
    pub updated_at: String,
}

impl StoredNavSnapshot {
    pub fn record_id(&self) -> String {
        format!(
            "{}|{}|{}",
            self.date.trim(),
            self.account_id.trim(),
            self.currency.trim().to_ascii_uppercase()
        )
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BenchmarkPricePoint {
    /// YYYY-MM-DD
    pub date: String,
    #[serde(with = "i128_string_serde")]
    pub close_micros: i128,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredBenchmarkSeries {
    pub symbol: String,
    pub currency: String,
    pub provider: String,
    pub as_of_utc: String,
    pub points: Vec<BenchmarkPricePoint>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredPortfolioSnapshot {
    pub id: String,
    #[serde(default = "default_account_id")]
    pub account_id: String,
    /// Deterministic SHA-256 hex digest of normalized snapshot content for idempotent imports.
    pub fingerprint: String,
    pub source_format: String,
    pub source_label: String,
    pub imported_at_utc: String,
    pub account_label: String,
    pub currency: String,
    /// Exact decimal string (for single-currency snapshots; "0.00" when multi-currency cash is isolated).
    pub cash: String,
    /// Exact decimal cash balances isolated by currency code (never summed cross-currency).
    #[serde(default)]
    pub cash_by_currency: BTreeMap<String, String>,
    /// Sorted unique currency codes across holdings and non-zero cash balances.
    #[serde(default)]
    pub currencies: Vec<String>,
    /// True when more than one currency is detected; UI and domain must isolate totals by currency.
    #[serde(default)]
    pub is_multi_currency: bool,
    pub holdings: Vec<StoredPortfolioHolding>,
    pub transactions: Vec<StoredPortfolioTransaction>,
    pub warnings: Vec<String>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PortfolioSaveOutcome {
    pub deduplicated: bool,
    pub snapshot: StoredPortfolioSnapshot,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredPaperOrderEvent {
    pub kind: String,
    pub at: String,
    pub detail_en: String,
    pub detail_zh: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredPaperOrder {
    pub id: String,
    pub workspace_mode: String,
    #[serde(default = "default_account_id")]
    pub account_id: String,
    pub symbol: String,
    pub side: String,
    pub order_type: String,
    pub quantity: String,
    pub filled_quantity: String,
    pub limit_price: Option<String>,
    #[serde(default = "default_order_currency")]
    pub currency: String,
    pub status: String,
    pub submitted_at: String,
    pub events: Vec<StoredPaperOrderEvent>,
}

#[derive(Clone, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppLockBackoffState {
    pub failed_attempts: u32,
    pub locked_until_unix: Option<i64>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CachedPublicQuote {
    pub symbol: String,
    /// Exact decimal string.
    pub price: String,
    /// Exact decimal string.
    pub change: String,
    /// Exact decimal string percentage.
    pub change_pct: String,
    pub currency: String,
    pub provider: String,
    pub as_of_utc: String,
    pub delayed: bool,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultStatusDto {
    pub unlocked: bool,
    pub lock_state: String,
    pub has_lock_passphrase: bool,
    pub retry_after_seconds: u64,
    pub cipher: String,
    pub schema_version: u16,
    pub key_provider: String,
    pub signer_public_key: Option<String>,
    pub evidence_count: u64,
    pub has_local_portfolio: bool,
    pub locked_reason: Option<String>,
}

#[derive(Clone, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultBackupPayload {
    pub schema_version: u16,
    pub exported_at_utc: String,
    #[serde(with = "zeroizing_string_serde")]
    pub device_signing_seed_hex: Zeroizing<String>,
    pub evidence_entries: Vec<SignedEvidenceEntry>,
    pub portfolio_snapshots: Vec<StoredPortfolioSnapshot>,
    pub paper_orders: Vec<StoredPaperOrder>,
    pub quote_cache: Vec<CachedPublicQuote>,
    pub settings: BTreeMap<String, String>,
    #[serde(default)]
    pub accounts: Vec<StoredAccount>,
    #[serde(default)]
    pub nav_snapshots: Vec<StoredNavSnapshot>,
    #[serde(default)]
    pub benchmark_history: Vec<StoredBenchmarkSeries>,
}

impl fmt::Debug for VaultBackupPayload {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("VaultBackupPayload")
            .field("schema_version", &self.schema_version)
            .field("exported_at_utc", &self.exported_at_utc)
            .field("device_signing_seed_hex", &"[REDACTED]")
            .field("evidence_entries_len", &self.evidence_entries.len())
            .field("portfolio_snapshots_len", &self.portfolio_snapshots.len())
            .field("paper_orders_len", &self.paper_orders.len())
            .field("quote_cache_len", &self.quote_cache.len())
            .field("settings_len", &self.settings.len())
            .field("accounts_len", &self.accounts.len())
            .field("nav_snapshots_len", &self.nav_snapshots.len())
            .field("benchmark_history_len", &self.benchmark_history.len())
            .finish()
    }
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RestoreIntentRecord {
    schema_version: u16,
    #[serde(with = "zeroizing_string_serde")]
    previous_seed_hex: Zeroizing<String>,
    #[serde(with = "zeroizing_string_serde")]
    target_seed_hex: Zeroizing<String>,
    staging_file_name: String,
    backup_file_name: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultRestoreSummaryDto {
    pub evidence_count: usize,
    pub portfolio_count: usize,
    pub paper_order_count: usize,
    pub quote_count: usize,
    pub setting_count: usize,
    #[serde(default)]
    pub account_count: usize,
    #[serde(default)]
    pub nav_snapshot_count: usize,
    #[serde(default)]
    pub benchmark_count: usize,
    pub signer_public_key: String,
}

pub struct EncryptedVaultDb {
    db_path: PathBuf,
    conn: Connection,
    keys: VaultKeyMaterial,
    key_provider: String,
}

fn restore_intent_path(db_path: &Path) -> PathBuf {
    let base = db_path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("foliohelm-vault.sqlite");
    db_path.with_file_name(format!("{base}.restore-intent"))
}

fn sqlite_sidecar_paths(db_path: &Path) -> [PathBuf; 2] {
    let base = db_path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("foliohelm-vault.sqlite");
    [
        db_path.with_file_name(format!("{base}-wal")),
        db_path.with_file_name(format!("{base}-shm")),
    ]
}

fn remove_sqlite_files(db_path: &Path) {
    let _ = fs::remove_file(db_path);
    for sidecar in sqlite_sidecar_paths(db_path) {
        let _ = fs::remove_file(sidecar);
    }
}

fn is_safe_sibling_file_name(name: &str) -> bool {
    !name.is_empty()
        && !name.contains('/')
        && !name.contains('\\')
        && !name.contains("..")
        && name != "."
}

fn sibling_file_path(db_path: &Path, file_name: &str) -> Result<PathBuf, StorageError> {
    if !is_safe_sibling_file_name(file_name) {
        return Err(StorageError::Integrity(
            "restore intent contains unsafe file name".to_string(),
        ));
    }
    Ok(db_path.with_file_name(file_name))
}

fn verify_sqlite_file_with_keys(
    path: &Path,
    db_master_key: &[u8; 32],
    signing_key: SigningKey,
) -> Result<EvidenceJournal, StorageError> {
    let conn = Connection::open(path)?;
    configure_connection(&conn)?;
    verify_connection_schema_and_canary(&conn, db_master_key)?;
    let entries = load_evidence_entries_from_conn(&conn, db_master_key)?;
    EvidenceJournal::from_persisted(signing_key, entries).map_err(|error| {
        StorageError::Integrity(format!(
            "vault evidence chain failed cryptographic verification: {error}"
        ))
    })
}

/// Automatically recover from a process crash that occurred mid-`.fhvault` atomic restore.
///
/// The `.restore-intent` file is AES-256-GCM encrypted under `db_master_key` (which never
/// changes across a restore). Depending on whether the OS keyring already switched to
/// `target_seed_hex` and whether `db_path` cryptographically verifies under it, this
/// either rolls forward cleanly or rolls back to the untouched pre-restore backup + old seed.
fn recover_interrupted_restore(
    db_path: &Path,
    key_store: &dyn KeyStore,
    keys: &mut VaultKeyMaterial,
) -> Result<(), StorageError> {
    let intent_path = restore_intent_path(db_path);
    if !intent_path.exists() {
        return Ok(());
    }

    let ciphertext = fs::read(&intent_path)?;
    let aad = build_aad(
        STORAGE_SCHEMA_VERSION,
        RESTORE_INTENT_AAD_TABLE,
        RESTORE_INTENT_RECORD_ID,
    );
    let plaintext = decrypt_record(keys.db_master_key(), &aad, &ciphertext)?;
    let intent: RestoreIntentRecord = serde_json::from_slice(&plaintext).map_err(|error| {
        StorageError::Integrity(format!("corrupted restore intent record: {error}"))
    })?;
    if intent.schema_version != STORAGE_SCHEMA_VERSION {
        return Err(StorageError::Integrity(format!(
            "unsupported restore intent schema version {}",
            intent.schema_version
        )));
    }

    let backup_path = sibling_file_path(db_path, &intent.backup_file_name)?;
    let staging_path = sibling_file_path(db_path, &intent.staging_file_name)?;

    let keyring_on_target = keys.signing_seed_matches_hex(&intent.target_seed_hex);
    if keyring_on_target
        && db_path.exists()
        && verify_sqlite_file_with_keys(db_path, keys.db_master_key(), keys.signing_key()).is_ok()
    {
        // Both DB and keyring already committed cleanly; remove recovery leftovers.
        remove_sqlite_files(&backup_path);
        remove_sqlite_files(&staging_path);
        let _ = fs::remove_file(&intent_path);
        return Ok(());
    }

    // Roll back to pre-restore backup and ensure OS keyring matches `previous_seed_hex`.
    if backup_path.exists() {
        remove_sqlite_files(db_path);
        fs::rename(&backup_path, db_path)?;
    }
    if !keys.signing_seed_matches_hex(&intent.previous_seed_hex) {
        let _ = keys.replace_signing_seed(key_store, &intent.previous_seed_hex)?;
    }
    remove_sqlite_files(&staging_path);
    let _ = fs::remove_file(&intent_path);
    Ok(())
}

impl EncryptedVaultDb {
    /// Open or initialize the encrypted SQLite database at `db_path`.
    pub fn open(
        db_path: &Path,
        key_store: &dyn KeyStore,
        key_provider: impl Into<String>,
    ) -> Result<Self, StorageError> {
        if let Some(parent) = db_path.parent() {
            if !parent.as_os_str().is_empty() {
                fs::create_dir_all(parent)?;
            }
        }

        let has_restore_intent = restore_intent_path(db_path).exists();
        let database_exists = has_restore_intent
            || match fs::metadata(db_path) {
                Ok(meta) => meta.len() > 0,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => false,
                Err(error) => return Err(StorageError::Io(error)),
            };

        // Load or initialize OS-protected key material before opening/creating SQLite.
        let mut keys = VaultKeyMaterial::load_or_initialize(key_store, database_exists)?;

        if has_restore_intent {
            recover_interrupted_restore(db_path, key_store, &mut keys)?;
        }

        let conn = Connection::open(db_path)?;
        configure_connection(&conn)?;

        let mut db = Self {
            db_path: db_path.to_path_buf(),
            conn,
            keys,
            key_provider: key_provider.into(),
        };

        if database_exists {
            db.verify_existing_schema_and_canary()?;
            db.migrate_legacy_app_lock_verifier_if_needed()?;
            ensure_wave2_tables_on_conn(&db.conn)?;
            db.ensure_default_account_if_missing()?;
        } else {
            db.initialize_schema()?;
            db.ensure_default_account_if_missing()?;
        }

        Ok(db)
    }

    pub fn signing_key(&self) -> SigningKey {
        self.keys.signing_key()
    }

    pub fn signer_public_key_hex(&self) -> String {
        encode_hex(&self.keys.signing_key().verifying_key().to_bytes())
    }

    pub fn status(&self) -> Result<VaultStatusDto, StorageError> {
        let evidence_count: i64 =
            self.conn
                .query_row("SELECT COUNT(*) FROM evidence_entries", [], |row| {
                    row.get(0)
                })?;
        let portfolio_count: i64 =
            self.conn
                .query_row("SELECT COUNT(*) FROM portfolio_snapshots", [], |row| {
                    row.get(0)
                })?;

        let has_lock_passphrase = self.load_app_lock_verifier()?.is_some();

        Ok(VaultStatusDto {
            unlocked: true,
            lock_state: "unlocked".to_string(),
            has_lock_passphrase,
            retry_after_seconds: 0,
            cipher: "AES-256-GCM + Ed25519".to_string(),
            schema_version: STORAGE_SCHEMA_VERSION,
            key_provider: self.key_provider.clone(),
            signer_public_key: Some(self.signer_public_key_hex()),
            evidence_count: u64::try_from(evidence_count).unwrap_or(0),
            has_local_portfolio: portfolio_count > 0,
            locked_reason: None,
        })
    }

    fn initialize_schema(&mut self) -> Result<(), StorageError> {
        initialize_schema_on_conn(&mut self.conn, self.keys.db_master_key())
    }

    fn verify_existing_schema_and_canary(&self) -> Result<(), StorageError> {
        verify_connection_schema_and_canary(&self.conn, self.keys.db_master_key())
    }

    pub fn load_evidence_entries(&self) -> Result<Vec<SignedEvidenceEntry>, StorageError> {
        load_evidence_entries_from_conn(&self.conn, self.keys.db_master_key())
    }

    pub fn insert_evidence_entry(
        &mut self,
        entry: &SignedEvidenceEntry,
    ) -> Result<(), StorageError> {
        let seq = i64::try_from(entry.event.sequence)
            .map_err(|_| StorageError::InvalidInput("evidence sequence overflow".to_string()))?;
        let aad = build_aad(
            STORAGE_SCHEMA_VERSION,
            "evidence_entries",
            &entry.event.sequence.to_string(),
        );
        let plaintext = serde_json::to_vec(entry)?;
        let ciphertext = encrypt_record(self.keys.db_master_key(), &aad, &plaintext)?;

        let tx = self.conn.transaction()?;
        tx.execute(
            "INSERT INTO evidence_entries (sequence, event_id, occurred_at_utc, ciphertext)
             VALUES (?1, ?2, ?3, ?4)",
            params![
                seq,
                entry.event.event_id,
                entry.event.occurred_at_utc,
                ciphertext
            ],
        )?;
        tx.commit()?;
        Ok(())
    }

    pub fn replace_evidence_entries(
        &mut self,
        entries: &[SignedEvidenceEntry],
    ) -> Result<(), StorageError> {
        let tx = self.conn.transaction()?;
        tx.execute("DELETE FROM evidence_entries", [])?;
        for entry in entries {
            let seq = i64::try_from(entry.event.sequence).map_err(|_| {
                StorageError::InvalidInput("evidence sequence overflow".to_string())
            })?;
            let aad = build_aad(
                STORAGE_SCHEMA_VERSION,
                "evidence_entries",
                &entry.event.sequence.to_string(),
            );
            let plaintext = serde_json::to_vec(entry)?;
            let ciphertext = encrypt_record(self.keys.db_master_key(), &aad, &plaintext)?;
            tx.execute(
                "INSERT INTO evidence_entries (sequence, event_id, occurred_at_utc, ciphertext)
                 VALUES (?1, ?2, ?3, ?4)",
                params![
                    seq,
                    entry.event.event_id,
                    entry.event.occurred_at_utc,
                    ciphertext
                ],
            )?;
        }
        tx.commit()?;
        Ok(())
    }

    pub fn clear_evidence_entries(&mut self) -> Result<(), StorageError> {
        let tx = self.conn.transaction()?;
        tx.execute("DELETE FROM evidence_entries", [])?;
        tx.commit()?;
        Ok(())
    }

    /// Persist a normalized CSV portfolio snapshot encrypted at rest.
    ///
    /// Idempotent by deterministic `fingerprint`: re-importing the identical
    /// snapshot returns `deduplicated = true` and preserves the existing record.
    pub fn save_portfolio_snapshot(
        &mut self,
        snapshot: &StoredPortfolioSnapshot,
    ) -> Result<PortfolioSaveOutcome, StorageError> {
        if snapshot.id.trim().is_empty() || snapshot.fingerprint.trim().is_empty() {
            return Err(StorageError::InvalidInput(
                "portfolio snapshot id and fingerprint are required".to_string(),
            ));
        }

        let existing: Option<(String, Vec<u8>)> = self
            .conn
            .query_row(
                "SELECT id, ciphertext FROM portfolio_snapshots WHERE fingerprint = ?1",
                params![snapshot.fingerprint],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;

        if let Some((existing_id, ciphertext)) = existing {
            let aad = build_aad(STORAGE_SCHEMA_VERSION, "portfolio_snapshots", &existing_id);
            let plaintext = decrypt_record(self.keys.db_master_key(), &aad, &ciphertext)?;
            let stored: StoredPortfolioSnapshot = serde_json::from_slice(&plaintext)?;
            return Ok(PortfolioSaveOutcome {
                deduplicated: true,
                snapshot: stored,
            });
        }

        let aad = build_aad(STORAGE_SCHEMA_VERSION, "portfolio_snapshots", &snapshot.id);
        let plaintext = serde_json::to_vec(snapshot)?;
        let ciphertext = encrypt_record(self.keys.db_master_key(), &aad, &plaintext)?;

        let tx = self.conn.transaction()?;
        tx.execute(
            "INSERT INTO portfolio_snapshots (id, fingerprint, source_format, imported_at_utc, ciphertext)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![
                snapshot.id,
                snapshot.fingerprint,
                snapshot.source_format,
                snapshot.imported_at_utc,
                ciphertext
            ],
        )?;
        tx.commit()?;

        Ok(PortfolioSaveOutcome {
            deduplicated: false,
            snapshot: snapshot.clone(),
        })
    }

    pub fn load_latest_portfolio_snapshot(
        &self,
    ) -> Result<Option<StoredPortfolioSnapshot>, StorageError> {
        let row: Option<(String, Vec<u8>)> = self
            .conn
            .query_row(
                "SELECT id, ciphertext FROM portfolio_snapshots
                 ORDER BY imported_at_utc DESC, rowid DESC LIMIT 1",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;
        let Some((id, ciphertext)) = row else {
            return Ok(None);
        };
        let aad = build_aad(STORAGE_SCHEMA_VERSION, "portfolio_snapshots", &id);
        let plaintext = decrypt_record(self.keys.db_master_key(), &aad, &ciphertext)?;
        let snapshot: StoredPortfolioSnapshot = serde_json::from_slice(&plaintext)?;
        Ok(Some(snapshot))
    }

    pub fn has_portfolio_fingerprint(&self, fingerprint: &str) -> Result<bool, StorageError> {
        let count: i64 = self.conn.query_row(
            "SELECT COUNT(*) FROM portfolio_snapshots WHERE fingerprint = ?1",
            params![fingerprint],
            |row| row.get(0),
        )?;
        Ok(count > 0)
    }

    pub fn clear_portfolio_snapshots(&mut self) -> Result<(), StorageError> {
        let tx = self.conn.transaction()?;
        tx.execute("DELETE FROM portfolio_snapshots", [])?;
        tx.commit()?;
        Ok(())
    }

    pub fn save_paper_order(&mut self, order: &StoredPaperOrder) -> Result<(), StorageError> {
        if order.id.trim().is_empty() {
            return Err(StorageError::InvalidInput(
                "paper order id must not be empty".to_string(),
            ));
        }
        if !matches!(order.workspace_mode.as_str(), "mock" | "local-csv") {
            return Err(StorageError::InvalidInput(
                "unsupported workspace_mode".to_string(),
            ));
        }
        let aad = build_aad(STORAGE_SCHEMA_VERSION, "paper_orders", &order.id);
        let plaintext = serde_json::to_vec(order)?;
        let ciphertext = encrypt_record(self.keys.db_master_key(), &aad, &plaintext)?;

        let tx = self.conn.transaction()?;
        tx.execute(
            "INSERT OR REPLACE INTO paper_orders (id, workspace_mode, submitted_at_utc, ciphertext)
             VALUES (?1, ?2, ?3, ?4)",
            params![
                order.id,
                order.workspace_mode,
                order.submitted_at,
                ciphertext
            ],
        )?;
        tx.commit()?;
        Ok(())
    }

    pub fn load_paper_orders(
        &self,
        workspace_mode: &str,
    ) -> Result<Vec<StoredPaperOrder>, StorageError> {
        let mut stmt = self.conn.prepare(
            "SELECT id, ciphertext FROM paper_orders
             WHERE workspace_mode = ?1
             ORDER BY submitted_at_utc DESC, rowid DESC",
        )?;
        let rows = stmt.query_map(params![workspace_mode], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, Vec<u8>>(1)?))
        })?;
        let mut orders = Vec::new();
        for row in rows {
            let (id, ciphertext) = row?;
            let aad = build_aad(STORAGE_SCHEMA_VERSION, "paper_orders", &id);
            let plaintext = decrypt_record(self.keys.db_master_key(), &aad, &ciphertext)?;
            orders.push(serde_json::from_slice(&plaintext)?);
        }
        Ok(orders)
    }

    pub fn upsert_quote_cache(&mut self, quotes: &[CachedPublicQuote]) -> Result<(), StorageError> {
        let tx = self.conn.transaction()?;
        for quote in quotes {
            let aad = build_aad(STORAGE_SCHEMA_VERSION, "quote_cache", &quote.symbol);
            let plaintext = serde_json::to_vec(quote)?;
            let ciphertext = encrypt_record(self.keys.db_master_key(), &aad, &plaintext)?;
            tx.execute(
                "INSERT OR REPLACE INTO quote_cache (symbol, provider, as_of_utc, ciphertext)
                 VALUES (?1, ?2, ?3, ?4)",
                params![quote.symbol, quote.provider, quote.as_of_utc, ciphertext],
            )?;
        }
        tx.commit()?;
        Ok(())
    }

    pub fn load_quote_cache(&self) -> Result<Vec<CachedPublicQuote>, StorageError> {
        let mut stmt = self
            .conn
            .prepare("SELECT symbol, ciphertext FROM quote_cache ORDER BY symbol ASC")?;
        let rows = stmt.query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, Vec<u8>>(1)?))
        })?;
        let mut quotes = Vec::new();
        for row in rows {
            let (symbol, ciphertext) = row?;
            let aad = build_aad(STORAGE_SCHEMA_VERSION, "quote_cache", &symbol);
            let plaintext = decrypt_record(self.keys.db_master_key(), &aad, &ciphertext)?;
            quotes.push(serde_json::from_slice(&plaintext)?);
        }
        Ok(quotes)
    }

    pub fn save_setting(&mut self, key: &str, value_json: &str) -> Result<(), StorageError> {
        if key.trim().is_empty() || key.len() > 128 {
            return Err(StorageError::InvalidInput(
                "setting key must be 1..=128 characters".to_string(),
            ));
        }
        let aad = build_aad(STORAGE_SCHEMA_VERSION, "app_settings", key);
        let ciphertext = encrypt_record(self.keys.db_master_key(), &aad, value_json.as_bytes())?;
        let now = Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true);

        let tx = self.conn.transaction()?;
        tx.execute(
            "INSERT OR REPLACE INTO app_settings (setting_key, updated_at_utc, ciphertext)
             VALUES (?1, ?2, ?3)",
            params![key, now, ciphertext],
        )?;
        tx.commit()?;
        Ok(())
    }

    pub fn load_setting(&self, key: &str) -> Result<Option<String>, StorageError> {
        let ciphertext: Option<Vec<u8>> = self
            .conn
            .query_row(
                "SELECT ciphertext FROM app_settings WHERE setting_key = ?1",
                params![key],
                |row| row.get(0),
            )
            .optional()?;
        let Some(ciphertext) = ciphertext else {
            return Ok(None);
        };
        let aad = build_aad(STORAGE_SCHEMA_VERSION, "app_settings", key);
        let plaintext = decrypt_record(self.keys.db_master_key(), &aad, &ciphertext)?;
        let value = String::from_utf8(plaintext.to_vec()).map_err(|_| {
            StorageError::Integrity(format!("setting {key} decrypted to invalid UTF-8"))
        })?;
        Ok(Some(value))
    }

    pub fn load_app_lock_verifier(&self) -> Result<Option<AppLockVerifier>, StorageError> {
        let raw: Option<Vec<u8>> = self
            .conn
            .query_row(
                "SELECT meta_value FROM vault_meta WHERE meta_key = ?1",
                params![APP_LOCK_VERIFIER_META_KEY],
                |row| row.get(0),
            )
            .optional()?;
        let Some(bytes) = raw else {
            return Ok(None);
        };
        if bytes.is_empty() {
            return Err(StorageError::Integrity(
                "app lock verifier record is empty".to_string(),
            ));
        }

        let verifier: AppLockVerifier = if bytes[0] == VAULT_CRYPTO_VERSION {
            let aad = build_aad(
                STORAGE_SCHEMA_VERSION,
                "vault_meta",
                APP_LOCK_VERIFIER_META_KEY,
            );
            let plaintext = decrypt_record(self.keys.db_master_key(), &aad, &bytes)?;
            serde_json::from_slice(&plaintext).map_err(|error| {
                StorageError::Integrity(format!(
                    "decrypted app lock verifier is malformed: {error}"
                ))
            })?
        } else if bytes.iter().copied().find(|b| !b.is_ascii_whitespace()) == Some(b'{') {
            // Backward-compatible read of legacy plaintext JSON verifier (migrated on open).
            serde_json::from_slice(&bytes).map_err(|error| {
                StorageError::Integrity(format!("legacy app lock verifier is malformed: {error}"))
            })?
        } else {
            return Err(StorageError::Integrity(
                "app lock verifier record has unrecognized encoding".to_string(),
            ));
        };

        validate_app_lock_verifier(&verifier)?;
        Ok(Some(verifier))
    }

    /// Transparently migrate a legacy plaintext `app_lock_verifier` JSON record in
    /// `vault_meta` to AES-256-GCM ciphertext with AAD on vault open.
    fn migrate_legacy_app_lock_verifier_if_needed(&mut self) -> Result<(), StorageError> {
        let raw: Option<Vec<u8>> = self
            .conn
            .query_row(
                "SELECT meta_value FROM vault_meta WHERE meta_key = ?1",
                params![APP_LOCK_VERIFIER_META_KEY],
                |row| row.get(0),
            )
            .optional()?;
        let Some(bytes) = raw else {
            return Ok(());
        };
        if bytes.first() == Some(&VAULT_CRYPTO_VERSION) {
            // Already encrypted; verify it decrypts cleanly fail-closed.
            let _ = self.load_app_lock_verifier()?;
            return Ok(());
        }
        let verifier = self.load_app_lock_verifier()?;
        self.save_app_lock_verifier(verifier.as_ref())
    }

    pub fn save_app_lock_verifier(
        &mut self,
        verifier: Option<&AppLockVerifier>,
    ) -> Result<(), StorageError> {
        let tx = self.conn.transaction()?;
        match verifier {
            Some(v) => {
                validate_app_lock_verifier(v)?;
                let plaintext = Zeroizing::new(serde_json::to_vec(v)?);
                let aad = build_aad(
                    STORAGE_SCHEMA_VERSION,
                    "vault_meta",
                    APP_LOCK_VERIFIER_META_KEY,
                );
                let ciphertext = encrypt_record(self.keys.db_master_key(), &aad, &plaintext)?;
                tx.execute(
                    "INSERT OR REPLACE INTO vault_meta (meta_key, meta_value) VALUES (?1, ?2)",
                    params![APP_LOCK_VERIFIER_META_KEY, ciphertext],
                )?;
            }
            None => {
                tx.execute(
                    "DELETE FROM vault_meta WHERE meta_key = ?1",
                    params![APP_LOCK_VERIFIER_META_KEY],
                )?;
                tx.execute(
                    "DELETE FROM vault_meta WHERE meta_key = ?1",
                    params![APP_LOCK_BACKOFF_META_KEY],
                )?;
            }
        }
        tx.commit()?;
        Ok(())
    }

    pub fn load_app_lock_backoff(&self) -> Result<AppLockBackoffState, StorageError> {
        let raw: Option<Vec<u8>> = self
            .conn
            .query_row(
                "SELECT meta_value FROM vault_meta WHERE meta_key = ?1",
                params![APP_LOCK_BACKOFF_META_KEY],
                |row| row.get(0),
            )
            .optional()?;
        let Some(ciphertext) = raw else {
            return Ok(AppLockBackoffState::default());
        };
        let aad = build_aad(
            STORAGE_SCHEMA_VERSION,
            "vault_meta",
            APP_LOCK_BACKOFF_META_KEY,
        );
        let plaintext = decrypt_record(self.keys.db_master_key(), &aad, &ciphertext)?;
        serde_json::from_slice(&plaintext).map_err(|error| {
            StorageError::Integrity(format!(
                "decrypted app lock backoff state is malformed: {error}"
            ))
        })
    }

    pub fn save_app_lock_backoff(
        &mut self,
        state: &AppLockBackoffState,
    ) -> Result<(), StorageError> {
        let tx = self.conn.transaction()?;
        if state.failed_attempts == 0 && state.locked_until_unix.is_none() {
            tx.execute(
                "DELETE FROM vault_meta WHERE meta_key = ?1",
                params![APP_LOCK_BACKOFF_META_KEY],
            )?;
        } else {
            let plaintext = serde_json::to_vec(state)?;
            let aad = build_aad(
                STORAGE_SCHEMA_VERSION,
                "vault_meta",
                APP_LOCK_BACKOFF_META_KEY,
            );
            let ciphertext = encrypt_record(self.keys.db_master_key(), &aad, &plaintext)?;
            tx.execute(
                "INSERT OR REPLACE INTO vault_meta (meta_key, meta_value) VALUES (?1, ?2)",
                params![APP_LOCK_BACKOFF_META_KEY, ciphertext],
            )?;
        }
        tx.commit()?;
        Ok(())
    }

    pub fn load_all_portfolio_snapshots(
        &self,
    ) -> Result<Vec<StoredPortfolioSnapshot>, StorageError> {
        let mut stmt = self.conn.prepare(
            "SELECT id, ciphertext FROM portfolio_snapshots ORDER BY imported_at_utc ASC, rowid ASC",
        )?;
        let rows = stmt.query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, Vec<u8>>(1)?))
        })?;
        let mut snapshots = Vec::new();
        for row in rows {
            let (id, ciphertext) = row?;
            let aad = build_aad(STORAGE_SCHEMA_VERSION, "portfolio_snapshots", &id);
            let plaintext = decrypt_record(self.keys.db_master_key(), &aad, &ciphertext)?;
            snapshots.push(serde_json::from_slice(&plaintext)?);
        }
        Ok(snapshots)
    }

    pub fn load_all_paper_orders(&self) -> Result<Vec<StoredPaperOrder>, StorageError> {
        let mut stmt = self.conn.prepare(
            "SELECT id, ciphertext FROM paper_orders ORDER BY submitted_at_utc ASC, rowid ASC",
        )?;
        let rows = stmt.query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, Vec<u8>>(1)?))
        })?;
        let mut orders = Vec::new();
        for row in rows {
            let (id, ciphertext) = row?;
            let aad = build_aad(STORAGE_SCHEMA_VERSION, "paper_orders", &id);
            let plaintext = decrypt_record(self.keys.db_master_key(), &aad, &ciphertext)?;
            orders.push(serde_json::from_slice(&plaintext)?);
        }
        Ok(orders)
    }

    pub fn load_all_settings(&self) -> Result<BTreeMap<String, String>, StorageError> {
        let mut stmt = self
            .conn
            .prepare("SELECT setting_key, ciphertext FROM app_settings ORDER BY setting_key ASC")?;
        let rows = stmt.query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, Vec<u8>>(1)?))
        })?;
        let mut settings = BTreeMap::new();
        for row in rows {
            let (key, ciphertext) = row?;
            let aad = build_aad(STORAGE_SCHEMA_VERSION, "app_settings", &key);
            let plaintext = decrypt_record(self.keys.db_master_key(), &aad, &ciphertext)?;
            let value = String::from_utf8(plaintext.to_vec()).map_err(|_| {
                StorageError::Integrity(format!("setting {key} decrypted to invalid UTF-8"))
            })?;
            settings.insert(key, value);
        }
        Ok(settings)
    }

    /// Ensure at least the default account (`acct_default`) exists so legacy single-account
    /// snapshots, paper orders, and NAV records smoothly migrate without breaking existing data.
    pub fn ensure_default_account_if_missing(&mut self) -> Result<(), StorageError> {
        let count: i64 = self
            .conn
            .query_row("SELECT COUNT(*) FROM accounts", [], |row| row.get(0))?;
        if count > 0 {
            return Ok(());
        }
        let inferred_currency = self
            .load_latest_portfolio_snapshot()
            .ok()
            .flatten()
            .and_then(|snap| {
                let c = snap.currency.trim().to_ascii_uppercase();
                if !c.is_empty() && c != "MULTI" && c.len() >= 3 && c.len() <= 5 {
                    Some(c)
                } else {
                    snap.currencies
                        .first()
                        .map(|first| first.trim().to_ascii_uppercase())
                }
            })
            .filter(|c| !c.is_empty() && c != "MULTI")
            .unwrap_or_else(|| "USD".to_string());

        let default_acct = StoredAccount {
            id: DEFAULT_ACCOUNT_ID.to_string(),
            name: "Default Account".to_string(),
            broker: "Local CSV".to_string(),
            account_type: "taxable".to_string(),
            base_currency: inferred_currency,
            created_at: Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true),
        };
        let _ = self.upsert_account(&default_acct)?;
        Ok(())
    }

    pub fn list_accounts(&self) -> Result<Vec<StoredAccount>, StorageError> {
        let mut stmt = self.conn.prepare(
            "SELECT id, ciphertext FROM accounts ORDER BY created_at_utc ASC, rowid ASC",
        )?;
        let rows = stmt.query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, Vec<u8>>(1)?))
        })?;
        let mut accounts = Vec::new();
        for row in rows {
            let (id, ciphertext) = row?;
            let aad = build_aad(STORAGE_SCHEMA_VERSION, "accounts", &id);
            let plaintext = decrypt_record(self.keys.db_master_key(), &aad, &ciphertext)?;
            accounts.push(serde_json::from_slice(&plaintext)?);
        }
        Ok(accounts)
    }

    pub fn upsert_account(
        &mut self,
        account: &StoredAccount,
    ) -> Result<StoredAccount, StorageError> {
        let normalized = validate_and_normalize_account(account)?;
        let aad = build_aad(STORAGE_SCHEMA_VERSION, "accounts", &normalized.id);
        let plaintext = serde_json::to_vec(&normalized)?;
        let ciphertext = encrypt_record(self.keys.db_master_key(), &aad, &plaintext)?;

        let tx = self.conn.transaction()?;
        tx.execute(
            "INSERT OR REPLACE INTO accounts (id, created_at_utc, ciphertext)
             VALUES (?1, ?2, ?3)",
            params![normalized.id, normalized.created_at, ciphertext],
        )?;
        tx.commit()?;
        Ok(normalized)
    }

    pub fn delete_account(&mut self, account_id: &str) -> Result<bool, StorageError> {
        let trimmed = account_id.trim();
        if trimmed.is_empty() {
            return Err(StorageError::InvalidInput(
                "account_id must not be empty".to_string(),
            ));
        }
        if trimmed == DEFAULT_ACCOUNT_ID {
            return Err(StorageError::InvalidInput(
                "default account cannot be deleted".to_string(),
            ));
        }
        let tx = self.conn.transaction()?;
        let deleted = tx.execute("DELETE FROM accounts WHERE id = ?1", params![trimmed])?;
        tx.execute(
            "DELETE FROM nav_snapshots WHERE account_id = ?1",
            params![trimmed],
        )?;
        tx.commit()?;

        // Also remove any portfolio snapshots scoped to the deleted account.
        let all_snaps = self.load_all_portfolio_snapshots()?;
        let ids_to_remove: Vec<String> = all_snaps
            .into_iter()
            .filter(|snap| snap.account_id == trimmed)
            .map(|snap| snap.id)
            .collect();
        if !ids_to_remove.is_empty() {
            let tx2 = self.conn.transaction()?;
            for snap_id in ids_to_remove {
                tx2.execute(
                    "DELETE FROM portfolio_snapshots WHERE id = ?1",
                    params![snap_id],
                )?;
            }
            tx2.commit()?;
        }

        Ok(deleted > 0)
    }

    /// Returns the most recent `StoredPortfolioSnapshot` for each distinct `account_id`.
    pub fn load_latest_portfolio_snapshots_per_account(
        &self,
    ) -> Result<Vec<StoredPortfolioSnapshot>, StorageError> {
        let all = self.load_all_portfolio_snapshots()?;
        let mut latest_by_account: BTreeMap<String, StoredPortfolioSnapshot> = BTreeMap::new();
        for mut snap in all {
            if snap.account_id.trim().is_empty() {
                snap.account_id = DEFAULT_ACCOUNT_ID.to_string();
            }
            // `all` is ordered chronologically ASC, so inserting keeps the latest snapshot per account.
            latest_by_account.insert(snap.account_id.clone(), snap);
        }
        Ok(latest_by_account.into_values().collect())
    }

    pub fn upsert_nav_snapshot(
        &mut self,
        snapshot: &StoredNavSnapshot,
        preserve_existing_cf: bool,
    ) -> Result<StoredNavSnapshot, StorageError> {
        let mut normalized = validate_and_normalize_nav_snapshot(snapshot)?;
        let record_id = normalized.record_id();

        if preserve_existing_cf && normalized.external_cash_flow_micros == 0 {
            let existing_blob: Option<Vec<u8>> = self
                .conn
                .query_row(
                    "SELECT ciphertext FROM nav_snapshots WHERE record_id = ?1",
                    params![record_id],
                    |row| row.get(0),
                )
                .optional()?;
            if let Some(blob) = existing_blob {
                let aad = build_aad(STORAGE_SCHEMA_VERSION, "nav_snapshots", &record_id);
                let plaintext = decrypt_record(self.keys.db_master_key(), &aad, &blob)?;
                let prev: StoredNavSnapshot = serde_json::from_slice(&plaintext)?;
                normalized.external_cash_flow_micros = prev.external_cash_flow_micros;
            }
        }

        let aad = build_aad(STORAGE_SCHEMA_VERSION, "nav_snapshots", &record_id);
        let plaintext = serde_json::to_vec(&normalized)?;
        let ciphertext = encrypt_record(self.keys.db_master_key(), &aad, &plaintext)?;

        let tx = self.conn.transaction()?;
        tx.execute(
            "INSERT OR REPLACE INTO nav_snapshots
                (record_id, date, account_id, currency, updated_at_utc, ciphertext)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                record_id,
                normalized.date,
                normalized.account_id,
                normalized.currency,
                normalized.updated_at,
                ciphertext
            ],
        )?;
        tx.commit()?;
        Ok(normalized)
    }

    pub fn load_all_nav_snapshots(&self) -> Result<Vec<StoredNavSnapshot>, StorageError> {
        self.load_nav_snapshots(None, None)
    }

    pub fn load_nav_snapshots(
        &self,
        account_id: Option<&str>,
        currency: Option<&str>,
    ) -> Result<Vec<StoredNavSnapshot>, StorageError> {
        let acct_filter = account_id
            .map(str::trim)
            .filter(|s| !s.is_empty() && !s.eq_ignore_ascii_case("ALL"));
        let curr_filter = currency
            .map(|c| c.trim().to_ascii_uppercase())
            .filter(|c| !c.is_empty() && c != "MULTI");

        let mut stmt = self.conn.prepare(
            "SELECT record_id, ciphertext FROM nav_snapshots
             ORDER BY date ASC, account_id ASC, currency ASC",
        )?;
        let rows = stmt.query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, Vec<u8>>(1)?))
        })?;
        let mut out = Vec::new();
        for row in rows {
            let (record_id, ciphertext) = row?;
            let aad = build_aad(STORAGE_SCHEMA_VERSION, "nav_snapshots", &record_id);
            let plaintext = decrypt_record(self.keys.db_master_key(), &aad, &ciphertext)?;
            let item: StoredNavSnapshot = serde_json::from_slice(&plaintext)?;
            if let Some(target_acct) = acct_filter {
                if item.account_id != target_acct {
                    continue;
                }
            }
            if let Some(ref target_curr) = curr_filter {
                if !item.currency.eq_ignore_ascii_case(target_curr) {
                    continue;
                }
            }
            out.push(item);
        }
        Ok(out)
    }

    pub fn clear_nav_snapshots(&mut self) -> Result<(), StorageError> {
        let tx = self.conn.transaction()?;
        tx.execute("DELETE FROM nav_snapshots", [])?;
        tx.commit()?;
        Ok(())
    }

    pub fn upsert_benchmark_series(
        &mut self,
        series: &StoredBenchmarkSeries,
    ) -> Result<(), StorageError> {
        let normalized = validate_and_normalize_benchmark_series(series)?;
        let aad = build_aad(
            STORAGE_SCHEMA_VERSION,
            "benchmark_history",
            &normalized.symbol,
        );
        let plaintext = serde_json::to_vec(&normalized)?;
        let ciphertext = encrypt_record(self.keys.db_master_key(), &aad, &plaintext)?;

        let tx = self.conn.transaction()?;
        tx.execute(
            "INSERT OR REPLACE INTO benchmark_history
                (symbol, currency, provider, updated_at_utc, ciphertext)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![
                normalized.symbol,
                normalized.currency,
                normalized.provider,
                normalized.as_of_utc,
                ciphertext
            ],
        )?;
        tx.commit()?;
        Ok(())
    }

    pub fn load_benchmark_series(
        &self,
        symbol: &str,
    ) -> Result<Option<StoredBenchmarkSeries>, StorageError> {
        let normalized = symbol.trim().to_ascii_uppercase();
        if normalized.is_empty() {
            return Ok(None);
        }
        let ciphertext: Option<Vec<u8>> = self
            .conn
            .query_row(
                "SELECT ciphertext FROM benchmark_history WHERE symbol = ?1",
                params![normalized],
                |row| row.get(0),
            )
            .optional()?;
        let Some(blob) = ciphertext else {
            return Ok(None);
        };
        let aad = build_aad(STORAGE_SCHEMA_VERSION, "benchmark_history", &normalized);
        let plaintext = decrypt_record(self.keys.db_master_key(), &aad, &blob)?;
        Ok(Some(serde_json::from_slice(&plaintext)?))
    }

    pub fn load_all_benchmark_series(&self) -> Result<Vec<StoredBenchmarkSeries>, StorageError> {
        let mut stmt = self
            .conn
            .prepare("SELECT symbol, ciphertext FROM benchmark_history ORDER BY symbol ASC")?;
        let rows = stmt.query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, Vec<u8>>(1)?))
        })?;
        let mut out = Vec::new();
        for row in rows {
            let (symbol, ciphertext) = row?;
            let aad = build_aad(STORAGE_SCHEMA_VERSION, "benchmark_history", &symbol);
            let plaintext = decrypt_record(self.keys.db_master_key(), &aad, &ciphertext)?;
            out.push(serde_json::from_slice(&plaintext)?);
        }
        Ok(out)
    }

    pub fn clear_benchmark_series(&mut self) -> Result<(), StorageError> {
        let tx = self.conn.transaction()?;
        tx.execute("DELETE FROM benchmark_history", [])?;
        tx.commit()?;
        Ok(())
    }

    /// Export all encrypted tables and the device signing seed into a payload ready for
    /// Argon2id + AES-256-GCM `.fhvault` backup encryption.
    pub fn export_backup_payload(&self) -> Result<VaultBackupPayload, StorageError> {
        let evidence_entries = self.load_evidence_entries()?;
        let portfolio_snapshots = self.load_all_portfolio_snapshots()?;
        let paper_orders = self.load_all_paper_orders()?;
        let quote_cache = self.load_quote_cache()?;
        let settings = self.load_all_settings()?;
        let accounts = self.list_accounts()?;
        let nav_snapshots = self.load_all_nav_snapshots()?;
        let benchmark_history = self.load_all_benchmark_series()?;
        let seed_hex = self.keys.device_signing_seed_hex();

        Ok(VaultBackupPayload {
            schema_version: STORAGE_SCHEMA_VERSION,
            exported_at_utc: Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true),
            device_signing_seed_hex: seed_hex,
            evidence_entries,
            portfolio_snapshots,
            paper_orders,
            quote_cache,
            settings,
            accounts,
            nav_snapshots,
            benchmark_history,
        })
    }

    /// Fail-closed, crash-safe atomic restore from a decrypted `.fhvault` backup payload.
    ///
    /// Guarantees:
    /// - Pre-validates schema version, Ed25519 signing seed, full evidence signature chain,
    ///   and uniqueness of ALL primary/unique keys BEFORE touching disk or OS keyring.
    /// - Writes all restored records encrypted under this device's `db_master_key` into an
    ///   independent sibling staging SQLite database, then re-reads and cryptographically
    ///   verifies its canary and full Ed25519 chain before switching.
    /// - Records an AES-256-GCM encrypted `.restore-intent` before swapping files and
    ///   syncing the OS keyring signing seed so any mid-restore crash recovers cleanly on
    ///   next startup without permanent bricking.
    pub fn restore_from_backup_payload(
        &mut self,
        payload: VaultBackupPayload,
        key_store: &dyn KeyStore,
    ) -> Result<(EvidenceJournal, VaultRestoreSummaryDto), StorageError> {
        if payload.schema_version != STORAGE_SCHEMA_VERSION {
            return Err(StorageError::Integrity(format!(
                "unsupported backup schema version {}",
                payload.schema_version
            )));
        }

        let restored_signing_key = decode_signing_key_hex(&payload.device_signing_seed_hex)?;
        let verified_journal = EvidenceJournal::from_persisted(
            restored_signing_key.clone(),
            payload.evidence_entries.clone(),
        )
        .map_err(|error| {
            StorageError::Integrity(format!(
                "backup evidence chain failed cryptographic verification: {error}"
            ))
        })?;

        // Pre-validate all record constraints and unique keys before writing anything.
        let mut seen_evidence_seq = BTreeSet::new();
        let mut seen_evidence_ids = BTreeSet::new();
        for entry in &payload.evidence_entries {
            if !seen_evidence_seq.insert(entry.event.sequence) {
                return Err(StorageError::InvalidInput(format!(
                    "backup contains duplicate evidence sequence {}",
                    entry.event.sequence
                )));
            }
            if !seen_evidence_ids.insert(entry.event.event_id.as_str()) {
                return Err(StorageError::InvalidInput(format!(
                    "backup contains duplicate evidence event_id '{}'",
                    entry.event.event_id
                )));
            }
        }

        let mut seen_portfolio_ids = BTreeSet::new();
        let mut seen_portfolio_fps = BTreeSet::new();
        for snapshot in &payload.portfolio_snapshots {
            if snapshot.id.trim().is_empty() || snapshot.fingerprint.trim().is_empty() {
                return Err(StorageError::InvalidInput(
                    "backup contains portfolio snapshot with empty id or fingerprint".to_string(),
                ));
            }
            if !seen_portfolio_ids.insert(snapshot.id.as_str()) {
                return Err(StorageError::InvalidInput(format!(
                    "backup contains duplicate portfolio snapshot id '{}'",
                    snapshot.id
                )));
            }
            if !seen_portfolio_fps.insert(snapshot.fingerprint.as_str()) {
                return Err(StorageError::InvalidInput(format!(
                    "backup contains duplicate portfolio snapshot fingerprint '{}'",
                    snapshot.fingerprint
                )));
            }
        }

        let mut seen_order_ids = BTreeSet::new();
        for order in &payload.paper_orders {
            if order.id.trim().is_empty()
                || !matches!(order.workspace_mode.as_str(), "mock" | "local-csv")
            {
                return Err(StorageError::InvalidInput(
                    "backup contains invalid paper order".to_string(),
                ));
            }
            if !seen_order_ids.insert(order.id.as_str()) {
                return Err(StorageError::InvalidInput(format!(
                    "backup contains duplicate paper order id '{}'",
                    order.id
                )));
            }
        }

        let mut seen_quote_symbols = BTreeSet::new();
        for quote in &payload.quote_cache {
            if quote.symbol.trim().is_empty() {
                return Err(StorageError::InvalidInput(
                    "backup contains quote cache entry with empty symbol".to_string(),
                ));
            }
            if !seen_quote_symbols.insert(quote.symbol.as_str()) {
                return Err(StorageError::InvalidInput(format!(
                    "backup contains duplicate quote cache symbol '{}'",
                    quote.symbol
                )));
            }
        }

        for key in payload.settings.keys() {
            if key.trim().is_empty() || key.len() > 128 {
                return Err(StorageError::InvalidInput(
                    "backup contains invalid setting key".to_string(),
                ));
            }
        }

        let mut seen_account_ids = BTreeSet::new();
        let mut normalized_accounts = Vec::with_capacity(payload.accounts.len());
        for account in &payload.accounts {
            let norm = validate_and_normalize_account(account)?;
            if !seen_account_ids.insert(norm.id.clone()) {
                return Err(StorageError::InvalidInput(format!(
                    "backup contains duplicate account id '{}'",
                    norm.id
                )));
            }
            normalized_accounts.push(norm);
        }

        let mut seen_nav_ids = BTreeSet::new();
        let mut normalized_nav_snapshots = Vec::with_capacity(payload.nav_snapshots.len());
        for snap in &payload.nav_snapshots {
            let norm = validate_and_normalize_nav_snapshot(snap)?;
            let record_id = norm.record_id();
            if !seen_nav_ids.insert(record_id.clone()) {
                return Err(StorageError::InvalidInput(format!(
                    "backup contains duplicate nav snapshot '{record_id}'"
                )));
            }
            normalized_nav_snapshots.push((record_id, norm));
        }

        let mut seen_bench_symbols = BTreeSet::new();
        let mut normalized_benchmarks = Vec::with_capacity(payload.benchmark_history.len());
        for series in &payload.benchmark_history {
            let norm = validate_and_normalize_benchmark_series(series)?;
            if !seen_bench_symbols.insert(norm.symbol.clone()) {
                return Err(StorageError::InvalidInput(format!(
                    "backup contains duplicate benchmark symbol '{}'",
                    norm.symbol
                )));
            }
            normalized_benchmarks.push(norm);
        }

        // Preserve local device App Lock configuration across backup restore.
        let preserved_verifier = self.load_app_lock_verifier()?;
        let preserved_backoff = self.load_app_lock_backoff()?;

        // Pre-encrypt every restored record with this device's db_master_key.
        let mut encrypted_evidence = Vec::with_capacity(payload.evidence_entries.len());
        for entry in &payload.evidence_entries {
            let seq = i64::try_from(entry.event.sequence).map_err(|_| {
                StorageError::InvalidInput("evidence sequence overflow".to_string())
            })?;
            let aad = build_aad(
                STORAGE_SCHEMA_VERSION,
                "evidence_entries",
                &entry.event.sequence.to_string(),
            );
            let plaintext = serde_json::to_vec(entry)?;
            let ciphertext = encrypt_record(self.keys.db_master_key(), &aad, &plaintext)?;
            encrypted_evidence.push((
                seq,
                entry.event.event_id.clone(),
                entry.event.occurred_at_utc.clone(),
                ciphertext,
            ));
        }

        let mut encrypted_portfolios = Vec::with_capacity(payload.portfolio_snapshots.len());
        for snapshot in &payload.portfolio_snapshots {
            let aad = build_aad(STORAGE_SCHEMA_VERSION, "portfolio_snapshots", &snapshot.id);
            let plaintext = serde_json::to_vec(snapshot)?;
            let ciphertext = encrypt_record(self.keys.db_master_key(), &aad, &plaintext)?;
            encrypted_portfolios.push((
                snapshot.id.clone(),
                snapshot.fingerprint.clone(),
                snapshot.source_format.clone(),
                snapshot.imported_at_utc.clone(),
                ciphertext,
            ));
        }

        let mut encrypted_orders = Vec::with_capacity(payload.paper_orders.len());
        for order in &payload.paper_orders {
            let aad = build_aad(STORAGE_SCHEMA_VERSION, "paper_orders", &order.id);
            let plaintext = serde_json::to_vec(order)?;
            let ciphertext = encrypt_record(self.keys.db_master_key(), &aad, &plaintext)?;
            encrypted_orders.push((
                order.id.clone(),
                order.workspace_mode.clone(),
                order.submitted_at.clone(),
                ciphertext,
            ));
        }

        let mut encrypted_quotes = Vec::with_capacity(payload.quote_cache.len());
        for quote in &payload.quote_cache {
            let aad = build_aad(STORAGE_SCHEMA_VERSION, "quote_cache", &quote.symbol);
            let plaintext = serde_json::to_vec(quote)?;
            let ciphertext = encrypt_record(self.keys.db_master_key(), &aad, &plaintext)?;
            encrypted_quotes.push((
                quote.symbol.clone(),
                quote.provider.clone(),
                quote.as_of_utc.clone(),
                ciphertext,
            ));
        }

        let now = Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true);
        let mut encrypted_settings = Vec::with_capacity(payload.settings.len());
        for (key, value_json) in &payload.settings {
            let aad = build_aad(STORAGE_SCHEMA_VERSION, "app_settings", key);
            let ciphertext =
                encrypt_record(self.keys.db_master_key(), &aad, value_json.as_bytes())?;
            encrypted_settings.push((key.clone(), now.clone(), ciphertext));
        }

        let mut encrypted_accounts = Vec::with_capacity(normalized_accounts.len());
        for account in &normalized_accounts {
            let aad = build_aad(STORAGE_SCHEMA_VERSION, "accounts", &account.id);
            let plaintext = serde_json::to_vec(account)?;
            let ciphertext = encrypt_record(self.keys.db_master_key(), &aad, &plaintext)?;
            encrypted_accounts.push((account.id.clone(), account.created_at.clone(), ciphertext));
        }

        let mut encrypted_nav_snapshots = Vec::with_capacity(normalized_nav_snapshots.len());
        for (record_id, snap) in &normalized_nav_snapshots {
            let aad = build_aad(STORAGE_SCHEMA_VERSION, "nav_snapshots", record_id);
            let plaintext = serde_json::to_vec(snap)?;
            let ciphertext = encrypt_record(self.keys.db_master_key(), &aad, &plaintext)?;
            encrypted_nav_snapshots.push((
                record_id.clone(),
                snap.date.clone(),
                snap.account_id.clone(),
                snap.currency.clone(),
                snap.updated_at.clone(),
                ciphertext,
            ));
        }

        let mut encrypted_benchmarks = Vec::with_capacity(normalized_benchmarks.len());
        for series in &normalized_benchmarks {
            let aad = build_aad(STORAGE_SCHEMA_VERSION, "benchmark_history", &series.symbol);
            let plaintext = serde_json::to_vec(series)?;
            let ciphertext = encrypt_record(self.keys.db_master_key(), &aad, &plaintext)?;
            encrypted_benchmarks.push((
                series.symbol.clone(),
                series.currency.clone(),
                series.provider.clone(),
                series.as_of_utc.clone(),
                ciphertext,
            ));
        }

        // Build and verify an independent staging SQLite file in the same directory.
        let mut nonce = [0_u8; 8];
        getrandom::fill(&mut nonce)
            .map_err(|_| StorageError::Vault(VaultError::RandomnessUnavailable))?;
        let suffix = encode_hex(&nonce);
        let base_name = self
            .db_path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("foliohelm-vault.sqlite");
        let staging_file_name = format!("{base_name}.restore-staging-{suffix}");
        let backup_file_name = format!("{base_name}.pre-restore-{suffix}");
        let staging_path = self.db_path.with_file_name(&staging_file_name);
        let backup_path = self.db_path.with_file_name(&backup_file_name);
        let intent_path = restore_intent_path(&self.db_path);

        let stage_result: Result<(), StorageError> = (|| {
            let mut staging_conn = Connection::open(&staging_path)?;
            configure_connection(&staging_conn)?;
            initialize_schema_on_conn(&mut staging_conn, self.keys.db_master_key())?;

            let tx = staging_conn.transaction()?;
            if let Some(ref verifier) = preserved_verifier {
                let plaintext = Zeroizing::new(serde_json::to_vec(verifier)?);
                let aad = build_aad(
                    STORAGE_SCHEMA_VERSION,
                    "vault_meta",
                    APP_LOCK_VERIFIER_META_KEY,
                );
                let ciphertext = encrypt_record(self.keys.db_master_key(), &aad, &plaintext)?;
                tx.execute(
                    "INSERT OR REPLACE INTO vault_meta (meta_key, meta_value) VALUES (?1, ?2)",
                    params![APP_LOCK_VERIFIER_META_KEY, ciphertext],
                )?;
            }
            if preserved_backoff.failed_attempts > 0
                || preserved_backoff.locked_until_unix.is_some()
            {
                let plaintext = serde_json::to_vec(&preserved_backoff)?;
                let aad = build_aad(
                    STORAGE_SCHEMA_VERSION,
                    "vault_meta",
                    APP_LOCK_BACKOFF_META_KEY,
                );
                let ciphertext = encrypt_record(self.keys.db_master_key(), &aad, &plaintext)?;
                tx.execute(
                    "INSERT OR REPLACE INTO vault_meta (meta_key, meta_value) VALUES (?1, ?2)",
                    params![APP_LOCK_BACKOFF_META_KEY, ciphertext],
                )?;
            }

            for (seq, event_id, occurred_at_utc, ciphertext) in &encrypted_evidence {
                tx.execute(
                    "INSERT INTO evidence_entries (sequence, event_id, occurred_at_utc, ciphertext)
                     VALUES (?1, ?2, ?3, ?4)",
                    params![seq, event_id, occurred_at_utc, ciphertext],
                )?;
            }
            for (id, fingerprint, source_format, imported_at_utc, ciphertext) in
                &encrypted_portfolios
            {
                tx.execute(
                    "INSERT INTO portfolio_snapshots (id, fingerprint, source_format, imported_at_utc, ciphertext)
                     VALUES (?1, ?2, ?3, ?4, ?5)",
                    params![id, fingerprint, source_format, imported_at_utc, ciphertext],
                )?;
            }
            for (id, workspace_mode, submitted_at_utc, ciphertext) in &encrypted_orders {
                tx.execute(
                    "INSERT INTO paper_orders (id, workspace_mode, submitted_at_utc, ciphertext)
                     VALUES (?1, ?2, ?3, ?4)",
                    params![id, workspace_mode, submitted_at_utc, ciphertext],
                )?;
            }
            for (symbol, provider, as_of_utc, ciphertext) in &encrypted_quotes {
                tx.execute(
                    "INSERT INTO quote_cache (symbol, provider, as_of_utc, ciphertext)
                     VALUES (?1, ?2, ?3, ?4)",
                    params![symbol, provider, as_of_utc, ciphertext],
                )?;
            }
            for (key, updated_at_utc, ciphertext) in &encrypted_settings {
                tx.execute(
                    "INSERT INTO app_settings (setting_key, updated_at_utc, ciphertext)
                     VALUES (?1, ?2, ?3)",
                    params![key, updated_at_utc, ciphertext],
                )?;
            }
            for (id, created_at_utc, ciphertext) in &encrypted_accounts {
                tx.execute(
                    "INSERT INTO accounts (id, created_at_utc, ciphertext)
                     VALUES (?1, ?2, ?3)",
                    params![id, created_at_utc, ciphertext],
                )?;
            }
            for (record_id, date, account_id, currency, updated_at_utc, ciphertext) in
                &encrypted_nav_snapshots
            {
                tx.execute(
                    "INSERT INTO nav_snapshots
                        (record_id, date, account_id, currency, updated_at_utc, ciphertext)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                    params![
                        record_id,
                        date,
                        account_id,
                        currency,
                        updated_at_utc,
                        ciphertext
                    ],
                )?;
            }
            for (symbol, currency, provider, updated_at_utc, ciphertext) in &encrypted_benchmarks {
                tx.execute(
                    "INSERT INTO benchmark_history
                        (symbol, currency, provider, updated_at_utc, ciphertext)
                     VALUES (?1, ?2, ?3, ?4, ?5)",
                    params![symbol, currency, provider, updated_at_utc, ciphertext],
                )?;
            }
            tx.commit()?;

            // Re-read and cryptographically verify staging DB canary + full Ed25519 chain.
            verify_connection_schema_and_canary(&staging_conn, self.keys.db_master_key())?;
            let staged_entries =
                load_evidence_entries_from_conn(&staging_conn, self.keys.db_master_key())?;
            let _ = EvidenceJournal::from_persisted(restored_signing_key.clone(), staged_entries)
                .map_err(|error| {
                StorageError::Integrity(format!(
                    "staged restore database failed Ed25519 verification: {error}"
                ))
            })?;

            // Flush WAL into main staging file before closing so a single atomic rename suffices.
            staging_conn.execute_batch(
                "PRAGMA wal_checkpoint(TRUNCATE);
                 PRAGMA journal_mode = DELETE;",
            )?;
            drop(staging_conn);
            for sidecar in sqlite_sidecar_paths(&staging_path) {
                let _ = fs::remove_file(sidecar);
            }
            Ok(())
        })();

        if let Err(error) = stage_result {
            remove_sqlite_files(&staging_path);
            return Err(error);
        }

        // Write encrypted crash-recovery intent BEFORE mutating live DB or OS keyring.
        let previous_seed_hex = self.keys.device_signing_seed_hex();
        let intent = RestoreIntentRecord {
            schema_version: STORAGE_SCHEMA_VERSION,
            previous_seed_hex,
            target_seed_hex: payload.device_signing_seed_hex.clone(),
            staging_file_name,
            backup_file_name,
        };
        let intent_plaintext = Zeroizing::new(serde_json::to_vec(&intent)?);
        let intent_aad = build_aad(
            STORAGE_SCHEMA_VERSION,
            RESTORE_INTENT_AAD_TABLE,
            RESTORE_INTENT_RECORD_ID,
        );
        let intent_ciphertext =
            encrypt_record(self.keys.db_master_key(), &intent_aad, &intent_plaintext)?;
        if let Err(error) = atomic_write_bytes(&intent_path, &intent_ciphertext) {
            remove_sqlite_files(&staging_path);
            return Err(StorageError::Io(error));
        }

        // Flush WAL and release live connection lock (required on Windows before rename).
        let flush_res = self.conn.execute_batch(
            "PRAGMA wal_checkpoint(TRUNCATE);
             PRAGMA journal_mode = DELETE;",
        );
        if let Err(error) = flush_res {
            let _ = configure_connection(&self.conn);
            remove_sqlite_files(&staging_path);
            let _ = fs::remove_file(&intent_path);
            return Err(StorageError::Sqlite(error));
        }

        let placeholder = Connection::open_in_memory()?;
        let old_conn = std::mem::replace(&mut self.conn, placeholder);
        drop(old_conn);
        for sidecar in sqlite_sidecar_paths(&self.db_path) {
            let _ = fs::remove_file(sidecar);
        }

        // Swap live DB -> backup, staging DB -> live DB.
        let swap_result: Result<(), StorageError> = (|| {
            fs::rename(&self.db_path, &backup_path)?;
            if let Err(error) = fs::rename(&staging_path, &self.db_path) {
                let _ = fs::rename(&backup_path, &self.db_path);
                return Err(StorageError::Io(error));
            }
            Ok(())
        })();

        if let Err(error) = swap_result {
            remove_sqlite_files(&staging_path);
            let _ = fs::remove_file(&intent_path);
            if let Ok(reopened) = Connection::open(&self.db_path) {
                let _ = configure_connection(&reopened);
                self.conn = reopened;
            }
            return Err(error);
        }

        // Synchronize OS keyring Ed25519 signing seed AFTER DB file switch succeeds.
        let previous_seed = match self
            .keys
            .replace_signing_seed(key_store, &payload.device_signing_seed_hex)
        {
            Ok(prev) => prev,
            Err(error) => {
                remove_sqlite_files(&self.db_path);
                let _ = fs::rename(&backup_path, &self.db_path);
                remove_sqlite_files(&staging_path);
                let _ = fs::remove_file(&intent_path);
                if let Ok(reopened) = Connection::open(&self.db_path) {
                    let _ = configure_connection(&reopened);
                    self.conn = reopened;
                }
                return Err(StorageError::Vault(error));
            }
        };

        // Reopen live connection on the restored DB and verify canary + Ed25519 chain.
        let verify_reopened: Result<(), StorageError> = (|| {
            let reopened = Connection::open(&self.db_path)?;
            configure_connection(&reopened)?;
            verify_connection_schema_and_canary(&reopened, self.keys.db_master_key())?;
            let entries = load_evidence_entries_from_conn(&reopened, self.keys.db_master_key())?;
            let _ = EvidenceJournal::from_persisted(self.keys.signing_key(), entries).map_err(
                |error| {
                    StorageError::Integrity(format!(
                        "restored database failed post-swap verification: {error}"
                    ))
                },
            )?;
            self.conn = reopened;
            Ok(())
        })();

        if let Err(error) = verify_reopened {
            let _ = self.keys.restore_signing_seed(key_store, previous_seed);
            remove_sqlite_files(&self.db_path);
            let _ = fs::rename(&backup_path, &self.db_path);
            let _ = fs::remove_file(&intent_path);
            if let Ok(reopened) = Connection::open(&self.db_path) {
                let _ = configure_connection(&reopened);
                self.conn = reopened;
            }
            return Err(error);
        }

        // Clean up backup and crash-recovery intent once both DB and keyring are live & verified.
        remove_sqlite_files(&backup_path);
        remove_sqlite_files(&staging_path);
        let _ = fs::remove_file(&intent_path);

        // Smoothly guarantee default account exists even when restoring a legacy v1 backup.
        self.ensure_default_account_if_missing()?;

        let summary = VaultRestoreSummaryDto {
            evidence_count: encrypted_evidence.len(),
            portfolio_count: encrypted_portfolios.len(),
            paper_order_count: encrypted_orders.len(),
            quote_count: encrypted_quotes.len(),
            setting_count: encrypted_settings.len(),
            account_count: encrypted_accounts.len(),
            nav_snapshot_count: encrypted_nav_snapshots.len(),
            benchmark_count: encrypted_benchmarks.len(),
            signer_public_key: verified_journal.signer_public_key_hex(),
        };
        Ok((verified_journal, summary))
    }

    /// Clear all workspace records inside one atomic transaction while keeping
    /// the device key and vault canary intact.
    pub fn clear_all_workspace_data(&mut self) -> Result<(), StorageError> {
        let tx = self.conn.transaction()?;
        tx.execute("DELETE FROM evidence_entries", [])?;
        tx.execute("DELETE FROM portfolio_snapshots", [])?;
        tx.execute("DELETE FROM paper_orders", [])?;
        tx.execute("DELETE FROM quote_cache", [])?;
        tx.execute("DELETE FROM app_settings", [])?;
        tx.execute("DELETE FROM accounts", [])?;
        tx.execute("DELETE FROM nav_snapshots", [])?;
        tx.execute("DELETE FROM benchmark_history", [])?;
        tx.commit()?;
        self.ensure_default_account_if_missing()?;
        Ok(())
    }
}

fn validate_and_normalize_account(account: &StoredAccount) -> Result<StoredAccount, StorageError> {
    let id = account.id.trim().to_string();
    if id.is_empty()
        || id.len() > 64
        || !id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-'))
    {
        return Err(StorageError::InvalidInput(
            "account id must be 1..=64 ASCII alphanumeric/underscore/dash characters".to_string(),
        ));
    }
    let name: String = account
        .name
        .trim()
        .chars()
        .filter(|c| !c.is_control())
        .take(80)
        .collect();
    if name.is_empty() {
        return Err(StorageError::InvalidInput(
            "account name must not be empty".to_string(),
        ));
    }
    let broker: String = account
        .broker
        .trim()
        .chars()
        .filter(|c| !c.is_control())
        .take(64)
        .collect();
    let account_type: String = account
        .account_type
        .trim()
        .chars()
        .filter(|c| !c.is_control())
        .take(32)
        .collect();
    let base_currency = account.base_currency.trim().to_ascii_uppercase();
    if base_currency.len() < 3
        || base_currency.len() > 5
        || base_currency == "MULTI"
        || !base_currency.bytes().all(|b| b.is_ascii_uppercase())
    {
        return Err(StorageError::InvalidInput(format!(
            "invalid account base_currency: {}",
            account.base_currency
        )));
    }
    let created_at = if account.created_at.trim().is_empty() {
        Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
    } else {
        account.created_at.trim().to_string()
    };

    Ok(StoredAccount {
        id,
        name,
        broker: if broker.is_empty() {
            "Local CSV".to_string()
        } else {
            broker
        },
        account_type: if account_type.is_empty() {
            "taxable".to_string()
        } else {
            account_type
        },
        base_currency,
        created_at,
    })
}

fn validate_and_normalize_nav_snapshot(
    snapshot: &StoredNavSnapshot,
) -> Result<StoredNavSnapshot, StorageError> {
    let date = snapshot.date.trim().to_string();
    if date.len() != 10 || NaiveDate::parse_from_str(&date, "%Y-%m-%d").is_err() {
        return Err(StorageError::InvalidInput(format!(
            "invalid nav_snapshot date '{}': expected YYYY-MM-DD",
            snapshot.date
        )));
    }
    let account_id = if snapshot.account_id.trim().is_empty() {
        DEFAULT_ACCOUNT_ID.to_string()
    } else {
        snapshot.account_id.trim().to_string()
    };
    if account_id.len() > 64
        || !account_id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-'))
    {
        return Err(StorageError::InvalidInput(
            "invalid nav_snapshot account_id".to_string(),
        ));
    }
    let currency = snapshot.currency.trim().to_ascii_uppercase();
    if currency.len() < 3
        || currency.len() > 5
        || currency == "MULTI"
        || !currency.bytes().all(|b| b.is_ascii_uppercase())
    {
        return Err(StorageError::InvalidInput(format!(
            "invalid nav_snapshot currency '{}': cross-currency snapshots are forbidden",
            snapshot.currency
        )));
    }
    let source = if snapshot.source.trim().is_empty() {
        "portfolio-load".to_string()
    } else {
        snapshot.source.trim().chars().take(32).collect()
    };
    let updated_at = if snapshot.updated_at.trim().is_empty() {
        Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
    } else {
        snapshot.updated_at.trim().to_string()
    };

    Ok(StoredNavSnapshot {
        date,
        account_id,
        currency,
        net_value_micros: snapshot.net_value_micros,
        cash_micros: snapshot.cash_micros,
        positions_micros: snapshot.positions_micros,
        external_cash_flow_micros: snapshot.external_cash_flow_micros,
        source,
        updated_at,
    })
}

fn validate_and_normalize_benchmark_series(
    series: &StoredBenchmarkSeries,
) -> Result<StoredBenchmarkSeries, StorageError> {
    let symbol = series.symbol.trim().to_ascii_uppercase();
    if symbol.is_empty()
        || symbol.len() > 16
        || !symbol
            .bytes()
            .all(|b| b.is_ascii_uppercase() || b.is_ascii_digit() || matches!(b, b'.' | b'-'))
    {
        return Err(StorageError::InvalidInput(format!(
            "invalid benchmark symbol '{}'",
            series.symbol
        )));
    }
    let currency = series.currency.trim().to_ascii_uppercase();
    if currency.len() < 3
        || currency.len() > 5
        || currency == "MULTI"
        || !currency.bytes().all(|b| b.is_ascii_uppercase())
    {
        return Err(StorageError::InvalidInput(format!(
            "invalid benchmark currency '{}'",
            series.currency
        )));
    }
    let mut by_date: BTreeMap<String, i128> = BTreeMap::new();
    for pt in &series.points {
        let date = pt.date.trim();
        if date.len() != 10 || NaiveDate::parse_from_str(date, "%Y-%m-%d").is_err() {
            return Err(StorageError::InvalidInput(format!(
                "invalid benchmark point date '{}'",
                pt.date
            )));
        }
        if pt.close_micros <= 0 {
            return Err(StorageError::InvalidInput(
                "benchmark close price must be positive".to_string(),
            ));
        }
        by_date.insert(date.to_string(), pt.close_micros);
    }

    let points: Vec<BenchmarkPricePoint> = by_date
        .into_iter()
        .map(|(date, close_micros)| BenchmarkPricePoint { date, close_micros })
        .collect();

    Ok(StoredBenchmarkSeries {
        symbol,
        currency,
        provider: series.provider.trim().to_string(),
        as_of_utc: if series.as_of_utc.trim().is_empty() {
            Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
        } else {
            series.as_of_utc.trim().to_string()
        },
        points,
    })
}

fn ensure_wave2_tables_on_conn(conn: &Connection) -> Result<(), StorageError> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS accounts (
            id TEXT PRIMARY KEY,
            created_at_utc TEXT NOT NULL,
            ciphertext BLOB NOT NULL
        );
        CREATE TABLE IF NOT EXISTS nav_snapshots (
            record_id TEXT PRIMARY KEY,
            date TEXT NOT NULL,
            account_id TEXT NOT NULL,
            currency TEXT NOT NULL,
            updated_at_utc TEXT NOT NULL,
            ciphertext BLOB NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_nav_snapshots_date
            ON nav_snapshots (date);
        CREATE INDEX IF NOT EXISTS idx_nav_snapshots_account_currency
            ON nav_snapshots (account_id, currency, date);
        CREATE TABLE IF NOT EXISTS benchmark_history (
            symbol TEXT PRIMARY KEY,
            currency TEXT NOT NULL,
            provider TEXT NOT NULL,
            updated_at_utc TEXT NOT NULL,
            ciphertext BLOB NOT NULL
        );",
    )?;
    Ok(())
}

fn initialize_schema_on_conn(
    conn: &mut Connection,
    db_master_key: &[u8; 32],
) -> Result<(), StorageError> {
    let tx = conn.transaction()?;
    tx.execute_batch(
        "CREATE TABLE IF NOT EXISTS vault_meta (
            meta_key TEXT PRIMARY KEY,
            meta_value BLOB NOT NULL
        );
        CREATE TABLE IF NOT EXISTS evidence_entries (
            sequence INTEGER PRIMARY KEY,
            event_id TEXT NOT NULL UNIQUE,
            occurred_at_utc TEXT NOT NULL,
            ciphertext BLOB NOT NULL
        );
        CREATE TABLE IF NOT EXISTS portfolio_snapshots (
            id TEXT PRIMARY KEY,
            fingerprint TEXT NOT NULL UNIQUE,
            source_format TEXT NOT NULL,
            imported_at_utc TEXT NOT NULL,
            ciphertext BLOB NOT NULL
        );
        CREATE TABLE IF NOT EXISTS paper_orders (
            id TEXT PRIMARY KEY,
            workspace_mode TEXT NOT NULL,
            submitted_at_utc TEXT NOT NULL,
            ciphertext BLOB NOT NULL
        );
        CREATE TABLE IF NOT EXISTS quote_cache (
            symbol TEXT PRIMARY KEY,
            provider TEXT NOT NULL,
            as_of_utc TEXT NOT NULL,
            ciphertext BLOB NOT NULL
        );
        CREATE TABLE IF NOT EXISTS app_settings (
            setting_key TEXT PRIMARY KEY,
            updated_at_utc TEXT NOT NULL,
            ciphertext BLOB NOT NULL
        );
        CREATE TABLE IF NOT EXISTS accounts (
            id TEXT PRIMARY KEY,
            created_at_utc TEXT NOT NULL,
            ciphertext BLOB NOT NULL
        );
        CREATE TABLE IF NOT EXISTS nav_snapshots (
            record_id TEXT PRIMARY KEY,
            date TEXT NOT NULL,
            account_id TEXT NOT NULL,
            currency TEXT NOT NULL,
            updated_at_utc TEXT NOT NULL,
            ciphertext BLOB NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_nav_snapshots_date
            ON nav_snapshots (date);
        CREATE INDEX IF NOT EXISTS idx_nav_snapshots_account_currency
            ON nav_snapshots (account_id, currency, date);
        CREATE TABLE IF NOT EXISTS benchmark_history (
            symbol TEXT PRIMARY KEY,
            currency TEXT NOT NULL,
            provider TEXT NOT NULL,
            updated_at_utc TEXT NOT NULL,
            ciphertext BLOB NOT NULL
        );",
    )?;

    let aad = build_aad(STORAGE_SCHEMA_VERSION, "vault_meta", CANARY_RECORD_ID);
    let canary_blob = encrypt_record(db_master_key, &aad, CANARY_PLAINTEXT)?;

    tx.execute(
        "INSERT OR REPLACE INTO vault_meta (meta_key, meta_value) VALUES (?1, ?2)",
        params![
            "schema_version",
            STORAGE_SCHEMA_VERSION.to_string().as_bytes()
        ],
    )?;
    tx.execute(
        "INSERT OR REPLACE INTO vault_meta (meta_key, meta_value) VALUES (?1, ?2)",
        params![
            "crypto_version",
            VAULT_CRYPTO_VERSION.to_string().as_bytes()
        ],
    )?;
    tx.execute(
        "INSERT OR REPLACE INTO vault_meta (meta_key, meta_value) VALUES (?1, ?2)",
        params![CANARY_RECORD_ID, canary_blob],
    )?;

    tx.commit()?;
    Ok(())
}

fn verify_connection_schema_and_canary(
    conn: &Connection,
    db_master_key: &[u8; 32],
) -> Result<(), StorageError> {
    let schema_bytes: Option<Vec<u8>> = conn
        .query_row(
            "SELECT meta_value FROM vault_meta WHERE meta_key = 'schema_version'",
            [],
            |row| row.get(0),
        )
        .optional()?;
    let Some(schema_bytes) = schema_bytes else {
        return Err(StorageError::Integrity(
            "existing database is missing vault_meta schema_version".to_string(),
        ));
    };
    let schema_str = String::from_utf8(schema_bytes).map_err(|_| {
        StorageError::Integrity("vault_meta schema_version is not UTF-8".to_string())
    })?;
    let version: u16 = schema_str.parse().map_err(|_| {
        StorageError::Integrity(format!("invalid vault schema version: {schema_str}"))
    })?;
    if version != STORAGE_SCHEMA_VERSION {
        return Err(StorageError::Integrity(format!(
            "unsupported vault schema version {version}"
        )));
    }

    let canary_blob: Option<Vec<u8>> = conn
        .query_row(
            "SELECT meta_value FROM vault_meta WHERE meta_key = ?1",
            params![CANARY_RECORD_ID],
            |row| row.get(0),
        )
        .optional()?;
    let Some(canary_blob) = canary_blob else {
        return Err(StorageError::Integrity(
            "existing database is missing encryption canary".to_string(),
        ));
    };
    let aad = build_aad(STORAGE_SCHEMA_VERSION, "vault_meta", CANARY_RECORD_ID);
    let decrypted = decrypt_record(db_master_key, &aad, &canary_blob)?;
    if decrypted.as_slice() != CANARY_PLAINTEXT {
        return Err(StorageError::Integrity(
            "vault encryption canary mismatch".to_string(),
        ));
    }

    Ok(())
}

fn load_evidence_entries_from_conn(
    conn: &Connection,
    db_master_key: &[u8; 32],
) -> Result<Vec<SignedEvidenceEntry>, StorageError> {
    let mut stmt =
        conn.prepare("SELECT sequence, ciphertext FROM evidence_entries ORDER BY sequence ASC")?;
    let rows = stmt.query_map([], |row| {
        Ok((row.get::<_, i64>(0)?, row.get::<_, Vec<u8>>(1)?))
    })?;

    let mut entries = Vec::new();
    for row in rows {
        let (sequence, ciphertext) = row?;
        let aad = build_aad(
            STORAGE_SCHEMA_VERSION,
            "evidence_entries",
            &sequence.to_string(),
        );
        let plaintext = decrypt_record(db_master_key, &aad, &ciphertext)?;
        let entry: SignedEvidenceEntry = serde_json::from_slice(&plaintext)?;
        if i64::try_from(entry.event.sequence).ok() != Some(sequence) {
            return Err(StorageError::Integrity(format!(
                "evidence sequence mismatch at row {sequence}"
            )));
        }
        entries.push(entry);
    }
    Ok(entries)
}

fn configure_connection(conn: &Connection) -> Result<(), rusqlite::Error> {
    conn.execute_batch(
        "PRAGMA journal_mode = WAL;
         PRAGMA synchronous = FULL;
         PRAGMA foreign_keys = ON;
         PRAGMA secure_delete = ON;",
    )
}

#[cfg(test)]
mod tests {
    use std::{collections::BTreeMap, path::PathBuf};

    use super::*;
    use crate::{
        evidence::{AppendEvidenceRequest, EvidenceJournal},
        vault::InMemoryKeyStore,
    };

    fn unique_temp_db(label: &str) -> PathBuf {
        let mut nonce = [0_u8; 8];
        getrandom::fill(&mut nonce).expect("random");
        let suffix = encode_hex(&nonce);
        std::env::temp_dir()
            .join(format!("foliohelm-vault-test-{label}-{suffix}"))
            .join("vault.sqlite")
    }

    fn cleanup_temp_db(path: &Path) {
        if let Some(parent) = path.parent() {
            let _ = fs::remove_dir_all(parent);
        }
    }

    fn sample_snapshot(fingerprint: &str) -> StoredPortfolioSnapshot {
        StoredPortfolioSnapshot {
            id: format!("snap-{fingerprint}"),
            account_id: DEFAULT_ACCOUNT_ID.to_string(),
            fingerprint: fingerprint.to_string(),
            source_format: "schwab_positions".to_string(),
            source_label: "positions.csv".to_string(),
            imported_at_utc: "2026-11-22T02:00:00.000Z".to_string(),
            account_label: "Local CSV Portfolio".to_string(),
            currency: "USD".to_string(),
            cash: "14250.50".to_string(),
            cash_by_currency: BTreeMap::from([("USD".to_string(), "14250.50".to_string())]),
            currencies: vec!["USD".to_string()],
            is_multi_currency: false,
            holdings: vec![StoredPortfolioHolding {
                symbol: "AAPL".to_string(),
                company: "Apple Inc.".to_string(),
                quantity: "42".to_string(),
                average_cost: "198.25".to_string(),
                last_price: "226.34".to_string(),
                currency: "USD".to_string(),
            }],
            transactions: vec![],
            warnings: vec![],
        }
    }

    #[test]
    fn persists_encrypted_evidence_and_portfolio_across_restarts_without_plaintext_on_disk() {
        let db_path = unique_temp_db("roundtrip");
        let key_store = InMemoryKeyStore::new();

        {
            let mut db =
                EncryptedVaultDb::open(&db_path, &key_store, "in-memory-test").expect("open");
            let mut journal = EvidenceJournal::from_signing_key(db.signing_key());
            let (entry, _) = journal
                .append_entry(AppendEvidenceRequest {
                    kind: "portfolio_import".into(),
                    payload: BTreeMap::from([
                        ("source".into(), "schwab_positions".into()),
                        ("holdingsCount".into(), "1".into()),
                        ("marker".into(), "TOP_SECRET_FINANCE_99812".into()),
                    ]),
                    app_version: Some("0.1.0".into()),
                    occurred_at_utc: Some("2026-11-22T02:00:00Z".into()),
                    account_ref: Some("acct_local_csv".into()),
                    intent_id: Some("import-001".into()),
                })
                .expect("append");
            db.insert_evidence_entry(&entry).expect("persist evidence");

            let saved = db
                .save_portfolio_snapshot(&sample_snapshot("fp-001"))
                .expect("save portfolio");
            assert!(!saved.deduplicated);

            // Re-importing the identical fingerprint is idempotent.
            let dup = db
                .save_portfolio_snapshot(&sample_snapshot("fp-001"))
                .expect("deduplicate portfolio");
            assert!(dup.deduplicated);
        }

        // Verify zero plaintext leakage in the SQLite file on disk.
        let raw_bytes = fs::read(&db_path).expect("read sqlite file");
        let raw_text = String::from_utf8_lossy(&raw_bytes);
        assert!(!raw_text.contains("TOP_SECRET_FINANCE_99812"));
        assert!(!raw_text.contains("14250.50"));
        assert!(!raw_text.contains("Apple Inc."));

        // Reopen with the same OS key store and verify full restoration & signature verification.
        {
            let db = EncryptedVaultDb::open(&db_path, &key_store, "in-memory-test")
                .expect("reopen vault");
            let entries = db.load_evidence_entries().expect("load evidence");
            assert_eq!(entries.len(), 1);
            let journal =
                EvidenceJournal::from_persisted(db.signing_key(), entries).expect("verify chain");
            assert!(journal.verify().valid);

            let portfolio = db
                .load_latest_portfolio_snapshot()
                .expect("load portfolio")
                .expect("snapshot exists");
            assert_eq!(portfolio.cash, "14250.50");
            assert_eq!(portfolio.holdings[0].symbol, "AAPL");
            assert_eq!(portfolio.holdings[0].average_cost, "198.25");
        }

        cleanup_temp_db(&db_path);
    }

    #[test]
    fn fails_closed_when_keyring_is_empty_for_existing_database_and_preserves_ciphertext() {
        let db_path = unique_temp_db("missing-key");
        let original_store = InMemoryKeyStore::new();

        {
            let mut db =
                EncryptedVaultDb::open(&db_path, &original_store, "in-memory-test").expect("open");
            db.save_portfolio_snapshot(&sample_snapshot("fp-keep"))
                .expect("save");
        }

        let before_bytes = fs::read(&db_path).expect("read original db");

        // Opening with an empty key store MUST fail closed and not overwrite the file.
        let empty_store = InMemoryKeyStore::new();
        let error = EncryptedVaultDb::open(&db_path, &empty_store, "in-memory-test")
            .err()
            .expect("must fail closed");
        assert!(matches!(
            error,
            StorageError::Vault(VaultError::KeyMissingForExistingDatabase(_))
        ));

        let after_bytes = fs::read(&db_path).expect("read untouched db");
        assert_eq!(before_bytes, after_bytes);

        // Original key store can still unlock and read intact data.
        let reopened =
            EncryptedVaultDb::open(&db_path, &original_store, "in-memory-test").expect("reopen");
        assert!(reopened
            .load_latest_portfolio_snapshot()
            .expect("load")
            .is_some());

        cleanup_temp_db(&db_path);
    }

    #[test]
    fn detects_tampered_ciphertext_and_cross_row_aad_swap() {
        let db_path = unique_temp_db("tamper");
        let key_store = InMemoryKeyStore::new();

        {
            let mut db =
                EncryptedVaultDb::open(&db_path, &key_store, "in-memory-test").expect("open");
            db.save_setting("setting_a", r#"{"enabled":true}"#)
                .expect("save a");
            db.save_setting("setting_b", r#"{"enabled":false}"#)
                .expect("save b");
        }

        // Transplant setting_a's ciphertext into setting_b (AAD mismatch attack).
        {
            let raw_conn = Connection::open(&db_path).expect("raw sqlite");
            let blob_a: Vec<u8> = raw_conn
                .query_row(
                    "SELECT ciphertext FROM app_settings WHERE setting_key = 'setting_a'",
                    [],
                    |row| row.get(0),
                )
                .expect("read blob a");
            raw_conn
                .execute(
                    "UPDATE app_settings SET ciphertext = ?1 WHERE setting_key = 'setting_b'",
                    params![blob_a],
                )
                .expect("swap");
        }

        let db = EncryptedVaultDb::open(&db_path, &key_store, "in-memory-test").expect("open");
        let error = db
            .load_setting("setting_b")
            .expect_err("AAD mismatch must fail closed");
        assert!(matches!(
            error,
            StorageError::Vault(VaultError::DecryptionFailed(_))
        ));

        cleanup_temp_db(&db_path);
    }

    #[test]
    fn restores_verified_backup_payload_to_fresh_device_and_preserves_db_on_invalid_backup() {
        let src_path = unique_temp_db("backup-src");
        let dst_path = unique_temp_db("backup-dst");
        let src_keys = InMemoryKeyStore::new();
        let dst_keys = InMemoryKeyStore::new();

        let exported_payload = {
            let mut db =
                EncryptedVaultDb::open(&src_path, &src_keys, "in-memory-test").expect("src open");
            let mut journal = EvidenceJournal::from_signing_key(db.signing_key());
            let (entry, _) = journal
                .append_entry(AppendEvidenceRequest {
                    kind: "portfolio_import".into(),
                    payload: BTreeMap::from([("mode".into(), "local-csv".into())]),
                    app_version: Some("0.1.0".into()),
                    occurred_at_utc: Some("2026-11-22T02:00:00Z".into()),
                    account_ref: Some("acct_local_csv".into()),
                    intent_id: Some("imp-01".into()),
                })
                .expect("append");
            db.insert_evidence_entry(&entry).expect("insert evidence");
            db.save_portfolio_snapshot(&sample_snapshot("fp-backup"))
                .expect("save portfolio");
            db.save_setting("protections", r#"{"autoLock":true}"#)
                .expect("save setting");
            db.export_backup_payload().expect("export payload")
        };

        {
            let mut dst_db =
                EncryptedVaultDb::open(&dst_path, &dst_keys, "in-memory-test").expect("dst open");
            dst_db
                .save_setting("existing_marker", r#""preserve-me""#)
                .expect("save marker");

            // Tampered evidence inside backup must fail closed without touching existing DB!
            let mut tampered = exported_payload.clone();
            tampered.evidence_entries[0]
                .event
                .payload
                .fields
                .insert("mode".into(), "tampered".into());
            assert!(dst_db
                .restore_from_backup_payload(tampered, &dst_keys)
                .is_err());
            assert_eq!(
                dst_db.load_setting("existing_marker").expect("load"),
                Some(r#""preserve-me""#.to_string())
            );

            // Valid backup restores everything atomically and preserves signer continuity.
            let (restored_journal, summary) = dst_db
                .restore_from_backup_payload(exported_payload.clone(), &dst_keys)
                .expect("restore ok");
            assert_eq!(summary.evidence_count, 1);
            assert_eq!(summary.portfolio_count, 1);
            assert_eq!(summary.setting_count, 1);
            assert!(restored_journal.verify().valid);
            assert_eq!(
                dst_db.load_setting("protections").expect("protections"),
                Some(r#"{"autoLock":true}"#.to_string())
            );
            assert!(dst_db
                .load_setting("existing_marker")
                .expect("old")
                .is_none());
        }

        // Reopen destination DB after restart and confirm Ed25519 signer and records persist intact.
        {
            let reopened =
                EncryptedVaultDb::open(&dst_path, &dst_keys, "in-memory-test").expect("reopen dst");
            let entries = reopened.load_evidence_entries().expect("entries");
            let journal = EvidenceJournal::from_persisted(reopened.signing_key(), entries)
                .expect("chain valid after restart");
            assert!(journal.verify().valid);
            assert_eq!(journal.list().len(), 1);
        }

        cleanup_temp_db(&src_path);
        cleanup_temp_db(&dst_path);
    }

    #[test]
    fn encrypts_app_lock_verifier_and_backoff_with_aad_and_migrates_legacy_plaintext() {
        let db_path = unique_temp_db("verifier-aad");
        let key_store = InMemoryKeyStore::new();
        let verifier = crate::vault::create_app_lock_verifier_with_params(
            "Stage4-Strong-Passphrase!",
            4096,
            1,
            1,
        )
        .expect("create verifier");

        // 1. Seed a legacy plaintext JSON verifier directly into vault_meta.
        {
            let db = EncryptedVaultDb::open(&db_path, &key_store, "in-memory-test").expect("open");
            drop(db);
            let raw_conn = Connection::open(&db_path).expect("raw");
            let legacy_json = serde_json::to_vec(&verifier).expect("json");
            raw_conn
                .execute(
                    "INSERT OR REPLACE INTO vault_meta (meta_key, meta_value) VALUES (?1, ?2)",
                    params![APP_LOCK_VERIFIER_META_KEY, legacy_json],
                )
                .expect("seed legacy");
        }

        // 2. Opening migrates legacy plaintext verifier to AES-256-GCM ciphertext with AAD.
        {
            let mut db =
                EncryptedVaultDb::open(&db_path, &key_store, "in-memory-test").expect("reopen");
            let loaded = db
                .load_app_lock_verifier()
                .expect("load migrated")
                .expect("some verifier");
            assert_eq!(loaded, verifier);

            let raw_blob: Vec<u8> = db
                .conn
                .query_row(
                    "SELECT meta_value FROM vault_meta WHERE meta_key = ?1",
                    params![APP_LOCK_VERIFIER_META_KEY],
                    |row| row.get(0),
                )
                .expect("raw meta");
            assert_eq!(raw_blob[0], VAULT_CRYPTO_VERSION);
            assert!(!String::from_utf8_lossy(&raw_blob).contains("argon2id"));
            assert!(!String::from_utf8_lossy(&raw_blob).contains(&verifier.hash_b64));

            // Save encrypted backoff state and verify roundtrip.
            let backoff = AppLockBackoffState {
                failed_attempts: 3,
                locked_until_unix: Some(2_000_000_000),
            };
            db.save_app_lock_backoff(&backoff).expect("save backoff");
            assert_eq!(db.load_app_lock_backoff().expect("load backoff"), backoff);
        }

        // 3. Cross-row AAD swap (replacing verifier with canary ciphertext) MUST fail closed.
        {
            let raw_conn = Connection::open(&db_path).expect("raw");
            let canary_blob: Vec<u8> = raw_conn
                .query_row(
                    "SELECT meta_value FROM vault_meta WHERE meta_key = ?1",
                    params![CANARY_RECORD_ID],
                    |row| row.get(0),
                )
                .expect("canary");
            raw_conn
                .execute(
                    "UPDATE vault_meta SET meta_value = ?1 WHERE meta_key = ?2",
                    params![canary_blob, APP_LOCK_VERIFIER_META_KEY],
                )
                .expect("swap");
        }
        assert!(
            EncryptedVaultDb::open(&db_path, &key_store, "in-memory-test").is_err(),
            "tampered app_lock_verifier ciphertext must fail closed on open"
        );

        cleanup_temp_db(&db_path);
    }

    #[test]
    fn backup_restore_rejects_duplicates_redacts_seed_and_recovers_from_keyring_or_crash_failure() {
        use std::sync::atomic::{AtomicBool, Ordering};

        struct ToggleFailKeyStore {
            inner: InMemoryKeyStore,
            fail_seed_writes: AtomicBool,
        }
        impl KeyStore for ToggleFailKeyStore {
            fn get_secret(
                &self,
                service: &str,
                account: &str,
            ) -> Result<Option<Zeroizing<String>>, VaultError> {
                self.inner.get_secret(service, account)
            }
            fn set_secret(
                &self,
                service: &str,
                account: &str,
                secret: &str,
            ) -> Result<(), VaultError> {
                if account == crate::vault::DEVICE_SIGNING_SEED_ACCOUNT
                    && self.fail_seed_writes.load(Ordering::SeqCst)
                {
                    return Err(VaultError::KeyStoreUnavailable(
                        "simulated keyring write failure".to_string(),
                    ));
                }
                self.inner.set_secret(service, account, secret)
            }
            fn delete_secret(&self, service: &str, account: &str) -> Result<(), VaultError> {
                self.inner.delete_secret(service, account)
            }
        }

        let src_path = unique_temp_db("p0-3-src");
        let dst_path = unique_temp_db("p0-3-dst");
        let src_keys = InMemoryKeyStore::new();
        let dst_keys = ToggleFailKeyStore {
            inner: InMemoryKeyStore::new(),
            fail_seed_writes: AtomicBool::new(false),
        };

        let exported = {
            let mut db =
                EncryptedVaultDb::open(&src_path, &src_keys, "in-memory-test").expect("src");
            let mut journal = EvidenceJournal::from_signing_key(db.signing_key());
            let (entry, _) = journal
                .append_entry(AppendEvidenceRequest {
                    kind: "portfolio_import".into(),
                    payload: BTreeMap::from([("mode".into(), "local-csv".into())]),
                    app_version: Some("0.1.0".into()),
                    occurred_at_utc: Some("2026-11-22T02:00:00Z".into()),
                    account_ref: Some("acct_local_csv".into()),
                    intent_id: Some("imp-01".into()),
                })
                .expect("append");
            db.insert_evidence_entry(&entry).expect("insert");
            db.save_portfolio_snapshot(&sample_snapshot("fp-01"))
                .expect("snap");
            db.save_setting("restored_key", r#""from-backup""#)
                .expect("setting");
            db.export_backup_payload().expect("export")
        };

        // Debug representation of VaultBackupPayload must redact signing seed hex.
        let debug_str = format!("{exported:?}");
        assert!(debug_str.contains("[REDACTED]"));
        assert!(!debug_str.contains(exported.device_signing_seed_hex.as_str()));

        // Open destination vault with existing data and an App Lock verifier.
        let mut dst_db =
            EncryptedVaultDb::open(&dst_path, &dst_keys, "in-memory-test").expect("dst");
        dst_db
            .save_setting("existing_key", r#""original-data""#)
            .expect("existing");
        let mut dst_journal = EvidenceJournal::from_signing_key(dst_db.signing_key());
        let (dst_entry, _) = dst_journal
            .append_entry(AppendEvidenceRequest {
                kind: "state_changed".into(),
                payload: BTreeMap::from([("phase".into(), "pre-restore".into())]),
                app_version: Some("0.1.0".into()),
                occurred_at_utc: Some("2026-11-22T01:00:00Z".into()),
                account_ref: Some("acct_local_mock".into()),
                intent_id: Some("pre-01".into()),
            })
            .expect("append dst");
        dst_db
            .insert_evidence_entry(&dst_entry)
            .expect("insert dst");

        // 1. Duplicate unique keys inside backup MUST be rejected before touching DB/keyring.
        let mut dup_payload = exported.clone();
        dup_payload
            .portfolio_snapshots
            .push(sample_snapshot("fp-01"));
        assert!(dst_db
            .restore_from_backup_payload(dup_payload, &dst_keys)
            .is_err());
        assert_eq!(
            dst_db.load_setting("existing_key").expect("still intact"),
            Some(r#""original-data""#.to_string())
        );

        // 2. Simulated OS keyring write failure during restore MUST roll back DB cleanly.
        dst_keys.fail_seed_writes.store(true, Ordering::SeqCst);
        assert!(dst_db
            .restore_from_backup_payload(exported.clone(), &dst_keys)
            .is_err());
        dst_keys.fail_seed_writes.store(false, Ordering::SeqCst);
        assert_eq!(
            dst_db.load_setting("existing_key").expect("rolled back"),
            Some(r#""original-data""#.to_string())
        );
        assert!(dst_db
            .load_setting("restored_key")
            .expect("no leak")
            .is_none());
        assert!(!restore_intent_path(&dst_path).exists());

        // 3. Simulated mid-restore crash (DB swapped, keyring still holds old seed, encrypted
        //    `.restore-intent` left on disk) MUST auto-recover on reopen without bricking!
        let old_seed_hex = dst_db.keys.device_signing_seed_hex();
        let db_master_key = *dst_db.keys.db_master_key();
        drop(dst_db);

        let backup_name = "vault.sqlite.pre-restore-crashsim".to_string();
        let staging_name = "vault.sqlite.restore-staging-crashsim".to_string();
        let backup_path = dst_path.with_file_name(&backup_name);
        let staging_path = dst_path.with_file_name(&staging_name);
        // Move intact original DB to backup_path and put an incompatible DB at dst_path.
        fs::rename(&dst_path, &backup_path).expect("move to backup");
        for sidecar in sqlite_sidecar_paths(&dst_path) {
            let _ = fs::remove_file(sidecar);
        }
        fs::write(&dst_path, b"corrupted-mid-swap").expect("simulate partial swap");
        fs::write(&staging_path, b"leftover-staging").expect("simulate staging");

        let intent = RestoreIntentRecord {
            schema_version: STORAGE_SCHEMA_VERSION,
            previous_seed_hex: old_seed_hex,
            target_seed_hex: exported.device_signing_seed_hex.clone(),
            staging_file_name: staging_name,
            backup_file_name: backup_name,
        };
        let intent_bytes = encrypt_record(
            &db_master_key,
            &build_aad(
                STORAGE_SCHEMA_VERSION,
                RESTORE_INTENT_AAD_TABLE,
                RESTORE_INTENT_RECORD_ID,
            ),
            &serde_json::to_vec(&intent).expect("intent json"),
        )
        .expect("encrypt intent");
        atomic_write_bytes(&restore_intent_path(&dst_path), &intent_bytes).expect("write intent");

        // Reopen recovers automatically to the intact pre-restore DB and cleans up leftovers!
        let recovered =
            EncryptedVaultDb::open(&dst_path, &dst_keys, "in-memory-test").expect("auto-recover");
        assert_eq!(
            recovered.load_setting("existing_key").expect("recovered"),
            Some(r#""original-data""#.to_string())
        );
        let recovered_entries = recovered.load_evidence_entries().expect("entries");
        assert!(
            EvidenceJournal::from_persisted(recovered.signing_key(), recovered_entries)
                .expect("verified chain")
                .verify()
                .valid
        );
        assert!(!restore_intent_path(&dst_path).exists());
        assert!(!backup_path.exists());
        assert!(!staging_path.exists());

        cleanup_temp_db(&src_path);
        cleanup_temp_db(&dst_path);
    }

    #[test]
    fn paper_order_validates_workspace_mode_and_persists_currency_with_legacy_default() {
        let db_path = unique_temp_db("paper-order-currency");
        let key_store = InMemoryKeyStore::new();
        let mut db = EncryptedVaultDb::open(&db_path, &key_store, "in-memory-test").expect("open");

        let invalid_order = StoredPaperOrder {
            id: "ORD-BAD-1".into(),
            workspace_mode: "live-broker".into(),
            account_id: DEFAULT_ACCOUNT_ID.into(),
            symbol: "AAPL".into(),
            side: "buy".into(),
            order_type: "market".into(),
            quantity: "1".into(),
            filled_quantity: "0".into(),
            limit_price: None,
            currency: "USD".into(),
            status: "working".into(),
            submitted_at: "2026-11-22T05:00:00Z".into(),
            events: vec![],
        };
        assert!(matches!(
            db.save_paper_order(&invalid_order),
            Err(StorageError::InvalidInput(_))
        ));

        let hkd_order = StoredPaperOrder {
            id: "PAPER-HKD-1".into(),
            workspace_mode: "local-csv".into(),
            account_id: DEFAULT_ACCOUNT_ID.into(),
            symbol: "00700.HK".into(),
            side: "buy".into(),
            order_type: "limit".into(),
            quantity: "100".into(),
            filled_quantity: "0".into(),
            limit_price: Some("380.00".into()),
            currency: "HKD".into(),
            status: "working".into(),
            submitted_at: "2026-11-22T05:00:00Z".into(),
            events: vec![],
        };
        db.save_paper_order(&hkd_order).expect("save hkd order");
        let loaded = db.load_paper_orders("local-csv").expect("load orders");
        assert_eq!(loaded.len(), 1);
        assert_eq!(loaded[0].currency, "HKD");
        assert_eq!(loaded[0].account_id, DEFAULT_ACCOUNT_ID);

        // Deserializing a legacy order JSON without `currency` or `accountId` defaults cleanly.
        let legacy_json = r#"{"id":"OLD-1","workspaceMode":"mock","symbol":"AAPL","side":"buy","orderType":"market","quantity":"1","filledQuantity":"0","limitPrice":null,"status":"working","submittedAt":"2026-11-22T00:00:00Z","events":[]}"#;
        let parsed: StoredPaperOrder = serde_json::from_str(legacy_json).expect("legacy parse");
        assert_eq!(parsed.currency, "USD");
        assert_eq!(parsed.account_id, DEFAULT_ACCOUNT_ID);

        cleanup_temp_db(&db_path);
    }

    #[test]
    fn migrates_legacy_v1_database_idempotently_and_encrypts_accounts_nav_and_benchmarks() {
        let db_path = unique_temp_db("wave2-migration");
        let key_store = InMemoryKeyStore::new();

        // 1. Create a vault and drop the Wave 2 tables to simulate an existing v1 database on disk.
        {
            let mut db =
                EncryptedVaultDb::open(&db_path, &key_store, "in-memory-test").expect("open");
            db.save_portfolio_snapshot(&sample_snapshot("fp-legacy"))
                .expect("save legacy snap");
            db.conn
                .execute_batch(
                    "DROP TABLE IF EXISTS accounts;
                     DROP TABLE IF EXISTS nav_snapshots;
                     DROP TABLE IF EXISTS benchmark_history;",
                )
                .expect("simulate v1 schema");
        }

        // 2. Reopen smoothly migrates v1 DB: creates new tables, preserves existing snapshot, seeds default account.
        {
            let mut db =
                EncryptedVaultDb::open(&db_path, &key_store, "in-memory-test").expect("migrate");
            let accounts = db.list_accounts().expect("list accounts");
            assert_eq!(accounts.len(), 1);
            assert_eq!(accounts[0].id, DEFAULT_ACCOUNT_ID);

            let legacy_snap = db
                .load_latest_portfolio_snapshot()
                .expect("load legacy")
                .expect("preserved");
            assert_eq!(legacy_snap.account_id, DEFAULT_ACCOUNT_ID);
            assert_eq!(legacy_snap.cash, "14250.50");

            // Add a second account, NAV snapshots, and benchmark cache.
            db.upsert_account(&StoredAccount {
                id: "acct_schwab_ira".into(),
                name: "Schwab IRA SecretLabel99".into(),
                broker: "Schwab".into(),
                account_type: "ira".into(),
                base_currency: "USD".into(),
                created_at: "2026-11-22T03:00:00.000Z".into(),
            })
            .expect("upsert account");

            db.upsert_nav_snapshot(
                &StoredNavSnapshot {
                    date: "2026-11-21".into(),
                    account_id: "acct_schwab_ira".into(),
                    currency: "USD".into(),
                    net_value_micros: 88_776_655_000,
                    cash_micros: 10_000_000_000,
                    positions_micros: 78_776_655_000,
                    external_cash_flow_micros: 5_000_000_000,
                    source: "csv-import".into(),
                    updated_at: "2026-11-21T21:00:00.000Z".into(),
                },
                false,
            )
            .expect("upsert nav");

            // Idempotent re-upsert preserves existing external cash flow when incoming CF == 0.
            let updated_nav = db
                .upsert_nav_snapshot(
                    &StoredNavSnapshot {
                        date: "2026-11-21".into(),
                        account_id: "acct_schwab_ira".into(),
                        currency: "USD".into(),
                        net_value_micros: 89_000_000_000,
                        cash_micros: 10_000_000_000,
                        positions_micros: 79_000_000_000,
                        external_cash_flow_micros: 0,
                        source: "portfolio-load".into(),
                        updated_at: "2026-11-21T22:00:00.000Z".into(),
                    },
                    true,
                )
                .expect("idempotent nav upsert");
            assert_eq!(updated_nav.external_cash_flow_micros, 5_000_000_000);
            assert_eq!(updated_nav.net_value_micros, 89_000_000_000);

            // Rejects MULTI currency nav snapshots Fail-Closed.
            assert!(db
                .upsert_nav_snapshot(
                    &StoredNavSnapshot {
                        date: "2026-11-22".into(),
                        account_id: "acct_schwab_ira".into(),
                        currency: "MULTI".into(),
                        net_value_micros: 1_000_000,
                        cash_micros: 1_000_000,
                        positions_micros: 0,
                        external_cash_flow_micros: 0,
                        source: "test".into(),
                        updated_at: "2026-11-22T00:00:00.000Z".into(),
                    },
                    false,
                )
                .is_err());

            db.upsert_benchmark_series(&StoredBenchmarkSeries {
                symbol: "SPY".into(),
                currency: "USD".into(),
                provider: "stooq.com".into(),
                as_of_utc: "2026-11-22T00:00:00.000Z".into(),
                points: vec![BenchmarkPricePoint {
                    date: "2026-11-21".into(),
                    close_micros: 591_230_000,
                }],
            })
            .expect("upsert benchmark");
        }

        // Verify zero plaintext leakage of account names, NAV micros, or benchmark prices on disk.
        let raw_bytes = fs::read(&db_path).expect("read db");
        let raw_text = String::from_utf8_lossy(&raw_bytes);
        assert!(!raw_text.contains("SecretLabel99"));
        assert!(!raw_text.contains("89000000000"));
        assert!(!raw_text.contains("591230000"));

        cleanup_temp_db(&db_path);
    }

    #[test]
    fn fhvault_backup_losslessly_restores_wave2_tables_and_stays_v1_backward_compatible() {
        let src_path = unique_temp_db("wave2-bk-src");
        let dst_path = unique_temp_db("wave2-bk-dst");
        let v1_dst_path = unique_temp_db("wave2-bk-v1");
        let src_keys = InMemoryKeyStore::new();
        let dst_keys = InMemoryKeyStore::new();
        let v1_keys = InMemoryKeyStore::new();

        let exported = {
            let mut db =
                EncryptedVaultDb::open(&src_path, &src_keys, "in-memory-test").expect("src open");
            db.upsert_account(&StoredAccount {
                id: "acct_futu_hk".into(),
                name: "Futu HK".into(),
                broker: "Futu".into(),
                account_type: "taxable".into(),
                base_currency: "HKD".into(),
                created_at: "2026-11-22T02:00:00.000Z".into(),
            })
            .expect("acct");
            db.upsert_nav_snapshot(
                &StoredNavSnapshot {
                    date: "2026-11-20".into(),
                    account_id: "acct_futu_hk".into(),
                    currency: "HKD".into(),
                    net_value_micros: 53_000_000_000,
                    cash_micros: 15_000_000_000,
                    positions_micros: 38_000_000_000,
                    external_cash_flow_micros: 0,
                    source: "csv-import".into(),
                    updated_at: "2026-11-20T08:00:00.000Z".into(),
                },
                false,
            )
            .expect("nav");
            db.upsert_benchmark_series(&StoredBenchmarkSeries {
                symbol: "2800.HK".into(),
                currency: "HKD".into(),
                provider: "stooq.com".into(),
                as_of_utc: "2026-11-22T00:00:00.000Z".into(),
                points: vec![BenchmarkPricePoint {
                    date: "2026-11-20".into(),
                    close_micros: 20_450_000,
                }],
            })
            .expect("bench");
            db.export_backup_payload().expect("export")
        };

        // 1. Lossless restore of Wave 2 backup payload (accounts + nav_snapshots + benchmark_history)
        {
            let mut dst =
                EncryptedVaultDb::open(&dst_path, &dst_keys, "in-memory-test").expect("dst open");
            let (_, summary) = dst
                .restore_from_backup_payload(exported.clone(), &dst_keys)
                .expect("restore wave2");
            assert_eq!(summary.account_count, 2);
            assert_eq!(summary.nav_snapshot_count, 1);
            assert_eq!(summary.benchmark_count, 1);

            let restored_accounts = dst.list_accounts().expect("accounts");
            assert!(restored_accounts.iter().any(|a| a.id == "acct_futu_hk"));
            let restored_nav = dst
                .load_nav_snapshots(Some("acct_futu_hk"), Some("HKD"))
                .expect("nav");
            assert_eq!(restored_nav.len(), 1);
            assert_eq!(restored_nav[0].net_value_micros, 53_000_000_000);
            let restored_bench = dst
                .load_benchmark_series("2800.HK")
                .expect("bench")
                .expect("some");
            assert_eq!(restored_bench.points[0].close_micros, 20_450_000);
        }

        // 2. Backward-compatible restore of a legacy v1 JSON payload (NO accounts/navSnapshots/benchmarkHistory fields)
        {
            let mut v1_json_val = serde_json::to_value(&exported).expect("to value");
            let obj = v1_json_val.as_object_mut().expect("object");
            obj.remove("accounts");
            obj.remove("navSnapshots");
            obj.remove("benchmarkHistory");
            let v1_payload: VaultBackupPayload =
                serde_json::from_value(v1_json_val).expect("parse v1 backup");
            assert!(v1_payload.accounts.is_empty());
            assert!(v1_payload.nav_snapshots.is_empty());

            let mut v1_dst =
                EncryptedVaultDb::open(&v1_dst_path, &v1_keys, "in-memory-test").expect("v1 open");
            let (_, summary) = v1_dst
                .restore_from_backup_payload(v1_payload, &v1_keys)
                .expect("v1 restore ok");
            assert_eq!(summary.account_count, 0);
            assert_eq!(summary.nav_snapshot_count, 0);
            // Smoothly ensured default account exists after v1 restore!
            let accounts = v1_dst.list_accounts().expect("default acct");
            assert_eq!(accounts.len(), 1);
            assert_eq!(accounts[0].id, DEFAULT_ACCOUNT_ID);
        }

        cleanup_temp_db(&src_path);
        cleanup_temp_db(&dst_path);
        cleanup_temp_db(&v1_dst_path);
    }
}
