pub mod evidence;

use std::sync::Mutex;

use evidence::{
    AppendEvidenceRequest, EvidenceJournal, EvidenceVerificationDto, SignedEvidenceRecordDto,
};
use tauri::State;

pub struct EvidenceJournalState(Mutex<EvidenceJournal>);

impl EvidenceJournalState {
    pub fn new() -> Result<Self, evidence::EvidenceError> {
        Ok(Self(Mutex::new(EvidenceJournal::new_random()?)))
    }

    fn lock_journal(&self) -> Result<std::sync::MutexGuard<'_, EvidenceJournal>, String> {
        self.0
            .lock()
            .map_err(|_| "evidence journal lock is poisoned".to_string())
    }
}

#[tauri::command]
fn evidence_append(
    state: State<'_, EvidenceJournalState>,
    request: AppendEvidenceRequest,
) -> Result<SignedEvidenceRecordDto, String> {
    let mut journal = state.lock_journal()?;
    journal.append(request).map_err(|error| error.to_string())
}

#[tauri::command]
fn evidence_list(
    state: State<'_, EvidenceJournalState>,
) -> Result<Vec<SignedEvidenceRecordDto>, String> {
    let journal = state.lock_journal()?;
    Ok(journal.list())
}

#[tauri::command]
fn evidence_verify(
    state: State<'_, EvidenceJournalState>,
) -> Result<EvidenceVerificationDto, String> {
    let journal = state.lock_journal()?;
    Ok(journal.verify())
}

#[tauri::command]
fn evidence_export(state: State<'_, EvidenceJournalState>) -> Result<String, String> {
    let journal = state.lock_journal()?;
    journal.export().map_err(|error| error.to_string())
}

#[tauri::command]
fn evidence_import(
    state: State<'_, EvidenceJournalState>,
    serialized: String,
) -> Result<EvidenceVerificationDto, String> {
    let mut journal = state.lock_journal()?;
    journal
        .import(&serialized)
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn evidence_clear(state: State<'_, EvidenceJournalState>) -> Result<bool, String> {
    let mut journal = state.lock_journal()?;
    Ok(journal.clear())
}

pub fn run() {
    let journal_state =
        EvidenceJournalState::new().expect("failed to initialize FolioHelm evidence journal");
    tauri::Builder::default()
        .manage(journal_state)
        .invoke_handler(tauri::generate_handler![
            evidence_append,
            evidence_list,
            evidence_verify,
            evidence_export,
            evidence_import,
            evidence_clear,
        ])
        .run(tauri::tauri_build_context!())
        .expect("error while running FolioHelm application");
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use super::*;

    #[test]
    fn evidence_journal_state_initializes_with_random_device_key_and_signs_events() {
        let state = EvidenceJournalState::new().expect("state initializes");
        let mut journal = state.lock_journal().expect("lock succeeds");
        let record = journal
            .append(AppendEvidenceRequest {
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
            .expect("append succeeds");
        assert_eq!(record.sequence, 1);
        assert_eq!(record.rust_kind, "safety_setting_changed");
        assert!(journal.verify().valid);
    }
}
