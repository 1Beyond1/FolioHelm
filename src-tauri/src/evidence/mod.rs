//! Tamper-evident evidence primitives.
//!
//! This module is deliberately independent from storage and networking. The
//! SQLCipher repository and optional notary transport will be added around
//! these types, never inside the hash/signature implementation.

use std::{collections::BTreeMap, error::Error as StdError, future::Future, pin::Pin};

use chrono::{DateTime, SecondsFormat, Utc};
use ed25519_dalek::{Signature, Signer, SigningKey, VerifyingKey};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use thiserror::Error;

pub const EVIDENCE_SCHEMA_VERSION: u16 = 1;
pub const GENESIS_HASH: [u8; 32] = [0; 32];

const PAYLOAD_DOMAIN: &[u8] = b"foliohelm/evidence-payload/v1";
const ENTRY_DOMAIN: &[u8] = b"foliohelm/evidence-entry/v1";
const CHECKPOINT_DOMAIN: &[u8] = b"foliohelm/evidence-checkpoint/v1";
const RECEIPT_DOMAIN: &[u8] = b"foliohelm/evidence-receipt/v1";

pub type Hash32 = [u8; 32];
pub type PublicKey32 = [u8; 32];
pub type Signature64 = [u8; 64];

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EvidenceKind {
    DraftCreated,
    PreviewRequested,
    PreviewReceived,
    ConfirmationOpened,
    ConfirmationAccepted,
    DispatchStarted,
    BrokerAccepted,
    BrokerRejected,
    OrderUnknown,
    ReconciliationObserved,
    CancelStarted,
    CancelObserved,
    ReplaceStarted,
    ReplaceObserved,
    SessionLocked,
    SafetySettingChanged,
    StateChanged,
    AutomationRun,
    PortfolioImport,
}

impl EvidenceKind {
    pub fn canonical_name(&self) -> &'static str {
        match self {
            Self::DraftCreated => "draft_created",
            Self::PreviewRequested => "preview_requested",
            Self::PreviewReceived => "preview_received",
            Self::ConfirmationOpened => "confirmation_opened",
            Self::ConfirmationAccepted => "confirmation_accepted",
            Self::DispatchStarted => "dispatch_started",
            Self::BrokerAccepted => "broker_accepted",
            Self::BrokerRejected => "broker_rejected",
            Self::OrderUnknown => "order_unknown",
            Self::ReconciliationObserved => "reconciliation_observed",
            Self::CancelStarted => "cancel_started",
            Self::CancelObserved => "cancel_observed",
            Self::ReplaceStarted => "replace_started",
            Self::ReplaceObserved => "replace_observed",
            Self::SessionLocked => "session_locked",
            Self::SafetySettingChanged => "safety_setting_changed",
            Self::StateChanged => "state_changed",
            Self::AutomationRun => "automation_run",
            Self::PortfolioImport => "portfolio_import",
        }
    }

    pub fn local_kind(&self) -> &'static str {
        match self {
            Self::DraftCreated => "order_intent",
            Self::PreviewRequested | Self::PreviewReceived => "preview_created",
            Self::ConfirmationOpened | Self::ConfirmationAccepted => "user_confirmation",
            Self::DispatchStarted
            | Self::BrokerAccepted
            | Self::BrokerRejected
            | Self::OrderUnknown => "mock_response",
            Self::ReconciliationObserved => "reconciliation",
            Self::SafetySettingChanged => "safety_setting_changed",
            Self::AutomationRun => "automation_run",
            Self::PortfolioImport => "portfolio_import",
            Self::CancelStarted
            | Self::CancelObserved
            | Self::ReplaceStarted
            | Self::ReplaceObserved
            | Self::SessionLocked
            | Self::StateChanged => "state_changed",
        }
    }

    pub fn from_canonical(name: &str) -> Result<Self, EvidenceError> {
        match name {
            "draft_created" => Ok(Self::DraftCreated),
            "preview_requested" => Ok(Self::PreviewRequested),
            "preview_received" => Ok(Self::PreviewReceived),
            "confirmation_opened" => Ok(Self::ConfirmationOpened),
            "confirmation_accepted" => Ok(Self::ConfirmationAccepted),
            "dispatch_started" => Ok(Self::DispatchStarted),
            "broker_accepted" => Ok(Self::BrokerAccepted),
            "broker_rejected" => Ok(Self::BrokerRejected),
            "order_unknown" => Ok(Self::OrderUnknown),
            "reconciliation_observed" => Ok(Self::ReconciliationObserved),
            "cancel_started" => Ok(Self::CancelStarted),
            "cancel_observed" => Ok(Self::CancelObserved),
            "replace_started" => Ok(Self::ReplaceStarted),
            "replace_observed" => Ok(Self::ReplaceObserved),
            "session_locked" => Ok(Self::SessionLocked),
            "safety_setting_changed" => Ok(Self::SafetySettingChanged),
            "state_changed" => Ok(Self::StateChanged),
            "automation_run" => Ok(Self::AutomationRun),
            "portfolio_import" => Ok(Self::PortfolioImport),
            other => Err(EvidenceError::UnsupportedKind(other.to_string())),
        }
    }

    pub fn from_frontend_or_canonical(
        name: &str,
        fields: &BTreeMap<String, String>,
    ) -> Result<Self, EvidenceError> {
        match name {
            "order_intent" => Ok(Self::DraftCreated),
            "preview_created" => Ok(Self::PreviewReceived),
            "user_confirmation" => Ok(Self::ConfirmationAccepted),
            "mock_response" => match fields.get("status").map(String::as_str) {
                Some("unknown") => Ok(Self::OrderUnknown),
                Some("rejected" | "failed") => Ok(Self::BrokerRejected),
                _ => Ok(Self::BrokerAccepted),
            },
            "reconciliation" => Ok(Self::ReconciliationObserved),
            "automation_run" => Ok(Self::AutomationRun),
            "safety_setting_changed" => Ok(Self::SafetySettingChanged),
            "state_changed" => Ok(Self::StateChanged),
            "portfolio_import" => Ok(Self::PortfolioImport),
            other => Self::from_canonical(other),
        }
    }
}

/// Full local evidence payload. This is stored only in the encrypted local
/// journal. The remote notary never receives this value or any of its fields.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct EvidencePayload {
    /// A local pseudonymous account reference, never a raw brokerage account.
    pub account_ref: String,
    pub intent_id: String,
    /// Versioned, string-only fields avoid locale and floating-point ambiguity.
    pub fields: BTreeMap<String, String>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct EvidenceEvent {
    pub schema_version: u16,
    pub event_id: String,
    pub sequence: u64,
    pub occurred_at_utc: String,
    pub app_version: String,
    pub kind: EvidenceKind,
    pub payload: EvidencePayload,
}

