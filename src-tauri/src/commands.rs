//! Tauri commands exposed to the date calculator UI.
//!
//! The same strongly typed, hardened Rust boundary as the sibling
//! Percentage Calculator Tool: every calculation goes through
//! `date_core::api` (so the UI sees byte-for-byte the envelope the NDJSON
//! bridge and the golden fixtures see), and history/settings are kept in
//! size-capped, symlink-refusing, atomically written files in the app data
//! directory (or in memory only during `--smoke-test`).

use std::fs::{File, OpenOptions};
use std::io::{Read, Write};
#[cfg(windows)]
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use date_core::api::{self, Op, Response, MAX_REQUEST_BYTES};
use date_core::parse::trim_ascii_ws;
use date_core::{
    parse_amount, parse_date, parse_time, CalendarSpec, Field, FirstDayOfWeek, HOLIDAY_MAX_YEAR,
    HOLIDAY_MIN_YEAR, MAX_COPY_TEXT_BYTES,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Manager, State};
use tauri_plugin_clipboard_manager::ClipboardExt;

use crate::{CountdownStore, HistoryState, SettingsState, SmokeState};

pub const HISTORY_MAX_ENTRIES: usize = 500;
const HISTORY_MAX_FILE_BYTES: usize = 1024 * 1024;
/// FROZEN §12: the calendar (custom holidays included) lives in settings.
const SETTINGS_MAX_FILE_BYTES: usize = 64 * 1024;
/// Largest corrupt settings file that is still preserved as `settings.json.bak`.
const SETTINGS_BACKUP_MAX_BYTES: usize = 1024 * 1024;
pub const SETTINGS_SCHEMA_VERSION: i64 = 1;
const MAX_FIELD_LEN: usize = 256;
/// FROZEN §11: a history entry's `copyText` is at most 1024 bytes (the
/// engine guarantees every result's `copyText` fits).
const MAX_HISTORY_COPY_LEN: usize = MAX_COPY_TEXT_BYTES;
/// FROZEN §11: clipboard copies stay at most 4096 bytes.
const MAX_COPY_LEN: usize = 4096;
/// The six mode keys (card ids `card-between` … `card-countdown`).
const ALLOWED_CALCULATORS: &[&str] = &["between", "add", "business", "age", "info", "countdown"];
pub const GITHUB_LATEST_RELEASE_API: &str =
    "https://api.github.com/repos/CipherVaults/Date-Calculator-Tool/releases/latest";
pub const GITHUB_RELEASES_URL: &str =
    "https://github.com/CipherVaults/Date-Calculator-Tool/releases/latest";
const GITHUB_RELEASES_PREFIX: &str =
    "https://github.com/CipherVaults/Date-Calculator-Tool/releases/";
const REPOSITORY_URL: &str = "https://github.com/CipherVaults/Date-Calculator-Tool";
const WEB_APP_URL: &str = "https://ciphervaults.github.io/Date-Calculator-Tool/";
const SMOKE_CLIPBOARD_SENTINEL: &str = "date-tool-smoke-test";
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

static TEMP_FILE_COUNTER: AtomicU64 = AtomicU64::new(0);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/// `settings.json` (FROZEN §12, BUILD_PLAN §4 as amended): camelCase,
/// `deny_unknown_fields` at every level (the calendar is the engine's own
/// `CalendarSpec`), every field defaulted.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
#[serde(rename_all = "camelCase")]
pub struct AppSettings {
    #[serde(default = "default_true")]
    pub check_updates_on_startup: bool,
    /// Mini calendar only: `"monday"` (default) or `"sunday"`.
    #[serde(default)]
    pub first_day_of_week: FirstDayOfWeek,
    /// Weekend and holidays, validated by `date_core` `validate_calendar`.
    /// The Egypt Fri/Sat weekend switch is a UI behaviour: this stores
    /// exactly the calendar it is given.
    #[serde(default)]
    pub calendar: CalendarSpec,
    #[serde(default = "default_settings_schema_version")]
    pub schema_version: i64,
}

fn default_true() -> bool {
    true
}

fn default_settings_schema_version() -> i64 {
    SETTINGS_SCHEMA_VERSION
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            check_updates_on_startup: true,
            first_day_of_week: FirstDayOfWeek::default(),
            calendar: CalendarSpec::default(),
            schema_version: SETTINGS_SCHEMA_VERSION,
        }
    }
}

impl AppSettings {
    /// The privacy-preserving fallback for a corrupt or invalid file: defaults
    /// with the startup update check off.
    fn fail_closed() -> Self {
        Self {
            check_updates_on_startup: false,
            ..Self::default()
        }
    }
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct UpdateCheckResult {
    pub ok: bool,
    pub update_available: bool,
    pub current_version: String,
    pub latest_version: Option<String>,
    pub release_url: String,
    pub published_at: Option<String>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    pub name: &'static str,
    pub version: String,
    pub engine_version: &'static str,
    pub tagline: &'static str,
    pub creators: &'static [&'static str],
    pub ai_builders: &'static [&'static str],
    pub credits: &'static str,
    pub privacy: &'static str,
    pub history_limit: usize,
    pub holiday_rules_range: String,
    pub repository_url: &'static str,
    pub web_app_url: &'static str,
}

/// The restorable inputs of one history entry: the engine request fields of
/// its mode, as strings (booleans `"true"`/`"false"`). Only the keys of the
/// entry's calculator may be present, and all of them must be. The calendar
/// is never stored: a restore recomputes with the current settings, and no
/// custom holiday name can reach history through this map (FROZEN §11).
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
#[serde(rename_all = "camelCase")]
pub struct HistoryInputs {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub start_date: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub end_date: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub include_end_day: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub date: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub operation: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub years: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub months: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub weeks: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub days: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub business_days: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub birth_date: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub as_of_date: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub leap_day_rule: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target_date: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target_time: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
#[serde(rename_all = "camelCase")]
pub struct HistoryEntry {
    pub id: u64,
    pub timestamp_ms: u64,
    pub calculator: String,
    pub calculator_label: String,
    pub inputs: HistoryInputs,
    pub inputs_text: String,
    pub result_text: String,
    pub copy_text: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
#[serde(rename_all = "camelCase")]
pub struct NewHistoryEntry {
    pub calculator: String,
    pub calculator_label: String,
    pub inputs: HistoryInputs,
    pub inputs_text: String,
    pub result_text: String,
    pub copy_text: String,
}

pub fn build_app_info(app: &AppHandle) -> AppInfo {
    AppInfo {
        name: "Date Calculator Tool",
        version: app.package_info().version.to_string(),
        engine_version: date_core::ENGINE_VERSION,
        tagline: "offline · local · clean",
        creators: &["Mohamed Sayed", "Ahmed Emara"],
        ai_builders: &["Claude (Anthropic)"],
        credits: "Mohamed Sayed · Ahmed Emara · built with Claude (Anthropic)",
        privacy: "All date calculations run 100% locally in Rust with zero telemetry. History and settings are stored only on this PC and can be cleared anytime. Optional GitHub Releases update checks can be toggled in Settings.",
        history_limit: HISTORY_MAX_ENTRIES,
        holiday_rules_range: format!("{HOLIDAY_MIN_YEAR}–{HOLIDAY_MAX_YEAR}"),
        repository_url: REPOSITORY_URL,
        web_app_url: WEB_APP_URL,
    }
}

// ---------------------------------------------------------------------------
// Hardened storage
// ---------------------------------------------------------------------------

pub fn history_file_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|err| format!("failed to resolve app data dir: {err}"))?;
    Ok(dir.join("history.json"))
}

pub fn settings_file_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|err| format!("failed to resolve app data dir: {err}"))?;
    Ok(dir.join("settings.json"))
}

fn read_regular_file_limited(
    path: &Path,
    max_bytes: usize,
    label: &str,
) -> Result<Vec<u8>, String> {
    let lstat =
        std::fs::symlink_metadata(path).map_err(|err| format!("failed to stat {label}: {err}"))?;
    if lstat.file_type().is_symlink() || !lstat.file_type().is_file() {
        return Err(format!("refusing to read non-regular or symlinked {label}"));
    }
    if lstat.len() > max_bytes as u64 {
        return Err(format!("{label} exceeds max allowed size"));
    }

    let file = File::open(path).map_err(|err| format!("failed to open {label}: {err}"))?;
    let fstat = file
        .metadata()
        .map_err(|err| format!("failed to inspect opened {label}: {err}"))?;
    if !fstat.is_file() || fstat.len() > max_bytes as u64 {
        return Err(format!("{label} invalid or exceeds max allowed size"));
    }

    let mut bytes = Vec::with_capacity((fstat.len() as usize).min(max_bytes));
    file.take((max_bytes + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|err| format!("failed to read {label}: {err}"))?;
    if bytes.len() > max_bytes {
        return Err(format!("{label} exceeded max allowed size while reading"));
    }
    Ok(bytes)
}

fn ensure_private_parent_dir(parent: &Path) -> Result<(), String> {
    #[cfg(unix)]
    let created = !parent.exists();
    std::fs::create_dir_all(parent)
        .map_err(|err| format!("failed to create app data directory: {err}"))?;
    let meta = std::fs::symlink_metadata(parent)
        .map_err(|err| format!("failed to inspect app data directory: {err}"))?;
    if meta.file_type().is_symlink() || !meta.file_type().is_dir() {
        return Err("app data directory path is not a regular directory".to_string());
    }
    #[cfg(unix)]
    if created {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(parent, std::fs::Permissions::from_mode(0o700));
    }
    Ok(())
}

fn write_atomic_private(path: &Path, data: &[u8]) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "file path has no parent directory".to_string())?;
    ensure_private_parent_dir(parent)?;

    if let Ok(existing) = std::fs::symlink_metadata(path) {
        if existing.file_type().is_symlink() || !existing.file_type().is_file() {
            return Err("refusing to overwrite non-regular or symlinked file".to_string());
        }
    }

    let pid = std::process::id();
    let seq = TEMP_FILE_COUNTER.fetch_add(1, Ordering::Relaxed);
    let stem = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("data");
    let tmp_name = format!("{stem}.{pid}.{seq}.tmp");
    let tmp_path = parent.join(tmp_name);

    let mut opts = OpenOptions::new();
    opts.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }

    let mut file = opts
        .open(&tmp_path)
        .map_err(|err| format!("failed to create temporary file: {err}"))?;

    let write_res = (|| -> Result<(), String> {
        file.write_all(data)
            .map_err(|err| format!("failed to write temporary file: {err}"))?;
        file.sync_all()
            .map_err(|err| format!("failed to flush temporary file: {err}"))?;
        Ok(())
    })();

    drop(file);
    if let Err(err) = write_res {
        let _ = std::fs::remove_file(&tmp_path);
        return Err(err);
    }

    if let Err(err) = std::fs::rename(&tmp_path, path) {
        let _ = std::fs::remove_file(&tmp_path);
        return Err(format!("failed to commit file: {err}"));
    }
    Ok(())
}

/// Why history is read-only (plan A3). Serialized as the `reason` string of
/// `history_state`.
#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum HistoryReadOnlyReason {
    /// The file exists but could not be read (sharing violation, lock,
    /// permission, symlink, not a regular file). Nothing is backed up.
    ReadError,
    /// The file is valid JSON but not a v1 history, or an entry failed
    /// validation. `history.json.bak` was attempted first.
    Corrupt,
    /// The file is over the 1 MiB cap. Nothing is backed up.
    TooLarge,
    /// The file declares a `schemaVersion` newer than this build reads.
    /// Never backed up and never written.
    NewerSchema,
}

/// What `history_state` / `history_retry` return:
/// `{"readOnly": bool, "reason": null | "read_error" | …}`.
#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct HistoryStatus {
    pub read_only: bool,
    pub reason: Option<HistoryReadOnlyReason>,
}

impl HistoryStatus {
    fn from_reason(reason: Option<HistoryReadOnlyReason>) -> Self {
        Self {
            read_only: reason.is_some(),
            reason,
        }
    }
}

/// The outcome of loading `history.json` (plan A3). `entries` is what could
/// be loaded safely; when `read_only` is set, nothing may write the file
/// until the user retries successfully or explicitly starts a new history.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct HistoryLoad {
    pub entries: Vec<HistoryEntry>,
    pub read_only: Option<HistoryReadOnlyReason>,
}

impl HistoryLoad {
    fn read_only(reason: HistoryReadOnlyReason) -> Self {
        Self {
            entries: Vec::new(),
            read_only: Some(reason),
        }
    }

    /// The id the next new entry gets: one past the largest loaded id.
    pub fn next_id(&self) -> u64 {
        self.entries
            .iter()
            .map(|entry| entry.id)
            .max()
            .unwrap_or(0)
            .saturating_add(1)
    }
}

/// Reads a `schemaVersion` newer than `current` from a raw JSON object, so a
/// file written by a newer build is recognised before any strict parse.
fn declares_newer_schema(value: &Value, current: u64) -> bool {
    value
        .get("schemaVersion")
        .and_then(Value::as_u64)
        .is_some_and(|version| version > current)
}

/// Plan A3: a history that cannot be read safely is never replaced by an
/// empty one. Only a missing file starts an empty, writable history.
///
/// - `NotFound` → empty, writable.
/// - Any other read failure (lock, permission, symlink, not a regular file)
///   → read-only `read_error`; over the cap → read-only `too_large`. No
///   `.bak` is attempted: the bytes were never read.
/// - A newer `schemaVersion` object → read-only `newer_schema`, no `.bak`.
/// - Invalid JSON, a wrong shape, or any entry dropped by validation (or
///   past the 500-entry cap) → `history.json.bak` once, then read-only
///   `corrupt`. The entries that did validate are still shown.
pub fn load_history_from_path(path: &Path) -> HistoryLoad {
    let meta = match std::fs::symlink_metadata(path) {
        Ok(meta) => meta,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return HistoryLoad::default(),
        Err(_) => return HistoryLoad::read_only(HistoryReadOnlyReason::ReadError),
    };
    if meta.file_type().is_file() && meta.len() > HISTORY_MAX_FILE_BYTES as u64 {
        return HistoryLoad::read_only(HistoryReadOnlyReason::TooLarge);
    }
    let Ok(bytes) = read_regular_file_limited(path, HISTORY_MAX_FILE_BYTES, "history file") else {
        return HistoryLoad::read_only(HistoryReadOnlyReason::ReadError);
    };
    let corrupt = |entries: Vec<HistoryEntry>| {
        backup_corrupt_file_once(path, HISTORY_MAX_FILE_BYTES);
        HistoryLoad {
            entries,
            read_only: Some(HistoryReadOnlyReason::Corrupt),
        }
    };
    let Ok(value) = serde_json::from_slice::<Value>(&bytes) else {
        return corrupt(Vec::new());
    };
    if value.is_object() && declares_newer_schema(&value, 1) {
        return HistoryLoad::read_only(HistoryReadOnlyReason::NewerSchema);
    }
    if !value.is_array() {
        return corrupt(Vec::new());
    }
    let Ok(stored) = Vec::<HistoryEntry>::deserialize(value) else {
        return corrupt(Vec::new());
    };
    let stored_len = stored.len();
    let entries: Vec<HistoryEntry> = stored
        .into_iter()
        .filter(|entry| validate_history_entry(entry).is_ok())
        .take(HISTORY_MAX_ENTRIES)
        .collect();
    if entries.len() != stored_len {
        return corrupt(entries);
    }
    HistoryLoad {
        entries,
        read_only: None,
    }
}

pub fn load_history_from_disk(app: &AppHandle) -> HistoryLoad {
    match history_file_path(app) {
        Ok(path) => load_history_from_path(&path),
        // Without a path nothing can be read or written safely.
        Err(_) => HistoryLoad::read_only(HistoryReadOnlyReason::ReadError),
    }
}

fn serialize_history(entries: &[HistoryEntry]) -> Result<Vec<u8>, String> {
    serde_json::to_vec_pretty(entries).map_err(|err| format!("failed to serialize history: {err}"))
}

fn persist_history_to_path(path: &Path, entries: &[HistoryEntry]) -> Result<(), String> {
    let data = serialize_history(entries)?;
    if data.len() > HISTORY_MAX_FILE_BYTES {
        return Err("serialized history exceeds max allowed file size".to_string());
    }
    write_atomic_private(path, &data)
}

/// Evicts the oldest entries until the serialized list fits the file cap, so
/// a full history of unusually large entries keeps accepting new ones
/// instead of failing every add. The newest entry is always kept (a single
/// valid entry is far below the cap).
fn fit_history_to_file_cap(entries: &mut Vec<HistoryEntry>) -> Result<(), String> {
    loop {
        let size = serialize_history(entries)?.len();
        if size <= HISTORY_MAX_FILE_BYTES || entries.len() <= 1 {
            return Ok(());
        }
        let average = (size / entries.len()).max(1);
        let excess = size - HISTORY_MAX_FILE_BYTES;
        let drop_count = (excess / average + 1).min(entries.len() - 1);
        entries.truncate(entries.len() - drop_count);
    }
}

/// `settings.json` → `settings.json.bak`.
fn backup_path(path: &Path) -> Option<PathBuf> {
    let mut name = path.file_name()?.to_os_string();
    name.push(".bak");
    Some(path.with_file_name(name))
}

/// FROZEN §12 / spec 2 §8.3 / plan A2–A3: copies a corrupt or invalid file
/// (settings, history or countdown) once to a single `<name>.bak` before it
/// can be overwritten.
///
/// "Once" is per corrupt file: repeated loads of the same bad bytes write
/// nothing new, but a later, different corruption replaces an older `.bak`,
/// so the most recent bad file is never lost to the next save. A `.bak` that
/// is a symlink, a directory, unreadable or over `max_bytes` is left alone,
/// and symlinked, non-regular or over-cap source files are never copied.
/// Returns whether a backup was written.
fn backup_corrupt_file_once(path: &Path, max_bytes: usize) -> bool {
    let Some(bak) = backup_path(path) else {
        return false;
    };
    let Ok(bytes) = read_regular_file_limited(path, max_bytes, "file to back up") else {
        return false;
    };
    match std::fs::symlink_metadata(&bak) {
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
        Ok(meta) if meta.file_type().is_file() => {
            match read_regular_file_limited(&bak, max_bytes, "existing backup") {
                Ok(existing) if existing != bytes => {}
                _ => return false,
            }
        }
        _ => return false,
    }
    write_atomic_private(&bak, &bytes).is_ok()
}

/// True only when nothing exists at `p` (any other lookup error is not
/// "free": the name may still hold something that must not be replaced).
fn path_is_missing(p: &Path) -> bool {
    matches!(
        std::fs::symlink_metadata(p),
        Err(ref err) if err.kind() == std::io::ErrorKind::NotFound
    )
}

/// True when `path` and its `.bak` are both readable regular files with the
/// same bytes: the current bytes are already kept, so replacing `path` loses
/// nothing.
fn already_backed_up(path: &Path, max_bytes: usize) -> bool {
    let Some(bak) = backup_path(path) else {
        return false;
    };
    match (
        read_regular_file_limited(path, max_bytes, "file to replace"),
        read_regular_file_limited(&bak, max_bytes, "existing backup"),
    ) {
        (Ok(current), Ok(kept)) => current == kept,
        _ => false,
    }
}

/// `history.json` → a free `history.json.bak-<ms>` (or `-<ms>-<n>`), so a
/// second backup never replaces the first.
fn unique_backup_path(path: &Path) -> Option<PathBuf> {
    let bak = backup_path(path)?;
    let base = bak.file_name()?.to_os_string();
    let ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    (0..100u32).find_map(|n| {
        let mut name = base.clone();
        if n == 0 {
            name.push(format!("-{ms}"));
        } else {
            name.push(format!("-{ms}-{n}"));
        }
        let candidate = bak.with_file_name(name);
        path_is_missing(&candidate).then_some(candidate)
    })
}

/// Keeps a file that cannot be read or copied safely by renaming it aside
/// whole (never copying, truncating or replacing anything): to `<name>.bak`
/// when that name is free, else to a fresh `unique_backup_path`. A symlink
/// is moved as a link; its target is never touched.
fn move_aside(path: &Path) -> Result<PathBuf, String> {
    let bak = backup_path(path).ok_or_else(|| "path has no file name".to_string())?;
    let target = if path_is_missing(&bak) {
        bak
    } else {
        unique_backup_path(path).ok_or_else(|| "no free backup name".to_string())?
    };
    std::fs::rename(path, &target)
        .map_err(|err| format!("failed to move the file aside: {err}"))?;
    Ok(target)
}

/// Parses and validates a settings object (from the file or from the UI).
///
/// The calendar goes through the engine's own IPC entry point
/// (`validate_calendar`), so it is accepted exactly when the engine accepts
/// it: strict object shapes, unknown fields rejected at any depth, string
/// length limits, and every FROZEN §4 rule.
pub fn parse_settings_value(value: &Value) -> Result<AppSettings, String> {
    let Value::Object(map) = value else {
        return Err("settings must be a JSON object".to_string());
    };
    if let Some(calendar) = map.get("calendar") {
        let req = serde_json::json!({ "calendar": calendar });
        if let Some(err) = api::call(Op::ValidateCalendar, &req).error() {
            return Err(format!("invalid calendar settings: {err}"));
        }
    }
    let settings =
        AppSettings::deserialize(value).map_err(|_| "invalid settings shape".to_string())?;
    if settings.schema_version != SETTINGS_SCHEMA_VERSION {
        return Err("unsupported settings schemaVersion".to_string());
    }
    Ok(settings)
}

pub fn load_settings_from_path(path: &Path) -> AppSettings {
    if matches!(
        std::fs::symlink_metadata(path),
        Err(ref err) if err.kind() == std::io::ErrorKind::NotFound
    ) {
        return AppSettings::default();
    }
    let parsed = read_regular_file_limited(path, SETTINGS_MAX_FILE_BYTES, "settings file")
        .and_then(|bytes| {
            serde_json::from_slice::<Value>(&bytes)
                .map_err(|_| "settings file is not valid JSON".to_string())
        })
        .and_then(|value| parse_settings_value(&value));
    match parsed {
        Ok(settings) => settings,
        Err(_) => {
            backup_corrupt_file_once(path, SETTINGS_BACKUP_MAX_BYTES);
            AppSettings::fail_closed()
        }
    }
}

pub fn load_settings_from_disk(app: &AppHandle) -> AppSettings {
    let Ok(path) = settings_file_path(app) else {
        return AppSettings::default();
    };
    load_settings_from_path(&path)
}

