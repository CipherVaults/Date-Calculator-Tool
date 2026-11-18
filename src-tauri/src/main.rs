// Prevents an extra console window on Windows in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;

use std::sync::Mutex;
use std::time::Duration;
use tauri::Manager;

use commands::{CountdownState, HistoryEntry, HistoryReadOnlyReason, LayoutState};

pub struct SmokeState {
    pub enabled: bool,
}

/// Lock order: `entries`, then `next_id`, then `read_only`.
pub struct HistoryState {
    pub in_memory_only: bool,
    pub entries: Mutex<Vec<HistoryEntry>>,
    pub next_id: Mutex<u64>,
    /// Plan A3: `Some` while `history.json` could not be loaded safely. Every
    /// history write is refused until Retry succeeds or the user starts a
    /// new history.
    pub read_only: Mutex<Option<HistoryReadOnlyReason>>,
}

/// Plan A2: the saved countdown. On disk it is `countdown.json`; during
/// `--smoke-test` it lives only in `state`.
pub struct CountdownStore {
    pub in_memory_only: bool,
    pub state: Mutex<Option<CountdownState>>,
}

/// Plan A8: the saved card order and collapsed cards. On disk it is
/// `layout.json`; during `--smoke-test` it lives only in `state`.
pub struct LayoutStore {
    pub in_memory_only: bool,
    pub state: Mutex<Option<LayoutState>>,
}

pub struct SettingsState {
    pub in_memory_only: bool,
    pub settings: Mutex<commands::AppSettings>,
}

fn main() {
    let smoke_enabled = std::env::args().any(|arg| arg == "--smoke-test");

    tauri::Builder::default()
        .plugin(tauri_plugin_clipboard_manager::init())
        .manage(SmokeState {
            enabled: smoke_enabled,
        })
        .setup(move |app| {
            // Smoke mode never touches the real history/settings/countdown/
            // layout files: it starts empty and keeps everything in memory.
            let history = if smoke_enabled {
                commands::HistoryLoad::default()
            } else {
                commands::load_history_from_disk(app.handle())
            };
            let next_id = history.next_id();

            app.manage(HistoryState {
                in_memory_only: smoke_enabled,
                entries: Mutex::new(history.entries),
                next_id: Mutex::new(next_id),
                read_only: Mutex::new(history.read_only),
            });

            // The countdown file is read on demand by `countdown_load`.
            app.manage(CountdownStore {
                in_memory_only: smoke_enabled,
                state: Mutex::new(None),
            });

            // The layout file is read on demand by `layout_load`.
            app.manage(LayoutStore {
                in_memory_only: smoke_enabled,
                state: Mutex::new(None),
            });

            let initial_settings = if smoke_enabled {
                commands::AppSettings::default()
            } else {
                commands::load_settings_from_disk(app.handle())
            };
            app.manage(SettingsState {
                in_memory_only: smoke_enabled,
                settings: Mutex::new(initial_settings),
            });

            if smoke_enabled {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.hide();
                }
                // Safety watchdog so a broken renderer cannot hang CI forever.
                let handle = app.handle().clone();
                std::thread::spawn(move || {
                    std::thread::sleep(Duration::from_secs(20));
                    eprintln!("SMOKE_TEST_TIMEOUT: renderer did not report within 20s.");
                    handle.exit(1);
                });
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::calc_days_between,
            commands::calc_add_subtract,
            commands::calc_business_days,
            commands::calc_age,
            commands::calc_date_info,
            commands::calc_countdown,
            commands::holidays_in_range,
            commands::month_grid,
            commands::validate_calendar,
            commands::history_list,
            commands::history_add,
            commands::history_delete,
            commands::history_clear,
            commands::history_state,
            commands::history_retry,
            commands::history_reset,
            commands::countdown_load,
            commands::countdown_save,
            commands::countdown_clear,
            commands::layout_load,
            commands::layout_save,
            commands::layout_reset,
            commands::get_settings,
            commands::set_settings,
            commands::check_for_updates,
            commands::open_release_page,
            commands::copy_text,
            commands::get_app_info,
            commands::is_smoke_test,
            commands::report_smoke_result,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Date Calculator Tool");
}