impl EvidenceEvent {
    pub fn new(
        event_id: impl Into<String>,
        sequence: u64,
        occurred_at: impl AsRef<str>,
        app_version: impl Into<String>,
        kind: EvidenceKind,
        payload: EvidencePayload,
    ) -> Result<Self, EvidenceError> {
        let event = Self {
            schema_version: EVIDENCE_SCHEMA_VERSION,
            event_id: event_id.into(),
            sequence,
            occurred_at_utc: normalize_timestamp(occurred_at.as_ref())?,
            app_version: app_version.into(),
            kind,
            payload,
        };
        event.validate()?;
        Ok(event)
    }

    fn validate(&self) -> Result<(), EvidenceError> {
        if self.schema_version != EVIDENCE_SCHEMA_VERSION {
            return Err(EvidenceError::UnsupportedSchema(self.schema_version));
        }
        if self.sequence == 0 {
            return Err(EvidenceError::InvalidSequence);
        }
        require_non_empty("event_id", &self.event_id)?;
        require_non_empty("app_version", &self.app_version)?;
        require_non_empty("account_ref", &self.payload.account_ref)?;
        require_non_empty("intent_id", &self.payload.intent_id)?;
        reject_sensitive_value("account_ref", &self.payload.account_ref)?;
        reject_sensitive_value("intent_id", &self.payload.intent_id)?;

        if normalize_timestamp(&self.occurred_at_utc)? != self.occurred_at_utc {
            return Err(EvidenceError::TimestampNotCanonical);
        }

        for (key, value) in &self.payload.fields {
            require_non_empty("payload field name", key)?;
            if key.len() > 128 {
                return Err(EvidenceError::FieldTooLong("payload field name"));
            }
            if value.len() > 16_384 {
                return Err(EvidenceError::FieldTooLong("payload field value"));
            }
            reject_sensitive_field(key, value)?;
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct SignedEvidenceEntry {
    pub event: EvidenceEvent,
    pub previous_hash: Hash32,
    pub payload_hash: Hash32,
    pub entry_hash: Hash32,
    pub signer_public_key: PublicKey32,
    #[serde(with = "signature_hex")]
    pub signature: Signature64,
}

impl SignedEvidenceEntry {
    pub fn sign(
        event: EvidenceEvent,
        previous_hash: Hash32,
        signing_key: &SigningKey,
    ) -> Result<Self, EvidenceError> {
        event.validate()?;
        if event.sequence == 1 && previous_hash != GENESIS_HASH {
            return Err(EvidenceError::InvalidGenesis);
        }

        let payload_hash = hash_payload(&event.payload);
        let entry_hash = hash_entry(&event, &previous_hash, &payload_hash);
        let signature = signing_key.sign(&entry_hash).to_bytes();

        Ok(Self {
            event,
            previous_hash,
            payload_hash,
            entry_hash,
            signer_public_key: signing_key.verifying_key().to_bytes(),
            signature,
        })
    }

    pub fn verify(&self) -> Result<(), EvidenceError> {
        self.event.validate()?;
        if self.event.sequence == 1 && self.previous_hash != GENESIS_HASH {
            return Err(EvidenceError::InvalidGenesis);
        }

        let expected_payload_hash = hash_payload(&self.event.payload);
        if expected_payload_hash != self.payload_hash {
            return Err(EvidenceError::PayloadHashMismatch);
        }

        let expected_entry_hash = hash_entry(&self.event, &self.previous_hash, &self.payload_hash);
        if expected_entry_hash != self.entry_hash {
            return Err(EvidenceError::EntryHashMismatch);
        }

        verify_signature(&self.signer_public_key, &self.entry_hash, &self.signature)
    }
}

pub fn verify_chain(entries: &[SignedEvidenceEntry]) -> Result<ChainHead, EvidenceError> {
    if entries.is_empty() {
        return Ok(ChainHead {
            sequence: 0,
            hash: GENESIS_HASH,
            signer_public_key: None,
        });
    }

    let expected_public_key = entries[0].signer_public_key;
    let mut expected_previous = GENESIS_HASH;

    for (index, entry) in entries.iter().enumerate() {
        entry.verify()?;
        let expected_sequence = u64::try_from(index)
            .map_err(|_| EvidenceError::SequenceOverflow)?
            .checked_add(1)
            .ok_or(EvidenceError::SequenceOverflow)?;

        if entry.event.sequence != expected_sequence {
            return Err(EvidenceError::ChainSequenceMismatch {
                expected: expected_sequence,
                actual: entry.event.sequence,
            });
        }
        if entry.previous_hash != expected_previous {
            return Err(EvidenceError::PreviousHashMismatch);
        }
        if entry.signer_public_key != expected_public_key {
            return Err(EvidenceError::SignerChanged);
        }

        expected_previous = entry.entry_hash;
    }

    Ok(ChainHead {
        sequence: entries
            .last()
            .expect("non-empty chain checked above")
            .event
            .sequence,
        hash: expected_previous,
        signer_public_key: Some(expected_public_key),
    })
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct ChainHead {
    pub sequence: u64,
    pub hash: Hash32,
    pub signer_public_key: Option<PublicKey32>,
}

/// Privacy-minimized data sent to an optional FolioHelm or self-hosted notary.
/// There is intentionally no account, symbol, amount, order ID, or payload.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct NotaryCommitment {
    pub schema_version: u16,
    pub sequence: u64,
    pub chain_head_hash: Hash32,
    pub signer_public_key: PublicKey32,
    pub created_at_utc: String,
    pub app_version: String,
    pub commitment_hash: Hash32,
    #[serde(with = "signature_hex")]
    pub device_signature: Signature64,
}

impl NotaryCommitment {
    pub fn from_entry(
        entry: &SignedEvidenceEntry,
        created_at: impl AsRef<str>,
        app_version: impl Into<String>,
        signing_key: &SigningKey,
    ) -> Result<Self, EvidenceError> {
        entry.verify()?;
        if signing_key.verifying_key().to_bytes() != entry.signer_public_key {
            return Err(EvidenceError::SignerChanged);
        }

        let created_at_utc = normalize_timestamp(created_at.as_ref())?;
        let app_version = app_version.into();
        require_non_empty("app_version", &app_version)?;

        let commitment_hash = hash_checkpoint(
            entry.event.sequence,
            &entry.entry_hash,
            &entry.signer_public_key,
            &created_at_utc,
            &app_version,
        );
        let device_signature = signing_key.sign(&commitment_hash).to_bytes();

        Ok(Self {
            schema_version: EVIDENCE_SCHEMA_VERSION,
            sequence: entry.event.sequence,
            chain_head_hash: entry.entry_hash,
            signer_public_key: entry.signer_public_key,
            created_at_utc,
            app_version,
            commitment_hash,
            device_signature,
        })
    }

    pub fn verify(&self) -> Result<(), EvidenceError> {
        if self.schema_version != EVIDENCE_SCHEMA_VERSION {
            return Err(EvidenceError::UnsupportedSchema(self.schema_version));
        }
        if self.sequence == 0 {
            return Err(EvidenceError::InvalidSequence);
        }
        if normalize_timestamp(&self.created_at_utc)? != self.created_at_utc {
            return Err(EvidenceError::TimestampNotCanonical);
        }
        require_non_empty("app_version", &self.app_version)?;

        let expected_hash = hash_checkpoint(
            self.sequence,
            &self.chain_head_hash,
            &self.signer_public_key,
            &self.created_at_utc,
            &self.app_version,
        );
        if expected_hash != self.commitment_hash {
            return Err(EvidenceError::CommitmentHashMismatch);
        }

        verify_signature(
            &self.signer_public_key,
            &self.commitment_hash,
            &self.device_signature,
        )
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct NotaryReceipt {
    pub schema_version: u16,
    pub receipt_id: String,
    pub commitment_hash: Hash32,
    pub notarized_at_utc: String,
    pub notary_public_key: PublicKey32,
    pub receipt_hash: Hash32,
    #[serde(with = "signature_hex")]
    pub notary_signature: Signature64,
}

/// Transport boundary for an optional official or self-hosted notary.
///
/// Accepting only [`NotaryCommitment`] at this boundary makes it impossible
/// for an implementation to receive the local [`EvidencePayload`] by
/// accident. No implementation is registered in the application yet, so the
/// current build performs no notary network requests.
pub trait NotarySink: Send + Sync {
    type Error: StdError + Send + Sync + 'static;

    fn submit<'a>(
        &'a self,
        commitment: &'a NotaryCommitment,
    ) -> Pin<Box<dyn Future<Output = Result<NotaryReceipt, Self::Error>> + Send + 'a>>;
}

impl NotaryReceipt {
    /// Server-side primitive. The future notary service calls this only after it
    /// verifies the client commitment and applies abuse controls.
    pub fn issue(
        receipt_id: impl Into<String>,
        commitment: &NotaryCommitment,
        notarized_at: impl AsRef<str>,
        notary_signing_key: &SigningKey,
    ) -> Result<Self, EvidenceError> {
        commitment.verify()?;
        let receipt_id = receipt_id.into();
        require_non_empty("receipt_id", &receipt_id)?;
        let notarized_at_utc = normalize_timestamp(notarized_at.as_ref())?;
        let notary_public_key = notary_signing_key.verifying_key().to_bytes();
        let receipt_hash = hash_receipt(
            &receipt_id,
            &commitment.commitment_hash,
            &notarized_at_utc,
            &notary_public_key,
        );
        let notary_signature = notary_signing_key.sign(&receipt_hash).to_bytes();

        Ok(Self {
            schema_version: EVIDENCE_SCHEMA_VERSION,
            receipt_id,
            commitment_hash: commitment.commitment_hash,
            notarized_at_utc,
            notary_public_key,
            receipt_hash,
            notary_signature,
        })
    }

    pub fn verify(
        &self,
        commitment: &NotaryCommitment,
        trusted_notary_public_key: &PublicKey32,
    ) -> Result<(), EvidenceError> {
        commitment.verify()?;
        if self.schema_version != EVIDENCE_SCHEMA_VERSION {
            return Err(EvidenceError::UnsupportedSchema(self.schema_version));
        }
        require_non_empty("receipt_id", &self.receipt_id)?;
        if self.commitment_hash != commitment.commitment_hash {
            return Err(EvidenceError::ReceiptCommitmentMismatch);
        }
        if self.notary_public_key != *trusted_notary_public_key {
            return Err(EvidenceError::UntrustedNotary);
        }
        if normalize_timestamp(&self.notarized_at_utc)? != self.notarized_at_utc {
            return Err(EvidenceError::TimestampNotCanonical);
        }

        let expected_hash = hash_receipt(
            &self.receipt_id,
            &self.commitment_hash,
            &self.notarized_at_utc,
            &self.notary_public_key,
        );
        if expected_hash != self.receipt_hash {
            return Err(EvidenceError::ReceiptHashMismatch);
        }

        verify_signature(
            &self.notary_public_key,
            &self.receipt_hash,
            &self.notary_signature,
        )
    }
}

#[derive(Debug, Error, Eq, PartialEq)]
pub enum EvidenceError {
    #[error("unsupported evidence schema version {0}")]
    UnsupportedSchema(u16),
    #[error("sequence must start at one")]
    InvalidSequence,
    #[error("sequence exceeds supported range")]
    SequenceOverflow,
    #[error("first entry must reference the genesis hash")]
    InvalidGenesis,
    #[error("{0} must not be empty")]
    EmptyField(&'static str),
    #[error("{0} exceeds the evidence size limit")]
    FieldTooLong(&'static str),
    #[error("timestamp is not valid RFC 3339")]
    InvalidTimestamp,
    #[error("timestamp is not in canonical UTC form")]
    TimestampNotCanonical,
    #[error("payload hash does not match the event")]
    PayloadHashMismatch,
    #[error("entry hash does not match the event")]
    EntryHashMismatch,
    #[error("signature or public key is invalid")]
    InvalidSignature,
    #[error("chain sequence mismatch: expected {expected}, got {actual}")]
    ChainSequenceMismatch { expected: u64, actual: u64 },
    #[error("previous hash does not match the preceding entry")]
    PreviousHashMismatch,
    #[error("device signer changed inside one evidence chain")]
    SignerChanged,
    #[error("checkpoint commitment hash mismatch")]
    CommitmentHashMismatch,
    #[error("notary receipt is for another commitment")]
    ReceiptCommitmentMismatch,
    #[error("notary receipt was not signed by the configured notary")]
    UntrustedNotary,
    #[error("notary receipt hash mismatch")]
    ReceiptHashMismatch,
    #[error("sensitive evidence field rejected: {0}")]
    SensitiveField(String),
    #[error("unsupported evidence kind: {0}")]
    UnsupportedKind(String),
    #[error("unsupported evidence bundle: {0}")]
    InvalidBundle(String),
    #[error("operating system randomness is unavailable")]
    RandomnessUnavailable,
}

fn hash_payload(payload: &EvidencePayload) -> Hash32 {
    let mut bytes = Vec::with_capacity(256);
    push_bytes(&mut bytes, PAYLOAD_DOMAIN);
    push_str(&mut bytes, &payload.account_ref);
    push_str(&mut bytes, &payload.intent_id);
    push_u64(&mut bytes, payload.fields.len() as u64);
    for (key, value) in &payload.fields {
        push_str(&mut bytes, key);
        push_str(&mut bytes, value);
    }
    sha256(&bytes)
}

fn hash_entry(event: &EvidenceEvent, previous_hash: &Hash32, payload_hash: &Hash32) -> Hash32 {
    let mut bytes = Vec::with_capacity(384);
    push_bytes(&mut bytes, ENTRY_DOMAIN);
    push_u16(&mut bytes, event.schema_version);
    push_u64(&mut bytes, event.sequence);
    push_str(&mut bytes, &event.event_id);
    push_str(&mut bytes, &event.occurred_at_utc);
    push_str(&mut bytes, &event.app_version);
    push_str(&mut bytes, event.kind.canonical_name());
    push_bytes(&mut bytes, previous_hash);
    push_bytes(&mut bytes, payload_hash);
    sha256(&bytes)
}

fn hash_checkpoint(
    sequence: u64,
    chain_head_hash: &Hash32,
    signer_public_key: &PublicKey32,
    created_at_utc: &str,
    app_version: &str,
) -> Hash32 {
    let mut bytes = Vec::with_capacity(192);
    push_bytes(&mut bytes, CHECKPOINT_DOMAIN);
    push_u16(&mut bytes, EVIDENCE_SCHEMA_VERSION);
    push_u64(&mut bytes, sequence);
    push_bytes(&mut bytes, chain_head_hash);
    push_bytes(&mut bytes, signer_public_key);
    push_str(&mut bytes, created_at_utc);
    push_str(&mut bytes, app_version);
    sha256(&bytes)
}

fn hash_receipt(
    receipt_id: &str,
    commitment_hash: &Hash32,
    notarized_at_utc: &str,
    notary_public_key: &PublicKey32,
) -> Hash32 {
    let mut bytes = Vec::with_capacity(192);
    push_bytes(&mut bytes, RECEIPT_DOMAIN);
    push_u16(&mut bytes, EVIDENCE_SCHEMA_VERSION);
    push_str(&mut bytes, receipt_id);
    push_bytes(&mut bytes, commitment_hash);
    push_str(&mut bytes, notarized_at_utc);
    push_bytes(&mut bytes, notary_public_key);
    sha256(&bytes)
}

fn sha256(bytes: &[u8]) -> Hash32 {
    Sha256::digest(bytes).into()
}

fn verify_signature(
    public_key: &PublicKey32,
    message: &[u8],
    signature: &Signature64,
) -> Result<(), EvidenceError> {
    let verifying_key =
        VerifyingKey::from_bytes(public_key).map_err(|_| EvidenceError::InvalidSignature)?;
    let signature = Signature::from_bytes(signature);
    verifying_key
        .verify_strict(message, &signature)
        .map_err(|_| EvidenceError::InvalidSignature)
}

fn normalize_timestamp(value: &str) -> Result<String, EvidenceError> {
    let parsed: DateTime<Utc> = DateTime::parse_from_rfc3339(value)
        .map_err(|_| EvidenceError::InvalidTimestamp)?
        .with_timezone(&Utc);
    Ok(parsed.to_rfc3339_opts(SecondsFormat::Millis, true))
}

fn require_non_empty(name: &'static str, value: &str) -> Result<(), EvidenceError> {
    if value.trim().is_empty() {
        Err(EvidenceError::EmptyField(name))
    } else {
        Ok(())
    }
}

const SENSITIVE_KEY_TOKENS: &[&str] = &[
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
];

const SENSITIVE_KEY_COMPACT_SUBSTRINGS: &[&str] = &[
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
];

const SENSITIVE_VALUE_ASSIGNMENT_KEYS: &[&str] = &[
    "api_key",
    "api-key",
    "apikey",
    "app_key",
    "app-key",
    "appkey",
    "client_secret",
    "client-secret",
    "clientsecret",
    "access_token",
    "access-token",
    "accesstoken",
    "refresh_token",
    "refresh-token",
    "refreshtoken",
    "private_key",
    "private-key",
    "privatekey",
    "account_number",
    "account-number",
    "accountnumber",
    "account_hash",
    "account-hash",
    "accounthash",
    "authorization",
    "credential",
    "passphrase",
    "password",
    "passwd",
    "secret",
    "cookie",
    "token",
];

fn is_sensitive_key(key: &str) -> bool {
    let lower = key.to_ascii_lowercase();
    if lower
        .split(|ch: char| !ch.is_ascii_alphanumeric())
        .any(|token| SENSITIVE_KEY_TOKENS.contains(&token))
    {
        return true;
    }

    let compact: String = lower.chars().filter(char::is_ascii_alphanumeric).collect();
    SENSITIVE_KEY_COMPACT_SUBSTRINGS
        .iter()
        .any(|pattern| compact.contains(pattern))
}

fn is_word_boundary(bytes: &[u8], index: usize) -> bool {
    index == 0 || !bytes[index - 1].is_ascii_alphanumeric()
}

fn contains_auth_scheme_credential(
    lower: &str,
    scheme: &str,
    min_len: usize,
    base64_only: bool,
) -> bool {
    let bytes = lower.as_bytes();
    let scheme_bytes = scheme.as_bytes();
    let mut offset = 0;

    while let Some(rel) = lower[offset..].find(scheme) {
        let pos = offset + rel;
        let after_scheme = pos + scheme_bytes.len();
        if is_word_boundary(bytes, pos)
            && after_scheme < bytes.len()
            && bytes[after_scheme].is_ascii_whitespace()
        {
            let mut cursor = after_scheme;
            while cursor < bytes.len() && bytes[cursor].is_ascii_whitespace() {
                cursor += 1;
            }
            let token_start = cursor;
            while cursor < bytes.len() {
                let b = bytes[cursor];
                let valid = if base64_only {
                    b.is_ascii_alphanumeric() || matches!(b, b'+' | b'/' | b'=')
                } else {
                    b.is_ascii_alphanumeric()
                        || matches!(b, b'.' | b'_' | b'~' | b'+' | b'/' | b'=' | b'-')
                };
                if !valid {
                    break;
                }
                cursor += 1;
            }
            if cursor.saturating_sub(token_start) >= min_len {
                return true;
            }
        }
        offset = after_scheme;
    }
    false
}

fn is_jwt_token(token: &str) -> bool {
    if !token.starts_with("eyJ") {
        return false;
    }
    let mut parts = token.split('.');
    let (Some(header), Some(payload), Some(sig), None) =
        (parts.next(), parts.next(), parts.next(), parts.next())
    else {
        return false;
    };
    [header, payload, sig].iter().all(|part| {
        part.len() >= 6
            && part
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_'))
    })
}

fn has_known_secret_prefix(token: &str) -> bool {
    (token.starts_with("sk-") && token.len() >= 20)
        || (token.starts_with("ghp_") && token.len() >= 24)
        || (token.starts_with("AIza") && token.len() >= 24)
}

fn contains_credential_assignment(lower: &str) -> bool {
    let bytes = lower.as_bytes();
    for key in SENSITIVE_VALUE_ASSIGNMENT_KEYS {
        let mut offset = 0;
        while let Some(rel) = lower[offset..].find(key) {
            let pos = offset + rel;
            let after_key = pos + key.len();
            if is_word_boundary(bytes, pos) {
                let mut cursor = after_key;
                while cursor < bytes.len() && bytes[cursor].is_ascii_whitespace() {
                    cursor += 1;
                }
                if cursor < bytes.len() && matches!(bytes[cursor], b'=' | b':') {
                    cursor += 1;
                    while cursor < bytes.len() && bytes[cursor].is_ascii_whitespace() {
                        cursor += 1;
                    }
                    if cursor < bytes.len() && !bytes[cursor].is_ascii_whitespace() {
                        return true;
                    }
                }
            }
            offset = after_key;
        }
    }
    false
}

fn contains_sensitive_value(value: &str) -> bool {
    let lower = value.to_ascii_lowercase();
    if lower.contains("-----begin ") && lower.contains("private key-----") {
        return true;
    }
    if contains_auth_scheme_credential(&lower, "bearer", 6, false)
        || contains_auth_scheme_credential(&lower, "basic", 12, true)
    {
        return true;
    }
    if contains_credential_assignment(&lower) {
        return true;
    }
    value
        .split(|ch: char| ch.is_whitespace() || matches!(ch, '"' | '\'' | ',' | ';' | '(' | ')'))
        .any(|token| is_jwt_token(token) || has_known_secret_prefix(token))
}

fn reject_sensitive_value(label: &str, value: &str) -> Result<(), EvidenceError> {
    if contains_sensitive_value(value) {
        return Err(EvidenceError::SensitiveField(label.to_string()));
    }
    Ok(())
}

fn reject_sensitive_field(key: &str, value: &str) -> Result<(), EvidenceError> {
    if is_sensitive_key(key) || contains_sensitive_value(value) {
        return Err(EvidenceError::SensitiveField(key.to_string()));
    }
    Ok(())
}

pub const SIGNED_EVIDENCE_BUNDLE_FORMAT: &str = "foliohelm-signed-evidence";

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppendEvidenceRequest {
    pub kind: String,
    pub payload: BTreeMap<String, String>,
    pub app_version: Option<String>,
    pub occurred_at_utc: Option<String>,
    pub account_ref: Option<String>,
    pub intent_id: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SignedEvidenceRecordDto {
    pub schema_version: u16,
    pub event_id: String,
    pub sequence: u64,
    pub occurred_at_utc: String,
    pub app_version: String,
    pub kind: String,
    pub rust_kind: String,
    pub account_ref: String,
    pub intent_id: String,
    pub payload: BTreeMap<String, String>,
    pub previous_hash: String,
    pub payload_hash: String,
    pub entry_hash: String,
    pub signer_public_key: String,
    pub signature: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EvidenceVerificationDto {
    pub valid: bool,
    pub sequence: u64,
    pub head_hash: String,
    pub signer_public_key: Option<String>,
    pub reason: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EvidenceExportBundleDto {
    pub format: String,
    pub schema_version: u16,
    pub mode: String,
    pub exported_at_utc: String,
    pub signer_public_key: Option<String>,
    pub records: Vec<SignedEvidenceRecordDto>,
}

impl SignedEvidenceRecordDto {
    pub fn from_entry(entry: &SignedEvidenceEntry) -> Self {
        Self {
            schema_version: entry.event.schema_version,
            event_id: entry.event.event_id.clone(),
            sequence: entry.event.sequence,
            occurred_at_utc: entry.event.occurred_at_utc.clone(),
            app_version: entry.event.app_version.clone(),
            kind: entry.event.kind.local_kind().to_string(),
            rust_kind: entry.event.kind.canonical_name().to_string(),
            account_ref: entry.event.payload.account_ref.clone(),
            intent_id: entry.event.payload.intent_id.clone(),
            payload: entry.event.payload.fields.clone(),
            previous_hash: encode_hex(&entry.previous_hash),
            payload_hash: encode_hex(&entry.payload_hash),
            entry_hash: encode_hex(&entry.entry_hash),
            signer_public_key: encode_hex(&entry.signer_public_key),
            signature: encode_hex(&entry.signature),
        }
    }

    pub fn into_entry(self) -> Result<SignedEvidenceEntry, EvidenceError> {
        let kind = EvidenceKind::from_canonical(&self.rust_kind)?;
        let event = EvidenceEvent {
            schema_version: self.schema_version,
            event_id: self.event_id,
            sequence: self.sequence,
            occurred_at_utc: self.occurred_at_utc,
            app_version: self.app_version,
            kind,
            payload: EvidencePayload {
                account_ref: self.account_ref,
                intent_id: self.intent_id,
                fields: self.payload,
            },
        };
        let entry = SignedEvidenceEntry {
            event,
            previous_hash: decode_hex_fixed::<32>(&self.previous_hash)
                .map_err(|msg| EvidenceError::InvalidBundle(msg.to_string()))?,
            payload_hash: decode_hex_fixed::<32>(&self.payload_hash)
                .map_err(|msg| EvidenceError::InvalidBundle(msg.to_string()))?,
            entry_hash: decode_hex_fixed::<32>(&self.entry_hash)
                .map_err(|msg| EvidenceError::InvalidBundle(msg.to_string()))?,
            signer_public_key: decode_hex_fixed::<32>(&self.signer_public_key)
                .map_err(|msg| EvidenceError::InvalidBundle(msg.to_string()))?,
            signature: decode_hex_fixed::<64>(&self.signature)
                .map_err(|msg| EvidenceError::InvalidBundle(msg.to_string()))?,
        };
        entry.verify()?;
        Ok(entry)
    }
}

/// Ed25519-signed evidence journal backed by the encrypted SQLite vault at runtime.
pub struct EvidenceJournal {
    signing_key: SigningKey,
    entries: Vec<SignedEvidenceEntry>,
}

impl EvidenceJournal {
    pub fn new_random() -> Result<Self, EvidenceError> {
        let mut seed = [0_u8; 32];
        getrandom::fill(&mut seed).map_err(|_| EvidenceError::RandomnessUnavailable)?;
        Ok(Self::from_signing_key(SigningKey::from_bytes(&seed)))
    }

    pub fn from_signing_key(signing_key: SigningKey) -> Self {
        Self {
            signing_key,
            entries: Vec::new(),
        }
    }

    /// Rehydrate a persisted journal after verifying both chain integrity and
    /// device signer continuity.
    pub fn from_persisted(
        signing_key: SigningKey,
        entries: Vec<SignedEvidenceEntry>,
    ) -> Result<Self, EvidenceError> {
        let head = verify_chain(&entries)?;
        if let Some(persisted_signer) = head.signer_public_key {
            if persisted_signer != signing_key.verifying_key().to_bytes() {
                return Err(EvidenceError::SignerChanged);
            }
        }
        Ok(Self {
            signing_key,
            entries,
        })
    }

    pub fn entries(&self) -> &[SignedEvidenceEntry] {
        &self.entries
    }

    pub fn signer_public_key_hex(&self) -> String {
        encode_hex(&self.signing_key.verifying_key().to_bytes())
    }

    /// Build and sign the next entry without mutating in-memory state yet so a
    /// caller can persist it atomically before committing.
    pub fn prepare_append(
        &self,
        request: AppendEvidenceRequest,
    ) -> Result<(SignedEvidenceEntry, SignedEvidenceRecordDto), EvidenceError> {
        let head = verify_chain(&self.entries)?;
        let sequence = head
            .sequence
            .checked_add(1)
            .ok_or(EvidenceError::SequenceOverflow)?;
        let kind = EvidenceKind::from_frontend_or_canonical(&request.kind, &request.payload)?;
        let occurred_at = request
            .occurred_at_utc
            .unwrap_or_else(|| Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true));
        let app_version = request
            .app_version
            .unwrap_or_else(|| env!("CARGO_PKG_VERSION").to_string());
        let account_ref = request
            .account_ref
            .unwrap_or_else(|| "acct_local_mock".to_string());
        let intent_id = request
            .intent_id
            .unwrap_or_else(|| format!("intent-{sequence:06}"));
        let event_id = format!("FH-EVENT-{sequence:06}");

        let event = EvidenceEvent::new(
            event_id,
            sequence,
            occurred_at,
            app_version,
            kind,
            EvidencePayload {
                account_ref,
                intent_id,
                fields: request.payload,
            },
        )?;
        let signed = SignedEvidenceEntry::sign(event, head.hash, &self.signing_key)?;
        let dto = SignedEvidenceRecordDto::from_entry(&signed);
        Ok((signed, dto))
    }

    pub fn commit_prepared(&mut self, signed: SignedEvidenceEntry) {
        self.entries.push(signed);
    }

    pub fn append_entry(
        &mut self,
        request: AppendEvidenceRequest,
    ) -> Result<(SignedEvidenceEntry, SignedEvidenceRecordDto), EvidenceError> {
        let (signed, dto) = self.prepare_append(request)?;
        self.entries.push(signed.clone());
        Ok((signed, dto))
    }

    pub fn append(
        &mut self,
        request: AppendEvidenceRequest,
    ) -> Result<SignedEvidenceRecordDto, EvidenceError> {
        let (_, dto) = self.append_entry(request)?;
        Ok(dto)
    }

    /// Validate an imported bundle without mutating the active journal yet.
    pub fn parse_import_bundle(
        &self,
        serialized: &str,
    ) -> Result<(Vec<SignedEvidenceEntry>, EvidenceVerificationDto), EvidenceError> {
        let bundle: EvidenceExportBundleDto = serde_json::from_str(serialized)
            .map_err(|error| EvidenceError::InvalidBundle(error.to_string()))?;
        if bundle.format != SIGNED_EVIDENCE_BUNDLE_FORMAT
            || bundle.schema_version != EVIDENCE_SCHEMA_VERSION
            || !matches!(bundle.mode.as_str(), "mock" | "local-csv")
        {
            return Err(EvidenceError::InvalidBundle(
                "unsupported format, schema version, or mode".to_string(),
            ));
        }
        if normalize_timestamp(&bundle.exported_at_utc)? != bundle.exported_at_utc {
            return Err(EvidenceError::TimestampNotCanonical);
        }

        let mut entries = Vec::with_capacity(bundle.records.len());
        for record in bundle.records {
            entries.push(record.into_entry()?);
        }
        let head = verify_chain(&entries)?;
        if let Some(imported_signer) = head.signer_public_key {
            let current_signer = self.signing_key.verifying_key().to_bytes();
            if imported_signer != current_signer {
                return Err(EvidenceError::SignerChanged);
            }
        }
        let verification = EvidenceVerificationDto {
            valid: true,
            sequence: head.sequence,
            head_hash: encode_hex(&head.hash),
            signer_public_key: head.signer_public_key.map(|pk| encode_hex(&pk)),
            reason: None,
        };
        Ok((entries, verification))
    }

    pub fn replace_entries(&mut self, entries: Vec<SignedEvidenceEntry>) {
        self.entries = entries;
    }

    pub fn list(&self) -> Vec<SignedEvidenceRecordDto> {
        self.entries
            .iter()
            .map(SignedEvidenceRecordDto::from_entry)
            .collect()
    }

    pub fn verify(&self) -> EvidenceVerificationDto {
        match verify_chain(&self.entries) {
            Ok(head) => EvidenceVerificationDto {
                valid: true,
                sequence: head.sequence,
                head_hash: encode_hex(&head.hash),
                signer_public_key: head.signer_public_key.map(|pk| encode_hex(&pk)),
                reason: None,
            },
            Err(error) => EvidenceVerificationDto {
                valid: false,
                sequence: self.entries.len() as u64,
                head_hash: self
                    .entries
                    .last()
                    .map_or_else(|| encode_hex(&GENESIS_HASH), |e| encode_hex(&e.entry_hash)),
                signer_public_key: Some(self.signer_public_key_hex()),
                reason: Some(error.to_string()),
            },
        }
    }

    pub fn export(&self) -> Result<String, EvidenceError> {
        let head = verify_chain(&self.entries)?;
        let bundle = EvidenceExportBundleDto {
            format: SIGNED_EVIDENCE_BUNDLE_FORMAT.to_string(),
            schema_version: EVIDENCE_SCHEMA_VERSION,
            mode: "mock".to_string(),
            exported_at_utc: Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true),
            signer_public_key: head.signer_public_key.map(|pk| encode_hex(&pk)),
            records: self.list(),
        };
        serde_json::to_string_pretty(&bundle)
            .map_err(|error| EvidenceError::InvalidBundle(error.to_string()))
    }

    pub fn import(&mut self, serialized: &str) -> Result<EvidenceVerificationDto, EvidenceError> {
        let (entries, verification) = self.parse_import_bundle(serialized)?;
        self.entries = entries;
        Ok(verification)
    }

    pub fn clear(&mut self) -> bool {
        self.entries.clear();
        true
    }
}

pub fn encode_hex(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut encoded = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        encoded.push(HEX[usize::from(byte >> 4)] as char);
        encoded.push(HEX[usize::from(byte & 0x0f)] as char);
    }
    encoded
}

fn decode_hex_fixed<const N: usize>(encoded: &str) -> Result<[u8; N], &'static str> {
    if encoded.len() != N * 2 {
        return Err("hex string has unexpected length");
    }
    let mut output = [0_u8; N];
    for (index, pair) in encoded.as_bytes().chunks_exact(2).enumerate() {
        let high = decode_hex_nibble(pair[0]).ok_or("hex string contains non-hex character")?;
        let low = decode_hex_nibble(pair[1]).ok_or("hex string contains non-hex character")?;
        output[index] = (high << 4) | low;
    }
    Ok(output)
}

fn decode_hex_nibble(value: u8) -> Option<u8> {
    match value {
        b'0'..=b'9' => Some(value - b'0'),
        b'a'..=b'f' => Some(value - b'a' + 10),
        b'A'..=b'F' => Some(value - b'A' + 10),
        _ => None,
    }
}

fn push_u16(target: &mut Vec<u8>, value: u16) {
    target.extend_from_slice(&value.to_be_bytes());
}

fn push_u64(target: &mut Vec<u8>, value: u64) {
    target.extend_from_slice(&value.to_be_bytes());
}

fn push_str(target: &mut Vec<u8>, value: &str) {
    push_bytes(target, value.as_bytes());
}

fn push_bytes(target: &mut Vec<u8>, value: &[u8]) {
    push_u64(target, value.len() as u64);
    target.extend_from_slice(value);
}

mod signature_hex {
    use serde::{de::Error as _, Deserialize, Deserializer, Serializer};

    use super::Signature64;

    pub fn serialize<S>(signature: &Signature64, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        let mut encoded = String::with_capacity(signature.len() * 2);
        for byte in signature {
            const HEX: &[u8; 16] = b"0123456789abcdef";
            encoded.push(HEX[usize::from(byte >> 4)] as char);
            encoded.push(HEX[usize::from(byte & 0x0f)] as char);
        }
        serializer.serialize_str(&encoded)
    }

    pub fn deserialize<'de, D>(deserializer: D) -> Result<Signature64, D::Error>
    where
        D: Deserializer<'de>,
    {
        let encoded = String::deserialize(deserializer)?;
        if encoded.len() != 128 {
            return Err(D::Error::custom(
                "Ed25519 signature must be exactly 128 hexadecimal characters",
            ));
        }

        let mut signature = [0_u8; 64];
        for (index, pair) in encoded.as_bytes().chunks_exact(2).enumerate() {
            let high = decode_nibble(pair[0]).ok_or_else(|| {
                D::Error::custom("Ed25519 signature contains a non-hexadecimal character")
            })?;
            let low = decode_nibble(pair[1]).ok_or_else(|| {
                D::Error::custom("Ed25519 signature contains a non-hexadecimal character")
            })?;
            signature[index] = (high << 4) | low;
        }
        Ok(signature)
    }

    fn decode_nibble(value: u8) -> Option<u8> {
        match value {
            b'0'..=b'9' => Some(value - b'0'),
            b'a'..=b'f' => Some(value - b'a' + 10),
            b'A'..=b'F' => Some(value - b'A' + 10),
            _ => None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn device_key() -> SigningKey {
        SigningKey::from_bytes(&[7; 32])
    }

    fn notary_key() -> SigningKey {
        SigningKey::from_bytes(&[11; 32])
    }

    fn payload(quantity: &str) -> EvidencePayload {
        EvidencePayload {
            account_ref: "acct_local_01".into(),
            intent_id: "intent_01".into(),
            fields: BTreeMap::from([
                ("limit_price".into(), "182.40".into()),
                ("quantity".into(), quantity.into()),
                ("side".into(), "buy".into()),
                ("symbol".into(), "AAPL".into()),
            ]),
        }
    }

    fn event(sequence: u64, quantity: &str) -> EvidenceEvent {
        EvidenceEvent::new(
            format!("event_{sequence}"),
            sequence,
            format!("2026-08-09T14:00:0{sequence}Z"),
            "0.1.0",
            if sequence == 1 {
                EvidenceKind::PreviewReceived
            } else {
                EvidenceKind::DispatchStarted
            },
            payload(quantity),
        )
        .expect("test event must be valid")
    }

    fn two_entry_chain() -> Vec<SignedEvidenceEntry> {
        let key = device_key();
        let first = SignedEvidenceEntry::sign(event(1, "10"), GENESIS_HASH, &key)
            .expect("first entry signs");
        let second = SignedEvidenceEntry::sign(event(2, "10"), first.entry_hash, &key)
            .expect("second entry signs");
        vec![first, second]
    }

    #[test]
    fn signs_and_verifies_a_chain() {
        let chain = two_entry_chain();
        let head = verify_chain(&chain).expect("chain verifies");
        assert_eq!(head.sequence, 2);
        assert_eq!(head.hash, chain[1].entry_hash);
        assert_eq!(
            head.signer_public_key,
            Some(device_key().verifying_key().to_bytes())
        );
    }

    #[test]
    fn detects_payload_tampering() {
        let mut chain = two_entry_chain();
        chain[0]
            .event
            .payload
            .fields
            .insert("quantity".into(), "1000".into());

        assert_eq!(
            verify_chain(&chain),
            Err(EvidenceError::PayloadHashMismatch)
        );
    }

    #[test]
    fn detects_deleted_or_reordered_entries() {
        let chain = two_entry_chain();
        assert_eq!(
            verify_chain(&chain[1..]),
            Err(EvidenceError::ChainSequenceMismatch {
                expected: 1,
                actual: 2,
            })
        );

        let reordered = vec![chain[1].clone(), chain[0].clone()];
        assert!(verify_chain(&reordered).is_err());
    }

    #[test]
    fn detects_signature_replacement() {
        let mut chain = two_entry_chain();
        chain[1].signature = [0; 64];
        assert_eq!(verify_chain(&chain), Err(EvidenceError::InvalidSignature));
    }

    #[test]
    fn empty_chain_has_a_genesis_head() {
        assert_eq!(
            verify_chain(&[]).expect("empty chain is valid"),
            ChainHead {
                sequence: 0,
                hash: GENESIS_HASH,
                signer_public_key: None,
            }
        );
    }

    #[test]
    fn checkpoint_and_receipt_verify_without_private_trade_data() {
        let chain = two_entry_chain();
        let commitment =
            NotaryCommitment::from_entry(&chain[1], "2026-08-09T14:05:00Z", "0.1.0", &device_key())
                .expect("commitment signs");
        commitment.verify().expect("commitment verifies");

        let receipt = NotaryReceipt::issue(
            "receipt_01",
            &commitment,
            "2026-08-09T14:05:02Z",
            &notary_key(),
        )
        .expect("receipt issues");
        receipt
            .verify(&commitment, &notary_key().verifying_key().to_bytes())
            .expect("receipt verifies");

        let serialized = serde_json::to_string(&commitment).expect("serialize commitment");
        for forbidden in ["AAPL", "182.40", "quantity", "account_ref", "order_id"] {
            assert!(!serialized.contains(forbidden));
        }
    }

    #[test]
    fn receipt_cannot_be_reused_for_another_commitment() {
        let key = device_key();
        let first =
            SignedEvidenceEntry::sign(event(1, "10"), GENESIS_HASH, &key).expect("entry signs");
        let original = NotaryCommitment::from_entry(&first, "2026-08-09T14:05:00Z", "0.1.0", &key)
            .expect("commitment signs");
        let receipt = NotaryReceipt::issue(
            "receipt_01",
            &original,
            "2026-08-09T14:05:02Z",
            &notary_key(),
        )
        .expect("receipt issues");

        let second =
            SignedEvidenceEntry::sign(event(2, "11"), first.entry_hash, &key).expect("entry signs");
        let different =
            NotaryCommitment::from_entry(&second, "2026-08-09T14:06:00Z", "0.1.0", &key)
                .expect("commitment signs");

        assert_eq!(
            receipt.verify(&different, &notary_key().verifying_key().to_bytes()),
            Err(EvidenceError::ReceiptCommitmentMismatch)
        );
    }

    #[test]
    fn receipt_rejects_an_untrusted_notary_key() {
        let entry = two_entry_chain().remove(0);
        let commitment =
            NotaryCommitment::from_entry(&entry, "2026-08-09T14:05:00Z", "0.1.0", &device_key())
                .expect("commitment signs");
        let receipt = NotaryReceipt::issue(
            "receipt_01",
            &commitment,
            "2026-08-09T14:05:02Z",
            &notary_key(),
        )
        .expect("receipt issues");
        let attacker_key = SigningKey::from_bytes(&[29; 32]);

        assert_eq!(
            receipt.verify(&commitment, &attacker_key.verifying_key().to_bytes()),
            Err(EvidenceError::UntrustedNotary)
        );
    }

    #[test]
    fn timestamps_are_normalized_to_utc_milliseconds() {
        let event = EvidenceEvent::new(
            "event_1",
            1,
            "2026-08-09T22:00:01+08:00",
            "0.1.0",
            EvidenceKind::DraftCreated,
            payload("1"),
        )
        .expect("timestamp normalizes");

        assert_eq!(event.occurred_at_utc, "2026-08-09T14:00:01.000Z");
    }

    #[test]
    fn signature_json_round_trip_preserves_fixed_length_bytes() {
        let entry = two_entry_chain().remove(0);
        let serialized = serde_json::to_string(&entry).expect("entry serializes");
        let restored: SignedEvidenceEntry =
            serde_json::from_str(&serialized).expect("entry deserializes");

        assert_eq!(restored, entry);
        assert_eq!(restored.signature.len(), 64);
    }

    #[test]
    fn signature_json_rejects_wrong_length_and_non_hex_characters() {
        let entry = two_entry_chain().remove(0);
        let mut value = serde_json::to_value(entry).expect("entry serializes");

        value["signature"] = serde_json::Value::String("00".repeat(63));
        assert!(serde_json::from_value::<SignedEvidenceEntry>(value.clone()).is_err());

        value["signature"] = serde_json::Value::String(format!("{}gg", "00".repeat(63)));
        assert!(serde_json::from_value::<SignedEvidenceEntry>(value).is_err());
    }

    #[test]
    fn rejects_sensitive_keys_and_credential_values_without_blocking_normal_status_text() {
        let safe_event = EvidenceEvent::new(
            "event_safe",
            1,
            "2026-08-09T14:00:01Z",
            "0.1.0",
            EvidenceKind::BrokerRejected,
            EvidencePayload {
                account_ref: "acct_local_01".into(),
                intent_id: "intent_safe".into(),
                fields: BTreeMap::from([
                    ("status".into(), "reauth-required".into()),
                    ("reason".into(), "Reauthorization required".into()),
                    (
                        "detail".into(),
                        "Mock session requires reauthorization before preview".into(),
                    ),
                ]),
            },
        );
        assert!(safe_event.is_ok());

        for bad_key in [
            "secret",
            "access_token",
            "password",
            "api_key",
            "bearer",
            "account_number",
            "credential",
            "authorization",
            "private_key",
            "client_id",
            "app_key",
            "cookie",
        ] {
            let result = EvidenceEvent::new(
                "event_bad_key",
                1,
                "2026-08-09T14:00:01Z",
                "0.1.0",
                EvidenceKind::DraftCreated,
                EvidencePayload {
                    account_ref: "acct_local_01".into(),
                    intent_id: "intent_01".into(),
                    fields: BTreeMap::from([(bad_key.into(), "benign".into())]),
                },
            );
            assert_eq!(
                result,
                Err(EvidenceError::SensitiveField(bad_key.to_string())),
                "key {bad_key} must be rejected"
            );
        }

        for bad_value in [
            "Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTYifQ.abcdef123456",
            "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTYifQ.abcdef123456",
            "api_key=supersecret123",
            "password: hunter2",
            "account_number=987654321",
            "-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQE",
            "sk-1234567890abcdefghij",
        ] {
            let result = EvidenceEvent::new(
                "event_bad_val",
                1,
                "2026-08-09T14:00:01Z",
                "0.1.0",
                EvidenceKind::DraftCreated,
                EvidencePayload {
                    account_ref: "acct_local_01".into(),
                    intent_id: "intent_01".into(),
                    fields: BTreeMap::from([("reason".into(), bad_value.into())]),
                },
            );
            assert_eq!(
                result,
                Err(EvidenceError::SensitiveField("reason".to_string())),
                "value {bad_value} must be rejected"
            );
        }
    }

    #[test]
    fn journal_appends_maps_frontend_kinds_verifies_exports_imports_and_clears() {
        let mut journal = EvidenceJournal::from_signing_key(device_key());

        let first = journal
            .append(AppendEvidenceRequest {
                kind: "preview_created".into(),
                payload: BTreeMap::from([
                    ("mode".into(), "mock".into()),
                    ("symbol".into(), "AAPL".into()),
                ]),
                app_version: Some("0.1.0-mock".into()),
                occurred_at_utc: Some("2026-08-09T14:00:01Z".into()),
                account_ref: None,
                intent_id: None,
            })
            .expect("first append succeeds");
        assert_eq!(first.sequence, 1);
        assert_eq!(first.kind, "preview_created");
        assert_eq!(first.rust_kind, "preview_received");
        assert_eq!(first.signature.len(), 128);

        let second = journal
            .append(AppendEvidenceRequest {
                kind: "mock_response".into(),
                payload: BTreeMap::from([
                    ("mode".into(), "mock".into()),
                    ("status".into(), "unknown".into()),
                    ("symbol".into(), "AAPL".into()),
                ]),
                app_version: Some("0.1.0-mock".into()),
                occurred_at_utc: Some("2026-08-09T14:00:02Z".into()),
                account_ref: None,
                intent_id: None,
            })
            .expect("second append succeeds");
        assert_eq!(second.sequence, 2);
        assert_eq!(second.kind, "mock_response");
        assert_eq!(second.rust_kind, "order_unknown");
        assert_eq!(second.previous_hash, first.entry_hash);

        let verification = journal.verify();
        assert!(verification.valid);
        assert_eq!(verification.sequence, 2);
        assert_eq!(verification.head_hash, second.entry_hash);
        assert_eq!(journal.list().len(), 2);

        let exported = journal.export().expect("export succeeds");
        assert!(journal.clear());
        assert_eq!(journal.list().len(), 0);
        assert_eq!(journal.verify().sequence, 0);

        let imported = journal.import(&exported).expect("import succeeds");
        assert!(imported.valid);
        assert_eq!(imported.sequence, 2);
        assert_eq!(journal.list().len(), 2);

        // Tampered bundle must fail closed on import
        let tampered = exported.replace("AAPL", "NVDA");
        assert!(journal.import(&tampered).is_err());

        // Bundle signed by another key must be rejected to keep one signer per chain
        let mut other_journal = EvidenceJournal::from_signing_key(notary_key());
        assert_eq!(
            other_journal.import(&exported),
            Err(EvidenceError::SignerChanged)
        );
    }
}