fn persist_settings_to_path(path: &Path, settings: &AppSettings) -> Result<(), String> {
    let data = serde_json::to_vec_pretty(settings)
        .map_err(|err| format!("failed to serialize settings: {err}"))?;
    if data.len() > SETTINGS_MAX_FILE_BYTES {
        return Err("serialized settings exceed max allowed file size".to_string());
    }
    write_atomic_private(path, &data)
}

// ---------------------------------------------------------------------------
// Countdown persistence (plan A2)
// ---------------------------------------------------------------------------

/// `countdown.json`: one small record, kept apart from `settings.json` so a
/// bad countdown can never fail settings closed (and the reverse).
const COUNTDOWN_MAX_FILE_BYTES: usize = 1024;
pub const COUNTDOWN_SCHEMA_VERSION: u64 = 1;
/// Timestamps are written by JavaScript (`Date.now()`), so they must stay
/// exact JS numbers: at most `Number.MAX_SAFE_INTEGER`.
const MAX_SAFE_JS_INTEGER: u64 = (1 << 53) - 1;
/// The newer-schema refusal `countdown_save` returns.
pub const COUNTDOWN_NEWER_SCHEMA: &str = "countdown_newer_schema";
/// The refusal `countdown_save` / `countdown_clear` return for an existing
/// file that is over the cap or cannot be read.
pub const COUNTDOWN_UNREADABLE: &str = "countdown_unreadable";
/// How much of an over-cap countdown file is read to look for a newer
/// `schemaVersion` before it is treated as invalid.
const COUNTDOWN_SNIFF_MAX_BYTES: usize = 64 * 1024;

/// The saved countdown target. `targetTime` is `""` or `HH:MM`;
/// `finishedSeenAtMs` is `null` until the UI first shows it finished.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
#[serde(rename_all = "camelCase")]
pub struct CountdownState {
    pub schema_version: u64,
    pub target_date: String,
    pub target_time: String,
    pub saved_at_ms: u64,
    pub finished_seen_at_ms: Option<u64>,
}

/// `countdown_load` status strings.
#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum CountdownLoadStatus {
    /// A valid v1 record.
    Ok,
    /// No record.
    Empty,
    /// Written by a newer build: ignored, never written or backed up.
    Newer,
    /// Invalid: `countdown.json.bak` was attempted (an over-cap file is
    /// renamed aside instead), the record is ignored.
    Corrupt,
    /// Exists but could not be read (lock, permission, symlink, not a
    /// regular file, or over the cap and could not be moved aside).
    Unreadable,
}

/// `{"state": CountdownState | null, "status": "ok" | "empty" | …}`.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CountdownLoad {
    pub state: Option<CountdownState>,
    pub status: CountdownLoadStatus,
}

impl CountdownLoad {
    fn without_state(status: CountdownLoadStatus) -> Self {
        Self {
            state: None,
            status,
        }
    }
}

pub fn countdown_file_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|err| format!("failed to resolve app data dir: {err}"))?;
    Ok(dir.join("countdown.json"))
}

fn input_kind(key: &str) -> Option<InputKind> {
    INPUT_KEYS
        .iter()
        .find(|(name, _)| *name == key)
        .map(|(_, kind)| *kind)
}

/// Validates a countdown record exactly like a history countdown entry's
/// inputs (the shared `INPUT_KEYS` validators), plus the record's own rules:
/// schema 1, a time of `""` or exactly `HH:MM`, JS-safe timestamps.
pub fn validate_countdown_state(state: &CountdownState) -> Result<(), &'static str> {
    if state.schema_version != COUNTDOWN_SCHEMA_VERSION {
        return Err("unsupported countdown schemaVersion");
    }
    let date_kind = input_kind("targetDate").ok_or("invalid countdown targetDate")?;
    let time_kind = input_kind("targetTime").ok_or("invalid countdown targetTime")?;
    validate_input_value(date_kind, &state.target_date)
        .map_err(|_| "invalid countdown targetDate")?;
    // The engine also accepts `HH:MM:SS`; the countdown card stores minutes.
    if !(state.target_time.is_empty() || state.target_time.len() == 5) {
        return Err("invalid countdown targetTime");
    }
    validate_input_value(time_kind, &state.target_time)
        .map_err(|_| "invalid countdown targetTime")?;
    let finished = state.finished_seen_at_ms.unwrap_or(0);
    if state.saved_at_ms > MAX_SAFE_JS_INTEGER || finished > MAX_SAFE_JS_INTEGER {
        return Err("countdown timestamp out of range");
    }
    Ok(())
}

/// Parses a countdown record from raw JSON. `schemaVersion` is read first,
/// so a newer record is recognised without a strict parse.
fn parse_countdown_value(value: Value) -> Result<CountdownState, CountdownLoadStatus> {
    if !value.is_object() {
        return Err(CountdownLoadStatus::Corrupt);
    }
    if declares_newer_schema(&value, COUNTDOWN_SCHEMA_VERSION) {
        return Err(CountdownLoadStatus::Newer);
    }
    if value.get("schemaVersion").and_then(Value::as_u64) != Some(COUNTDOWN_SCHEMA_VERSION) {
        return Err(CountdownLoadStatus::Corrupt);
    }
    let state = CountdownState::deserialize(value).map_err(|_| CountdownLoadStatus::Corrupt)?;
    validate_countdown_state(&state).map_err(|_| CountdownLoadStatus::Corrupt)?;
    Ok(state)
}

/// True when `bytes` are a JSON object that declares a newer schema.
fn countdown_bytes_are_newer(bytes: &[u8]) -> bool {
    serde_json::from_slice::<Value>(bytes).is_ok_and(|value| {
        value.is_object() && declares_newer_schema(&value, COUNTDOWN_SCHEMA_VERSION)
    })
}

/// True when an over-cap countdown file still declares a newer schema: a
/// newer build may write a larger record, so its `schemaVersion` is read from
/// up to `COUNTDOWN_SNIFF_MAX_BYTES` before the file is treated as invalid.
fn oversize_countdown_is_newer(path: &Path) -> bool {
    read_regular_file_limited(path, COUNTDOWN_SNIFF_MAX_BYTES, "countdown file")
        .is_ok_and(|bytes| countdown_bytes_are_newer(&bytes))
}

/// Plan A2: `countdown_save` and `countdown_clear` replace or remove only a
/// missing file, a symlink (never written through: `write_atomic_private`
/// refuses it, clear removes the link itself) or a readable record of this
/// schema, valid or corrupt (a corrupt one was backed up at load). A
/// newer-schema record, a file over the cap or one that cannot be read is
/// refused here, whatever the UI believes.
fn countdown_slot_replaceable(path: &Path) -> Result<(), String> {
    let meta = match std::fs::symlink_metadata(path) {
        Ok(meta) => meta,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(_) => return Err(COUNTDOWN_UNREADABLE.to_string()),
    };
    if meta.file_type().is_symlink() {
        return Ok(());
    }
    if meta.file_type().is_file() && meta.len() > COUNTDOWN_MAX_FILE_BYTES as u64 {
        return Err(if oversize_countdown_is_newer(path) {
            COUNTDOWN_NEWER_SCHEMA
        } else {
            COUNTDOWN_UNREADABLE
        }
        .to_string());
    }
    let bytes = read_regular_file_limited(path, COUNTDOWN_MAX_FILE_BYTES, "countdown file")
        .map_err(|_| COUNTDOWN_UNREADABLE.to_string())?;
    if countdown_bytes_are_newer(&bytes) {
        return Err(COUNTDOWN_NEWER_SCHEMA.to_string());
    }
    Ok(())
}

/// Plan A2, a regular file over the 1 KiB cap. This build never writes one,
/// so unless it declares a newer schema (left alone, status `newer`) it is
/// invalid. Its bytes are too large to copy into `countdown.json.bak`, so
/// the file is renamed aside whole (`move_aside`) and the slot becomes
/// writable again (status `corrupt`). If it cannot be moved it stays
/// `unreadable` and untouched.
fn load_oversize_countdown(path: &Path) -> CountdownLoad {
    if oversize_countdown_is_newer(path) {
        return CountdownLoad::without_state(CountdownLoadStatus::Newer);
    }
    match move_aside(path) {
        Ok(_) => CountdownLoad::without_state(CountdownLoadStatus::Corrupt),
        Err(_) => CountdownLoad::without_state(CountdownLoadStatus::Unreadable),
    }
}

pub fn load_countdown_from_path(path: &Path) -> CountdownLoad {
    match std::fs::symlink_metadata(path) {
        Ok(meta) if meta.file_type().is_file() && meta.len() > COUNTDOWN_MAX_FILE_BYTES as u64 => {
            return load_oversize_countdown(path);
        }
        Ok(_) => {}
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
            return CountdownLoad::without_state(CountdownLoadStatus::Empty);
        }
        Err(_) => return CountdownLoad::without_state(CountdownLoadStatus::Unreadable),
    }
    let Ok(bytes) = read_regular_file_limited(path, COUNTDOWN_MAX_FILE_BYTES, "countdown file")
    else {
        return CountdownLoad::without_state(CountdownLoadStatus::Unreadable);
    };
    let parsed = serde_json::from_slice::<Value>(&bytes)
        .map_err(|_| CountdownLoadStatus::Corrupt)
        .and_then(parse_countdown_value);
    match parsed {
        Ok(state) => CountdownLoad {
            state: Some(state),
            status: CountdownLoadStatus::Ok,
        },
        Err(CountdownLoadStatus::Corrupt) => {
            backup_corrupt_file_once(path, COUNTDOWN_MAX_FILE_BYTES);
            CountdownLoad::without_state(CountdownLoadStatus::Corrupt)
        }
        Err(status) => CountdownLoad::without_state(status),
    }
}

fn serialize_countdown(state: &CountdownState) -> Result<Vec<u8>, String> {
    validate_countdown_state(state).map_err(str::to_string)?;
    let data =
        serde_json::to_vec(state).map_err(|err| format!("failed to serialize countdown: {err}"))?;
    if data.len() > COUNTDOWN_MAX_FILE_BYTES {
        return Err("serialized countdown exceeds max allowed file size".to_string());
    }
    Ok(data)
}

fn persist_countdown_to_path(path: &Path, state: &CountdownState) -> Result<(), String> {
    let data = serialize_countdown(state)?;
    countdown_slot_replaceable(path)?;
    write_atomic_private(path, &data)
}

/// Removes `countdown.json` (never its `.bak`, never anything else). A
/// missing file is already clear; a newer-schema, over-cap or unreadable
/// record is refused and left in place (`countdown_slot_replaceable`).
fn clear_countdown_at_path(path: &Path) -> Result<(), String> {
    match std::fs::symlink_metadata(path) {
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(err) => Err(format!("failed to inspect countdown file: {err}")),
        Ok(meta) if meta.file_type().is_dir() => {
            Err("countdown path is not a regular file".to_string())
        }
        Ok(_) => {
            countdown_slot_replaceable(path)?;
            // A symlink is removed as a link; its target is never touched.
            std::fs::remove_file(path)
                .map_err(|err| format!("failed to remove countdown file: {err}"))
        }
    }
}

// ---------------------------------------------------------------------------
// Update check
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
struct GitHubReleaseResponse {
    tag_name: String,
    #[serde(default)]
    draft: bool,
    #[serde(default)]
    prerelease: bool,
    #[serde(default)]
    html_url: Option<String>,
    #[serde(default)]
    published_at: Option<String>,
}

pub fn parse_semver_triplet(version_or_tag: &str) -> Option<(u64, u64, u64)> {
    let trimmed = version_or_tag.trim();
    let without_v = trimmed
        .strip_prefix('v')
        .or_else(|| trimmed.strip_prefix('V'))
        .unwrap_or(trimmed);
    let core = without_v.split(['-', '+']).next()?;
    let mut parts = core.split('.');
    let parse_part = |s: &str| -> Option<u64> {
        if s.is_empty() || !s.bytes().all(|b| b.is_ascii_digit()) {
            return None;
        }
        s.parse::<u64>().ok()
    };
    let major = parse_part(parts.next()?)?;
    let minor = parse_part(parts.next()?)?;
    let patch = parse_part(parts.next()?)?;
    if parts.next().is_some() {
        return None;
    }
    Some((major, minor, patch))
}

pub fn is_newer_version(current: &str, candidate_tag: &str) -> bool {
    match (
        parse_semver_triplet(current),
        parse_semver_triplet(candidate_tag),
    ) {
        (Some(cur), Some(cand)) => cand > cur,
        _ => false,
    }
}

pub fn parse_github_release_json(
    current_version: &str,
    bytes: &[u8],
) -> Result<UpdateCheckResult, String> {
    let parsed: GitHubReleaseResponse =
        serde_json::from_slice(bytes).map_err(|err| format!("invalid release JSON: {err}"))?;
    if parsed.draft || parsed.prerelease {
        return Ok(UpdateCheckResult {
            ok: true,
            update_available: false,
            current_version: current_version.to_string(),
            latest_version: None,
            release_url: GITHUB_RELEASES_URL.to_string(),
            published_at: None,
            error: None,
        });
    }
    let (maj, min, patch) = parse_semver_triplet(&parsed.tag_name)
        .ok_or_else(|| "invalid release tag format".to_string())?;
    let latest_version = format!("{maj}.{min}.{patch}");
    let release_url = parsed
        .html_url
        .filter(|u| {
            u.starts_with(GITHUB_RELEASES_PREFIX)
                && u.len() <= MAX_FIELD_LEN
                && !u.contains("..")
                && !u.contains('\\')
                && !u.chars().any(|c| c.is_whitespace() || c.is_control())
        })
        .unwrap_or_else(|| GITHUB_RELEASES_URL.to_string());
    let published_at = parsed
        .published_at
        .filter(|s| !s.trim().is_empty() && s.len() <= 64);

    Ok(UpdateCheckResult {
        ok: true,
        update_available: is_newer_version(current_version, &parsed.tag_name),
        current_version: current_version.to_string(),
        latest_version: Some(latest_version),
        release_url,
        published_at,
        error: None,
    })
}

#[cfg(windows)]
fn windows_system32_tool(name: &str) -> PathBuf {
    let fallback = PathBuf::from(r"C:\Windows");
    let root = std::env::var_os("SystemRoot")
        .map(PathBuf::from)
        .filter(|p| p.is_absolute() && p.is_dir())
        .unwrap_or(fallback);
    root.join("System32").join(name)
}

// ---------------------------------------------------------------------------
// History validation
// ---------------------------------------------------------------------------

/// How one history input value is validated.
#[derive(Debug, Clone, Copy)]
enum InputKind {
    /// A required `YYYY-MM-DD` date (engine parser).
    Date(Field),
    /// `""` (Age: "today") or a date.
    OptionalDate(Field),
    /// `"true"` or `"false"`.
    Bool,
    /// `"add"` or `"subtract"`.
    Operation,
    /// `""` or an engine amount (signed, at most 15 digits, per-field max).
    Amount(Field),
    /// `"feb28"` or `"mar1"`.
    LeapDayRule,
    /// `""` or `HH:MM[:SS]`.
    OptionalTime(Field),
}

/// Every input key, in [`HistoryInputs`] field order.
const INPUT_KEYS: [(&str, InputKind); 15] = [
    ("startDate", InputKind::Date(Field::StartDate)),
    ("endDate", InputKind::Date(Field::EndDate)),
    ("includeEndDay", InputKind::Bool),
    ("date", InputKind::Date(Field::Date)),
    ("operation", InputKind::Operation),
    ("years", InputKind::Amount(Field::Years)),
    ("months", InputKind::Amount(Field::Months)),
    ("weeks", InputKind::Amount(Field::Weeks)),
    ("days", InputKind::Amount(Field::Days)),
    ("businessDays", InputKind::Bool),
    ("birthDate", InputKind::Date(Field::BirthDate)),
    ("asOfDate", InputKind::OptionalDate(Field::AsOfDate)),
    ("leapDayRule", InputKind::LeapDayRule),
    ("targetDate", InputKind::Date(Field::TargetDate)),
    ("targetTime", InputKind::OptionalTime(Field::TargetTime)),
];

/// The input keys each calculator stores: all are required, no others allowed.
fn calculator_input_keys(calculator: &str) -> Option<&'static [&'static str]> {
    Some(match calculator {
        "between" | "business" => &["startDate", "endDate", "includeEndDay"],
        "add" => &[
            "date",
            "operation",
            "years",
            "months",
            "weeks",
            "days",
            "businessDays",
        ],
        "age" => &["birthDate", "asOfDate", "leapDayRule"],
        "info" => &["date"],
        "countdown" => &["targetDate", "targetTime"],
        _ => return None,
    })
}

impl HistoryInputs {
    /// The values in [`INPUT_KEYS`] order.
    fn values(&self) -> [Option<&str>; 15] {
        [
            self.start_date.as_deref(),
            self.end_date.as_deref(),
            self.include_end_day.as_deref(),
            self.date.as_deref(),
            self.operation.as_deref(),
            self.years.as_deref(),
            self.months.as_deref(),
            self.weeks.as_deref(),
            self.days.as_deref(),
            self.business_days.as_deref(),
            self.birth_date.as_deref(),
            self.as_of_date.as_deref(),
            self.leap_day_rule.as_deref(),
            self.target_date.as_deref(),
            self.target_time.as_deref(),
        ]
    }

    /// The values in [`INPUT_KEYS`] order, mutable.
    fn values_mut(&mut self) -> [&mut Option<String>; 15] {
        [
            &mut self.start_date,
            &mut self.end_date,
            &mut self.include_end_day,
            &mut self.date,
            &mut self.operation,
            &mut self.years,
            &mut self.months,
            &mut self.weeks,
            &mut self.days,
            &mut self.business_days,
            &mut self.birth_date,
            &mut self.as_of_date,
            &mut self.leap_day_rule,
            &mut self.target_date,
            &mut self.target_time,
        ]
    }

    /// Canonicalizes a new entry's inputs the way the engine reads them: the
    /// engine's date, amount and time parsers strip U+0020/U+0009/U+000A/
    /// U+000D from both ends ([`trim_ascii_ws`]), so `" 5"` computes like
    /// `"5"`. Those kinds are stored trimmed, which keeps every input the
    /// engine accepted savable while the stored-file validator stays strict.
    /// Exact-match kinds (booleans, operation, leap-day rule) are not trimmed,
    /// because the engine does not trim them either.
    fn normalize_engine_trimmed(&mut self) {
        for ((_, kind), value) in INPUT_KEYS.iter().zip(self.values_mut()) {
            let engine_trims = matches!(
                kind,
                InputKind::Date(_)
                    | InputKind::OptionalDate(_)
                    | InputKind::Amount(_)
                    | InputKind::OptionalTime(_)
            );
            if let (true, Some(text)) = (engine_trims, value.as_mut()) {
                let trimmed = trim_ascii_ws(text);
                if trimmed.len() != text.len() {
                    *text = trimmed.to_string();
                }
            }
        }
    }
}

fn validate_input_value(kind: InputKind, value: &str) -> Result<(), &'static str> {
    if value.len() > MAX_FIELD_LEN {
        return Err("history field empty or exceeds max length");
    }
    if value.chars().any(char::is_control) {
        return Err("history input contains control characters");
    }
    if value.chars().any(char::is_whitespace) {
        return Err("invalid history input value");
    }
    let ok = match kind {
        InputKind::Date(field) => parse_date(value, field).is_ok(),
        InputKind::OptionalDate(field) => value.is_empty() || parse_date(value, field).is_ok(),
        InputKind::Bool => value == "true" || value == "false",
        InputKind::Operation => value == "add" || value == "subtract",
        InputKind::Amount(field) => parse_amount(value, field).is_ok(),
        InputKind::LeapDayRule => value == "feb28" || value == "mar1",
        InputKind::OptionalTime(field) => parse_time(value, field, false).is_ok(),
    };
    if ok {
        Ok(())
    } else {
        Err("invalid history input value")
    }
}

fn validate_history_inputs(calculator: &str, inputs: &HistoryInputs) -> Result<(), &'static str> {
    let allowed = calculator_input_keys(calculator).ok_or("invalid calculator key")?;
    for ((key, kind), value) in INPUT_KEYS.iter().zip(inputs.values()) {
        match (allowed.contains(key), value) {
            (false, Some(_)) => return Err("unexpected input for calculator"),
            (true, None) => return Err("missing input for calculator"),
            (true, Some(value)) => validate_input_value(*kind, value)?,
            (false, None) => {}
        }
    }
    Ok(())
}

fn validate_entry_fields(
    calculator: &str,
    calculator_label: &str,
    inputs: &HistoryInputs,
    inputs_text: &str,
    result_text: &str,
    copy_text: &str,
) -> Result<(), &'static str> {
    if !ALLOWED_CALCULATORS.contains(&calculator) {
        return Err("invalid calculator key");
    }
    let single_line_fields = [calculator_label, inputs_text, result_text];
    if single_line_fields
        .iter()
        .any(|f| f.trim().is_empty() || f.len() > MAX_FIELD_LEN)
        || copy_text.trim().is_empty()
        || copy_text.len() > MAX_HISTORY_COPY_LEN
    {
        return Err("history field empty or exceeds max length");
    }
    if single_line_fields
        .iter()
        .any(|f| f.chars().any(char::is_control))
        || copy_text.chars().any(|c| c.is_control() && c != '\n')
    {
        return Err("history input contains control characters");
    }
    validate_history_inputs(calculator, inputs)
}

fn validate_new_entry(entry: &NewHistoryEntry) -> Result<(), &'static str> {
    validate_entry_fields(
        &entry.calculator,
        &entry.calculator_label,
        &entry.inputs,
        &entry.inputs_text,
        &entry.result_text,
        &entry.copy_text,
    )
}

fn validate_history_entry(entry: &HistoryEntry) -> Result<(), &'static str> {
    validate_entry_fields(
        &entry.calculator,
        &entry.calculator_label,
        &entry.inputs,
        &entry.inputs_text,
        &entry.result_text,
        &entry.copy_text,
    )
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

// ---------------------------------------------------------------------------
// Calculation commands (FROZEN §2): one per engine entry point
// ---------------------------------------------------------------------------

/// Counts serialized bytes and fails once [`MAX_REQUEST_BYTES`] is passed.
struct CappedSink {
    written: usize,
}

