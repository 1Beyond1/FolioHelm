//! OS-backed key management, authenticated record encryption (AES-256-GCM),
//! Argon2id passphrase-protected `.fhvault` offline backups, and App Lock verification.
//!
//! Security invariants:
//! - Secrets and derived keys are always held in `Zeroizing` buffers so memory is scrubbed on drop.
//! - If an encrypted database already exists on disk but OS keyring material is
//!   missing, initialization fails closed and never overwrites or resets data.
//! - Every encrypted record binds `(schema_version, table, record_id)` via AEAD
//!   associated data (AAD) so ciphertext cannot be transplanted across rows.
//! - `.fhvault` offline backups derive 256-bit keys via Argon2id with random 128-bit salts
//!   and authenticate all header/KDF parameters as AES-256-GCM AAD.
//! - App Lock stores only an Argon2id verifier (salt + hash) and compares in constant time;
//!   plaintext passphrases are never persisted or logged.

use std::{collections::BTreeMap, sync::Mutex};

use aes_gcm::{
    aead::{Aead, KeyInit, Payload},
    Aes256Gcm, Nonce,
};
use argon2::{Algorithm, Argon2, Params, Version};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use ed25519_dalek::SigningKey;
use serde::{Deserialize, Serialize};
use subtle::ConstantTimeEq;
use thiserror::Error;
use zeroize::Zeroizing;

pub const VAULT_KEYRING_SERVICE: &str = "io.foliohelm.desktop.vault";
pub const DB_MASTER_KEY_ACCOUNT: &str = "db_master_key_v1";
pub const DEVICE_SIGNING_SEED_ACCOUNT: &str = "device_ed25519_seed_v1";
pub const VAULT_CRYPTO_VERSION: u8 = 1;

pub const FHVAULT_FORMAT: &str = "foliohelm-vault-backup";
pub const FHVAULT_VERSION: u16 = 1;
pub const MAX_FHVAULT_BYTES: usize = 20 * 1024 * 1024;
pub const MIN_PASSPHRASE_LEN: usize = 10;

/// Production Argon2id parameters: 64 MiB memory, 3 iterations, 1 lane.
pub const ARGON2_MEMORY_KIB: u32 = 65_536;
pub const ARGON2_ITERATIONS: u32 = 3;
pub const ARGON2_PARALLELISM: u32 = 1;

const MIN_IMPORT_ARGON2_MEMORY_KIB: u32 = 1_024;
const MAX_IMPORT_ARGON2_MEMORY_KIB: u32 = 262_144;
const MIN_IMPORT_ARGON2_ITERATIONS: u32 = 1;
const MAX_IMPORT_ARGON2_ITERATIONS: u32 = 20;
const MAX_IMPORT_ARGON2_PARALLELISM: u32 = 8;

const SALT_LEN: usize = 16;
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
    #[error("passphrase must be at least {MIN_PASSPHRASE_LEN} characters long")]
    WeakPassphrase,
    #[error("Argon2id key derivation failed: {0}")]
    KdfFailed(String),
    #[error("encrypted backup exceeds the 20 MB safety limit")]
    BackupTooLarge,
    #[error("invalid .fhvault backup format: {0}")]
    InvalidBackupFormat(String),
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

    /// Encode the Ed25519 device signing seed strictly for embedding inside an
    /// Argon2id + AES-256-GCM encrypted `.fhvault` backup payload.
    pub fn device_signing_seed_hex(&self) -> Zeroizing<String> {
        encode_key32(&self.device_signing_seed)
    }

    /// Replace the device signing seed in the OS keyring and memory, returning the
    /// previous seed so callers can roll back cleanly if a database transaction fails.
    pub fn replace_signing_seed(
        &mut self,
        store: &dyn KeyStore,
        new_seed_hex: &str,
    ) -> Result<Zeroizing<[u8; 32]>, VaultError> {
        let decoded = decode_key32(new_seed_hex)?;
        let normalized_hex = encode_key32(&decoded);
        store.set_secret(
            VAULT_KEYRING_SERVICE,
            DEVICE_SIGNING_SEED_ACCOUNT,
            &normalized_hex,
        )?;
        let previous = std::mem::replace(&mut self.device_signing_seed, decoded);
        Ok(previous)
    }

    /// Restore a previously replaced signing seed on rollback.
    pub fn restore_signing_seed(
        &mut self,
        store: &dyn KeyStore,
        previous_seed: Zeroizing<[u8; 32]>,
    ) -> Result<(), VaultError> {
        let hex = encode_key32(&previous_seed);
        store.set_secret(VAULT_KEYRING_SERVICE, DEVICE_SIGNING_SEED_ACCOUNT, &hex)?;
        self.device_signing_seed = previous_seed;
        Ok(())
    }

    /// Constant-time check comparing the current device signing seed against a hex candidate.
    pub fn signing_seed_matches_hex(&self, candidate_hex: &str) -> bool {
        match decode_key32(candidate_hex) {
            Ok(decoded) => bool::from(
                self.device_signing_seed
                    .as_slice()
                    .ct_eq(decoded.as_slice()),
            ),
            Err(_) => false,
        }
    }
}

