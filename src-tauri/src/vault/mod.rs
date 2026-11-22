//! OS-backed key management and authenticated record encryption (AES-256-GCM).
//!
//! Security invariants:
//! - Secrets are always held in `Zeroizing` buffers so memory is scrubbed on drop.
//! - If an encrypted database already exists on disk but OS keyring material is
//!   missing, initialization fails closed and never overwrites or resets data.
//! - Every encrypted record binds `(schema_version, table, record_id)` via AEAD
//!   associated data (AAD) so ciphertext cannot be transplanted across rows.

use std::{collections::BTreeMap, sync::Mutex};

use aes_gcm::{
    aead::{Aead, KeyInit, Payload},
    Aes256Gcm, Nonce,
};
use ed25519_dalek::SigningKey;
use thiserror::Error;
use zeroize::Zeroizing;

pub const VAULT_KEYRING_SERVICE: &str = "io.foliohelm.desktop.vault";
pub const DB_MASTER_KEY_ACCOUNT: &str = "db_master_key_v1";
pub const DEVICE_SIGNING_SEED_ACCOUNT: &str = "device_ed25519_seed_v1";
pub const VAULT_CRYPTO_VERSION: u8 = 1;

const NONCE_LEN: usize = 12;
const TAG_LEN: usize = 16;
const MIN_BLOB_LEN: usize = 1 + NONCE_LEN + TAG_LEN;

#[derive(Debug, Error, Eq, PartialEq)]
pub enum VaultError {
    #[error("vault is locked: OS keyring key is missing for an existing encrypted database ({0}); existing ciphertext was preserved")]
    KeyMissingForExistingDatabase(String),
    #[error("OS credential store is unavailable: {0}")]
    KeyStoreUnavailable(String),
    #[error("stored key material is corrupted: {0}")]
    CorruptedKeyMaterial(&'static str),
    #[error("operating system CSPRNG is unavailable")]
    RandomnessUnavailable,
    #[error("record encryption failed")]
    EncryptionFailed,
    #[error("record decryption or integrity check failed: {0}")]
    DecryptionFailed(String),
}

/// Abstract OS secret storage so unit tests can inject an isolated in-memory
/// implementation without touching the host Windows Credential Manager.
pub trait KeyStore: Send + Sync {
    fn get_secret(
        &self,
        service: &str,
        account: &str,
    ) -> Result<Option<Zeroizing<String>>, VaultError>;
    fn set_secret(&self, service: &str, account: &str, secret: &str) -> Result<(), VaultError>;
    fn delete_secret(&self, service: &str, account: &str) -> Result<(), VaultError>;
}

/// Production key store backed by Windows Credential Manager / macOS Keychain / Linux keyutils.
#[derive(Debug, Default)]
pub struct OsKeyringStore;

impl KeyStore for OsKeyringStore {
    fn get_secret(
        &self,
        service: &str,
        account: &str,
    ) -> Result<Option<Zeroizing<String>>, VaultError> {
        let entry = keyring::Entry::new(service, account)
            .map_err(|error| VaultError::KeyStoreUnavailable(error.to_string()))?;
        match entry.get_password() {
            Ok(secret) => Ok(Some(Zeroizing::new(secret))),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(error) => Err(VaultError::KeyStoreUnavailable(error.to_string())),
        }
    }

    fn set_secret(&self, service: &str, account: &str, secret: &str) -> Result<(), VaultError> {
        let entry = keyring::Entry::new(service, account)
            .map_err(|error| VaultError::KeyStoreUnavailable(error.to_string()))?;
        entry
            .set_password(secret)
            .map_err(|error| VaultError::KeyStoreUnavailable(error.to_string()))
    }

    fn delete_secret(&self, service: &str, account: &str) -> Result<(), VaultError> {
        let entry = keyring::Entry::new(service, account)
            .map_err(|error| VaultError::KeyStoreUnavailable(error.to_string()))?;
        match entry.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(error) => Err(VaultError::KeyStoreUnavailable(error.to_string())),
        }
    }
}

/// Isolated in-memory key store strictly for deterministic testing.
#[derive(Debug, Default)]
pub struct InMemoryKeyStore {
    entries: Mutex<BTreeMap<(String, String), Zeroizing<String>>>,
}

impl InMemoryKeyStore {
    pub fn new() -> Self {
        Self::default()
    }
}

impl KeyStore for InMemoryKeyStore {
    fn get_secret(
        &self,
        service: &str,
        account: &str,
    ) -> Result<Option<Zeroizing<String>>, VaultError> {
        let guard = self
            .entries
            .lock()
            .map_err(|_| VaultError::KeyStoreUnavailable("in-memory store lock poisoned".into()))?;
        Ok(guard
            .get(&(service.to_string(), account.to_string()))
            .cloned())
    }

