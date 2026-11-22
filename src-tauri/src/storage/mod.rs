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

use std::{fs, path::Path};

use chrono::{SecondsFormat, Utc};
use ed25519_dalek::SigningKey;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::{
    evidence::{encode_hex, SignedEvidenceEntry},
    vault::{
        build_aad, decrypt_record, encrypt_record, KeyStore, VaultError, VaultKeyMaterial,
        VAULT_CRYPTO_VERSION,
    },
};

pub const STORAGE_SCHEMA_VERSION: u16 = 1;
const CANARY_PLAINTEXT: &[u8] = b"foliohelm-vault-canary-v1";
const CANARY_RECORD_ID: &str = "canary";

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
pub struct StoredPortfolioSnapshot {
    pub id: String,
    /// Deterministic SHA-256 hex digest of normalized snapshot content for idempotent imports.
    pub fingerprint: String,
    pub source_format: String,
    pub source_label: String,
    pub imported_at_utc: String,
    pub account_label: String,
    pub currency: String,
    /// Exact decimal string.
    pub cash: String,
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
    pub symbol: String,
    pub side: String,
    pub order_type: String,
    pub quantity: String,
    pub filled_quantity: String,
    pub limit_price: Option<String>,
    pub status: String,
    pub submitted_at: String,
    pub events: Vec<StoredPaperOrderEvent>,
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
    pub cipher: String,
    pub schema_version: u16,
    pub key_provider: String,
    pub signer_public_key: Option<String>,
    pub evidence_count: u64,
    pub has_local_portfolio: bool,
    pub locked_reason: Option<String>,
}

pub struct EncryptedVaultDb {
    conn: Connection,
    keys: VaultKeyMaterial,
    key_provider: String,
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

        let database_exists = match fs::metadata(db_path) {
            Ok(meta) => meta.len() > 0,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => false,
            Err(error) => return Err(StorageError::Io(error)),
        };

        // Load or initialize OS-protected key material before opening/creating SQLite.
        let keys = VaultKeyMaterial::load_or_initialize(key_store, database_exists)?;

        let conn = Connection::open(db_path)?;
        configure_connection(&conn)?;

        let mut db = Self {
            conn,
            keys,
            key_provider: key_provider.into(),
        };

        if database_exists {
            db.verify_existing_schema_and_canary()?;
        } else {
            db.initialize_schema()?;
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

        Ok(VaultStatusDto {
            unlocked: true,
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
        let tx = self.conn.transaction()?;
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
            );",
        )?;

        let aad = build_aad(STORAGE_SCHEMA_VERSION, "vault_meta", CANARY_RECORD_ID);
        let canary_blob = encrypt_record(self.keys.db_master_key(), &aad, CANARY_PLAINTEXT)?;

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

    fn verify_existing_schema_and_canary(&self) -> Result<(), StorageError> {
        let schema_bytes: Option<Vec<u8>> = self
            .conn
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

        let canary_blob: Option<Vec<u8>> = self
            .conn
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
        let decrypted = decrypt_record(self.keys.db_master_key(), &aad, &canary_blob)?;
        if decrypted.as_slice() != CANARY_PLAINTEXT {
            return Err(StorageError::Integrity(
                "vault encryption canary mismatch".to_string(),
            ));
        }

        Ok(())
    }

    pub fn load_evidence_entries(&self) -> Result<Vec<SignedEvidenceEntry>, StorageError> {
        let mut stmt = self
            .conn
            .prepare("SELECT sequence, ciphertext FROM evidence_entries ORDER BY sequence ASC")?;
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
            let plaintext = decrypt_record(self.keys.db_master_key(), &aad, &ciphertext)?;
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

    /// Clear all workspace records inside one atomic transaction while keeping
    /// the device key and vault canary intact.
    pub fn clear_all_workspace_data(&mut self) -> Result<(), StorageError> {
        let tx = self.conn.transaction()?;
        tx.execute("DELETE FROM evidence_entries", [])?;
        tx.execute("DELETE FROM portfolio_snapshots", [])?;
        tx.execute("DELETE FROM paper_orders", [])?;
        tx.execute("DELETE FROM quote_cache", [])?;
        tx.execute("DELETE FROM app_settings", [])?;
        tx.commit()?;
        Ok(())
    }
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
            fingerprint: fingerprint.to_string(),
            source_format: "schwab_positions".to_string(),
            source_label: "positions.csv".to_string(),
            imported_at_utc: "2026-11-22T02:00:00.000Z".to_string(),
            account_label: "Local CSV Portfolio".to_string(),
            currency: "USD".to_string(),
            cash: "14250.50".to_string(),
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
}