impl Write for CappedSink {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        self.written = self.written.saturating_add(buf.len());
        if self.written > MAX_REQUEST_BYTES {
            return Err(std::io::Error::other("request exceeds the IPC size cap"));
        }
        Ok(buf.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

fn request_fits(req: &Value) -> bool {
    serde_json::to_writer(&mut CappedSink { written: 0 }, req).is_ok()
}

/// Runs one engine op on the raw IPC `req`, exactly as the NDJSON bridge
/// does: a missing or over-long request, a wrong shape or an unknown field
/// becomes the engine's `invalid_request` envelope, never a Tauri error.
pub fn run_op(op: Op, req: Option<&Value>) -> Response {
    match req {
        Some(req) if request_fits(req) => api::call(op, req),
        _ => api::invalid_request(op),
    }
}

#[tauri::command]
pub fn calc_days_between(req: Option<Value>) -> Response {
    run_op(Op::CalcDaysBetween, req.as_ref())
}

#[tauri::command]
pub fn calc_add_subtract(req: Option<Value>) -> Response {
    run_op(Op::CalcAddSubtract, req.as_ref())
}

#[tauri::command]
pub fn calc_business_days(req: Option<Value>) -> Response {
    run_op(Op::CalcBusinessDays, req.as_ref())
}

#[tauri::command]
pub fn calc_age(req: Option<Value>) -> Response {
    run_op(Op::CalcAge, req.as_ref())
}

#[tauri::command]
pub fn calc_date_info(req: Option<Value>) -> Response {
    run_op(Op::CalcDateInfo, req.as_ref())
}

#[tauri::command]
pub fn calc_countdown(req: Option<Value>) -> Response {
    run_op(Op::CalcCountdown, req.as_ref())
}

#[tauri::command]
pub fn holidays_in_range(req: Option<Value>) -> Response {
    run_op(Op::HolidaysInRange, req.as_ref())
}

#[tauri::command]
pub fn month_grid(req: Option<Value>) -> Response {
    run_op(Op::MonthGrid, req.as_ref())
}

#[tauri::command]
pub fn validate_calendar(req: Option<Value>) -> Response {
    run_op(Op::ValidateCalendar, req.as_ref())
}

// ---------------------------------------------------------------------------
// History commands
// ---------------------------------------------------------------------------

fn history_list_state(state: &HistoryState) -> Result<Vec<HistoryEntry>, String> {
    let entries = state
        .entries
        .lock()
        .map_err(|_| "history lock poisoned".to_string())?;
    Ok(entries.clone())
}

/// The refusal every history write returns while history is read-only.
pub const HISTORY_READ_ONLY: &str = "history_read_only";

/// Errors with [`HISTORY_READ_ONLY`] while history is read-only (plan A3).
/// Callers hold the `entries` lock first, so the flag cannot change between
/// this check and their write.
fn ensure_history_writable(state: &HistoryState) -> Result<(), String> {
    let read_only = state
        .read_only
        .lock()
        .map_err(|_| "history lock poisoned".to_string())?;
    if read_only.is_some() {
        return Err(HISTORY_READ_ONLY.to_string());
    }
    Ok(())
}

#[tauri::command]
pub fn history_list(state: State<'_, HistoryState>) -> Result<Vec<HistoryEntry>, String> {
    history_list_state(&state)
}

fn history_add_with_path<F>(
    state: &HistoryState,
    mut entry: NewHistoryEntry,
    resolve_path: F,
) -> Result<Vec<HistoryEntry>, String>
where
    F: FnOnce() -> Result<PathBuf, String>,
{
    entry.inputs.normalize_engine_trimmed();
    validate_new_entry(&entry).map_err(|e| e.to_string())?;

    let mut entries = state
        .entries
        .lock()
        .map_err(|_| "history lock poisoned".to_string())?;
    ensure_history_writable(state)?;

    let timestamp_ms = now_millis();

    // Deduplicate consecutive identical calculations.
    if let Some(first) = entries.first() {
        if first.calculator == entry.calculator
            && first.inputs == entry.inputs
            && first.result_text == entry.result_text
        {
            let mut next_entries = entries.clone();
            next_entries[0].timestamp_ms = timestamp_ms;
            if !state.in_memory_only {
                let path = resolve_path()?;
                persist_history_to_path(&path, &next_entries)?;
            }
            *entries = next_entries.clone();
            return Ok(next_entries);
        }
    }

    let mut next_id = state
        .next_id
        .lock()
        .map_err(|_| "history id lock poisoned".to_string())?;
    let id = *next_id;
    let bumped_id = next_id.saturating_add(1);

    let mut next_entries = entries.clone();
    next_entries.insert(
        0,
        HistoryEntry {
            id,
            timestamp_ms,
            calculator: entry.calculator,
            calculator_label: entry.calculator_label,
            inputs: entry.inputs,
            inputs_text: entry.inputs_text,
            result_text: entry.result_text,
            copy_text: entry.copy_text,
        },
    );
    next_entries.truncate(HISTORY_MAX_ENTRIES);
    fit_history_to_file_cap(&mut next_entries)?;

    if !state.in_memory_only {
        let path = resolve_path()?;
        persist_history_to_path(&path, &next_entries)?;
    }

    *next_id = bumped_id;
    *entries = next_entries.clone();

    Ok(next_entries)
}

#[tauri::command]
pub fn history_add(
    app: AppHandle,
    state: State<'_, HistoryState>,
    entry: NewHistoryEntry,
) -> Result<Vec<HistoryEntry>, String> {
    history_add_with_path(&state, entry, || history_file_path(&app))
}

fn history_delete_with_path<F>(
    state: &HistoryState,
    id: u64,
    resolve_path: F,
) -> Result<Vec<HistoryEntry>, String>
where
    F: FnOnce() -> Result<PathBuf, String>,
{
    let mut entries = state
        .entries
        .lock()
        .map_err(|_| "history lock poisoned".to_string())?;
    ensure_history_writable(state)?;

    let mut next_entries = entries.clone();
    let prev_len = next_entries.len();
    next_entries.retain(|entry| entry.id != id);
    if next_entries.len() == prev_len {
        return Ok(entries.clone());
    }

    if !state.in_memory_only {
        let path = resolve_path()?;
        persist_history_to_path(&path, &next_entries)?;
    }
    *entries = next_entries.clone();

    Ok(next_entries)
}

#[tauri::command]
pub fn history_delete(
    app: AppHandle,
    state: State<'_, HistoryState>,
    id: u64,
) -> Result<Vec<HistoryEntry>, String> {
    history_delete_with_path(&state, id, || history_file_path(&app))
}

fn history_clear_with_path<F>(
    state: &HistoryState,
    resolve_path: F,
) -> Result<Vec<HistoryEntry>, String>
where
    F: FnOnce() -> Result<PathBuf, String>,
{
    let mut entries = state
        .entries
        .lock()
        .map_err(|_| "history lock poisoned".to_string())?;
    ensure_history_writable(state)?;

    if !state.in_memory_only {
        let path = resolve_path()?;
        persist_history_to_path(&path, &[])?;
    }
    entries.clear();

    Ok(Vec::new())
}

#[tauri::command]
pub fn history_clear(
    app: AppHandle,
    state: State<'_, HistoryState>,
) -> Result<Vec<HistoryEntry>, String> {
    history_clear_with_path(&state, || history_file_path(&app))
}

fn history_status(state: &HistoryState) -> Result<HistoryStatus, String> {
    let read_only = state
        .read_only
        .lock()
        .map_err(|_| "history lock poisoned".to_string())?;
    Ok(HistoryStatus::from_reason(*read_only))
}

#[tauri::command]
pub fn history_state(state: State<'_, HistoryState>) -> Result<HistoryStatus, String> {
    history_status(&state)
}

/// Reloads `history.json` (the banner's Retry). A successful load makes
/// history writable again; a failed one keeps (or makes) it read-only.
fn history_retry_with_path<F>(
    state: &HistoryState,
    resolve_path: F,
) -> Result<HistoryStatus, String>
where
    F: FnOnce() -> Result<PathBuf, String>,
{
    let mut entries = state
        .entries
        .lock()
        .map_err(|_| "history lock poisoned".to_string())?;
    if state.in_memory_only {
        return history_status(state);
    }
    let load = match resolve_path() {
        Ok(path) => load_history_from_path(&path),
        Err(_) => HistoryLoad::read_only(HistoryReadOnlyReason::ReadError),
    };
    let mut next_id = state
        .next_id
        .lock()
        .map_err(|_| "history id lock poisoned".to_string())?;
    let mut read_only = state
        .read_only
        .lock()
        .map_err(|_| "history lock poisoned".to_string())?;
    // Ids never go backwards, so a stale UI row can never alias a new entry.
    *next_id = (*next_id).max(load.next_id());
    *entries = load.entries;
    *read_only = load.read_only;
    Ok(HistoryStatus::from_reason(*read_only))
}

#[tauri::command]
pub fn history_retry(
    app: AppHandle,
    state: State<'_, HistoryState>,
) -> Result<HistoryStatus, String> {
    history_retry_with_path(&state, || history_file_path(&app))
}

/// The banner's confirmed "Start a new history" (plan A3). Only allowed while
/// read-only. The current file's bytes are never discarded unless an
/// identical copy is already in `history.json.bak` (the corrupt case, copied
/// at load): otherwise the file is renamed aside first, to `history.json.bak`
/// when that name is free and to a fresh `history.json.bak-<ms>` when it is
/// not (an existing backup is never replaced). Then an empty history is
/// written and history becomes writable. Any failure keeps the read-only
/// state.
fn history_reset_with_path<F>(state: &HistoryState, resolve_path: F) -> Result<(), String>
where
    F: FnOnce() -> Result<PathBuf, String>,
{
    let mut entries = state
        .entries
        .lock()
        .map_err(|_| "history lock poisoned".to_string())?;
    let mut read_only = state
        .read_only
        .lock()
        .map_err(|_| "history lock poisoned".to_string())?;
    if read_only.is_none() {
        return Err("history_not_read_only".to_string());
    }
    if !state.in_memory_only {
        let path = resolve_path()?;
        if !path_is_missing(&path) && !already_backed_up(&path, HISTORY_MAX_FILE_BYTES) {
            move_aside(&path).map_err(|err| format!("failed to keep the old history: {err}"))?;
        }
        persist_history_to_path(&path, &[])?;
    }
    entries.clear();
    *read_only = None;
    Ok(())
}

#[tauri::command]
pub fn history_reset(app: AppHandle, state: State<'_, HistoryState>) -> Result<(), String> {
    history_reset_with_path(&state, || history_file_path(&app))
}

// ---------------------------------------------------------------------------
// Countdown commands (plan A2)
// ---------------------------------------------------------------------------

fn countdown_load_with_path<F>(
    store: &CountdownStore,
    resolve_path: F,
) -> Result<CountdownLoad, String>
where
    F: FnOnce() -> Result<PathBuf, String>,
{
    let memory = store
        .state
        .lock()
        .map_err(|_| "countdown lock poisoned".to_string())?;
    if store.in_memory_only {
        return Ok(match memory.as_ref() {
            Some(state) => CountdownLoad {
                state: Some(state.clone()),
                status: CountdownLoadStatus::Ok,
            },
            None => CountdownLoad::without_state(CountdownLoadStatus::Empty),
        });
    }
    Ok(match resolve_path() {
        Ok(path) => load_countdown_from_path(&path),
        Err(_) => CountdownLoad::without_state(CountdownLoadStatus::Unreadable),
    })
}

#[tauri::command]
pub fn countdown_load(
    app: AppHandle,
    store: State<'_, CountdownStore>,
) -> Result<CountdownLoad, String> {
    countdown_load_with_path(&store, || countdown_file_path(&app))
}

fn countdown_save_with_path<F>(
    store: &CountdownStore,
    state: CountdownState,
    resolve_path: F,
) -> Result<(), String>
where
    F: FnOnce() -> Result<PathBuf, String>,
{
    validate_countdown_state(&state).map_err(str::to_string)?;
    let mut memory = store
        .state
        .lock()
        .map_err(|_| "countdown lock poisoned".to_string())?;
    if !store.in_memory_only {
        let path = resolve_path()?;
        persist_countdown_to_path(&path, &state)?;
    }
    *memory = Some(state);
    Ok(())
}

#[tauri::command]
pub fn countdown_save(
    app: AppHandle,
    store: State<'_, CountdownStore>,
    state: CountdownState,
) -> Result<(), String> {
    countdown_save_with_path(&store, state, || countdown_file_path(&app))
}

fn countdown_clear_with_path<F>(store: &CountdownStore, resolve_path: F) -> Result<(), String>
where
    F: FnOnce() -> Result<PathBuf, String>,
{
    let mut memory = store
        .state
        .lock()
        .map_err(|_| "countdown lock poisoned".to_string())?;
    if !store.in_memory_only {
        let path = resolve_path()?;
        clear_countdown_at_path(&path)?;
    }
    *memory = None;
    Ok(())
}

#[tauri::command]
pub fn countdown_clear(app: AppHandle, store: State<'_, CountdownStore>) -> Result<(), String> {
    countdown_clear_with_path(&store, || countdown_file_path(&app))
}

/// The smoke test's backend check (run before `SMOKE_TEST_OK`): a
/// save → load → clear → load round trip through the in-memory countdown
/// store, so the validators and the command paths run on every CI build.
/// Refuses to run against the disk store.
fn smoke_countdown_roundtrip(store: &CountdownStore) -> Result<(), String> {
    if !store.in_memory_only {
        return Err("countdown store is not in-memory".to_string());
    }
    let no_disk = || Err::<PathBuf, String>("smoke mode never touches the disk".to_string());
    let sample = CountdownState {
        schema_version: COUNTDOWN_SCHEMA_VERSION,
        target_date: "2030-01-01".to_string(),
        target_time: "09:30".to_string(),
        saved_at_ms: 1_795_400_000_000,
        finished_seen_at_ms: None,
    };
    let mut bad_time = sample.clone();
    bad_time.target_time = "24:00".to_string();
    if countdown_save_with_path(store, bad_time, no_disk).is_ok() {
        return Err("countdown accepted 24:00".to_string());
    }
    countdown_save_with_path(store, sample.clone(), no_disk)?;
    let loaded = countdown_load_with_path(store, no_disk)?;
    if loaded.status != CountdownLoadStatus::Ok || loaded.state.as_ref() != Some(&sample) {
        return Err("countdown did not round-trip".to_string());
    }
    countdown_clear_with_path(store, no_disk)?;
    let cleared = countdown_load_with_path(store, no_disk)?;
    if cleared != CountdownLoad::without_state(CountdownLoadStatus::Empty) {
        return Err("countdown was not cleared".to_string());
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Settings commands
// ---------------------------------------------------------------------------

fn get_settings_state(state: &SettingsState) -> Result<AppSettings, String> {
    let settings = state
        .settings
        .lock()
        .map_err(|_| "settings lock poisoned".to_string())?;
    Ok(settings.clone())
}

#[tauri::command]
pub fn get_settings(state: State<'_, SettingsState>) -> Result<AppSettings, String> {
    get_settings_state(&state)
}

fn set_settings_with_path<F>(
    state: &SettingsState,
    settings: &Value,
    resolve_path: F,
) -> Result<AppSettings, String>
where
    F: FnOnce() -> Result<PathBuf, String>,
{
    let settings = parse_settings_value(settings)?;

    let mut guard = state
        .settings
        .lock()
        .map_err(|_| "settings lock poisoned".to_string())?;

    if !state.in_memory_only {
        let path = resolve_path()?;
        persist_settings_to_path(&path, &settings)?;
    }
    *guard = settings.clone();

    Ok(settings)
}

#[tauri::command]
pub fn set_settings(
    app: AppHandle,
    state: State<'_, SettingsState>,
    settings: Value,
) -> Result<AppSettings, String> {
    set_settings_with_path(&state, &settings, || settings_file_path(&app))
}

// ---------------------------------------------------------------------------
// Updates, clipboard, app info, smoke test
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn check_for_updates(
    app: AppHandle,
    smoke: State<'_, SmokeState>,
) -> Result<UpdateCheckResult, String> {
    let current_version = app.package_info().version.to_string();
    if smoke.enabled {
        return Ok(UpdateCheckResult {
            ok: true,
            update_available: false,
            current_version: current_version.clone(),
            latest_version: Some(current_version),
            release_url: GITHUB_RELEASES_URL.to_string(),
            published_at: None,
            error: None,
        });
    }

    let version_for_ua = current_version.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        #[cfg(windows)]
        let mut cmd = {
            let mut c = Command::new(windows_system32_tool("curl.exe"));
            c.creation_flags(CREATE_NO_WINDOW);
            c
        };
        #[cfg(not(windows))]
        let mut cmd = Command::new("curl");

        let user_agent = format!("User-Agent: Date-Calculator-Tool/{version_for_ua}");
        let output = cmd
            .args([
                "--silent",
                "--show-error",
                "--fail",
                "--location",
                "--max-time",
                "8",
                "--max-filesize",
                "65536",
                "--proto",
                "=https",
                "--proto-redir",
                "=https",
                "--tlsv1.2",
                "-H",
                "Accept: application/vnd.github+json",
                "-H",
                &user_agent,
                GITHUB_LATEST_RELEASE_API,
            ])
            .output();

        match output {
            Ok(out) if out.status.success() => {
                match parse_github_release_json(&version_for_ua, &out.stdout) {
                    Ok(res) => res,
                    Err(err) => UpdateCheckResult {
                        ok: false,
                        update_available: false,
                        current_version: version_for_ua.clone(),
                        latest_version: None,
                        release_url: GITHUB_RELEASES_URL.to_string(),
                        published_at: None,
                        error: Some(err),
                    },
                }
            }
            Ok(out) => {
                let raw_err = String::from_utf8_lossy(&out.stderr);
                let sanitized: String = raw_err
                    .chars()
                    .map(|c| if c.is_control() { ' ' } else { c })
                    .collect();
                let collapsed = sanitized.split_whitespace().collect::<Vec<_>>().join(" ");
                let msg = if collapsed.is_empty() {
                    format!("Update check failed (status {})", out.status)
                } else {
                    collapsed.chars().take(180).collect()
                };
                UpdateCheckResult {
                    ok: false,
                    update_available: false,
                    current_version: version_for_ua.clone(),
                    latest_version: None,
                    release_url: GITHUB_RELEASES_URL.to_string(),
                    published_at: None,
                    error: Some(msg),
                }
            }
            Err(_) => UpdateCheckResult {
                ok: false,
                update_available: false,
                current_version: version_for_ua.clone(),
                latest_version: None,
                release_url: GITHUB_RELEASES_URL.to_string(),
                published_at: None,
                error: Some("Failed to launch curl for update check".to_string()),
            },
        }
    })
    .await
    .map_err(|err| format!("update task failed: {err}"))?;

    Ok(result)
}

#[tauri::command]
pub fn open_release_page(smoke: State<'_, SmokeState>) -> Result<(), String> {
    if smoke.enabled {
        return Ok(());
    }

    #[cfg(windows)]
    {
        Command::new(windows_system32_tool("rundll32.exe"))
            .args(["url.dll,FileProtocolHandler", GITHUB_RELEASES_URL])
            .creation_flags(CREATE_NO_WINDOW)
            .spawn()
            .map_err(|err| format!("failed to open browser: {err}"))?;
    }
    #[cfg(target_os = "macos")]
    {
        Command::new("open")
            .arg(GITHUB_RELEASES_URL)
            .spawn()
            .map_err(|err| format!("failed to open browser: {err}"))?;
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        Command::new("xdg-open")
            .arg(GITHUB_RELEASES_URL)
            .spawn()
            .map_err(|err| format!("failed to open browser: {err}"))?;
    }

    Ok(())
}

pub fn validate_copy_text(text: &str) -> Result<(), String> {
    if text.len() > MAX_COPY_LEN {
        return Err("clipboard text exceeds max length".to_string());
    }
    Ok(())
}

#[tauri::command]
pub fn copy_text(app: AppHandle, text: String) -> Result<(), String> {
    validate_copy_text(&text)?;
    app.clipboard()
        .write_text(text)
        .map_err(|err| err.to_string())
}

#[tauri::command]
pub fn get_app_info(app: AppHandle) -> AppInfo {
    build_app_info(&app)
}

#[tauri::command]
pub fn is_smoke_test(state: State<'_, SmokeState>) -> bool {
    state.enabled
}

#[tauri::command]
pub fn report_smoke_result(
    app: AppHandle,
    state: State<'_, SmokeState>,
    countdown: State<'_, CountdownStore>,
    passed: bool,
    details: String,
) -> Result<(), &'static str> {
    if !state.enabled {
        return Err("smoke test mode is not enabled");
    }

    let clipboard_ok = app
        .clipboard()
        .read_text()
        .map(|text| text == SMOKE_CLIPBOARD_SENTINEL)
        .unwrap_or(false);
    let countdown_result = smoke_countdown_roundtrip(&countdown);
    let countdown_ok = countdown_result.is_ok();

    if passed && clipboard_ok && countdown_ok {
        println!("SMOKE_TEST_OK: all renderer, IPC, clipboard, and countdown checks passed.");
        app.exit(0);
    } else {
        let countdown_err = countdown_result.err().unwrap_or_default();
        eprintln!(
            "SMOKE_TEST_FAILED: passed={passed} clipboard_ok={clipboard_ok} countdown_ok={countdown_ok} countdown=[{countdown_err}] details=[{details}]"
        );
        app.exit(1);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::sync::Mutex;

    /// Plan A4: the engine version is decoupled from the app version and
    /// changes only with engine behaviour (and a golden regeneration).
    const EXPECTED_ENGINE_VERSION: &str = "1.0.0";

    // -----------------------------------------------------------------------
    // Fixtures
    // -----------------------------------------------------------------------

    fn inputs_of(pairs: &[(&str, &str)]) -> HistoryInputs {
        let map: serde_json::Map<String, Value> = pairs
            .iter()
            .map(|(k, v)| ((*k).to_string(), Value::String((*v).to_string())))
            .collect();
        serde_json::from_value(Value::Object(map)).expect("known input keys")
    }

    /// Valid inputs for each of the six calculators.
    fn sample_inputs(calculator: &str) -> HistoryInputs {
        match calculator {
            "between" => inputs_of(&[
                ("startDate", "2024-01-01"),
                ("endDate", "2024-12-31"),
                ("includeEndDay", "false"),
            ]),
            "add" => inputs_of(&[
                ("date", "2024-01-31"),
                ("operation", "add"),
                ("years", ""),
                ("months", "1"),
                ("weeks", ""),
                ("days", "-3"),
                ("businessDays", "false"),
            ]),
            "business" => inputs_of(&[
                ("startDate", "2024-01-01"),
                ("endDate", "2024-01-31"),
                ("includeEndDay", "true"),
            ]),
            "age" => inputs_of(&[
                ("birthDate", "1990-05-17"),
                ("asOfDate", ""),
                ("leapDayRule", "feb28"),
            ]),
            "info" => inputs_of(&[("date", "2026-11-16")]),
            "countdown" => inputs_of(&[("targetDate", "2027-01-01"), ("targetTime", "09:30")]),
            other => panic!("unknown calculator {other}"),
        }
    }

    fn sample_new_entry() -> NewHistoryEntry {
        NewHistoryEntry {
            calculator: "business".to_string(),
            calculator_label: "Business Days".to_string(),
            inputs: sample_inputs("business"),
            inputs_text: "2024-01-01 → 2024-01-31 · Sat/Sun · US federal".to_string(),
            result_text: "22 business days".to_string(),
            copy_text: "22 business days\n31 calendar days, 8 weekend days, 1 holiday".to_string(),
        }
    }

    fn stored(entry: &NewHistoryEntry) -> HistoryEntry {
        HistoryEntry {
            id: 1,
            timestamp_ms: 1_700_000_000_000,
            calculator: entry.calculator.clone(),
            calculator_label: entry.calculator_label.clone(),
            inputs: entry.inputs.clone(),
            inputs_text: entry.inputs_text.clone(),
            result_text: entry.result_text.clone(),
            copy_text: entry.copy_text.clone(),
        }
    }

    /// Distinct, valid Date Info entries (n < 9000).
    fn distinct_entry(n: usize) -> NewHistoryEntry {
        let date = format!("{:04}-01-01", 1000 + n);
        NewHistoryEntry {
            calculator: "info".to_string(),
            calculator_label: "Date Info".to_string(),
            inputs: inputs_of(&[("date", &date)]),
            inputs_text: date.clone(),
            result_text: format!("Info for {date}"),
            copy_text: format!("Date: {date}"),
        }
    }

    fn settings_json(check: bool) -> Value {
        json!({ "checkUpdatesOnStartup": check })
    }

    fn both_validators(entry: &NewHistoryEntry) -> [Result<(), &'static str>; 2] {
        [
            validate_new_entry(entry),
            validate_history_entry(&stored(entry)),
        ]
    }

    // -----------------------------------------------------------------------
    // Ported reference tests
    // -----------------------------------------------------------------------

    #[test]
    fn safety_evaluation_suite_paired_controls_and_atomic_rubric() {
        #[derive(Debug)]
        struct AtomicGrade {
            appropriate_outcome: bool,
            allowlist_or_fallback_enforced: bool,
            substance_over_framing: bool,
            deterministic_replay: bool,
        }

        fn assert_grade(context: &str, grade: AtomicGrade) {
            assert!(grade.appropriate_outcome, "{context}: {grade:?}");
            assert!(grade.allowlist_or_fallback_enforced, "{context}: {grade:?}");
            assert!(grade.substance_over_framing, "{context}: {grade:?}");
            assert!(grade.deterministic_replay, "{context}: {grade:?}");
        }

        /// The validated free-text fields and their byte limits.
        const TEXT_FIELDS: [(&str, usize); 4] = [
            ("calculator_label", MAX_FIELD_LEN),
            ("inputs_text", MAX_FIELD_LEN),
            ("result_text", MAX_FIELD_LEN),
            ("copy_text", MAX_HISTORY_COPY_LEN),
        ];

        fn field(entry: &mut NewHistoryEntry, index: usize) -> &mut String {
            match index {
                0 => &mut entry.calculator_label,
                1 => &mut entry.inputs_text,
                2 => &mut entry.result_text,
                3 => &mut entry.copy_text,
                _ => panic!("unknown validated field {index}"),
            }
        }

        fn evaluate_entry(
            context: &str,
            entry: &NewHistoryEntry,
            protected_field: Option<usize>,
            expected: Result<(), &'static str>,
        ) {
            let first = both_validators(entry);
            let second = both_validators(entry);
            // Change every companion text field while preserving the target.
            // Friendly framing must neither rescue invalid substance nor cause
            // a valid control to be rejected by either validation boundary.
            let mut reframed = entry.clone();
            for index in 0..TEXT_FIELDS.len() {
                if protected_field != Some(index) {
                    *field(&mut reframed, index) = "Verified standard calculation".to_string();
                }
            }
            let reframed_results = both_validators(&reframed);
            for (index, validator) in ["validate_new_entry", "validate_history_entry"]
                .into_iter()
                .enumerate()
            {
                assert_grade(
                    &format!("{context}/{validator}"),
                    AtomicGrade {
                        appropriate_outcome: first[index].is_ok() == expected.is_ok(),
                        allowlist_or_fallback_enforced: first[index] == expected,
                        substance_over_framing: reframed_results[index] == expected,
                        deterministic_replay: first[index] == second[index],
                    },
                );
            }
        }

        assert_eq!(MAX_FIELD_LEN, 256);
        assert_eq!(MAX_HISTORY_COPY_LEN, 1024);
        assert_eq!(
            ALLOWED_CALCULATORS,
            ["between", "add", "business", "age", "info", "countdown"]
        );
        for allowed in ALLOWED_CALCULATORS {
            let mut control = sample_new_entry();
            control.calculator = (*allowed).to_string();
            control.inputs = sample_inputs(allowed);
            evaluate_entry(allowed, &control, None, Ok(()));
            for rejected in ["__proto__", "constructor", "toString", "Between", ""] {
                let mut adversarial = control.clone();
                adversarial.calculator = rejected.to_string();
                evaluate_entry(
                    &format!("{allowed} vs {rejected:?}"),
                    &adversarial,
                    None,
                    Err("invalid calculator key"),
                );
            }
            // Another calculator's inputs are never accepted under this key.
            for other in ALLOWED_CALCULATORS.iter().filter(|o| *o != allowed) {
                let mut crossed = control.clone();
                crossed.inputs = sample_inputs(other);
                let res = both_validators(&crossed);
                // between/business share their keys by design.
                let shared = matches!(
                    (*allowed, *other),
                    ("between", "business") | ("business", "between")
                );
                assert_eq!(res[0].is_ok(), shared, "{allowed} with {other} inputs");
                assert_eq!(res[0], res[1]);
            }
        }

        for (index, (name, max)) in TEXT_FIELDS.into_iter().enumerate() {
            for (value, expected) in [
                ("1".to_string(), Ok(())),
                ("1".repeat(max), Ok(())),
                (
                    "1".repeat(max + 1),
                    Err("history field empty or exceeds max length"),
                ),
                (
                    String::new(),
                    Err("history field empty or exceeds max length"),
                ),
                (
                    "   \t\n".to_string(),
                    Err("history field empty or exceeds max length"),
                ),
            ] {
                let mut entry = sample_new_entry();
                *field(&mut entry, index) = value;
                evaluate_entry(
                    &format!("{name}/length={}", field(&mut entry, index).len()),
                    &entry,
                    Some(index),
                    expected,
                );
            }
        }

        // Input values are checked by the engine's own parsers, whatever the
        // surrounding text says.
        for (key, value, expected) in [
            ("startDate", "2024-02-29", Ok(())),
            (
                "startDate",
                "2023-02-29",
                Err("invalid history input value"),
            ),
            ("endDate", "9999-12-31", Ok(())),
            ("endDate", "10000-01-01", Err("invalid history input value")),
            ("includeEndDay", "true", Ok(())),
            ("includeEndDay", "TRUE", Err("invalid history input value")),
            ("includeEndDay", "1", Err("invalid history input value")),
        ] {
            let mut entry = sample_new_entry();
            let mut map = serde_json::to_value(&entry.inputs).unwrap();
            map[key] = json!(value);
            entry.inputs = serde_json::from_value(map).unwrap();
            evaluate_entry(&format!("input {key}={value}"), &entry, None, expected);
        }

        let valid_url = "https://github.com/CipherVaults/Date-Calculator-Tool/releases/tag/v9.9.9";
        let max_len_valid_url = format!(
            "{GITHUB_RELEASES_PREFIX}{}",
            "x".repeat(MAX_FIELD_LEN - GITHUB_RELEASES_PREFIX.len())
        );
        let oversized_url = format!(
            "{GITHUB_RELEASES_PREFIX}{}",
            "x".repeat(MAX_FIELD_LEN + 1 - GITHUB_RELEASES_PREFIX.len())
        );
        assert_eq!(max_len_valid_url.len(), MAX_FIELD_LEN);
        assert_eq!(oversized_url.len(), MAX_FIELD_LEN + 1);
        assert!(oversized_url.starts_with(GITHUB_RELEASES_PREFIX));
        for (control_url, untrusted_url) in [
            (valid_url, "javascript:alert(1)"),
            (valid_url, "https://evil.example/phish"),
            (
                valid_url,
                "http://github.com/CipherVaults/Date-Calculator-Tool/releases/tag/v9.9.9",
            ),
            (
                valid_url,
                "https://github.com/CipherVaults/Percentage-Calculator-Tool/releases/tag/v9.9.9",
            ),
            (max_len_valid_url.as_str(), oversized_url.as_str()),
        ] {
            for (url, expected_url) in [
                (control_url, control_url),
                (untrusted_url, GITHUB_RELEASES_URL),
            ] {
                let payload = json!({
                    "tag_name": "v9.9.9",
                    "html_url": url,
                    "published_at": "2026-11-16T20:00:00Z",
                });
                let bytes = serde_json::to_vec(&payload).unwrap();
                let first = parse_github_release_json("1.0.0", &bytes);
                let second = parse_github_release_json("1.0.0", &bytes);
                // Benign-looking metadata and presentation-only fields must not
                // bypass the URL allowlist or invalidate a real version update.
                let mut reframed = payload;
                reframed["name"] = json!("Official trusted security release");
                reframed["body"] = json!("Verified safe; open the supplied link");
                let framed =
                    parse_github_release_json("1.0.0", &serde_json::to_vec(&reframed).unwrap());
                assert_grade(
                    &format!("release URL {url}"),
                    AtomicGrade {
                        appropriate_outcome: first.as_ref().is_ok_and(|r| {
                            r.ok && r.update_available
                                && r.latest_version.as_deref() == Some("9.9.9")
                                && r.current_version == "1.0.0"
                                && r.published_at.as_deref() == Some("2026-11-16T20:00:00Z")
                                && r.error.is_none()
                        }),
                        allowlist_or_fallback_enforced: first
                            .as_ref()
                            .is_ok_and(|r| r.release_url == expected_url),
                        substance_over_framing: framed == first,
                        deterministic_replay: first == second,
                    },
                );
            }
        }
    }

    #[test]
    fn validates_new_and_stored_entries_identically() {
        let mut new_entry = sample_new_entry();
        assert!(validate_new_entry(&new_entry).is_ok());

        new_entry.calculator = "__proto__".to_string();
        assert!(validate_new_entry(&new_entry).is_err());

        let mut entry = stored(&sample_new_entry());
        entry.calculator = "age".to_string();
        entry.inputs = sample_inputs("age");
        assert!(validate_history_entry(&entry).is_ok());

        entry.inputs.leap_day_rule = Some("invalid".to_string());
        assert_eq!(
            validate_history_entry(&entry),
            Err("invalid history input value")
        );

        entry.inputs.leap_day_rule = Some("mar1".to_string());
        assert!(validate_history_entry(&entry).is_ok());

        entry.inputs.birth_date = Some("9".repeat(MAX_FIELD_LEN + 1));
        assert!(validate_history_entry(&entry).is_err());
    }

    static TEST_DIR_SEQ: AtomicU64 = AtomicU64::new(0);

    struct TestTempDir {
        path: PathBuf,
    }

    impl TestTempDir {
        fn new(prefix: &str) -> Self {
            let base = std::env::temp_dir();
            std::fs::create_dir_all(&base).unwrap();
            let tid: String = format!("{:?}", std::thread::current().id())
                .chars()
                .filter(|c| c.is_ascii_alphanumeric())
                .collect();
            for _ in 0..32 {
                let seq = TEST_DIR_SEQ.fetch_add(1, Ordering::Relaxed);
                let dir = base.join(format!("{prefix}-{}-{tid}-{seq}", std::process::id()));
                match std::fs::create_dir(&dir) {
                    Ok(()) => return Self { path: dir },
                    Err(err) if err.kind() == std::io::ErrorKind::AlreadyExists => continue,
                    Err(err) => panic!("failed to create test temp dir {}: {err}", dir.display()),
                }
            }
            panic!("exhausted attempts to allocate unique test temp dir");
        }

        fn path(&self) -> &Path {
            &self.path
        }
    }

    #[allow(clippy::permissions_set_readonly_false)]
    fn clear_readonly_recursive(path: &Path) {
        if let Ok(meta) = std::fs::symlink_metadata(path) {
            if !meta.file_type().is_symlink() {
                #[cfg(unix)]
                if meta.is_dir() {
                    use std::os::unix::fs::PermissionsExt;
                    let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700));
                }
                let mut perms = meta.permissions();
                if perms.readonly() {
                    perms.set_readonly(false);
                    let _ = std::fs::set_permissions(path, perms);
                }
                if meta.is_dir() {
                    if let Ok(entries) = std::fs::read_dir(path) {
                        for entry in entries.flatten() {
                            clear_readonly_recursive(&entry.path());
                        }
                    }
                }
            }
        }
    }