    fn set_secret(&self, service: &str, account: &str, secret: &str) -> Result<(), VaultError> {
        let mut guard = self
            .entries
            .lock()
            .map_err(|_| VaultError::KeyStoreUnavailable("in-memory store lock poisoned".into()))?;
        guard.insert(
            (service.to_string(), account.to_string()),
            Zeroizing::new(secret.to_string()),
        );
        Ok(())
    }

    fn delete_secret(&self, service: &str, account: &str) -> Result<(), VaultError> {
        let mut guard = self
            .entries
            .lock()
            .map_err(|_| VaultError::KeyStoreUnavailable("in-memory store lock poisoned".into()))?;
        guard.remove(&(service.to_string(), account.to_string()));
        Ok(())
    }
}

/// Zeroizing container for the database encryption key and Ed25519 device seed.
pub struct VaultKeyMaterial {
    db_master_key: Zeroizing<[u8; 32]>,
    device_signing_seed: Zeroizing<[u8; 32]>,
}

impl VaultKeyMaterial {
    /// Load existing keys from the OS keyring or generate new ones on first launch.
    ///
    /// Fail-closed behavior:
    /// - If `database_exists` is true and either key is missing, returns
    ///   `VaultError::KeyMissingForExistingDatabase` without modifying the keyring or DB.
    /// - If only one of the two keys exists (partial state), also fails closed.
    pub fn load_or_initialize(
        store: &dyn KeyStore,
        database_exists: bool,
    ) -> Result<Self, VaultError> {
        let db_secret = store.get_secret(VAULT_KEYRING_SERVICE, DB_MASTER_KEY_ACCOUNT)?;
        let seed_secret = store.get_secret(VAULT_KEYRING_SERVICE, DEVICE_SIGNING_SEED_ACCOUNT)?;

        match (db_secret, seed_secret) {
            (Some(db_hex), Some(seed_hex)) => Ok(Self {
                db_master_key: decode_key32(&db_hex)?,
                device_signing_seed: decode_key32(&seed_hex)?,
            }),
            (Some(_), None) => Err(VaultError::KeyMissingForExistingDatabase(
                DEVICE_SIGNING_SEED_ACCOUNT.to_string(),
            )),
            (None, Some(_)) => Err(VaultError::KeyMissingForExistingDatabase(
                DB_MASTER_KEY_ACCOUNT.to_string(),
            )),
            (None, None) if database_exists => Err(VaultError::KeyMissingForExistingDatabase(
                format!("{DB_MASTER_KEY_ACCOUNT}, {DEVICE_SIGNING_SEED_ACCOUNT}"),
            )),
            (None, None) => {
                let db_master_key = generate_random_key32()?;
                let device_signing_seed = generate_random_key32()?;

                let db_hex = encode_key32(&db_master_key);
                let seed_hex = encode_key32(&device_signing_seed);

                store.set_secret(VAULT_KEYRING_SERVICE, DB_MASTER_KEY_ACCOUNT, &db_hex)?;
                if let Err(error) = store.set_secret(
                    VAULT_KEYRING_SERVICE,
                    DEVICE_SIGNING_SEED_ACCOUNT,
                    &seed_hex,
                ) {
                    let _ = store.delete_secret(VAULT_KEYRING_SERVICE, DB_MASTER_KEY_ACCOUNT);
                    return Err(error);
                }

                Ok(Self {
                    db_master_key,
                    device_signing_seed,
                })
            }
        }
    }

    pub fn db_master_key(&self) -> &[u8; 32] {
        &self.db_master_key
    }

    pub fn signing_key(&self) -> SigningKey {
        SigningKey::from_bytes(&self.device_signing_seed)
    }
}

pub fn build_aad(schema_version: u16, table: &str, record_id: &str) -> Vec<u8> {
    format!("foliohelm|v{schema_version}|{table}|{record_id}").into_bytes()
}

pub fn encrypt_record(key: &[u8; 32], aad: &[u8], plaintext: &[u8]) -> Result<Vec<u8>, VaultError> {
    let mut nonce_bytes = [0_u8; NONCE_LEN];
    getrandom::fill(&mut nonce_bytes).map_err(|_| VaultError::RandomnessUnavailable)?;
    let cipher = Aes256Gcm::new(key.into());
    let nonce = Nonce::from_slice(&nonce_bytes);
    let ciphertext = cipher
        .encrypt(
            nonce,
            Payload {
                msg: plaintext,
                aad,
            },
        )
        .map_err(|_| VaultError::EncryptionFailed)?;

    let mut out = Vec::with_capacity(1 + NONCE_LEN + ciphertext.len());
    out.push(VAULT_CRYPTO_VERSION);
    out.extend_from_slice(&nonce_bytes);
    out.extend_from_slice(&ciphertext);
    Ok(out)
}