pub fn decode_signing_key_hex(seed_hex: &str) -> Result<SigningKey, VaultError> {
    let seed = decode_key32(seed_hex)?;
    Ok(SigningKey::from_bytes(&seed))
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

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FhVaultKdfParams {
    pub algorithm: String,
    pub version: u32,
    pub memory_kib: u32,
    pub iterations: u32,
    pub parallelism: u32,
    pub salt_b64: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FhVaultEnvelope {
    pub format: String,
    pub version: u16,
    pub kdf: FhVaultKdfParams,
    pub cipher: String,
    pub nonce_b64: String,
    pub ciphertext_b64: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppLockVerifier {
    pub algorithm: String,
    pub version: u32,
    pub memory_kib: u32,
    pub iterations: u32,
    pub parallelism: u32,
    pub salt_b64: String,
    pub hash_b64: String,
}

fn validate_passphrase_strength(passphrase: &str) -> Result<(), VaultError> {
    if passphrase.chars().count() < MIN_PASSPHRASE_LEN {
        return Err(VaultError::WeakPassphrase);
    }
    Ok(())
}

fn validate_kdf_bounds(
    memory_kib: u32,
    iterations: u32,
    parallelism: u32,
) -> Result<(), VaultError> {
    if !(MIN_IMPORT_ARGON2_MEMORY_KIB..=MAX_IMPORT_ARGON2_MEMORY_KIB).contains(&memory_kib) {
        return Err(VaultError::InvalidBackupFormat(format!(
            "Argon2id memoryKiB out of safe bounds: {memory_kib}"
        )));
    }
    if !(MIN_IMPORT_ARGON2_ITERATIONS..=MAX_IMPORT_ARGON2_ITERATIONS).contains(&iterations) {
        return Err(VaultError::InvalidBackupFormat(format!(
            "Argon2id iterations out of safe bounds: {iterations}"
        )));
    }
    if parallelism == 0 || parallelism > MAX_IMPORT_ARGON2_PARALLELISM {
        return Err(VaultError::InvalidBackupFormat(format!(
            "Argon2id parallelism out of safe bounds: {parallelism}"
        )));
    }
    Ok(())
}

pub fn derive_argon2id_key(
    passphrase: &str,
    salt: &[u8],
    memory_kib: u32,
    iterations: u32,
    parallelism: u32,
) -> Result<Zeroizing<[u8; 32]>, VaultError> {
    if salt.len() != SALT_LEN {
        return Err(VaultError::KdfFailed("expected 128-bit salt".to_string()));
    }
    validate_kdf_bounds(memory_kib, iterations, parallelism)?;
    let params = Params::new(memory_kib, iterations, parallelism, Some(32))
        .map_err(|error| VaultError::KdfFailed(error.to_string()))?;
    let argon2 = Argon2::new(Algorithm::Argon2id, Version::V0x13, params);
    let mut key = Zeroizing::new([0_u8; 32]);
    argon2
        .hash_password_into(passphrase.as_bytes(), salt, &mut *key)
        .map_err(|error| VaultError::KdfFailed(error.to_string()))?;
    Ok(key)
}

fn build_fhvault_aad(version: u16, kdf: &FhVaultKdfParams, cipher: &str) -> Vec<u8> {
    format!(
        "foliohelm-fhvault|v{version}|{}|v{}|m={}|t={}|p={}|salt={}|{cipher}",
        kdf.algorithm, kdf.version, kdf.memory_kib, kdf.iterations, kdf.parallelism, kdf.salt_b64
    )
    .into_bytes()
}

/// Encrypt a serialized vault payload into a passphrase-protected `.fhvault` JSON envelope
/// using Argon2id (64 MiB, 3 iterations, 128-bit random salt) + AES-256-GCM + full header AAD.
pub fn encrypt_fhvault_backup(passphrase: &str, plaintext: &[u8]) -> Result<String, VaultError> {
    encrypt_fhvault_backup_with_params(
        passphrase,
        plaintext,
        ARGON2_MEMORY_KIB,
        ARGON2_ITERATIONS,
        ARGON2_PARALLELISM,
    )
}

pub fn encrypt_fhvault_backup_with_params(
    passphrase: &str,
    plaintext: &[u8],
    memory_kib: u32,
    iterations: u32,
    parallelism: u32,
) -> Result<String, VaultError> {
    validate_passphrase_strength(passphrase)?;
    if plaintext.len() > MAX_FHVAULT_BYTES {
        return Err(VaultError::BackupTooLarge);
    }

    let mut salt = [0_u8; SALT_LEN];
    getrandom::fill(&mut salt).map_err(|_| VaultError::RandomnessUnavailable)?;
    let mut nonce_bytes = [0_u8; NONCE_LEN];
    getrandom::fill(&mut nonce_bytes).map_err(|_| VaultError::RandomnessUnavailable)?;

    let key = derive_argon2id_key(passphrase, &salt, memory_kib, iterations, parallelism)?;
    let kdf = FhVaultKdfParams {
        algorithm: "argon2id".to_string(),
        version: u32::from(Version::V0x13 as u8),
        memory_kib,
        iterations,
        parallelism,
        salt_b64: BASE64.encode(salt),
    };
    let cipher_name = "aes-256-gcm".to_string();
    let aad = build_fhvault_aad(FHVAULT_VERSION, &kdf, &cipher_name);

    let cipher = Aes256Gcm::new((&*key).into());
    let ciphertext = cipher
        .encrypt(
            Nonce::from_slice(&nonce_bytes),
            Payload {
                msg: plaintext,
                aad: &aad,
            },
        )
        .map_err(|_| VaultError::EncryptionFailed)?;

    let envelope = FhVaultEnvelope {
        format: FHVAULT_FORMAT.to_string(),
        version: FHVAULT_VERSION,
        kdf,
        cipher: cipher_name,
        nonce_b64: BASE64.encode(nonce_bytes),
        ciphertext_b64: BASE64.encode(ciphertext),
    };

    let serialized = serde_json::to_string_pretty(&envelope)
        .map_err(|error| VaultError::InvalidBackupFormat(error.to_string()))?;
    if serialized.len() > MAX_FHVAULT_BYTES {
        return Err(VaultError::BackupTooLarge);
    }
    Ok(serialized)
}

/// Fail-closed decryption and header/AAD authentication of a `.fhvault` backup envelope.
pub fn decrypt_fhvault_backup(
    passphrase: &str,
    raw_backup: &str,
) -> Result<Zeroizing<Vec<u8>>, VaultError> {
    if raw_backup.len() > MAX_FHVAULT_BYTES {
        return Err(VaultError::BackupTooLarge);
    }
    if passphrase.is_empty() {
        return Err(VaultError::DecryptionFailed(
            "passphrase is required to decrypt .fhvault backup".to_string(),
        ));
    }

    let envelope: FhVaultEnvelope = serde_json::from_str(raw_backup)
        .map_err(|error| VaultError::InvalidBackupFormat(error.to_string()))?;
    if envelope.format != FHVAULT_FORMAT {
        return Err(VaultError::InvalidBackupFormat(format!(
            "unsupported backup format '{}'",
            envelope.format
        )));
    }
    if envelope.version != FHVAULT_VERSION {
        return Err(VaultError::InvalidBackupFormat(format!(
            "unsupported backup version {}",
            envelope.version
        )));
    }
    if envelope.cipher != "aes-256-gcm" {
        return Err(VaultError::InvalidBackupFormat(format!(
            "unsupported backup cipher '{}'",
            envelope.cipher
        )));
    }
    if envelope.kdf.algorithm != "argon2id"
        || envelope.kdf.version != u32::from(Version::V0x13 as u8)
    {
        return Err(VaultError::InvalidBackupFormat(
            "unsupported KDF algorithm or version".to_string(),
        ));
    }
    validate_kdf_bounds(
        envelope.kdf.memory_kib,
        envelope.kdf.iterations,
        envelope.kdf.parallelism,
    )?;

    let salt = BASE64
        .decode(envelope.kdf.salt_b64.as_bytes())
        .map_err(|_| VaultError::InvalidBackupFormat("invalid base64 salt".to_string()))?;
    if salt.len() != SALT_LEN {
        return Err(VaultError::InvalidBackupFormat(
            "backup salt must be 128 bits".to_string(),
        ));
    }
    let nonce_bytes = BASE64
        .decode(envelope.nonce_b64.as_bytes())
        .map_err(|_| VaultError::InvalidBackupFormat("invalid base64 nonce".to_string()))?;
    if nonce_bytes.len() != NONCE_LEN {
        return Err(VaultError::InvalidBackupFormat(
            "backup nonce must be 96 bits".to_string(),
        ));
    }
    let ciphertext = BASE64
        .decode(envelope.ciphertext_b64.as_bytes())
        .map_err(|_| VaultError::InvalidBackupFormat("invalid base64 ciphertext".to_string()))?;
    if ciphertext.len() < TAG_LEN {
        return Err(VaultError::InvalidBackupFormat(
            "backup ciphertext is truncated".to_string(),
        ));
    }

    let key = derive_argon2id_key(
        passphrase,
        &salt,
        envelope.kdf.memory_kib,
        envelope.kdf.iterations,
        envelope.kdf.parallelism,
    )?;
    let aad = build_fhvault_aad(envelope.version, &envelope.kdf, &envelope.cipher);
    let cipher = Aes256Gcm::new((&*key).into());
    let plaintext = cipher
        .decrypt(
            Nonce::from_slice(&nonce_bytes),
            Payload {
                msg: &ciphertext,
                aad: &aad,
            },
        )
        .map_err(|_| {
            VaultError::DecryptionFailed(
                "wrong passphrase or tampered .fhvault backup (AEAD authentication failed)"
                    .to_string(),
            )
        })?;
    Ok(Zeroizing::new(plaintext))
}

/// Create a non-reversible Argon2id verifier for App Lock (never persists the plaintext passphrase).
pub fn create_app_lock_verifier(passphrase: &str) -> Result<AppLockVerifier, VaultError> {
    create_app_lock_verifier_with_params(
        passphrase,
        ARGON2_MEMORY_KIB,
        ARGON2_ITERATIONS,
        ARGON2_PARALLELISM,
    )
}

pub fn create_app_lock_verifier_with_params(
    passphrase: &str,
    memory_kib: u32,
    iterations: u32,
    parallelism: u32,
) -> Result<AppLockVerifier, VaultError> {
    validate_passphrase_strength(passphrase)?;
    let mut salt = [0_u8; SALT_LEN];
    getrandom::fill(&mut salt).map_err(|_| VaultError::RandomnessUnavailable)?;
    let derived = derive_argon2id_key(passphrase, &salt, memory_kib, iterations, parallelism)?;
    Ok(AppLockVerifier {
        algorithm: "argon2id".to_string(),
        version: u32::from(Version::V0x13 as u8),
        memory_kib,
        iterations,
        parallelism,
        salt_b64: BASE64.encode(salt),
        hash_b64: BASE64.encode(*derived),
    })
}

/// Validate structural integrity and KDF bounds of a persisted App Lock verifier.
pub fn validate_app_lock_verifier(
    verifier: &AppLockVerifier,
) -> Result<(Vec<u8>, Vec<u8>), VaultError> {
    if verifier.algorithm != "argon2id" || verifier.version != u32::from(Version::V0x13 as u8) {
        return Err(VaultError::CorruptedKeyMaterial(
            "unsupported app lock verifier algorithm",
        ));
    }
    validate_kdf_bounds(
        verifier.memory_kib,
        verifier.iterations,
        verifier.parallelism,
    )?;
    let salt = BASE64
        .decode(verifier.salt_b64.as_bytes())
        .map_err(|_| VaultError::CorruptedKeyMaterial("invalid app lock verifier salt"))?;
    let expected_hash = BASE64
        .decode(verifier.hash_b64.as_bytes())
        .map_err(|_| VaultError::CorruptedKeyMaterial("invalid app lock verifier hash"))?;
    if salt.len() != SALT_LEN || expected_hash.len() != 32 {
        return Err(VaultError::CorruptedKeyMaterial(
            "unexpected app lock verifier field lengths",
        ));
    }
    Ok((salt, expected_hash))
}

/// Constant-time verification of a candidate App Lock passphrase against a stored Argon2id verifier.
pub fn verify_app_lock_passphrase(
    verifier: &AppLockVerifier,
    candidate_passphrase: &str,
) -> Result<bool, VaultError> {
    let (salt, expected_hash) = validate_app_lock_verifier(verifier)?;
    if candidate_passphrase.is_empty() {
        return Ok(false);
    }
    let candidate = derive_argon2id_key(
        candidate_passphrase,
        &salt,
        verifier.memory_kib,
        verifier.iterations,
        verifier.parallelism,
    )?;
    Ok(bool::from(candidate.as_slice().ct_eq(&expected_hash)))
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

    #[test]
    fn encrypts_and_decrypts_fhvault_backup_with_argon2id_and_rejects_wrong_passphrase_or_tampered_header(
    ) {
        let plaintext = br#"{"portfolio":"VOO","cash":"12500.00"}"#;
        let passphrase = "Correct-Horse-Battery-Staple-2026!";

        // Rejects weak passphrase
        assert_eq!(
            encrypt_fhvault_backup("short", plaintext),
            Err(VaultError::WeakPassphrase)
        );

        // Production Argon2id parameters roundtrip
        let backup = encrypt_fhvault_backup(passphrase, plaintext).expect("encrypt backup");
        assert!(!backup.contains("12500.00"));
        assert!(!backup.contains(passphrase));
        assert!(backup.contains("argon2id"));

        let decrypted = decrypt_fhvault_backup(passphrase, &backup).expect("decrypt backup");
        assert_eq!(decrypted.as_slice(), plaintext);

        // Wrong passphrase must fail closed
        assert!(matches!(
            decrypt_fhvault_backup("Wrong-Passphrase-9999!", &backup),
            Err(VaultError::DecryptionFailed(_))
        ));

        // Tampering with authenticated header/KDF metadata fails AAD verification
        let tampered_header = backup.replace("\"iterations\": 3", "\"iterations\": 2");
        assert!(matches!(
            decrypt_fhvault_backup(passphrase, &tampered_header),
            Err(VaultError::DecryptionFailed(_))
        ));
    }

    #[test]
    fn creates_and_verifies_app_lock_verifier_without_storing_plaintext() {
        let passphrase = "Vault-Lock-Passphrase-2026";
        let verifier =
            create_app_lock_verifier_with_params(passphrase, 4096, 1, 1).expect("verifier");
        let serialized = serde_json::to_string(&verifier).expect("serialize");
        assert!(!serialized.contains(passphrase));

        assert!(verify_app_lock_passphrase(&verifier, passphrase).expect("verify ok"));
        assert!(!verify_app_lock_passphrase(&verifier, "Wrong-Passphrase-2026").expect("verify"));
        assert!(!verify_app_lock_passphrase(&verifier, "").expect("empty"));
    }
}