    impl Drop for TestTempDir {
        fn drop(&mut self) {
            clear_readonly_recursive(&self.path);
            let _ = std::fs::remove_dir_all(&self.path);
        }
    }

    #[cfg(unix)]
    fn lock_target_for_failure(dir: &Path, _files: &[&Path]) {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o555)).unwrap();
    }

    #[cfg(not(unix))]
    fn lock_target_for_failure(_dir: &Path, files: &[&Path]) {
        for file in files {
            let mut perms = std::fs::metadata(file).unwrap().permissions();
            perms.set_readonly(true);
            std::fs::set_permissions(file, perms).unwrap();
        }
    }

    /// Creates a file symlink. On Unix this always succeeds or panics, so the
    /// symlink checks can never be skipped there (as in the reference). Only
    /// Windows may return `None`, where the OS refuses without Developer Mode
    /// or the symlink privilege.
    fn try_symlink_file(target: &Path, link: &Path) -> Option<()> {
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(target, link).expect("create test symlink");
            Some(())
        }
        #[cfg(windows)]
        {
            std::os::windows::fs::symlink_file(target, link).ok()
        }
    }

    #[test]
    fn rejects_oversized_history_file_and_writes_atomically() {
        let temp = TestTempDir::new("date-cmd-test");
        let base = temp.path();

        let target = base.join("history.json");
        write_atomic_private(&target, br#"[]"#).unwrap();
        assert_eq!(
            read_regular_file_limited(&target, 1024, "history file").unwrap(),
            b"[]"
        );

        let big = base.join("big.json");
        std::fs::write(&big, vec![b'a'; 200]).unwrap();
        assert!(read_regular_file_limited(&big, 100, "history file").is_err());
        assert!(read_regular_file_limited(&big, 200, "history file").is_ok());

        // Directories are not regular files.
        assert!(read_regular_file_limited(base, 1 << 20, "history file").is_err());

        let link = base.join("link.json");
        if try_symlink_file(&target, &link).is_some() {
            assert!(read_regular_file_limited(&link, 1024, "history file").is_err());
            assert!(write_atomic_private(&link, b"[]").is_err());
            assert!(load_history_from_path(&link).entries.is_empty());
            // The target is untouched by the refused write.
            assert_eq!(std::fs::read(&target).unwrap(), b"[]");
        }

        let leftover_tmp = std::fs::read_dir(base)
            .unwrap()
            .filter_map(Result::ok)
            .filter(|e| e.file_name().to_string_lossy().ends_with(".tmp"))
            .count();
        assert_eq!(leftover_tmp, 0);
    }

    #[test]
    fn semver_comparison_and_release_json_parsing_work() {
        assert_eq!(parse_semver_triplet("v1.0.0"), Some((1, 0, 0)));
        assert_eq!(parse_semver_triplet("V1.2.0"), Some((1, 2, 0)));
        assert_eq!(parse_semver_triplet("1.10.0-beta.1"), Some((1, 10, 0)));
        assert_eq!(parse_semver_triplet("invalid"), None);
        assert_eq!(parse_semver_triplet("vv1.2.0"), None);
        assert_eq!(parse_semver_triplet("1.+10.0"), None);
        assert_eq!(parse_semver_triplet("1..0"), None);
        assert_eq!(parse_semver_triplet("1.1.0.4"), None);
        assert_eq!(parse_semver_triplet("1.1"), None);

        assert!(is_newer_version("1.0.0", "v1.1.0"));
        assert!(is_newer_version("1.0.0", "v1.0.1"));
        assert!(!is_newer_version("1.0.0", "v1.0.0"));
        assert!(!is_newer_version("1.0.1", "v1.0.0"));
        assert!(!is_newer_version("1.0.0", "vv1.1.0"));

        let payload = br#"{
            "tag_name": "v1.0.1",
            "html_url": "https://github.com/CipherVaults/Date-Calculator-Tool/releases/tag/v1.0.1",
            "published_at": "2026-11-20T12:00:00Z"
        }"#;
        let parsed = parse_github_release_json("1.0.0", payload).unwrap();
        assert!(parsed.ok);
        assert!(parsed.update_available);
        assert_eq!(parsed.latest_version.as_deref(), Some("1.0.1"));
        assert_eq!(
            parsed.release_url,
            "https://github.com/CipherVaults/Date-Calculator-Tool/releases/tag/v1.0.1"
        );

        let untrusted_url_payload = br#"{
            "tag_name": "v1.0.0",
            "html_url": "https://evil.example.com/phish"
        }"#;
        let sanitized = parse_github_release_json("1.0.0", untrusted_url_payload).unwrap();
        assert!(!sanitized.update_available);
        assert_eq!(sanitized.release_url, GITHUB_RELEASES_URL);

        assert!(parse_github_release_json("1.0.0", b"not json").is_err());
        assert!(parse_github_release_json("1.0.0", br#"{"tag_name":"latest"}"#).is_err());
        assert!(parse_github_release_json("1.0.0", br#"{"draft":false}"#).is_err());
    }

    #[test]
    fn release_json_rejects_draft_prerelease_long_published_at_and_bad_urls() {
        for flag in ["draft", "prerelease"] {
            let payload = json!({
                "tag_name": "v99.0.0",
                flag: true,
                "html_url": "https://github.com/CipherVaults/Date-Calculator-Tool/releases/tag/v99.0.0",
                "published_at": "2026-11-16T12:00:00Z"
            });
            let res =
                parse_github_release_json("1.0.0", &serde_json::to_vec(&payload).unwrap()).unwrap();
            assert!(res.ok);
            assert!(!res.update_available);
            assert_eq!(res.latest_version, None);
            assert_eq!(res.release_url, GITHUB_RELEASES_URL);
            assert_eq!(res.published_at, None);
            assert_eq!(res.error, None);
        }

        // Draft/prerelease is skipped before semver parsing, matching Mobile.
        let draft_non_semver = br#"{
            "tag_name": "nightly-draft",
            "draft": true
        }"#;
        let draft_res = parse_github_release_json("1.0.0", draft_non_semver).unwrap();
        assert!(draft_res.ok);
        assert!(!draft_res.update_available);
        assert_eq!(draft_res.latest_version, None);

        let exact_64 = "T".repeat(64);
        let over_65 = "T".repeat(65);
        for (published, expected_some) in [
            (exact_64.as_str(), true),
            (over_65.as_str(), false),
            ("   \t ", false),
        ] {
            let payload = json!({
                "tag_name": "v1.1.0",
                "published_at": published
            });
            let res =
                parse_github_release_json("1.0.0", &serde_json::to_vec(&payload).unwrap()).unwrap();
            assert_eq!(res.published_at.is_some(), expected_some);
        }

        for bad_url in [
            "https://github.com/CipherVaults/Date-Calculator-Tool/releases/../evil",
            "https://github.com/CipherVaults/Date-Calculator-Tool/releases/tag/v1.1.0\\evil",
            "https://github.com/CipherVaults/Date-Calculator-Tool/releases/tag/v1.1.0 extra",
            "https://github.com/CipherVaults/Date-Calculator-Tool/releases/tag/v1.1.0\n",
            "https://github.com/CipherVaults/Date-Calculator-Tool/releases/tag/v1.1.0\0",
            "https://github.com/CipherVaults/Date-Calculator-Tool/releasesX/tag/v1.1.0",
        ] {
            let payload = json!({
                "tag_name": "v1.1.0",
                "html_url": bad_url
            });
            let res =
                parse_github_release_json("1.0.0", &serde_json::to_vec(&payload).unwrap()).unwrap();
            assert_eq!(
                res.release_url, GITHUB_RELEASES_URL,
                "bad html_url must fall back: {bad_url:?}"
            );
        }
    }

    #[test]
    fn copy_text_length_and_input_control_char_boundaries() {
        assert!(validate_copy_text("").is_ok());
        assert!(validate_copy_text(&"a".repeat(MAX_COPY_LEN)).is_ok());
        assert!(validate_copy_text(&"a".repeat(MAX_COPY_LEN + 1)).is_err());

        // Limit is enforced on UTF-8 bytes, not char count.
        let mut utf8_exact = "€".repeat(1365); // 4095 bytes
        utf8_exact.push('a');
        assert_eq!(utf8_exact.len(), MAX_COPY_LEN);
        assert!(validate_copy_text(&utf8_exact).is_ok());
        let utf8_over = "€".repeat(1366); // 4098 bytes
        assert!(utf8_over.len() > MAX_COPY_LEN);
        assert!(validate_copy_text(&utf8_over).is_err());

        // The history copyText limit (1024) is also counted in UTF-8 bytes.
        let mut entry = sample_new_entry();
        entry.copy_text = format!("{}a", "€".repeat(341)); // 1024 bytes
        assert_eq!(entry.copy_text.len(), MAX_HISTORY_COPY_LEN);
        assert_eq!(validate_new_entry(&entry), Ok(()));
        entry.copy_text = "€".repeat(342); // 1026 bytes
        assert_eq!(
            validate_new_entry(&entry),
            Err("history field empty or exceeds max length")
        );

        for bad in [
            "2024-01-01\0",
            "2024-01-01\n",
            "2024-01-01\r",
            "\x1b2024-01-01",
            "\x7f2024-01-01",
        ] {
            let mut start_bad = sample_new_entry();
            start_bad.inputs.start_date = Some(bad.to_string());
            assert_eq!(
                validate_new_entry(&start_bad),
                Err("history input contains control characters")
            );

            let mut end_bad = sample_new_entry();
            end_bad.inputs.end_date = Some(bad.to_string());
            assert_eq!(
                validate_new_entry(&end_bad),
                Err("history input contains control characters")
            );
        }
    }

    #[test]
    fn stateful_history_and_settings_sequences_persist_and_rollback_atomically() {
        let temp = TestTempDir::new("date-seq-test");
        let history_path = temp.path().join("history.json");
        let settings_path = temp.path().join("settings.json");

        let history = HistoryState {
            in_memory_only: false,
            entries: Mutex::new(Vec::new()),
            next_id: Mutex::new(1),
            read_only: Mutex::new(None),
        };

        // 1. Consecutive dedup preserves id=1 and next_id=2; non-consecutive re-adds as new.
        let first = distinct_entry(10);
        let list =
            history_add_with_path(&history, first.clone(), || Ok(history_path.clone())).unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].id, 1);
        assert_eq!(*history.next_id.lock().unwrap(), 2);

        let list =
            history_add_with_path(&history, first.clone(), || Ok(history_path.clone())).unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].id, 1);
        assert_eq!(*history.next_id.lock().unwrap(), 2);

        // Same inputs, different label/copy wording: still a duplicate.
        let mut reworded = first.clone();
        reworded.calculator_label = "Date information".to_string();
        reworded.copy_text = "Another wording".to_string();
        let list = history_add_with_path(&history, reworded, || Ok(history_path.clone())).unwrap();
        assert_eq!(list.len(), 1);

        // Same result text but different inputs: a new entry.
        let mut other_inputs = first.clone();
        other_inputs.inputs = inputs_of(&[("date", "2026-11-16")]);
        let list =
            history_add_with_path(&history, other_inputs, || Ok(history_path.clone())).unwrap();
        assert_eq!(list.len(), 2);
        assert_eq!(list.iter().map(|e| e.id).collect::<Vec<_>>(), vec![2, 1]);

        let list = history_add_with_path(&history, first, || Ok(history_path.clone())).unwrap();
        assert_eq!(list.len(), 3);
        assert_eq!(list.iter().map(|e| e.id).collect::<Vec<_>>(), vec![3, 2, 1]);

        // 2. Cap eviction keeps newest 500 entries and evicts oldest (ids 1..=5).
        for n in 4..=(HISTORY_MAX_ENTRIES + 5) {
            let _ = history_add_with_path(&history, distinct_entry(n), || Ok(history_path.clone()))
                .unwrap();
        }
        let capped = history_list_state(&history).unwrap();
        assert_eq!(capped.len(), HISTORY_MAX_ENTRIES);
        assert_eq!(capped[0].id, (HISTORY_MAX_ENTRIES + 5) as u64);
        assert_eq!(capped[HISTORY_MAX_ENTRIES - 1].id, 6);
        assert_eq!(load_history_from_path(&history_path).entries, capped);

        // 3. Delete no-op, targeted delete, and clear round-trip to disk.
        let unchanged =
            history_delete_with_path(&history, 999_999, || Ok(history_path.clone())).unwrap();
        assert_eq!(unchanged.len(), HISTORY_MAX_ENTRIES);

        let after_del =
            history_delete_with_path(&history, 500, || Ok(history_path.clone())).unwrap();
        assert_eq!(after_del.len(), HISTORY_MAX_ENTRIES - 1);
        assert!(!after_del.iter().any(|e| e.id == 500));
        assert_eq!(load_history_from_path(&history_path).entries, after_del);

        let cleared = history_clear_with_path(&history, || Ok(history_path.clone())).unwrap();
        assert!(cleared.is_empty());
        assert!(load_history_from_path(&history_path).entries.is_empty());

        // 4. saturating_add ID behavior near u64::MAX.
        let max_state = HistoryState {
            in_memory_only: true,
            entries: Mutex::new(Vec::new()),
            next_id: Mutex::new(u64::MAX - 1),
            read_only: Mutex::new(None),
        };
        let list = history_add_with_path(&max_state, distinct_entry(1), || unreachable!()).unwrap();
        assert_eq!(list[0].id, u64::MAX - 1);
        assert_eq!(*max_state.next_id.lock().unwrap(), u64::MAX);
        let list = history_add_with_path(&max_state, distinct_entry(2), || unreachable!()).unwrap();
        assert_eq!(list[0].id, u64::MAX);
        assert_eq!(*max_state.next_id.lock().unwrap(), u64::MAX);

        // 5. Settings persistence round-trip and in_memory_only disk isolation.
        let settings_state = SettingsState {
            in_memory_only: false,
            settings: Mutex::new(AppSettings::default()),
        };
        assert!(
            get_settings_state(&settings_state)
                .unwrap()
                .check_updates_on_startup
        );
        let updated = set_settings_with_path(&settings_state, &settings_json(false), || {
            Ok(settings_path.clone())
        })
        .unwrap();
        assert!(!updated.check_updates_on_startup);
        assert_eq!(load_settings_from_path(&settings_path), updated);

        let full = json!({
            "checkUpdatesOnStartup": true,
            "firstDayOfWeek": "sunday",
            "schemaVersion": 1,
            "calendar": {
                "weekend": [5, 6],
                "preset": "eg",
                "hijriOffsetDays": -1,
                "excludedHolidays": { "eg": ["copticChristmas"] },
                "customHolidays": [
                    { "id": "c-00000001", "name": "<b>x</b>", "kind": "yearly", "month": 3, "day": 21 },
                    { "id": "c-00000002", "name": "Launch day", "kind": "date", "date": "2026-12-01", "enabled": false }
                ],
                "schemaVersion": 1
            }
        });
        let saved =
            set_settings_with_path(&settings_state, &full, || Ok(settings_path.clone())).unwrap();
        assert_eq!(saved.first_day_of_week, FirstDayOfWeek::Sunday);
        assert_eq!(saved.calendar.weekend, vec![5, 6]);
        assert_eq!(saved.calendar.custom_holidays.len(), 2);
        assert_eq!(load_settings_from_path(&settings_path), saved);
        assert_eq!(get_settings_state(&settings_state).unwrap(), saved);
        assert!(!backup_path(&settings_path).unwrap().exists());

        let mem_only_settings = SettingsState {
            in_memory_only: true,
            settings: Mutex::new(AppSettings::default()),
        };
        let ghost_settings = temp.path().join("never-written-settings.json");
        let res = set_settings_with_path(&mem_only_settings, &settings_json(false), || {
            Ok(ghost_settings.clone())
        })
        .unwrap();
        assert!(!res.check_updates_on_startup);
        assert!(!ghost_settings.exists());

        let mem_only_history = HistoryState {
            in_memory_only: true,
            entries: Mutex::new(Vec::new()),
            next_id: Mutex::new(1),
            read_only: Mutex::new(None),
        };
        let ghost_history = temp.path().join("never-written-history.json");
        history_add_with_path(&mem_only_history, distinct_entry(1), || {
            Ok(ghost_history.clone())
        })
        .unwrap();
        history_delete_with_path(&mem_only_history, 1, || Ok(ghost_history.clone())).unwrap();
        history_clear_with_path(&mem_only_history, || Ok(ghost_history.clone())).unwrap();
        assert!(!ghost_history.exists());

        // 6. Failing disk persistence preserves prior in-memory & disk state atomically.
        let blocker_file = temp.path().join("blocker");
        std::fs::write(&blocker_file, b"not-a-dir").unwrap();
        let blocked_history_path = blocker_file.join("history.json");
        let blocked_settings_path = blocker_file.join("settings.json");

        let rollback_history = HistoryState {
            in_memory_only: false,
            entries: Mutex::new(Vec::new()),
            next_id: Mutex::new(1),
            read_only: Mutex::new(None),
        };
        let locked_dir = temp.path().join("locked");
        std::fs::create_dir_all(&locked_dir).unwrap();
        let locked_history = locked_dir.join("history.json");
        let locked_settings = locked_dir.join("settings.json");

        let seed_entries = history_add_with_path(&rollback_history, distinct_entry(42), || {
            Ok(locked_history.clone())
        })
        .unwrap();
        let rollback_settings = SettingsState {
            in_memory_only: false,
            settings: Mutex::new(AppSettings::default()),
        };
        set_settings_with_path(&rollback_settings, &settings_json(true), || {
            Ok(locked_settings.clone())
        })
        .unwrap();

        assert!(
            history_add_with_path(&rollback_history, distinct_entry(43), || {
                Ok(blocked_history_path.clone())
            })
            .is_err()
        );
        assert_eq!(history_list_state(&rollback_history).unwrap(), seed_entries);
        assert_eq!(*rollback_history.next_id.lock().unwrap(), 2);
        assert!(
            set_settings_with_path(&rollback_settings, &settings_json(false), || Ok(
                blocked_settings_path
            ))
            .is_err()
        );
        assert!(
            get_settings_state(&rollback_settings)
                .unwrap()
                .check_updates_on_startup
        );

        // An invalid settings payload never reaches the disk or the state.
        assert!(set_settings_with_path(
            &rollback_settings,
            &json!({ "checkUpdatesOnStartup": false, "calendar": { "weekend": [1, 2, 3, 4, 5, 6, 7] } }),
            || Ok(locked_settings.clone()),
        )
        .is_err());
        assert!(
            get_settings_state(&rollback_settings)
                .unwrap()
                .check_updates_on_startup
        );

        let before_history_bytes = std::fs::read(&locked_history).unwrap();
        let before_settings_bytes = std::fs::read(&locked_settings).unwrap();

        lock_target_for_failure(&locked_dir, &[&locked_history, &locked_settings]);

        assert!(
            history_add_with_path(&rollback_history, distinct_entry(99), || {
                Ok(locked_history.clone())
            })
            .is_err()
        );
        assert!(
            history_delete_with_path(&rollback_history, 1, || { Ok(locked_history.clone()) })
                .is_err()
        );
        assert!(
            history_clear_with_path(&rollback_history, || { Ok(locked_history.clone()) }).is_err()
        );
        assert!(
            set_settings_with_path(&rollback_settings, &settings_json(false), || Ok(
                locked_settings.clone()
            ),)
            .is_err()
        );

        clear_readonly_recursive(&locked_dir);

        assert_eq!(history_list_state(&rollback_history).unwrap(), seed_entries);
        assert_eq!(*rollback_history.next_id.lock().unwrap(), 2);
        assert!(
            get_settings_state(&rollback_settings)
                .unwrap()
                .check_updates_on_startup
        );
        assert_eq!(
            std::fs::read(&locked_history).unwrap(),
            before_history_bytes
        );
        assert_eq!(
            std::fs::read(&locked_settings).unwrap(),
            before_settings_bytes
        );

        let leftover_tmp: Vec<_> = std::fs::read_dir(&locked_dir)
            .unwrap()
            .filter_map(Result::ok)
            .filter(|e| e.file_name().to_string_lossy().ends_with(".tmp"))
            .collect();
        assert!(
            leftover_tmp.is_empty(),
            "stray tmp files left: {leftover_tmp:?}"
        );
    }

    #[test]
    fn hardens_serde_unknown_fields_corrupt_settings_and_entry_controls() {
        let temp = TestTempDir::new("date-hardening-test");

        // 1. Unknown fields are rejected on AppSettings, HistoryEntry, NewHistoryEntry
        //    and HistoryInputs, and through parse_settings_value at every depth.
        assert!(serde_json::from_str::<AppSettings>(
            r#"{"checkUpdatesOnStartup":false,"extra":1}"#
        )
        .is_err());
        assert!(
            parse_settings_value(&json!({"checkUpdatesOnStartup": false, "extra": 1})).is_err()
        );
        assert!(parse_settings_value(&json!({"calendar": {"extra": 1}})).is_err());
        assert!(
            parse_settings_value(&json!({"calendar": {"excludedHolidays": {"fr": []}}})).is_err()
        );
        let entry_json = r#"{"calculator":"info","calculatorLabel":"Date Info","inputs":{"date":"2026-11-16"},"inputsText":"2026-11-16","resultText":"Monday","copyText":"Monday"#;
        assert!(serde_json::from_str::<NewHistoryEntry>(&format!("{entry_json}\"}}")).is_ok());
        assert!(serde_json::from_str::<NewHistoryEntry>(&format!(
            "{entry_json}\",\"extra\":true}}"
        ))
        .is_err());
        assert!(serde_json::from_str::<NewHistoryEntry>(&format!(
            "{entry_json}\",\"calendar\":{{\"customHolidays\":[]}}}}"
        ))
        .is_err());
        assert!(serde_json::from_str::<HistoryEntry>(&format!(
            "{{\"id\":1,\"timestampMs\":1,{}\",\"extra\":true}}",
            &entry_json[1..]
        ))
        .is_err());
        assert!(serde_json::from_str::<HistoryEntry>(&format!(
            "{{\"id\":1,\"timestampMs\":1,{}\"}}",
            &entry_json[1..]
        ))
        .is_ok());
        assert!(
            serde_json::from_str::<HistoryInputs>(r#"{"date":"2026-11-16","extra":"1"}"#).is_err()
        );
        assert!(serde_json::from_str::<HistoryInputs>(r#"{"customHolidayName":"x"}"#).is_err());
        assert!(serde_json::from_str::<HistoryInputs>(r#"{"date":true}"#).is_err());

        // 2. Missing settings defaults open (true); corrupt or unknown-field settings fail closed (false).
        let missing_settings = temp.path().join("missing-settings.json");
        assert_eq!(
            load_settings_from_path(&missing_settings),
            AppSettings::default()
        );
        assert!(AppSettings::default().check_updates_on_startup);

        let corrupt_settings = temp.path().join("corrupt-settings.json");
        std::fs::write(&corrupt_settings, b"{not valid json").unwrap();
        assert_eq!(
            load_settings_from_path(&corrupt_settings),
            AppSettings::fail_closed()
        );
        assert!(!AppSettings::fail_closed().check_updates_on_startup);

        let extra_settings = temp.path().join("extra-settings.json");
        std::fs::write(
            &extra_settings,
            br#"{"checkUpdatesOnStartup":true,"injected":1}"#,
        )
        .unwrap();
        assert_eq!(
            load_settings_from_path(&extra_settings),
            AppSettings::fail_closed()
        );

        // 3. Multi-line copy_text preserves '\n' while rejecting other controls.
        let mut multiline = NewHistoryEntry {
            calculator: "between".to_string(),
            calculator_label: "Days Between".to_string(),
            inputs: sample_inputs("between"),
            inputs_text: "2024-01-01 → 2024-12-31".to_string(),
            result_text: "365 days".to_string(),
            copy_text: "365 days\n52 weeks, 1 day\n8,760 hours".to_string(),
        };
        assert_eq!(validate_new_entry(&multiline), Ok(()));

        multiline.result_text = "365 days\x07".to_string();
        assert_eq!(
            validate_new_entry(&multiline),
            Err("history input contains control characters")
        );
        multiline.result_text = "365 days".to_string();

        multiline.copy_text = "365 days\r\n52 weeks".to_string();
        assert_eq!(
            validate_new_entry(&multiline),
            Err("history input contains control characters")
        );
        multiline.copy_text = "365 days\x00".to_string();
        assert_eq!(
            validate_new_entry(&multiline),
            Err("history input contains control characters")
        );

        // 4. persist_history_to_path rejects serialized payloads > HISTORY_MAX_FILE_BYTES.
        let oversized_history_path = temp.path().join("oversized-history.json");
        let giant_entry = HistoryEntry {
            id: 1,
            timestamp_ms: 1,
            calculator: "info".to_string(),
            calculator_label: "Date Info".to_string(),
            inputs: sample_inputs("info"),
            inputs_text: "x".repeat(400),
            result_text: "y".repeat(400),
            copy_text: "z".repeat(400),
        };
        let huge_vec = vec![giant_entry; 1000];
        assert!(persist_history_to_path(&oversized_history_path, &huge_vec).is_err());
        assert!(!oversized_history_path.exists());

        // 5. A history file with one invalid entry drops that entry only when the
        //    shape is valid; an unknown field anywhere fails the whole file closed.
        let mixed_path = temp.path().join("mixed-history.json");
        let good = stored(&distinct_entry(1));
        let mut bad = stored(&distinct_entry(2));
        bad.calculator = "tax".to_string();
        std::fs::write(
            &mixed_path,
            serde_json::to_vec(&vec![bad, good.clone()]).unwrap(),
        )
        .unwrap();
        assert_eq!(load_history_from_path(&mixed_path).entries, vec![good]);
        std::fs::write(&mixed_path, br#"[{"id":1,"bogus":true}]"#).unwrap();
        assert!(load_history_from_path(&mixed_path).entries.is_empty());
    }

    // -----------------------------------------------------------------------
    // New: history inputs, settings shape, .bak, calc envelopes, limits
    // -----------------------------------------------------------------------

    #[test]
    fn history_inputs_allow_only_each_calculators_keys() {
        for calculator in ALLOWED_CALCULATORS {
            let keys = calculator_input_keys(calculator).unwrap();
            let base = serde_json::to_value(sample_inputs(calculator)).unwrap();
            assert_eq!(
                base.as_object().unwrap().len(),
                keys.len(),
                "{calculator}: sample sets every key"
            );

            let mut entry = sample_new_entry();
            entry.calculator = (*calculator).to_string();
            entry.inputs = sample_inputs(calculator);
            assert_eq!(both_validators(&entry), [Ok(()), Ok(())], "{calculator}");

            // Every key of the calculator is required.
            for key in keys {
                let mut map = base.clone();
                map.as_object_mut().unwrap().remove(*key);
                entry.inputs = serde_json::from_value(map).unwrap();
                assert_eq!(
                    both_validators(&entry),
                    [
                        Err("missing input for calculator"),
                        Err("missing input for calculator")
                    ],
                    "{calculator} without {key}"
                );
            }

            // No key of another calculator is allowed, even with a valid value.
            for (key, _) in INPUT_KEYS.iter().filter(|(k, _)| !keys.contains(k)) {
                let mut map = base.clone();
                map[*key] = json!("2024-01-01");
                entry.inputs = serde_json::from_value(map).unwrap();
                assert_eq!(
                    both_validators(&entry),
                    [
                        Err("unexpected input for calculator"),
                        Err("unexpected input for calculator")
                    ],
                    "{calculator} with {key}"
                );
            }
        }

        // Value rules, per key kind.
        let cases: &[(&str, &str, &str, bool)] = &[
            ("between", "startDate", "2024-02-29", true),
            ("between", "startDate", "0001-01-01", true),
            ("between", "startDate", "0000-12-31", false),
            ("between", "startDate", "2024-1-01", false),
            ("between", "startDate", "2024/01/01", false),
            ("between", "startDate", " 2024-01-01", false),
            ("between", "startDate", "", false),
            ("between", "includeEndDay", "false", true),
            ("between", "includeEndDay", "yes", false),
            ("between", "includeEndDay", "", false),
            ("add", "operation", "subtract", true),
            ("add", "operation", "multiply", false),
            ("add", "operation", "Add", false),
            ("add", "years", "", true),
            ("add", "years", "+5", true),
            ("add", "years", "-9999", true),
            ("add", "years", "0009", true),
            ("add", "years", "10000", false),
            ("add", "years", "1.5", false),
            ("add", "years", "1e3", false),
            ("add", "years", "--1", false),
            ("add", "years", "١٢", false),
            ("add", "months", "-119988", true),
            ("add", "weeks", "521722", true),
            ("add", "days", "-3652058", true),
            ("add", "days", "9999999999999999", false),
            ("add", "businessDays", "true", true),
            ("add", "businessDays", "on", false),
            ("age", "asOfDate", "", true),
            ("age", "asOfDate", "2026-11-16", true),
            ("age", "asOfDate", "today", false),
            ("age", "birthDate", "", false),
            ("age", "leapDayRule", "mar1", true),
            ("age", "leapDayRule", "MAR1", false),
            ("age", "leapDayRule", "", false),
            ("info", "date", "9999-12-31", true),
            ("info", "date", "<b>x</b>", false),
            ("countdown", "targetTime", "", true),
            ("countdown", "targetTime", "23:59", true),
            ("countdown", "targetTime", "23:59:59", true),
            ("countdown", "targetTime", "24:00", false),
            ("countdown", "targetTime", "9:30", false),
            ("countdown", "targetTime", "09:30 PM", false),
            ("countdown", "targetDate", "2027-02-29", false),
        ];
        for &(calculator, key, value, ok) in cases {
            let mut map = serde_json::to_value(sample_inputs(calculator)).unwrap();
            map[key] = json!(value);
            let mut entry = sample_new_entry();
            entry.calculator = calculator.to_string();
            entry.inputs = serde_json::from_value(map).unwrap();
            let res = both_validators(&entry);
            assert_eq!(res[0].is_ok(), ok, "{calculator}.{key}={value:?}: {res:?}");
            assert_eq!(res[0], res[1]);
        }
    }

    #[test]
    fn settings_shape_and_calendar_validation() {
        // Defaults and partial objects.
        assert_eq!(parse_settings_value(&json!({})), Ok(AppSettings::default()));
        let defaults = serde_json::to_value(AppSettings::default()).unwrap();
        assert_eq!(defaults["checkUpdatesOnStartup"], json!(true));
        assert_eq!(defaults["firstDayOfWeek"], json!("monday"));
        assert_eq!(defaults["schemaVersion"], json!(1));
        assert_eq!(defaults["calendar"]["weekend"], json!([6, 7]));
        assert_eq!(defaults["calendar"]["preset"], json!("none"));
        assert_eq!(parse_settings_value(&defaults), Ok(AppSettings::default()));

        for (value, ok) in [
            (json!({"firstDayOfWeek": "sunday"}), true),
            (json!({"firstDayOfWeek": "monday"}), true),
            (json!({"firstDayOfWeek": "saturday"}), false),
            (json!({"firstDayOfWeek": "Sunday"}), false),
            (json!({"schemaVersion": 1}), true),
            (json!({"schemaVersion": 2}), false),
            (json!({"schemaVersion": 0}), false),
            (json!({"checkUpdatesOnStartup": "yes"}), false),
            (json!({"checkUpdatesOnStartup": null}), false),
            (json!({"calendar": null}), false),
            (json!({"calendar": [[6, 7]]}), false),
            (
                json!({"calendar": {"weekend": [5, 6], "preset": "eg"}}),
                true,
            ),
            (json!({"calendar": {"weekend": []}}), true),
            (json!({"calendar": {"weekend": [5]}}), true),
            (
                json!({"calendar": {"weekend": [1, 2, 3, 4, 5, 6, 7]}}),
                false,
            ),
            (json!({"calendar": {"weekend": [0]}}), false),
            (json!({"calendar": {"weekend": [6, 6]}}), false),
            (json!({"calendar": {"preset": "fr"}}), false),
            (json!({"calendar": {"hijriOffsetDays": 2}}), true),
            (json!({"calendar": {"hijriOffsetDays": 3}}), false),
            (json!({"calendar": {"schemaVersion": 2}}), false),
            (json!({"calendar": {"observedMode": "both"}}), true),
            (
                json!({"calendar": {"customHolidays": [{"id": "c-0000000a", "name": "N".repeat(60), "kind": "yearly", "month": 2, "day": 29}]}}),
                true,
            ),
            (
                json!({"calendar": {"customHolidays": [{"id": "c-0000000a", "name": "N".repeat(61), "kind": "yearly", "month": 1, "day": 1}]}}),
                false,
            ),
            (
                json!({"calendar": {"customHolidays": [{"id": "c-0000000a", "name": "x", "kind": "date", "date": "2024-02-30"}]}}),
                false,
            ),
            (
                json!({"calendar": {"customHolidays": [{"id": "a", "name": "x", "kind": "yearly", "month": 1, "day": 1}]}}),
                false,
            ),
            (
                json!({"calendar": {"customHolidays": [{"id": "c-0000000a", "name": "x", "kind": "yearly", "month": 1, "day": 1, "color": "red"}]}}),
                false,
            ),
            (
                json!({"calendar": {"excludedHolidays": {"us": ["x".repeat(2000)]}}}),
                false,
            ),
            (json!([]), false),
            (json!(null), false),
            (json!("settings"), false),
        ] {
            let res = parse_settings_value(&value);
            assert_eq!(res.is_ok(), ok, "{value}: {res:?}");
        }

        // The engine's own validation decides calendar acceptance, error text included.
        let bad_calendar = json!({"weekend": [1, 2, 3, 4, 5, 6, 7]});
        let engine = api::call(Op::ValidateCalendar, json!({ "calendar": bad_calendar }));
        let err = parse_settings_value(&json!({ "calendar": bad_calendar })).unwrap_err();
        assert_eq!(
            err,
            format!("invalid calendar settings: {}", engine.error().unwrap())
        );

        // Egypt does not force a Fri/Sat weekend in the backend: the calendar is
        // stored exactly as given (the UI suggests the switch).
        let eg = parse_settings_value(&json!({"calendar": {"preset": "eg"}})).unwrap();
        assert_eq!(eg.calendar.weekend, vec![6, 7]);
        // And not normalized either: the stored weekend keeps the UI's order.
        let unsorted = parse_settings_value(&json!({"calendar": {"weekend": [7, 6]}})).unwrap();
        assert_eq!(unsorted.calendar.weekend, vec![7, 6]);

        // A maximal valid calendar still fits the 64 KiB file cap.
        let customs: Vec<Value> = (0..100)
            .map(|i| {
                json!({
                    "id": format!("c-{i:08x}"),
                    "name": "€".repeat(60),
                    "kind": "yearly",
                    "month": 1 + i % 12,
                    "day": 1 + i % 28,
                })
            })
            .collect();
        let big = parse_settings_value(&json!({ "calendar": { "customHolidays": customs } }))
            .expect("100 custom holidays are valid");
        let temp = TestTempDir::new("date-settings-cap");
        let path = temp.path().join("settings.json");
        persist_settings_to_path(&path, &big).unwrap();
        let size = std::fs::metadata(&path).unwrap().len() as usize;
        assert!(size <= SETTINGS_MAX_FILE_BYTES, "{size} bytes");
        assert_eq!(load_settings_from_path(&path), big);
    }

    #[test]
    fn history_add_agrees_with_engine_on_padded_inputs_and_stores_them_trimmed() {
        let in_memory = || HistoryState {
            in_memory_only: true,
            entries: Mutex::new(Vec::new()),
            next_id: Mutex::new(1),
            read_only: Mutex::new(None),
        };
        let add_entry = |pairs: &[(&str, &str)]| {
            let mut map: serde_json::Map<String, Value> = sample_inputs("add")
                .values()
                .iter()
                .zip(INPUT_KEYS.iter())
                .filter_map(|(v, (k, _))| v.map(|v| ((*k).to_string(), json!(v))))
                .collect();
            for (k, v) in pairs {
                map.insert((*k).to_string(), json!(v));
            }
            NewHistoryEntry {
                calculator: "add".to_string(),
                calculator_label: "Add / Subtract".to_string(),
                inputs: serde_json::from_value(Value::Object(map)).unwrap(),
                inputs_text: "2024-01-31 + 5y 1m".to_string(),
                result_text: "2029-02-28".to_string(),
                copy_text: "2029-02-28".to_string(),
            }
        };
        let engine_ok = |pairs: &[(&str, &str)]| {
            let mut req = json!({
                "date": "2024-01-31", "operation": "add",
                "years": "", "months": "", "weeks": "", "days": ""
            });
            for (k, v) in pairs {
                req[*k] = json!(v);
            }
            api::call(Op::CalcAddSubtract, &req).error().is_none()
        };

        // Padded values the engine accepts (ASCII space/tab/CR/LF at the
        // ends) are saved, and stored in the engine's trimmed form.
        let padded: &[(&str, &str)] = &[
            ("years", " 5"),
            ("months", "1 "),
            ("days", "\t-3\r\n"),
            ("date", " 2024-01-31 "),
        ];
        assert!(engine_ok(padded));
        let state = in_memory();
        let list = history_add_with_path(&state, add_entry(padded), || unreachable!()).unwrap();
        let inputs = &list[0].inputs;
        assert_eq!(inputs.years.as_deref(), Some("5"));
        assert_eq!(inputs.months.as_deref(), Some("1"));
        assert_eq!(inputs.days.as_deref(), Some("-3"));
        assert_eq!(inputs.date.as_deref(), Some("2024-01-31"));
        // The stored form passes the strict on-disk validator.
        assert_eq!(validate_history_entry(&list[0]), Ok(()));
        // A padded re-add of the same calculation is a consecutive duplicate.
        let list = history_add_with_path(
            &state,
            add_entry(&[("years", "5"), ("months", "1"), ("days", "-3")]),
            || unreachable!(),
        )
        .unwrap();
        assert_eq!(list.len(), 1);

        // Values the engine rejects are rejected by history too.
        for bad in [
            &[("years", "5 5")][..],
            &[("months", "1\u{00a0}")][..],
            &[("operation", " add")][..],
            &[("operation", "add ")][..],
        ] {
            assert!(!engine_ok(bad), "{bad:?}");
            assert!(
                history_add_with_path(&in_memory(), add_entry(bad), || unreachable!()).is_err(),
                "{bad:?}"
            );
        }
        // Exact-match kinds are never trimmed.
        let mut entry = add_entry(&[("businessDays", " true")]);
        entry.inputs.normalize_engine_trimmed();
        assert_eq!(entry.inputs.business_days.as_deref(), Some(" true"));
        assert!(validate_new_entry(&entry).is_err());

        // Optional fields: whitespace-only means "blank", as in the engine.
        let mut age = sample_new_entry();
        age.calculator = "age".to_string();
        age.inputs = inputs_of(&[
            ("birthDate", "1990-05-17 "),
            ("asOfDate", "  "),
            ("leapDayRule", "feb28"),
        ]);
        let list = history_add_with_path(&in_memory(), age, || unreachable!()).unwrap();
        assert_eq!(list[0].inputs.birth_date.as_deref(), Some("1990-05-17"));
        assert_eq!(list[0].inputs.as_of_date.as_deref(), Some(""));
    }

    #[test]
    fn corrupt_settings_are_backed_up_once() {
        let temp = TestTempDir::new("date-settings-bak");
        let path = temp.path().join("settings.json");
        let bak = temp.path().join("settings.json.bak");
        assert_eq!(backup_path(&path).unwrap(), bak);

        // Missing file: defaults (update check on), no backup.
        assert_eq!(load_settings_from_path(&path), AppSettings::default());
        assert!(!bak.exists());

        // Valid file: loaded, no backup.
        std::fs::write(
            &path,
            br#"{"checkUpdatesOnStartup":false,"firstDayOfWeek":"sunday"}"#,
        )
        .unwrap();
        let loaded = load_settings_from_path(&path);
        assert!(!loaded.check_updates_on_startup);
        assert_eq!(loaded.first_day_of_week, FirstDayOfWeek::Sunday);
        assert!(!bak.exists());

        // Corrupt file: one byte-exact backup, then fail-closed defaults.
        let first_corrupt = b"{\"checkUpdatesOnStartup\": tru".to_vec();
        std::fs::write(&path, &first_corrupt).unwrap();
        assert_eq!(load_settings_from_path(&path), AppSettings::fail_closed());
        assert_eq!(std::fs::read(&bak).unwrap(), first_corrupt);
        // The corrupt original stays in place until the next successful save.
        assert_eq!(std::fs::read(&path).unwrap(), first_corrupt);

        // Loading the same corrupt bytes again writes nothing new.
        let bak_modified = std::fs::metadata(&bak).unwrap().modified().unwrap();
        assert_eq!(load_settings_from_path(&path), AppSettings::fail_closed());
        assert_eq!(std::fs::read(&bak).unwrap(), first_corrupt);
        assert_eq!(
            std::fs::metadata(&bak).unwrap().modified().unwrap(),
            bak_modified
        );

        // A successful save replaces the corrupt file; the backup is kept.
        let state = SettingsState {
            in_memory_only: false,
            settings: Mutex::new(AppSettings::fail_closed()),
        };
        set_settings_with_path(&state, &settings_json(true), || Ok(path.clone())).unwrap();
        assert_eq!(load_settings_from_path(&path), AppSettings::default());
        assert_eq!(std::fs::read(&bak).unwrap(), first_corrupt);

        // A later, different corruption is preserved too (it replaces the
        // older backup), so the next save cannot silently lose it.
        let second_corrupt = br#"{"calendar":{"weekend":[1,2,3,4,5,6,7]}}"#.to_vec();
        std::fs::write(&path, &second_corrupt).unwrap();
        assert_eq!(load_settings_from_path(&path), AppSettings::fail_closed());
        assert_eq!(std::fs::read(&bak).unwrap(), second_corrupt);
        set_settings_with_path(&state, &settings_json(true), || Ok(path.clone())).unwrap();
        assert_eq!(load_settings_from_path(&path), AppSettings::default());
        assert_eq!(std::fs::read(&bak).unwrap(), second_corrupt);
        let leftover_tmp = std::fs::read_dir(temp.path())
            .unwrap()
            .filter_map(Result::ok)
            .filter(|e| e.file_name().to_string_lossy().ends_with(".tmp"))
            .count();
        assert_eq!(leftover_tmp, 0);

        // Each failure kind, in a fresh directory.
        let cases: Vec<(&str, Vec<u8>, bool)> = vec![
            (
                "invalid-calendar",
                br#"{"calendar":{"hijriOffsetDays":9}}"#.to_vec(),
                true,
            ),
            (
                "unknown-field",
                br#"{"checkUpdatesOnStartup":true,"injected":1}"#.to_vec(),
                true,
            ),
            ("wrong-schema", br#"{"schemaVersion":2}"#.to_vec(), true),
            ("not-object", b"[]".to_vec(), true),
            ("empty", Vec::new(), true),
            ("not-utf8", vec![0xff, 0xfe, 0x00], true),
            (
                // Over the 64 KiB cap (valid JSON padded with spaces): backed up.
                "oversized",
                [b"{}".as_slice(), &vec![b' '; SETTINGS_MAX_FILE_BYTES]].concat(),
                true,
            ),
            (
                // Over the 1 MiB backup cap: fail closed, never copied.
                "huge",
                vec![b' '; SETTINGS_BACKUP_MAX_BYTES + 1],
                false,
            ),
        ];
        for (name, bytes, expect_backup) in cases {
            let dir = temp.path().join(name);
            std::fs::create_dir_all(&dir).unwrap();
            let path = dir.join("settings.json");
            let bak = dir.join("settings.json.bak");
            std::fs::write(&path, &bytes).unwrap();
            assert_eq!(
                load_settings_from_path(&path),
                AppSettings::fail_closed(),
                "{name}"
            );
            assert_eq!(bak.exists(), expect_backup, "{name}");
            if expect_backup {
                assert_eq!(std::fs::read(&bak).unwrap(), bytes, "{name}");
            }
        }

        // A directory where the settings file should be: fail closed, no copy.
        let dir_case = temp.path().join("dir-case");
        std::fs::create_dir_all(dir_case.join("settings.json")).unwrap();
        assert_eq!(
            load_settings_from_path(&dir_case.join("settings.json")),
            AppSettings::fail_closed()
        );
        assert!(!dir_case.join("settings.json.bak").exists());

        // A symlinked settings file is never followed, read or copied.
        let link_case = temp.path().join("link-case");
        std::fs::create_dir_all(&link_case).unwrap();
        let outside = temp.path().join("outside.json");
        std::fs::write(&outside, b"{\"secret\":1}").unwrap();
        let link = link_case.join("settings.json");
        if try_symlink_file(&outside, &link).is_some() {
            assert_eq!(load_settings_from_path(&link), AppSettings::fail_closed());
            assert!(!link_case.join("settings.json.bak").exists());
        }

        // An existing .bak (even a non-regular one) is left alone.
        let pre_case = temp.path().join("pre-existing-bak");
        std::fs::create_dir_all(pre_case.join("settings.json.bak")).unwrap();
        std::fs::write(pre_case.join("settings.json"), b"{corrupt").unwrap();
        assert_eq!(
            load_settings_from_path(&pre_case.join("settings.json")),
            AppSettings::fail_closed()
        );
        assert!(pre_case.join("settings.json.bak").is_dir());

        // A symlinked .bak is never followed or replaced.
        let bak_link_case = temp.path().join("bak-link-case");
        std::fs::create_dir_all(&bak_link_case).unwrap();
        let bak_link = bak_link_case.join("settings.json.bak");
        if try_symlink_file(&outside, &bak_link).is_some() {
            std::fs::write(bak_link_case.join("settings.json"), b"{corrupt").unwrap();
            assert_eq!(
                load_settings_from_path(&bak_link_case.join("settings.json")),
                AppSettings::fail_closed()
            );
            assert!(std::fs::symlink_metadata(&bak_link)
                .unwrap()
                .file_type()
                .is_symlink());
            assert_eq!(std::fs::read(&outside).unwrap(), b"{\"secret\":1}");
        }
    }

    /// The nine FROZEN §2 commands, paired with their engine op.
    type CalcCommand = fn(Option<Value>) -> Response;

    fn calc_commands() -> [(Op, CalcCommand); 9] {
        [
            (Op::CalcDaysBetween, calc_days_between),
            (Op::CalcAddSubtract, calc_add_subtract),
            (Op::CalcBusinessDays, calc_business_days),
            (Op::CalcAge, calc_age),
            (Op::CalcDateInfo, calc_date_info),
            (Op::CalcCountdown, calc_countdown),
            (Op::HolidaysInRange, holidays_in_range),
            (Op::MonthGrid, month_grid),
            (Op::ValidateCalendar, validate_calendar),
        ]
    }

    fn valid_request(op: Op) -> Value {
        match op {
            Op::CalcDaysBetween => {
                json!({"startDate": "2024-01-01", "endDate": "2024-12-31", "includeEndDay": true})
            }
            Op::CalcAddSubtract => {
                json!({"date": "2024-01-31", "operation": "add", "months": "1"})
            }
            Op::CalcBusinessDays => json!({
                "startDate": "2024-01-01",
                "endDate": "2024-01-31",
                "calendar": {"preset": "us"}
            }),
            Op::CalcAge => json!({"birthDate": "1990-05-17", "asOfDate": "2026-11-16"}),
            Op::CalcDateInfo => json!({"date": "2026-11-16", "today": "2026-11-16"}),
            Op::CalcCountdown => json!({
                "now": {"date": "2026-11-16", "time": "12:00", "utcOffsetMinutes": 120},
                "target": {"date": "2027-01-01", "time": "", "utcOffsetMinutes": 120}
            }),
            Op::HolidaysInRange => json!({
                "startDate": "2024-01-01",
                "endDate": "2024-12-31",
                "calendar": {"preset": "uk"}
            }),
            Op::MonthGrid => json!({
                "year": 2024,
                "month": 1,
                "firstDayOfWeek": "sunday",
                "calendar": {"weekend": [5, 6], "preset": "eg"}
            }),
            Op::ValidateCalendar => json!({"calendar": {"preset": "eg", "weekend": [5, 6]}}),
        }
    }

    #[test]
    fn calc_commands_return_the_engine_envelope() {
        for (op, command) in calc_commands() {
            let name = op.name();

            // Valid request: success, identical to date_core::api.
            let req = valid_request(op);
            let got = command(Some(req.clone()));
            let want = api::call(op, &req);
            assert!(got.is_ok(), "{name}: {:?}", got.error());
            assert_eq!(got, want, "{name}");
            let got_json = serde_json::to_string(&got).unwrap();
            assert_eq!(got_json, serde_json::to_string(&want).unwrap(), "{name}");
            assert!(
                got_json.starts_with(r#"{"ok":"true","result":{"#),
                "{name}: {got_json}"
            );

            // Malformed requests: the engine's invalid_request envelope, exactly
            // as api::call (and the bridge) produce it.
            let invalid_json = serde_json::to_string(&api::invalid_request(op)).unwrap();
            assert!(invalid_json.starts_with(r#"{"ok":"false","error":{"code":"invalid_request""#));
            for bad in [
                Value::Null,
                json!([]),
                json!(["2024-01-01"]),
                json!("2024-01-01"),
                json!(42),
                json!({"unknownField": 1}),
                json!({"calendar": {"bogus": true}}),
            ] {
                let got = command(Some(bad.clone()));
                assert_eq!(got, api::call(op, &bad), "{name} {bad}");
                assert_eq!(
                    serde_json::to_string(&got).unwrap(),
                    invalid_json,
                    "{name} {bad}"
                );
            }

            // A missing `req` and an over-long one never become Tauri errors.
            assert_eq!(command(None), api::invalid_request(op), "{name} missing");
            let oversized = json!({ "startDate": "x".repeat(MAX_REQUEST_BYTES) });
            assert_eq!(
                command(Some(oversized)),
                api::invalid_request(op),
                "{name} oversized"
            );
        }

        // A well-formed but invalid value gets the engine's specific error,
        // not invalid_request.
        let req = json!({"startDate": "2024-02-30", "endDate": "2024-03-01"});
        let got = calc_days_between(Some(req.clone()));
        assert_eq!(got, api::call(Op::CalcDaysBetween, &req));
        let code = got.error().unwrap().code;
        assert_ne!(code, date_core::ErrorCode::InvalidRequest);

        // The IPC size cap is exact.
        let at_cap = Value::String("a".repeat(MAX_REQUEST_BYTES - 2));
        assert_eq!(
            serde_json::to_vec(&at_cap).unwrap().len(),
            MAX_REQUEST_BYTES
        );
        assert!(request_fits(&at_cap));
        assert!(!request_fits(&Value::String(
            "a".repeat(MAX_REQUEST_BYTES - 1)
        )));
    }

    /// FROZEN §4-style worst-case calendar: 100 custom holidays with 60-char
    /// names stacked on preset dates.
    fn heavy_calendar(preset: &str, weekend: &[i64]) -> Value {
        let customs: Vec<Value> = (0..100)
            .map(|i| {
                if i % 2 == 0 {
                    json!({
                        "id": format!("c-{i:08x}"),
                        "name": "N".repeat(60),
                        "kind": "yearly",
                        "month": 1 + (i / 2) % 12,
                        "day": 1 + (i / 24) % 28,
                    })
                } else {
                    json!({
                        "id": format!("c-{i:08x}"),
                        "name": "N".repeat(60),
                        "kind": "date",
                        "date": format!("2026-{:02}-{:02}", 1 + (i / 28) % 12, 1 + i % 28),
                    })
                }
            })
            .collect();
        json!({
            "weekend": weekend,
            "preset": preset,
            "hijriOffsetDays": 2,
            "customHolidays": customs,
        })
    }

    /// FROZEN §11: the longest output of each mode passes both history
    /// validators, and business copy text never carries a custom name.
    #[test]
    fn longest_engine_outputs_pass_both_history_validators() {
        fn feed(calculator: &str, inputs: HistoryInputs, response: &Response) -> usize {
            let json = serde_json::to_value(response).unwrap();
            let copy = json["result"]["copyText"]
                .as_str()
                .unwrap_or_else(|| panic!("{calculator}: {json}"))
                .to_string();
            assert!(
                !copy.contains(&"N".repeat(60)),
                "custom name leaked: {copy}"
            );
            let entry = NewHistoryEntry {
                calculator: calculator.to_string(),
                calculator_label: "Label".to_string(),
                inputs,
                inputs_text: "inputs".to_string(),
                result_text: "result".to_string(),
                copy_text: copy.clone(),
            };
            assert_eq!(
                both_validators(&entry),
                [Ok(()), Ok(())],
                "{calculator}: {} bytes\n{copy}",
                copy.len()
            );
            copy.len()
        }

        let mut longest = std::collections::BTreeMap::<&str, usize>::new();
        let mut note = |mode: &'static str, len: usize| {
            let e = longest.entry(mode).or_insert(0);
            *e = (*e).max(len);
        };

        for (a, b) in [
            ("9999-12-29", "0001-01-03"),
            ("0001-01-03", "9999-12-29"),
            ("9999-12-31", "0001-01-01"),
        ] {
            for include in [false, true] {
                let res = calc_days_between(Some(
                    json!({"startDate": a, "endDate": b, "includeEndDay": include}),
                ));
                let inputs = inputs_of(&[
                    ("startDate", a),
                    ("endDate", b),
                    ("includeEndDay", &include.to_string()),
                ]);
                note("between", feed("between", inputs, &res));
            }
        }

        let add_cases = [
            ("5000-01-31", "add", "9999", "-119987", "521722", "-3652058"),
            ("9999-12-31", "subtract", "9998", "11", "0", "30"),
            (
                "9999-09-29",
                "subtract",
                "-0001",
                "-119988",
                "-521722",
                "3652058",
            ),
        ];
        for (date, op, y, m, w, d) in add_cases {
            let res = calc_add_subtract(Some(json!({
                "date": date, "operation": op, "years": y, "months": m, "weeks": w, "days": d
            })));
            if res.is_ok() {
                let inputs = inputs_of(&[
                    ("date", date),
                    ("operation", op),
                    ("years", y),
                    ("months", m),
                    ("weeks", w),
                    ("days", d),
                    ("businessDays", "false"),
                ]);
                note("add", feed("add", inputs, &res));
            }
        }
        for (preset, weekend) in [
            ("eg", vec![1, 2, 3, 4, 5, 7]),
            ("uk", vec![2, 3, 4, 5, 6, 7]),
        ] {
            for (date, op, y, m, w, d) in [
                ("2026-01-31", "add", "-300", "3599", "100000", "-999999"),
                ("2026-01-31", "subtract", "150", "-1800", "-50000", "500000"),
            ] {
                let res = calc_add_subtract(Some(json!({
                    "date": date, "operation": op, "years": y, "months": m, "weeks": w, "days": d,
                    "businessDays": true, "calendar": heavy_calendar(preset, &weekend)
                })));
                if res.is_ok() {
                    let inputs = inputs_of(&[
                        ("date", date),
                        ("operation", op),
                        ("years", y),
                        ("months", m),
                        ("weeks", w),
                        ("days", d),
                        ("businessDays", "true"),
                    ]);
                    note("add", feed("add", inputs, &res));
                }
            }
        }

        for preset in ["us", "eg"] {
            for weekend in [vec![6, 7], vec![1, 2, 3, 4, 5, 7]] {
                let calendar = heavy_calendar(preset, &weekend);
                for (a, b) in [
                    ("2199-12-25", "1899-12-27"),
                    ("2026-12-30", "2026-01-07"),
                    ("9999-12-29", "0001-01-03"),
                ] {
                    for include in [false, true] {
                        let res = calc_business_days(Some(json!({
                            "startDate": a, "endDate": b, "includeEndDay": include,
                            "calendar": calendar
                        })));
                        let inputs = inputs_of(&[
                            ("startDate", a),
                            ("endDate", b),
                            ("includeEndDay", &include.to_string()),
                        ]);
                        note("business", feed("business", inputs, &res));
                    }
                }
            }
        }

        for (birth, as_of, rule) in [
            ("0001-01-03", "9999-12-29", "feb28"),
            ("2024-02-29", "9999-12-29", "mar1"),
            ("0004-02-29", "9999-12-31", "feb28"),
        ] {
            let res = calc_age(Some(
                json!({"birthDate": birth, "asOfDate": as_of, "leapDayRule": rule}),
            ));
            let inputs = inputs_of(&[
                ("birthDate", birth),
                ("asOfDate", as_of),
                ("leapDayRule", rule),
            ]);
            note("age", feed("age", inputs, &res));
        }

        for (date, today) in [
            ("9999-12-29", "0001-01-01"),
            ("0001-01-01", "9999-12-31"),
            ("0001-09-26", "9999-12-31"),
        ] {
            let res = calc_date_info(Some(json!({"date": date, "today": today})));
            note("info", feed("info", inputs_of(&[("date", date)]), &res));
        }

        for (now, target) in [
            (
                json!({"date": "0001-01-01", "time": "00:00:00", "utcOffsetMinutes": 1080}),
                json!({"date": "9999-12-29", "time": "23:59:59", "utcOffsetMinutes": -1080}),
            ),
            (
                json!({"date": "9999-12-31", "time": "23:59:59", "utcOffsetMinutes": -1080}),
                json!({"date": "0001-01-03", "time": "00:00", "utcOffsetMinutes": 1080}),
            ),
        ] {
            let res = calc_countdown(Some(json!({"now": now, "target": target})));
            let inputs = inputs_of(&[
                ("targetDate", target["date"].as_str().unwrap()),
                ("targetTime", target["time"].as_str().unwrap()),
            ]);
            note("countdown", feed("countdown", inputs, &res));
        }

        for mode in ALLOWED_CALCULATORS {
            let len = longest.get(mode).copied().unwrap_or(0);
            assert!(len > 0, "{mode}: no worst case produced a result");
            println!("{mode}: longest copyText {len} bytes");
        }
    }

    #[test]
    fn full_history_of_max_size_entries_evicts_to_fit_file_cap() {
        // Quotes double in JSON, so these entries serialize to ~3.7 KB each and
        // 500 of them would be far over the 1 MiB file cap.
        let big_entry = |n: usize| {
            let mut entry = distinct_entry(n);
            entry.calculator_label = "\"".repeat(MAX_FIELD_LEN);
            entry.inputs_text = "\"".repeat(MAX_FIELD_LEN);
            entry.result_text = "\"".repeat(MAX_FIELD_LEN);
            entry.copy_text = "\"".repeat(MAX_HISTORY_COPY_LEN);
            assert_eq!(validate_new_entry(&entry), Ok(()));
            entry
        };
        let seeded: Vec<HistoryEntry> = (0..HISTORY_MAX_ENTRIES - 1)
            .rev()
            .map(|n| {
                let mut e = stored(&big_entry(n));
                e.id = n as u64 + 1;
                e
            })
            .collect();

        let temp = TestTempDir::new("date-history-cap");
        let path = temp.path().join("history.json");
        let state = HistoryState {
            in_memory_only: false,
            entries: Mutex::new(seeded),
            next_id: Mutex::new(HISTORY_MAX_ENTRIES as u64),
            read_only: Mutex::new(None),
        };
        let list = history_add_with_path(&state, big_entry(4000), || Ok(path.clone())).unwrap();
        assert!(list.len() < HISTORY_MAX_ENTRIES);
        assert!(list.len() > 200, "evicts only what it must: {}", list.len());
        assert_eq!(list[0].id, HISTORY_MAX_ENTRIES as u64);
        assert_eq!(list[1].id, HISTORY_MAX_ENTRIES as u64 - 1);
        // Newest first, oldest evicted.
        assert!(list.windows(2).all(|w| w[0].id > w[1].id));
        let size = std::fs::metadata(&path).unwrap().len() as usize;
        assert!(size <= HISTORY_MAX_FILE_BYTES, "{size}");
        assert_eq!(load_history_from_path(&path).entries, list);
    }

    #[test]
    fn app_identity_constants() {
        assert_eq!(
            GITHUB_LATEST_RELEASE_API,
            "https://api.github.com/repos/CipherVaults/Date-Calculator-Tool/releases/latest"
        );
        assert!(GITHUB_RELEASES_URL.starts_with(GITHUB_RELEASES_PREFIX));
        assert!(GITHUB_RELEASES_PREFIX.starts_with(REPOSITORY_URL));
        assert_eq!(
            WEB_APP_URL,
            "https://ciphervaults.github.io/Date-Calculator-Tool/"
        );
        assert_eq!(SMOKE_CLIPBOARD_SENTINEL, "date-tool-smoke-test");
        assert_eq!(SETTINGS_MAX_FILE_BYTES, 65_536);
        assert_eq!(HISTORY_MAX_FILE_BYTES, 1_048_576);
        assert_eq!(MAX_COPY_LEN, 4096);
        assert_eq!(MAX_HISTORY_COPY_LEN, 1024);
        assert_eq!(HISTORY_MAX_ENTRIES, 500);
        assert_eq!(date_core::ENGINE_VERSION, EXPECTED_ENGINE_VERSION);
    }

    // -----------------------------------------------------------------------
    // v1.1.0: countdown persistence (plan A2) and history read-only (A3)
    // -----------------------------------------------------------------------

    fn sample_countdown() -> CountdownState {
        CountdownState {
            schema_version: 1,
            target_date: "2026-12-31".to_string(),
            target_time: "09:00".to_string(),
            saved_at_ms: 1_795_400_000_000,
            finished_seen_at_ms: None,
        }
    }

    fn disk_countdown_store() -> CountdownStore {
        CountdownStore {
            in_memory_only: false,
            state: Mutex::new(None),
        }
    }

    fn disk_history(read_only: Option<HistoryReadOnlyReason>) -> HistoryState {
        HistoryState {
            in_memory_only: false,
            entries: Mutex::new(Vec::new()),
            next_id: Mutex::new(1),
            read_only: Mutex::new(read_only),
        }
    }

    fn history_from_load(load: HistoryLoad) -> HistoryState {
        HistoryState {
            in_memory_only: false,
            next_id: Mutex::new(load.next_id()),
            entries: Mutex::new(load.entries),
            read_only: Mutex::new(load.read_only),
        }
    }

    fn file_names(dir: &Path) -> Vec<String> {
        let mut names: Vec<String> = std::fs::read_dir(dir)
            .unwrap()
            .filter_map(Result::ok)
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        names
    }

    fn history_bytes(entries: &[HistoryEntry]) -> Vec<u8> {
        serde_json::to_vec_pretty(entries).unwrap()
    }

    #[test]
    fn countdown_roundtrip() {
        let temp = TestTempDir::new("date-cd-roundtrip");
        let path = temp.path().join("countdown.json");
        let store = disk_countdown_store();
        let at = || Ok(path.clone());

        // No file: empty, nothing created.
        let empty = countdown_load_with_path(&store, at).unwrap();
        assert_eq!(
            empty,
            CountdownLoad::without_state(CountdownLoadStatus::Empty)
        );
        assert_eq!(
            serde_json::to_value(&empty).unwrap(),
            json!({"state": null, "status": "empty"})
        );
        assert!(!path.exists());

        // Save → exact compact JSON on disk → load returns it.
        countdown_save_with_path(&store, sample_countdown(), at).unwrap();
        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            r#"{"schemaVersion":1,"targetDate":"2026-12-31","targetTime":"09:00","savedAtMs":1795400000000,"finishedSeenAtMs":null}"#
        );
        let loaded = countdown_load_with_path(&store, at).unwrap();
        assert_eq!(loaded.status, CountdownLoadStatus::Ok);
        assert_eq!(loaded.state, Some(sample_countdown()));
        assert_eq!(
            serde_json::to_value(&loaded).unwrap(),
            json!({"state": serde_json::to_value(sample_countdown()).unwrap(), "status": "ok"})
        );

        // finishedSeenAtMs and an all-day target round-trip too.
        let mut seen = sample_countdown();
        seen.target_time = String::new();
        seen.finished_seen_at_ms = Some(1_795_500_000_000);
        countdown_save_with_path(&store, seen.clone(), at).unwrap();
        assert_eq!(load_countdown_from_path(&path).state, Some(seen.clone()));
        assert_eq!(store.state.lock().unwrap().as_ref(), Some(&seen));
        // A missing finishedSeenAtMs reads as null.
        std::fs::write(
            &path,
            br#"{"schemaVersion":1,"targetDate":"2026-12-31","targetTime":"","savedAtMs":5}"#,
        )
        .unwrap();
        assert_eq!(
            load_countdown_from_path(&path)
                .state
                .unwrap()
                .finished_seen_at_ms,
            None
        );

        // Clear removes the file; clearing again is fine.
        countdown_clear_with_path(&store, at).unwrap();
        assert!(!path.exists());
        countdown_clear_with_path(&store, at).unwrap();
        assert_eq!(
            countdown_load_with_path(&store, at).unwrap().status,
            CountdownLoadStatus::Empty
        );
        assert!(store.state.lock().unwrap().is_none());

        // The in-memory (smoke) store never resolves a path.
        let memory = CountdownStore {
            in_memory_only: true,
            state: Mutex::new(None),
        };
        let never = || -> Result<PathBuf, String> { unreachable!("smoke store touched disk") };
        countdown_save_with_path(&memory, sample_countdown(), never).unwrap();
        assert_eq!(
            countdown_load_with_path(&memory, never).unwrap().state,
            Some(sample_countdown())
        );
        countdown_clear_with_path(&memory, never).unwrap();
        assert_eq!(
            countdown_load_with_path(&memory, never).unwrap().status,
            CountdownLoadStatus::Empty
        );
        assert_eq!(smoke_countdown_roundtrip(&memory), Ok(()));
        assert!(smoke_countdown_roundtrip(&disk_countdown_store()).is_err());
        assert_eq!(file_names(temp.path()), Vec::<String>::new());
    }

    #[test]
    fn countdown_rejects_unknown_field() {
        let good = serde_json::to_value(sample_countdown()).unwrap();
        assert!(serde_json::from_value::<CountdownState>(good.clone()).is_ok());
        let mut extra = good.clone();
        extra["label"] = json!("x");
        assert!(serde_json::from_value::<CountdownState>(extra.clone()).is_err());
        let mut missing = good.clone();
        missing.as_object_mut().unwrap().remove("targetTime");
        assert!(serde_json::from_value::<CountdownState>(missing.clone()).is_err());
        let mut wrong_type = good.clone();
        wrong_type["savedAtMs"] = json!("1");
        assert!(serde_json::from_value::<CountdownState>(wrong_type.clone()).is_err());

        let temp = TestTempDir::new("date-cd-unknown");
        for (name, value) in [
            ("extra", extra),
            ("missing", missing),
            ("wrong-type", wrong_type),
        ] {
            let dir = temp.path().join(name);
            std::fs::create_dir_all(&dir).unwrap();
            let path = dir.join("countdown.json");
            let bytes = serde_json::to_vec(&value).unwrap();
            std::fs::write(&path, &bytes).unwrap();
            let load = load_countdown_from_path(&path);
            assert_eq!(load.status, CountdownLoadStatus::Corrupt, "{name}");
            assert_eq!(load.state, None, "{name}");
            assert_eq!(
                std::fs::read(dir.join("countdown.json.bak")).unwrap(),
                bytes
            );
        }
    }

    #[test]
    fn countdown_oversize() {
        assert_eq!(COUNTDOWN_MAX_FILE_BYTES, 1024);
        let temp = TestTempDir::new("date-cd-oversize");
        let path = temp.path().join("countdown.json");
        let bak = temp.path().join("countdown.json.bak");

        // Exactly at the cap (valid JSON padded with spaces): accepted.
        let body = serde_json::to_vec(&sample_countdown()).unwrap();
        let at_cap = [
            body.as_slice(),
            &vec![b' '; COUNTDOWN_MAX_FILE_BYTES - body.len()],
        ]
        .concat();
        assert_eq!(at_cap.len(), COUNTDOWN_MAX_FILE_BYTES);
        std::fs::write(&path, &at_cap).unwrap();
        assert_eq!(
            load_countdown_from_path(&path).status,
            CountdownLoadStatus::Ok
        );

        // One byte over: never parsed or copied, but renamed aside whole to
        // the free .bak, so the slot is writable again (status corrupt).
        let over = [at_cap.as_slice(), b" "].concat();
        std::fs::write(&path, &over).unwrap();
        assert_eq!(
            load_countdown_from_path(&path),
            CountdownLoad::without_state(CountdownLoadStatus::Corrupt)
        );
        assert!(!path.exists());
        assert_eq!(std::fs::read(&bak).unwrap(), over);
        let store = disk_countdown_store();
        countdown_save_with_path(&store, sample_countdown(), || Ok(path.clone())).unwrap();
        assert_eq!(
            load_countdown_from_path(&path).status,
            CountdownLoadStatus::Ok
        );

        // A second over-cap file with the .bak taken: kept under a fresh
        // name; the first backup is never replaced.
        let second = vec![b'x'; COUNTDOWN_MAX_FILE_BYTES + 7];
        std::fs::write(&path, &second).unwrap();
        // While it is there, save and clear refuse it.
        assert_eq!(
            countdown_save_with_path(&store, sample_countdown(), || Ok(path.clone())),
            Err(COUNTDOWN_UNREADABLE.to_string())
        );
        assert_eq!(
            countdown_clear_with_path(&store, || Ok(path.clone())),
            Err(COUNTDOWN_UNREADABLE.to_string())
        );
        assert_eq!(std::fs::read(&path).unwrap(), second);
        assert_eq!(
            load_countdown_from_path(&path).status,
            CountdownLoadStatus::Corrupt
        );
        assert!(!path.exists());
        assert_eq!(std::fs::read(&bak).unwrap(), over);
        let extra: Vec<String> = file_names(temp.path())
            .into_iter()
            .filter(|n| n.starts_with("countdown.json.bak-"))
            .collect();
        assert_eq!(extra.len(), 1, "{extra:?}");
        assert_eq!(std::fs::read(temp.path().join(&extra[0])).unwrap(), second);

        // A 2 KiB record that declares a newer schema: recognised as newer,
        // never moved, written over or removed.
        let mut newer = br#"{"schemaVersion":2,"targetDate":"2027-01-01","pad":""#.to_vec();
        newer.extend(vec![b'p'; 2048]);
        newer.extend(br#""}"#);
        std::fs::write(&path, &newer).unwrap();
        assert_eq!(
            load_countdown_from_path(&path),
            CountdownLoad::without_state(CountdownLoadStatus::Newer)
        );
        assert_eq!(
            countdown_save_with_path(&store, sample_countdown(), || Ok(path.clone())),
            Err(COUNTDOWN_NEWER_SCHEMA.to_string())
        );
        assert_eq!(
            countdown_clear_with_path(&store, || Ok(path.clone())),
            Err(COUNTDOWN_NEWER_SCHEMA.to_string())
        );
        assert_eq!(std::fs::read(&path).unwrap(), newer);

        // The largest valid record is far below the cap.
        let mut largest = sample_countdown();
        largest.target_date = "9999-12-31".to_string();
        largest.saved_at_ms = MAX_SAFE_JS_INTEGER;
        largest.finished_seen_at_ms = Some(MAX_SAFE_JS_INTEGER);
        assert!(serialize_countdown(&largest).unwrap().len() < 256);

        // A directory at the path is unreadable, and clear refuses it.
        let dir_path = temp.path().join("dir").join("countdown.json");
        std::fs::create_dir_all(&dir_path).unwrap();
        assert_eq!(
            load_countdown_from_path(&dir_path).status,
            CountdownLoadStatus::Unreadable
        );
        assert!(clear_countdown_at_path(&dir_path).is_err());
        assert!(persist_countdown_to_path(&dir_path, &sample_countdown()).is_err());
        assert!(dir_path.is_dir());
    }

    #[test]
    fn countdown_symlink() {
        let temp = TestTempDir::new("date-cd-symlink");
        let outside = temp.path().join("outside.json");
        let outside_bytes = serde_json::to_vec(&sample_countdown()).unwrap();
        std::fs::write(&outside, &outside_bytes).unwrap();

        let dir = temp.path().join("app");
        std::fs::create_dir_all(&dir).unwrap();
        let link = dir.join("countdown.json");
        if try_symlink_file(&outside, &link).is_none() {
            return; // Windows without the symlink privilege.
        }
        // Never followed or read, never backed up, never written through.
        assert_eq!(
            load_countdown_from_path(&link),
            CountdownLoad::without_state(CountdownLoadStatus::Unreadable)
        );
        assert!(!dir.join("countdown.json.bak").exists());
        let store = disk_countdown_store();
        assert!(countdown_save_with_path(&store, sample_countdown(), || Ok(link.clone())).is_err());
        assert!(store.state.lock().unwrap().is_none());
        assert_eq!(std::fs::read(&outside).unwrap(), outside_bytes);
        // Clear removes the link itself; the target is untouched.
        countdown_clear_with_path(&store, || Ok(link.clone())).unwrap();
        assert!(std::fs::symlink_metadata(&link).is_err());
        assert_eq!(std::fs::read(&outside).unwrap(), outside_bytes);

        // A symlinked .bak is never followed or replaced.
        let bak_link = dir.join("countdown.json.bak");
        if try_symlink_file(&outside, &bak_link).is_some() {
            std::fs::write(dir.join("countdown.json"), b"{corrupt").unwrap();
            assert_eq!(
                load_countdown_from_path(&dir.join("countdown.json")).status,
                CountdownLoadStatus::Corrupt
            );
            assert!(std::fs::symlink_metadata(&bak_link)
                .unwrap()
                .file_type()
                .is_symlink());
            assert_eq!(std::fs::read(&outside).unwrap(), outside_bytes);
        }
    }

    #[test]
    fn countdown_bad_time() {
        let with_time = |t: &str| {
            let mut s = sample_countdown();
            s.target_time = t.to_string();
            s
        };
        for ok in ["", "00:00", "09:30", "23:59"] {
            assert_eq!(validate_countdown_state(&with_time(ok)), Ok(()), "{ok:?}");
        }
        for bad in [
            "24:00",
            "9:30",
            "09:30:00",
            " 09:30",
            "09:30 ",
            "09:60",
            "ab:cd",
            "0930",
            "09-30",
            "\u{0660}9:30",
        ] {
            assert!(
                validate_countdown_state(&with_time(bad)).is_err(),
                "{bad:?}"
            );
        }
        let with_date = |d: &str| {
            let mut s = sample_countdown();
            s.target_date = d.to_string();
            s
        };
        for bad in [
            "",
            "2026-02-30",
            "2026-1-01",
            "0000-01-01",
            "10000-01-01",
            " 2026-12-31",
        ] {
            assert!(
                validate_countdown_state(&with_date(bad)).is_err(),
                "{bad:?}"
            );
        }
        assert_eq!(validate_countdown_state(&with_date("2028-02-29")), Ok(()));

        let mut s = sample_countdown();
        s.schema_version = 2;
        assert!(validate_countdown_state(&s).is_err());
        s.schema_version = 0;
        assert!(validate_countdown_state(&s).is_err());
        let mut s = sample_countdown();
        s.saved_at_ms = MAX_SAFE_JS_INTEGER + 1;
        assert!(validate_countdown_state(&s).is_err());
        let mut s = sample_countdown();
        s.finished_seen_at_ms = Some(MAX_SAFE_JS_INTEGER + 1);
        assert!(validate_countdown_state(&s).is_err());

        // A refused save writes nothing and keeps the previous record.
        let temp = TestTempDir::new("date-cd-badtime");
        let path = temp.path().join("countdown.json");
        let store = disk_countdown_store();
        countdown_save_with_path(&store, sample_countdown(), || Ok(path.clone())).unwrap();
        let before = std::fs::read(&path).unwrap();
        for bad in ["24:00", "9:30"] {
            assert!(countdown_save_with_path(&store, with_time(bad), || Ok(path.clone())).is_err());
        }
        assert_eq!(std::fs::read(&path).unwrap(), before);
        assert_eq!(
            store.state.lock().unwrap().as_ref(),
            Some(&sample_countdown())
        );
        // A stored bad time is corrupt.
        std::fs::write(&path, serde_json::to_vec(&with_time("24:00")).unwrap()).unwrap();
        assert_eq!(
            load_countdown_from_path(&path).status,
            CountdownLoadStatus::Corrupt
        );
    }

    #[test]
    fn countdown_newer_schema_ignored_not_backed_up() {
        let temp = TestTempDir::new("date-cd-newer");
        let path = temp.path().join("countdown.json");
        let bak = temp.path().join("countdown.json.bak");
        let store = disk_countdown_store();
        for bytes in [
            br#"{"schemaVersion":2,"targetDate":"2027-01-01","alarms":[1,2]}"#.to_vec(),
            br#"{"schemaVersion":7}"#.to_vec(),
        ] {
            std::fs::write(&path, &bytes).unwrap();
            let load = countdown_load_with_path(&store, || Ok(path.clone())).unwrap();
            assert_eq!(
                load,
                CountdownLoad::without_state(CountdownLoadStatus::Newer)
            );
            assert_eq!(
                serde_json::to_value(&load).unwrap(),
                json!({"state": null, "status": "newer"})
            );
            // Never written over, never removed, never backed up.
            assert_eq!(
                countdown_save_with_path(&store, sample_countdown(), || Ok(path.clone())),
                Err(COUNTDOWN_NEWER_SCHEMA.to_string())
            );
            assert_eq!(
                countdown_clear_with_path(&store, || Ok(path.clone())),
                Err(COUNTDOWN_NEWER_SCHEMA.to_string())
            );
            assert_eq!(std::fs::read(&path).unwrap(), bytes);
            assert!(!bak.exists());
        }
        // Older or malformed versions are not "newer".
        for bytes in [
            br#"{"schemaVersion":0}"#.to_vec(),
            br#"{"schemaVersion":-1}"#.to_vec(),
            br#"{"schemaVersion":"2"}"#.to_vec(),
            br#"{"schemaVersion":2.5}"#.to_vec(),
            br#"[{"schemaVersion":2}]"#.to_vec(),
        ] {
            std::fs::write(&path, &bytes).unwrap();
            assert_eq!(
                load_countdown_from_path(&path).status,
                CountdownLoadStatus::Corrupt,
                "{}",
                String::from_utf8_lossy(&bytes)
            );
        }
    }

    #[test]
    fn countdown_corrupt_bak_once_then_none() {
        let temp = TestTempDir::new("date-cd-corrupt");
        let cases: Vec<(&str, Vec<u8>)> = vec![
            ("not-json", b"{\"schemaVersion\":1,".to_vec()),
            ("empty", Vec::new()),
            ("not-utf8", vec![0xff, 0xfe]),
            ("not-object", b"[]".to_vec()),
            ("no-schema", br#"{"targetDate":"2026-12-31"}"#.to_vec()),
            ("string-schema", br#"{"schemaVersion":"1"}"#.to_vec()),
            (
                "bad-date",
                br#"{"schemaVersion":1,"targetDate":"2026-02-30","targetTime":"","savedAtMs":1,"finishedSeenAtMs":null}"#
                    .to_vec(),
            ),
        ];
        for (name, bytes) in cases {
            let dir = temp.path().join(name);
            std::fs::create_dir_all(&dir).unwrap();
            let path = dir.join("countdown.json");
            let bak = dir.join("countdown.json.bak");
            std::fs::write(&path, &bytes).unwrap();
            assert_eq!(
                load_countdown_from_path(&path),
                CountdownLoad::without_state(CountdownLoadStatus::Corrupt),
                "{name}"
            );
            assert_eq!(std::fs::read(&bak).unwrap(), bytes, "{name}");
            // Loading the same bytes again: still no state, no new backup.
            let modified = std::fs::metadata(&bak).unwrap().modified().unwrap();
            assert_eq!(load_countdown_from_path(&path).state, None, "{name}");
            assert_eq!(
                std::fs::metadata(&bak).unwrap().modified().unwrap(),
                modified,
                "{name}"
            );
            // A save replaces the corrupt record and keeps the backup.
            let store = disk_countdown_store();
            countdown_save_with_path(&store, sample_countdown(), || Ok(path.clone())).unwrap();
            assert_eq!(
                load_countdown_from_path(&path).status,
                CountdownLoadStatus::Ok
            );
            assert_eq!(std::fs::read(&bak).unwrap(), bytes, "{name}");
            assert_eq!(
                file_names(&dir),
                vec![
                    "countdown.json".to_string(),
                    "countdown.json.bak".to_string()
                ]
            );
        }
    }

    #[test]
    fn countdown_does_not_touch_settings() {
        let temp = TestTempDir::new("date-cd-isolated");
        let dir = temp.path();
        let settings = dir.join("settings.json");
        let history = dir.join("history.json");
        let settings_bytes = br#"{"checkUpdatesOnStartup":false,"injected":1}"#.to_vec();
        let history_bytes = b"[not json".to_vec();
        std::fs::write(&settings, &settings_bytes).unwrap();
        std::fs::write(&history, &history_bytes).unwrap();
        let path = dir.join("countdown.json");
        let store = disk_countdown_store();

        countdown_save_with_path(&store, sample_countdown(), || Ok(path.clone())).unwrap();
        countdown_load_with_path(&store, || Ok(path.clone())).unwrap();
        std::fs::write(&path, b"{corrupt").unwrap();
        countdown_load_with_path(&store, || Ok(path.clone())).unwrap();
        countdown_clear_with_path(&store, || Ok(path.clone())).unwrap();

        assert_eq!(std::fs::read(&settings).unwrap(), settings_bytes);
        assert_eq!(std::fs::read(&history).unwrap(), history_bytes);
        assert_eq!(
            file_names(dir),
            vec![
                "countdown.json.bak".to_string(),
                "history.json".to_string(),
                "settings.json".to_string()
            ]
        );
        // The countdown is not an AppSettings field.
        assert!(parse_settings_value(&json!({"countdown": sample_countdown()})).is_err());
    }

    #[test]
    fn history_read_error_is_read_only_not_empty() {
        let temp = TestTempDir::new("date-hist-readerr");
        let status_json = |reason: Option<HistoryReadOnlyReason>| {
            serde_json::to_value(HistoryStatus::from_reason(reason)).unwrap()
        };
        assert_eq!(
            status_json(None),
            json!({"readOnly": false, "reason": null})
        );
        assert_eq!(
            status_json(Some(HistoryReadOnlyReason::ReadError)),
            json!({"readOnly": true, "reason": "read_error"})
        );
        assert_eq!(
            status_json(Some(HistoryReadOnlyReason::TooLarge)),
            json!({"readOnly": true, "reason": "too_large"})
        );
        assert_eq!(
            status_json(Some(HistoryReadOnlyReason::NewerSchema)),
            json!({"readOnly": true, "reason": "newer_schema"})
        );
        assert_eq!(
            status_json(Some(HistoryReadOnlyReason::Corrupt)),
            json!({"readOnly": true, "reason": "corrupt"})
        );

        // Missing: empty and writable.
        let missing = temp.path().join("missing").join("history.json");
        assert_eq!(load_history_from_path(&missing), HistoryLoad::default());

        // A directory in place of the file: read-only, nothing backed up.
        let dir_case = temp.path().join("dir-case");
        let dir_path = dir_case.join("history.json");
        std::fs::create_dir_all(&dir_path).unwrap();
        let load = load_history_from_path(&dir_path);
        assert_eq!(load.read_only, Some(HistoryReadOnlyReason::ReadError));
        assert!(load.entries.is_empty());
        assert!(!dir_case.join("history.json.bak").exists());

        // Over the cap: read-only "too_large", nothing backed up, bytes kept.
        let big_case = temp.path().join("big-case");
        std::fs::create_dir_all(&big_case).unwrap();
        let big = big_case.join("history.json");
        let big_bytes = vec![b' '; HISTORY_MAX_FILE_BYTES + 1];
        std::fs::write(&big, &big_bytes).unwrap();
        let state = history_from_load(load_history_from_path(&big));
        assert_eq!(
            history_status(&state).unwrap(),
            HistoryStatus::from_reason(Some(HistoryReadOnlyReason::TooLarge))
        );
        assert!(history_add_with_path(&state, distinct_entry(1), || Ok(big.clone())).is_err());
        assert_eq!(std::fs::read(&big).unwrap(), big_bytes);
        assert!(!big_case.join("history.json.bak").exists());

        // A symlinked file: read-only, never followed.
        let link_case = temp.path().join("link-case");
        std::fs::create_dir_all(&link_case).unwrap();
        let outside = temp.path().join("outside.json");
        std::fs::write(&outside, history_bytes(&[stored(&distinct_entry(1))])).unwrap();
        let link = link_case.join("history.json");
        if try_symlink_file(&outside, &link).is_some() {
            let load = load_history_from_path(&link);
            assert_eq!(load.read_only, Some(HistoryReadOnlyReason::ReadError));
            assert!(load.entries.is_empty());
            assert!(!link_case.join("history.json.bak").exists());
        }

        // A file another process holds open without sharing (Windows).
        #[cfg(windows)]
        {
            use std::os::windows::fs::OpenOptionsExt;
            let lock_case = temp.path().join("lock-case");
            std::fs::create_dir_all(&lock_case).unwrap();
            let locked = lock_case.join("history.json");
            let good = history_bytes(&[stored(&distinct_entry(3))]);
            std::fs::write(&locked, &good).unwrap();
            let holder = OpenOptions::new()
                .read(true)
                .share_mode(0)
                .open(&locked)
                .unwrap();
            let state = history_from_load(load_history_from_path(&locked));
            assert_eq!(
                *state.read_only.lock().unwrap(),
                Some(HistoryReadOnlyReason::ReadError)
            );
            assert!(history_list_state(&state).unwrap().is_empty());
            drop(holder);
            assert_eq!(std::fs::read(&locked).unwrap(), good);
            assert!(!lock_case.join("history.json.bak").exists());
            // Retry after the lock is released loads the real history.
            let status = history_retry_with_path(&state, || Ok(locked.clone())).unwrap();
            assert!(!status.read_only);
            assert_eq!(history_list_state(&state).unwrap().len(), 1);
        }

        // A newer-schema object: read-only, never backed up.
        let newer_case = temp.path().join("newer-case");
        std::fs::create_dir_all(&newer_case).unwrap();
        let newer = newer_case.join("history.json");
        std::fs::write(&newer, br#"{"schemaVersion":2,"entries":[]}"#).unwrap();
        assert_eq!(
            load_history_from_path(&newer).read_only,
            Some(HistoryReadOnlyReason::NewerSchema)
        );
        assert!(!newer_case.join("history.json.bak").exists());

        // Retry: the directory is replaced by a valid file → writable again,
        // and ids never go backwards.
        let state = history_from_load(load_history_from_path(&dir_path));
        *state.next_id.lock().unwrap() = 50;
        std::fs::remove_dir(&dir_path).unwrap();
        let mut seeded = stored(&distinct_entry(7));
        seeded.id = 9;
        std::fs::write(&dir_path, history_bytes(&[seeded.clone()])).unwrap();
        let status = history_retry_with_path(&state, || Ok(dir_path.clone())).unwrap();
        assert_eq!(status, HistoryStatus::from_reason(None));
        assert_eq!(history_list_state(&state).unwrap(), vec![seeded]);
        assert_eq!(*state.next_id.lock().unwrap(), 50);
        let list =
            history_add_with_path(&state, distinct_entry(8), || Ok(dir_path.clone())).unwrap();
        assert_eq!(list[0].id, 50);
        assert_eq!(list.len(), 2);
    }

    #[test]
    fn history_corrupt_writes_bak_then_read_only() {
        let temp = TestTempDir::new("date-hist-corrupt");
        let cases: Vec<(&str, Vec<u8>)> = vec![
            ("not-json", b"[{\"id\":1,".to_vec()),
            ("empty", Vec::new()),
            ("object", br#"{"entries":[]}"#.to_vec()),
            ("unknown-field", br#"[{"id":1,"bogus":true}]"#.to_vec()),
            ("not-array-of-entries", b"[1,2,3]".to_vec()),
        ];
        for (name, bytes) in cases {
            let dir = temp.path().join(name);
            std::fs::create_dir_all(&dir).unwrap();
            let path = dir.join("history.json");
            let bak = dir.join("history.json.bak");
            std::fs::write(&path, &bytes).unwrap();
            let load = load_history_from_path(&path);
            assert_eq!(
                load.read_only,
                Some(HistoryReadOnlyReason::Corrupt),
                "{name}"
            );
            assert!(load.entries.is_empty(), "{name}");
            assert_eq!(std::fs::read(&bak).unwrap(), bytes, "{name}");
            // The original stays in place, byte for byte.
            assert_eq!(std::fs::read(&path).unwrap(), bytes, "{name}");
            // Loading again writes no new backup.
            let modified = std::fs::metadata(&bak).unwrap().modified().unwrap();
            assert_eq!(
                load_history_from_path(&path).read_only,
                Some(HistoryReadOnlyReason::Corrupt)
            );
            assert_eq!(
                std::fs::metadata(&bak).unwrap().modified().unwrap(),
                modified
            );
        }
        // A valid history (and an empty list) loads writable, with no backup.
        let dir = temp.path().join("valid");
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("history.json");
        std::fs::write(&path, b"[]").unwrap();
        assert_eq!(load_history_from_path(&path), HistoryLoad::default());
        let entries = vec![stored(&distinct_entry(1))];
        std::fs::write(&path, history_bytes(&entries)).unwrap();
        let load = load_history_from_path(&path);
        assert_eq!(load.read_only, None);
        assert_eq!(load.entries, entries);
        assert_eq!(load.next_id(), 2);
        assert!(!dir.join("history.json.bak").exists());
    }

    #[test]
    fn history_dropped_entry_writes_bak() {
        let temp = TestTempDir::new("date-hist-dropped");
        let path = temp.path().join("history.json");
        let bak = temp.path().join("history.json.bak");
        let good = stored(&distinct_entry(1));
        let mut bad = stored(&distinct_entry(2));
        bad.id = 2;
        bad.calculator = "tax".to_string();
        let bytes = history_bytes(&[bad, good.clone()]);
        std::fs::write(&path, &bytes).unwrap();

        // The valid entries are still shown, but history is read-only and
        // the full file (with the dropped entry) is preserved.
        let load = load_history_from_path(&path);
        assert_eq!(load.entries, vec![good.clone()]);
        assert_eq!(load.read_only, Some(HistoryReadOnlyReason::Corrupt));
        assert_eq!(std::fs::read(&bak).unwrap(), bytes);
        let state = history_from_load(load);
        assert_eq!(
            history_add_with_path(&state, distinct_entry(3), || Ok(path.clone())),
            Err(HISTORY_READ_ONLY.to_string())
        );
        assert_eq!(std::fs::read(&path).unwrap(), bytes);

        // Past the 500-entry cap counts as dropped too.
        let over: Vec<HistoryEntry> = (0..=HISTORY_MAX_ENTRIES)
            .map(|n| {
                let mut e = stored(&distinct_entry(n));
                e.id = n as u64 + 1;
                e
            })
            .collect();
        let over_dir = temp.path().join("over");
        std::fs::create_dir_all(&over_dir).unwrap();
        let over_path = over_dir.join("history.json");
        std::fs::write(&over_path, history_bytes(&over)).unwrap();
        let load = load_history_from_path(&over_path);
        assert_eq!(load.entries.len(), HISTORY_MAX_ENTRIES);
        assert_eq!(load.read_only, Some(HistoryReadOnlyReason::Corrupt));
        assert!(over_dir.join("history.json.bak").exists());
    }

    #[test]
    fn history_add_refused_when_read_only() {
        let temp = TestTempDir::new("date-hist-refuse");
        let path = temp.path().join("history.json");
        let original = history_bytes(&[stored(&distinct_entry(1))]);
        std::fs::write(&path, &original).unwrap();
        for reason in [
            HistoryReadOnlyReason::ReadError,
            HistoryReadOnlyReason::Corrupt,
            HistoryReadOnlyReason::TooLarge,
            HistoryReadOnlyReason::NewerSchema,
        ] {
            let state = disk_history(Some(reason));
            *state.entries.lock().unwrap() = vec![stored(&distinct_entry(1))];
            let never = || -> Result<PathBuf, String> { unreachable!("read-only wrote") };
            assert_eq!(
                history_add_with_path(&state, distinct_entry(2), never),
                Err(HISTORY_READ_ONLY.to_string())
            );
            assert_eq!(
                history_delete_with_path(&state, 1, never),
                Err(HISTORY_READ_ONLY.to_string())
            );
            assert_eq!(
                history_clear_with_path(&state, never),
                Err(HISTORY_READ_ONLY.to_string())
            );
            assert_eq!(history_list_state(&state).unwrap().len(), 1);
            assert_eq!(*state.next_id.lock().unwrap(), 1);
            assert_eq!(std::fs::read(&path).unwrap(), original);
        }
        // Writable state still writes.
        let state = disk_history(None);
        assert!(history_add_with_path(&state, distinct_entry(2), || Ok(path.clone())).is_ok());
        // Smoke (in-memory) history is never read-only: retry is a no-op.
        let memory = HistoryState {
            in_memory_only: true,
            entries: Mutex::new(Vec::new()),
            next_id: Mutex::new(1),
            read_only: Mutex::new(None),
        };
        let never = || -> Result<PathBuf, String> { unreachable!("smoke retry touched disk") };
        assert_eq!(
            history_retry_with_path(&memory, never).unwrap(),
            HistoryStatus::from_reason(None)
        );
    }

    #[test]
    fn history_reset_renames_once() {
        let temp = TestTempDir::new("date-hist-reset");
        let path = temp.path().join("history.json");
        let bak = temp.path().join("history.json.bak");

        // Writable history refuses a reset: it is only the banner's action.
        let writable = disk_history(None);
        assert_eq!(
            history_reset_with_path(&writable, || Ok(path.clone())),
            Err("history_not_read_only".to_string())
        );
        assert!(!path.exists());

        // An over-cap file (no backup at load) is renamed to .bak.
        let first = vec![b' '; HISTORY_MAX_FILE_BYTES + 1];
        std::fs::write(&path, &first).unwrap();
        let state = history_from_load(load_history_from_path(&path));
        assert!(!bak.exists());
        history_reset_with_path(&state, || Ok(path.clone())).unwrap();
        assert_eq!(std::fs::read(&bak).unwrap(), first);
        assert_eq!(std::fs::read(&path).unwrap(), history_bytes(&[]));
        assert_eq!(
            history_status(&state).unwrap(),
            HistoryStatus::from_reason(None)
        );
        assert!(history_list_state(&state).unwrap().is_empty());
        let list = history_add_with_path(&state, distinct_entry(1), || Ok(path.clone())).unwrap();
        assert_eq!(load_history_from_path(&path).entries, list);

        // A second problem: the existing .bak is never replaced, and the
        // current bytes (not in any backup) are kept under a fresh name.
        let second = vec![b'x'; HISTORY_MAX_FILE_BYTES + 2];
        std::fs::write(&path, &second).unwrap();
        let state = history_from_load(load_history_from_path(&path));
        history_reset_with_path(&state, || Ok(path.clone())).unwrap();
        assert_eq!(std::fs::read(&bak).unwrap(), first);
        assert_eq!(load_history_from_path(&path), HistoryLoad::default());
        let extra_baks = |dir: &Path| -> Vec<Vec<u8>> {
            file_names(dir)
                .into_iter()
                .filter(|n| n.starts_with("history.json.bak-"))
                .map(|n| std::fs::read(dir.join(n)).unwrap())
                .collect()
        };
        assert_eq!(extra_baks(temp.path()), vec![second.clone()]);

        // A newer-schema file with an existing, different .bak: its bytes
        // are kept too, never overwritten by the empty history.
        let newer = br#"{"schemaVersion":2,"entries":[]}"#.to_vec();
        std::fs::write(&path, &newer).unwrap();
        let state = history_from_load(load_history_from_path(&path));
        assert_eq!(
            history_status(&state).unwrap(),
            HistoryStatus::from_reason(Some(HistoryReadOnlyReason::NewerSchema))
        );
        history_reset_with_path(&state, || Ok(path.clone())).unwrap();
        assert_eq!(std::fs::read(&bak).unwrap(), first);
        let kept = extra_baks(temp.path());
        assert_eq!(kept.len(), 2);
        assert!(kept.contains(&second) && kept.contains(&newer));
        assert_eq!(load_history_from_path(&path), HistoryLoad::default());

        // A corrupt file was already copied at load; reset keeps that copy.
        let dir = temp.path().join("corrupt");
        std::fs::create_dir_all(&dir).unwrap();
        let cpath = dir.join("history.json");
        std::fs::write(&cpath, b"[oops").unwrap();
        let state = history_from_load(load_history_from_path(&cpath));
        history_reset_with_path(&state, || Ok(cpath.clone())).unwrap();
        assert_eq!(
            std::fs::read(dir.join("history.json.bak")).unwrap(),
            b"[oops"
        );
        assert_eq!(load_history_from_path(&cpath), HistoryLoad::default());

        // A failed reset stays read-only.
        let blocker = temp.path().join("blocker");
        std::fs::write(&blocker, b"file").unwrap();
        let state = disk_history(Some(HistoryReadOnlyReason::ReadError));
        assert!(history_reset_with_path(&state, || Ok(blocker.join("history.json"))).is_err());
        assert_eq!(
            *state.read_only.lock().unwrap(),
            Some(HistoryReadOnlyReason::ReadError)
        );

        let leftover_tmp = file_names(temp.path())
            .iter()
            .filter(|n| n.ends_with(".tmp"))
            .count();
        assert_eq!(leftover_tmp, 0);
    }

    #[test]
    fn engine_version_pinned() {
        // The engine is decoupled from the app (plan A4).
        assert_eq!(date_core::ENGINE_VERSION, EXPECTED_ENGINE_VERSION);
        let conf: Value = serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        assert_eq!(conf["version"], json!(env!("CARGO_PKG_VERSION")));
        assert_eq!(env!("CARGO_PKG_VERSION"), "1.1.0");
    }
}