pub fn decrypt_record(
    key: &[u8; 32],
    aad: &[u8],
    blob: &[u8],
) -> Result<Zeroizing<Vec<u8>>, VaultError> {
    if blob.len() < MIN_BLOB_LEN {
        return Err(VaultError::DecryptionFailed(
            "encrypted blob is truncated".to_string(),
        ));
    }
    if blob[0] != VAULT_CRYPTO_VERSION {
        return Err(VaultError::DecryptionFailed(format!(
            "unsupported vault crypto version {}",
            blob[0]
        )));
    }

    let nonce = Nonce::from_slice(&blob[1..1 + NONCE_LEN]);
    let ciphertext = &blob[1 + NONCE_LEN..];
    let cipher = Aes256Gcm::new(key.into());
    let plaintext = cipher
        .decrypt(
            nonce,
            Payload {
                msg: ciphertext,
                aad,
            },
        )
        .map_err(|_| {
            VaultError::DecryptionFailed(
                "AES-256-GCM authentication failed (wrong key, wrong AAD, or tampered ciphertext)"
                    .to_string(),
            )
        })?;
    Ok(Zeroizing::new(plaintext))
}

fn generate_random_key32() -> Result<Zeroizing<[u8; 32]>, VaultError> {
    let mut key = Zeroizing::new([0_u8; 32]);
    getrandom::fill(&mut *key).map_err(|_| VaultError::RandomnessUnavailable)?;
    Ok(key)
}

fn encode_key32(key: &[u8; 32]) -> Zeroizing<String> {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(64);
    for byte in key {
        out.push(HEX[usize::from(byte >> 4)] as char);
        out.push(HEX[usize::from(byte & 0x0f)] as char);
    }
    Zeroizing::new(out)
}

fn decode_key32(hex: &str) -> Result<Zeroizing<[u8; 32]>, VaultError> {
    let trimmed = hex.trim();
    if trimmed.len() != 64 {
        return Err(VaultError::CorruptedKeyMaterial(
            "expected 64 hex characters for 256-bit key",
        ));
    }
    let mut out = Zeroizing::new([0_u8; 32]);
    for (index, pair) in trimmed.as_bytes().chunks_exact(2).enumerate() {
        let high = decode_nibble(pair[0])
            .ok_or(VaultError::CorruptedKeyMaterial("non-hex byte in key"))?;
        let low = decode_nibble(pair[1])
            .ok_or(VaultError::CorruptedKeyMaterial("non-hex byte in key"))?;
        out[index] = (high << 4) | low;
    }
    Ok(out)
}

fn decode_nibble(value: u8) -> Option<u8> {
    match value {
        b'0'..=b'9' => Some(value - b'0'),
        b'a'..=b'f' => Some(value - b'a' + 10),
        b'A'..=b'F' => Some(value - b'A' + 10),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn initializes_keys_once_and_reloads_identically() {
        let store = InMemoryKeyStore::new();
        let first = VaultKeyMaterial::load_or_initialize(&store, false).expect("initializes keys");
        let second = VaultKeyMaterial::load_or_initialize(&store, true).expect("reloads keys");

        assert_eq!(first.db_master_key(), second.db_master_key());
        assert_eq!(
            first.signing_key().verifying_key().to_bytes(),
            second.signing_key().verifying_key().to_bytes()
        );
    }

    #[test]
    fn fails_closed_when_existing_database_has_no_keyring_keys() {
        let store = InMemoryKeyStore::new();
        let error = VaultKeyMaterial::load_or_initialize(&store, true)
            .err()
            .expect("must fail closed");
        assert!(matches!(
            error,
            VaultError::KeyMissingForExistingDatabase(_)
        ));
        assert!(store
            .get_secret(VAULT_KEYRING_SERVICE, DB_MASTER_KEY_ACCOUNT)
            .expect("read succeeds")
            .is_none());
    }

    #[test]
    fn encrypts_and_decrypts_with_aad_and_rejects_tampering_or_row_swap() {
        let store = InMemoryKeyStore::new();
        let keys = VaultKeyMaterial::load_or_initialize(&store, false).expect("keys");
        let aad = build_aad(1, "portfolio_snapshots", "snap-01");
        let plaintext = br#"{"symbol":"AAPL","quantity":"100"}"#;

        let blob = encrypt_record(keys.db_master_key(), &aad, plaintext).expect("encrypt");
        assert_ne!(&blob[13..], plaintext);

        let decrypted = decrypt_record(keys.db_master_key(), &aad, &blob).expect("decrypt");
        assert_eq!(decrypted.as_slice(), plaintext);

        // Wrong AAD (cross-row transplant attack) must fail closed.
        let wrong_aad = build_aad(1, "portfolio_snapshots", "snap-02");
        assert!(matches!(
            decrypt_record(keys.db_master_key(), &wrong_aad, &blob),
            Err(VaultError::DecryptionFailed(_))
        ));

        // Single-bit ciphertext tamper must fail closed.
        let mut tampered = blob.clone();
        let last = tampered.len() - 1;
        tampered[last] ^= 0x01;
        assert!(matches!(
            decrypt_record(keys.db_master_key(), &aad, &tampered),
            Err(VaultError::DecryptionFailed(_))
        ));
    }
}
