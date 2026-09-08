use chrono::{DateTime, Datelike, Local, Timelike, Utc};
use rusqlite::{params, Connection};
use serde::Serialize;
mod ai;
mod database;
mod system;
use database::initialize_database;
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex,
    },
    thread,
    time::{Duration, Instant},
};
use tauri::{
    menu::{ContextMenu, MenuBuilder, MenuItemBuilder},
    tray::TrayIconBuilder,
    Manager, State,
};

const AI_KEYRING_SERVICE: &str = "com.daymate.desktop.ai";

struct AppState {
    ai: Arc<ai::AiRuntime>,
    database_path: PathBuf,
    tracking_enabled: Arc<AtomicBool>,
    title_capture_enabled: Arc<AtomicBool>,
    idle_detection_enabled: Arc<AtomicBool>,
    reset_requested: Arc<AtomicBool>,
    activity_gate: Arc<Mutex<()>>,
    tracking_changed: Arc<AtomicBool>,
    input_counters: Arc<InputCounters>,
    icon_cache: Mutex<HashMap<String, Option<String>>>,
}

#[derive(Default)]
struct InputCounters {
    mouse_clicks: AtomicU64,
    key_presses: AtomicU64,
    pending_mouse_clicks: AtomicU64,
    pending_key_presses: AtomicU64,
    pending_day: AtomicU64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct TodayStats {
    active_seconds: i64,
    idle_seconds: i64,
    app_switches: i64,
    mouse_clicks: i64,
    key_presses: i64,
    last_input_seconds_ago: i64,
    current_app: Option<String>,
    top_apps: Vec<AppUsage>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AppUsage {
    app_name: String,
    seconds: i64,
    icon_data_url: Option<String>,
}

struct ForegroundApplication {
    app_name: String,
    window_title: Option<String>,
    executable_path: String,
}

#[derive(Clone, Copy)]
struct SessionMetrics {
    active_seconds: i64,
    idle_seconds: i64,
    mouse_clicks: i64,
    key_presses: i64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum InputKind {
    Mouse,
    Keyboard,
}

fn input_kind(virtual_key: usize) -> Option<InputKind> {
    match virtual_key {
        0x01 | 0x02 | 0x04 | 0x05 | 0x06 => Some(InputKind::Mouse),
        0x07 | 0x10 | 0x11 | 0x12 => None,
        1..=254 => Some(InputKind::Keyboard),
        _ => None,
    }
}

fn input_press_transition(
    previous_states: &mut [bool; 256],
    virtual_key: usize,
    is_down: bool,
) -> Option<InputKind> {
    if virtual_key >= previous_states.len() {
        return None;
    }
    let was_down = previous_states[virtual_key];
    previous_states[virtual_key] = is_down;
    (!was_down && is_down)
        .then(|| input_kind(virtual_key))
        .flatten()
}

fn save_session(
    path: &Path,
    app_name: &str,
    window_title: Option<&str>,
    executable_path: Option<&str>,
    started_at: DateTime<Utc>,
    ended_at: DateTime<Utc>,
    metrics: SessionMetrics,
) {
    if metrics.active_seconds == 0
        && metrics.idle_seconds == 0
        && metrics.mouse_clicks == 0
        && metrics.key_presses == 0
    {
        return;
    }
    if let Ok(connection) = Connection::open(path) {
        let _ = connection.busy_timeout(Duration::from_secs(2));
        let _ = connection.execute(
            "INSERT INTO app_usage_sessions
             (app_name, window_title, executable_path, started_at, ended_at, active_seconds,
              idle_seconds, mouse_clicks, key_presses, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?5)",
            params![
                app_name,
                window_title,
                executable_path,
                started_at.to_rfc3339(),
                ended_at.to_rfc3339(),
                metrics.active_seconds,
                metrics.idle_seconds,
                metrics.mouse_clicks,
                metrics.key_presses,
            ],
        );
    }
}

#[cfg(windows)]
fn foreground_application(include_title: bool) -> Option<ForegroundApplication> {
    use windows_sys::Win32::{
        Foundation::{CloseHandle, HWND, LPARAM},
        System::Threading::{
            OpenProcess, QueryFullProcessImageNameW, PROCESS_QUERY_LIMITED_INFORMATION,
        },
        UI::WindowsAndMessaging::{
            EnumChildWindows, GetForegroundWindow, GetWindowTextW, GetWindowThreadProcessId,
        },
    };

    struct ChildProcessSearch {
        host_process_id: u32,
        application_process_id: u32,
    }

    unsafe extern "system" fn find_application_child(window: HWND, data: LPARAM) -> i32 {
        let search = &mut *(data as *mut ChildProcessSearch);
        let mut process_id = 0;
        GetWindowThreadProcessId(window, &mut process_id);
        if process_id != 0 && process_id != search.host_process_id {
            search.application_process_id = process_id;
            return 0;
        }
        1
    }

    unsafe fn executable_path(process_id: u32) -> Option<String> {
        let process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, process_id);
        if process.is_null() {
            return None;
        }
        let mut path = vec![0u16; 1024];
        let mut size = path.len() as u32;
        let ok = QueryFullProcessImageNameW(process, 0, path.as_mut_ptr(), &mut size);
        CloseHandle(process);
        (ok != 0).then(|| String::from_utf16_lossy(&path[..size as usize]))
    }

    unsafe {
        let window = GetForegroundWindow();
        if window.is_null() {
            return None;
        }
        let mut process_id = 0;
        GetWindowThreadProcessId(window, &mut process_id);
        let mut full_path = executable_path(process_id)?;
        if full_path.ends_with("\\ApplicationFrameHost.exe") {
            let mut search = ChildProcessSearch {
                host_process_id: process_id,
                application_process_id: 0,
            };
            EnumChildWindows(
                window,
                Some(find_application_child),
                &mut search as *mut ChildProcessSearch as LPARAM,
            );
            if search.application_process_id != 0 {
                if let Some(application_path) = executable_path(search.application_process_id) {
                    full_path = application_path;
                }
            }
        }
        let app_name = Path::new(&full_path)
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("unknown")
            .to_string();
        let title = include_title.then(|| {
            let mut buffer = vec![0u16; 512];
            let length = GetWindowTextW(window, buffer.as_mut_ptr(), buffer.len() as i32);
            String::from_utf16_lossy(&buffer[..length.max(0) as usize])
        });
        Some(ForegroundApplication {
            app_name,
            window_title: title.filter(|value| !value.is_empty()),
            executable_path: full_path,
        })
    }
}

#[cfg(not(windows))]
fn foreground_application(_include_title: bool) -> Option<ForegroundApplication> {
    None
}

#[cfg(windows)]
fn idle_seconds() -> u64 {
    use windows_sys::Win32::{
        System::SystemInformation::GetTickCount64,
        UI::Input::KeyboardAndMouse::{GetLastInputInfo, LASTINPUTINFO},
    };
    unsafe {
        let mut info = LASTINPUTINFO {
            cbSize: std::mem::size_of::<LASTINPUTINFO>() as u32,
            dwTime: 0,
        };
        if GetLastInputInfo(&mut info) == 0 {
            return 0;
        }
        idle_elapsed_seconds(GetTickCount64(), info.dwTime)
    }
}

fn idle_elapsed_seconds(tick_count: u64, last_input_tick: u32) -> u64 {
    // LASTINPUTINFO is a 32-bit tick value, including after the ~49.7-day wrap.
    let elapsed = (tick_count as u32).wrapping_sub(last_input_tick);
    if elapsed > i32::MAX as u32 {
        // Windows documents that injected input may carry a non-monotonic timestamp.
        0
    } else {
        u64::from(elapsed) / 1000
    }
}

fn discard_sample_interval(seconds: i64, settings_changed: bool) -> bool {
    settings_changed || !(1..=10).contains(&seconds)
}

fn measured_sample_seconds(wall_millis: i64, elapsed: Duration) -> i64 {
    let millis = elapsed.as_millis();
    if millis > 10_000 || (wall_millis as i128 - millis as i128).abs() > 1500 {
        return 0;
    }
    elapsed.as_secs() as i64
}

fn split_midnight_sample(seconds: i64, seconds_since_midnight: u32) -> (i64, i64) {
    let today = seconds.min(i64::from(seconds_since_midnight));
    (seconds - today, today)
}

fn pending_counts_for_day(counters: &InputCounters, day: u64) -> (i64, i64) {
    if counters.pending_day.load(Ordering::Relaxed) != day {
        return (0, 0);
    }
    (
        counters.pending_mouse_clicks.load(Ordering::Relaxed) as i64,
        counters.pending_key_presses.load(Ordering::Relaxed) as i64,
    )
}

#[cfg(windows)]
fn start_input_counter(counters: Arc<InputCounters>, enabled: Arc<AtomicBool>) {
    thread::spawn(move || {
        use windows_sys::Win32::UI::Input::KeyboardAndMouse::GetAsyncKeyState;
        let mut previous_states = [false; 256];
        let mut primed = false;
        loop {
            if !enabled.load(Ordering::Acquire) {
                primed = false;
                thread::sleep(Duration::from_millis(100));
                continue;
            }
            for virtual_key in 1..=254 {
                let is_down = unsafe { GetAsyncKeyState(virtual_key as i32) } as u16 & 0x8000 != 0;
                if !primed {
                    previous_states[virtual_key] = is_down;
                    continue;
                }
                match input_press_transition(&mut previous_states, virtual_key, is_down) {
                    Some(InputKind::Mouse) => {
                        counters.mouse_clicks.fetch_add(1, Ordering::Relaxed);
                    }
                    Some(InputKind::Keyboard) => {
                        counters.key_presses.fetch_add(1, Ordering::Relaxed);
                    }
                    None => {}
                }
            }
            primed = true;
            thread::sleep(Duration::from_millis(20));
        }
    });
}

#[cfg(not(windows))]
fn start_input_counter(_counters: Arc<InputCounters>, _enabled: Arc<AtomicBool>) {}

#[cfg(not(windows))]
fn idle_seconds() -> u64 {
    0
}

fn start_activity_tracker(state: &AppState) {
    let database_path = state.database_path.clone();
    let tracking_enabled = state.tracking_enabled.clone();
    let title_capture_enabled = state.title_capture_enabled.clone();
    let idle_detection_enabled = state.idle_detection_enabled.clone();
    let reset_requested = state.reset_requested.clone();
    let activity_gate = state.activity_gate.clone();
    let tracking_changed = state.tracking_changed.clone();
    let input_counters = state.input_counters.clone();
    thread::spawn(move || {
        let mut current_app = String::new();
        let mut current_title: Option<String> = None;
        let mut current_executable_path = String::new();
        let mut started_at = Utc::now();
        let mut last_flush = Instant::now();
        let mut active_seconds = 0i64;
        let mut inactive_seconds = 0i64;
        let mut mouse_clicks = 0i64;
        let mut key_presses = 0i64;
        let mut previous_mouse_clicks = input_counters.mouse_clicks.load(Ordering::Relaxed);
        let mut previous_key_presses = input_counters.key_presses.load(Ordering::Relaxed);
        let mut current_day = Local::now().date_naive();
        let mut last_observed = Utc::now();
        let mut last_sample = Instant::now();

        loop {
            thread::sleep(Duration::from_secs(3));
            let Ok(_activity_guard) = activity_gate.lock() else {
                return;
            };
            if reset_requested.swap(false, Ordering::Relaxed) {
                current_app.clear();
                current_title = None;
                current_executable_path.clear();
                active_seconds = 0;
                inactive_seconds = 0;
                mouse_clicks = 0;
                key_presses = 0;
                input_counters
                    .pending_mouse_clicks
                    .store(0, Ordering::Relaxed);
                input_counters
                    .pending_key_presses
                    .store(0, Ordering::Relaxed);
                started_at = Utc::now();
                last_flush = Instant::now();
                current_day = Local::now().date_naive();
                previous_mouse_clicks = input_counters.mouse_clicks.load(Ordering::Relaxed);
                previous_key_presses = input_counters.key_presses.load(Ordering::Relaxed);
                last_observed = started_at;
                last_sample = Instant::now();
                // Do not reintroduce the interval that straddled an explicit deletion.
                continue;
            }
            let observed = Utc::now();
            let sampled_at = Instant::now();
            let mut sample_seconds = measured_sample_seconds(
                (observed - last_observed).num_milliseconds(),
                sampled_at.duration_since(last_sample),
            );
            last_sample = sampled_at;
            let previous_observed = last_observed;
            last_observed = observed;
            // Never retain a captured title after its permission is disabled.
            if !title_capture_enabled.load(Ordering::Acquire) {
                current_title = None;
            }
            let total_mouse_clicks = input_counters.mouse_clicks.load(Ordering::Relaxed);
            let total_key_presses = input_counters.key_presses.load(Ordering::Relaxed);
            let mouse_delta = total_mouse_clicks.saturating_sub(previous_mouse_clicks) as i64;
            let key_delta = total_key_presses.saturating_sub(previous_key_presses) as i64;
            previous_mouse_clicks = total_mouse_clicks;
            previous_key_presses = total_key_presses;
            if !tracking_enabled.load(Ordering::Acquire)
                || discard_sample_interval(
                    sample_seconds,
                    tracking_changed.swap(false, Ordering::AcqRel),
                )
            {
                // Flush only the interval observed before pause/sleep/clock changes.
                save_session(
                    &database_path,
                    &current_app,
                    current_title.as_deref(),
                    (!current_executable_path.is_empty())
                        .then_some(current_executable_path.as_str()),
                    started_at,
                    previous_observed.max(started_at),
                    SessionMetrics {
                        active_seconds,
                        idle_seconds: inactive_seconds,
                        mouse_clicks,
                        key_presses,
                    },
                );
                current_app.clear();
                current_title = None;
                current_executable_path.clear();
                active_seconds = 0;
                inactive_seconds = 0;
                mouse_clicks = 0;
                key_presses = 0;
                started_at = observed;
                last_flush = Instant::now();
                current_day = Local::now().date_naive();
                input_counters
                    .pending_mouse_clicks
                    .store(0, Ordering::Relaxed);
                input_counters
                    .pending_key_presses
                    .store(0, Ordering::Relaxed);
                continue;
            }
            let capture_title = title_capture_enabled.load(Ordering::Relaxed);
            let Some(application) = foreground_application(capture_title) else {
                continue;
            };
            let app_name = application.app_name;
            let title = application.window_title;
            let executable_path = application.executable_path;
            let is_idle = idle_detection_enabled.load(Ordering::Relaxed) && idle_seconds() >= 300;
            let local_observed = observed.with_timezone(&Local);
            let day_changed = local_observed.date_naive() != current_day;
            let mut interval_start = previous_observed;
            if day_changed {
                let (previous_day_seconds, today_seconds) = split_midnight_sample(
                    sample_seconds,
                    local_observed.time().num_seconds_from_midnight(),
                );
                if !current_app.is_empty() {
                    if is_idle {
                        inactive_seconds += previous_day_seconds;
                    } else if !current_app.eq_ignore_ascii_case("daymate-desktop.exe") {
                        active_seconds += previous_day_seconds;
                    }
                }
                sample_seconds = today_seconds;
                interval_start = observed - chrono::Duration::seconds(today_seconds);
            }
            let app_changed = app_name != current_app || (capture_title && title != current_title);
            if (!current_app.is_empty() && app_changed)
                || day_changed
                || last_flush.elapsed().as_secs() >= 60
            {
                save_session(
                    &database_path,
                    &current_app,
                    current_title.as_deref(),
                    (!current_executable_path.is_empty())
                        .then_some(current_executable_path.as_str()),
                    started_at,
                    interval_start.max(started_at),
                    SessionMetrics {
                        active_seconds,
                        idle_seconds: inactive_seconds,
                        mouse_clicks,
                        key_presses,
                    },
                );
                current_app = app_name.clone();
                current_title = title.clone();
                current_executable_path = executable_path.clone();
                started_at = interval_start;
                active_seconds = 0;
                inactive_seconds = 0;
                mouse_clicks = 0;
                key_presses = 0;
                input_counters
                    .pending_mouse_clicks
                    .store(0, Ordering::Relaxed);
                input_counters
                    .pending_key_presses
                    .store(0, Ordering::Relaxed);
                last_flush = Instant::now();
                current_day = local_observed.date_naive();
            }
            if current_app.is_empty() {
                current_app = app_name;
                current_title = title;
                current_executable_path = executable_path;
                started_at = interval_start;
            }
            if is_idle {
                inactive_seconds += sample_seconds;
            } else if !current_app.eq_ignore_ascii_case("daymate-desktop.exe") {
                active_seconds += sample_seconds;
            }
            mouse_clicks += mouse_delta;
            key_presses += key_delta;
            input_counters.pending_day.store(
                local_observed.date_naive().num_days_from_ce() as u64,
                Ordering::Relaxed,
            );
            input_counters
                .pending_mouse_clicks
                .store(mouse_clicks as u64, Ordering::Relaxed);
            input_counters
                .pending_key_presses
                .store(key_presses as u64, Ordering::Relaxed);
        }
    });
}

#[tauri::command]
fn set_tracking(
    state: State<'_, AppState>,
    enabled: bool,
    include_titles: bool,
    detect_idle: bool,
) -> Result<(), String> {
    let _guard = state
        .activity_gate
        .lock()
        .map_err(|_| "记录设置暂时不可用")?;
    let old_enabled = state.tracking_enabled.swap(enabled, Ordering::AcqRel);
    let old_titles = state
        .title_capture_enabled
        .swap(include_titles, Ordering::AcqRel);
    let old_idle = state
        .idle_detection_enabled
        .swap(detect_idle, Ordering::AcqRel);
    if (old_enabled, old_titles, old_idle) != (enabled, include_titles, detect_idle) {
        state.tracking_changed.store(true, Ordering::Release);
    }
    Ok(())
}

fn is_local_executable_path(path: &str) -> bool {
    let bytes = path.as_bytes();
    bytes.len() > 3
        && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':'
        && bytes[2] == b'\\'
        && path.len() <= 32_767
        && !path.chars().any(char::is_control)
        && !path[2..].contains(':')
        && !path.split('\\').any(|part| part == ".." || part == ".")
        && path.to_ascii_lowercase().ends_with(".exe")
}

#[cfg(windows)]
fn application_icon_data_url(
    executable_path: Option<&str>,
    cache: &Mutex<HashMap<String, Option<String>>>,
) -> Option<String> {
    let path = executable_path?.trim();
    if !is_local_executable_path(path) {
        return None;
    }
    if let Ok(cache) = cache.lock() {
        if let Some(icon) = cache.get(path) {
            return icon.clone();
        }
    }
    let icon = windows_icons::get_icon_base64_by_path(path)
        .ok()
        .map(|value| format!("data:image/png;base64,{value}"));
    if let Ok(mut cache) = cache.lock() {
        if cache.len() >= 256 {
            cache.clear();
        }
        cache.insert(path.to_string(), icon.clone());
    }
    icon
}

#[cfg(not(windows))]
fn application_icon_data_url(
    _executable_path: Option<&str>,
    _cache: &Mutex<HashMap<String, Option<String>>>,
) -> Option<String> {
    None
}

#[tauri::command]
fn get_today_stats(state: State<'_, AppState>) -> Result<TodayStats, String> {
    let _activity_guard = state
        .activity_gate
        .lock()
        .map_err(|_| "活动统计暂时不可用")?;
    let connection = Connection::open(&state.database_path).map_err(|error| error.to_string())?;
    // A local midnight can be ambiguous or nonexistent on DST transition dates.
    // Keep the indexed candidate interval small, then let SQLite match the local date.
    let local_now = Local::now();
    let today = local_now.format("%Y-%m-%d").to_string();
    let start = (Utc::now() - chrono::Duration::days(2)).to_rfc3339();
    let end = (Utc::now() + chrono::Duration::days(2)).to_rfc3339();
    let (
        active_seconds,
        idle_seconds_total,
        app_switches,
        stored_mouse_clicks,
        stored_key_presses,
    ): (i64, i64, i64, i64, i64) = connection
            .query_row(
                "SELECT COALESCE(SUM(active_seconds), 0), COALESCE(SUM(idle_seconds), 0), COUNT(*),
                    COALESCE(SUM(mouse_clicks), 0), COALESCE(SUM(key_presses), 0)
             FROM app_usage_sessions WHERE started_at >= ?1 AND started_at < ?2 AND date(started_at, 'localtime') = ?3",
                [&start, &end, &today],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                    ))
                },
            )
            .map_err(|error| error.to_string())?;
    let mut statement = connection
        .prepare(
            "SELECT app_name, SUM(active_seconds) AS seconds,
                    MAX(NULLIF(executable_path, '')) AS executable_path
             FROM app_usage_sessions WHERE started_at >= ?1 AND started_at < ?2 AND date(started_at, 'localtime') = ?3
             GROUP BY app_name HAVING SUM(active_seconds) > 0 ORDER BY seconds DESC LIMIT 100",
        )
        .map_err(|error| error.to_string())?;
    let application_rows: Vec<(String, i64, Option<String>)> = statement
        .query_map([&start, &end, &today], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?))
        })
        .map_err(|error| error.to_string())?
        .filter_map(Result::ok)
        .collect();
    let (pending_mouse, pending_keys) = pending_counts_for_day(
        &state.input_counters,
        local_now.date_naive().num_days_from_ce() as u64,
    );
    let mouse_clicks = stored_mouse_clicks + pending_mouse;
    let key_presses = stored_key_presses + pending_keys;
    // Icon extraction can touch slow disks: never hold the sampler/settings lock here.
    drop(statement);
    drop(connection);
    drop(_activity_guard);
    let top_apps = application_rows
        .into_iter()
        .map(|(app_name, seconds, executable_path)| AppUsage {
            app_name,
            seconds,
            icon_data_url: application_icon_data_url(executable_path.as_deref(), &state.icon_cache),
        })
        .collect();
    let current_app = state
        .tracking_enabled
        .load(Ordering::Acquire)
        .then(|| foreground_application(false).map(|value| value.app_name))
        .flatten();
    Ok(TodayStats {
        active_seconds,
        idle_seconds: idle_seconds_total,
        app_switches,
        mouse_clicks,
        key_presses,
        last_input_seconds_ago: idle_seconds() as i64,
        current_app,
        top_apps,
    })
}

#[tauri::command]
fn delete_activity_data(state: State<'_, AppState>) -> Result<(), String> {
    let _activity_guard = state
        .activity_gate
        .lock()
        .map_err(|_| "活动记录暂时不可用，未执行删除")?;
    clear_activity_records(
        &state.database_path,
        &state.reset_requested,
        &state.input_counters,
    )
}

fn clear_activity_records(
    path: &Path,
    reset: &AtomicBool,
    counters: &InputCounters,
) -> Result<(), String> {
    let connection = Connection::open(path).map_err(|_| "无法打开活动数据库，未执行删除")?;
    connection
        .busy_timeout(Duration::from_secs(2))
        .map_err(|_| "活动数据库暂时不可用")?;
    connection
        .execute("DELETE FROM app_usage_sessions", [])
        .map_err(|_| "活动数据删除失败，请稍后重试")?;
    counters.pending_mouse_clicks.store(0, Ordering::Relaxed);
    counters.pending_key_presses.store(0, Ordering::Relaxed);
    reset.store(true, Ordering::Release);
    Ok(())
}

#[tauri::command]
fn data_location(state: State<'_, AppState>) -> String {
    state.database_path.display().to_string()
}

#[tauri::command]
fn show_companion_menu(app: tauri::AppHandle, window: tauri::Window) -> Result<(), String> {
    let show_item = MenuItemBuilder::with_id("show", "显示主窗口")
        .build(&app)
        .map_err(|error| error.to_string())?;
    let hide_item = MenuItemBuilder::with_id("hide_companion", "隐藏浮动球")
        .build(&app)
        .map_err(|error| error.to_string())?;
    let quit_item = MenuItemBuilder::with_id("quit", "退出 DayMate")
        .build(&app)
        .map_err(|error| error.to_string())?;
    let menu = MenuBuilder::new(&app)
        .item(&show_item)
        .item(&hide_item)
        .separator()
        .item(&quit_item)
        .build()
        .map_err(|error| error.to_string())?;
    menu.popup(window).map_err(|error| error.to_string())
}

fn show_main_window(app: &tauri::AppHandle) {
    if let Some(companion) = app.get_webview_window("companion") {
        let _ = companion.hide();
    }
    if let Some(main) = app.get_webview_window("main") {
        let _ = main.show();
        let _ = main.unminimize();
        let _ = main.set_focus();
    }
}

fn ai_key_entry(provider: &str) -> Result<keyring::Entry, String> {
    ai::provider_needs_key(provider)?;
    keyring::Entry::new(AI_KEYRING_SERVICE, provider)
        .map_err(|_| "无法访问系统 AI 凭据".to_string())
}

fn read_ai_key(
    entry: &keyring::Entry,
    provider: &str,
    destination: &reqwest::Url,
    bytes: &[u8],
) -> Result<String, String> {
    let legacy_password = if ai::is_bound_key_record(bytes) {
        None
    } else {
        Some(
            entry
                .get_password()
                .map_err(|_| "本地 AI 凭据无法读取，请重新保存密钥".to_string())?,
        )
    };
    ai::resolve_bound_key(provider, destination, bytes, legacy_password.as_deref())
}

fn load_ai_key(provider: &str, destination: &reqwest::Url) -> Result<String, String> {
    let entry = ai_key_entry(provider)?;
    let bytes = entry.get_secret().map_err(|error| match error {
        keyring::Error::NoEntry => "请先保存该服务商的 API Key".to_string(),
        _ => "无法读取系统 AI 凭据，请稍后重试".to_string(),
    })?;
    read_ai_key(&entry, provider, destination, &bytes)
}

#[tauri::command]
fn save_ai_key(
    state: State<'_, AppState>,
    provider: String,
    base_url: String,
    api_key: String,
) -> Result<(), String> {
    let record = ai::encode_bound_key(&provider, &base_url, &api_key)?;
    ai_key_entry(&provider)?
        .set_secret(&record)
        .map_err(|_| "密钥保存失败，请检查 Windows 凭据管理器".to_string())?;
    state.ai.clear_cache();
    Ok(())
}

#[tauri::command]
fn get_ai_key_status(provider: String, base_url: String) -> Result<ai::AiKeyStatus, String> {
    let entry = ai_key_entry(&provider)?;
    let bytes = match entry.get_secret() {
        Ok(bytes) => bytes,
        Err(keyring::Error::NoEntry) => {
            return Ok(ai::AiKeyStatus {
                saved: false,
                usable: false,
                message: String::new(),
            })
        }
        Err(_) => return Err("无法读取系统 AI 凭据，请稍后重试".into()),
    };
    let validated = ai::endpoint(&base_url)
        .and_then(|destination| read_ai_key(&entry, &provider, &destination, &bytes));
    Ok(ai::AiKeyStatus {
        saved: true,
        usable: validated.is_ok(),
        message: validated.err().unwrap_or_default(),
    })
}

#[tauri::command]
fn delete_ai_key(state: State<'_, AppState>, provider: String) -> Result<(), String> {
    let entry = ai_key_entry(&provider)?;
    match entry.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => {}
        Err(_) => return Err("删除系统 AI 凭据失败，请稍后重试".into()),
    };
    state.ai.clear_cache();
    Ok(())
}

#[tauri::command]
async fn test_ai_connection(
    state: State<'_, AppState>,
    provider: String,
    base_url: String,
    model: String,
    needs_key: bool,
    max_daily_calls: u32,
) -> Result<String, String> {
    let path = state.database_path.clone();
    let runtime = state.ai.clone();
    tauri::async_runtime::spawn_blocking(move || {
        runtime.test(
            &path,
            ai::AiConfig {
                provider,
                base_url,
                model,
                needs_key,
                max_daily_calls,
            },
        )
    })
    .await
    .map_err(|_| "AI 请求未能完成，请稍后重试".to_string())?
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
async fn recommend_music_with_ai(
    state: State<'_, AppState>,
    provider: String,
    base_url: String,
    model: String,
    preferred_category: String,
    scene: String,
    mood: String,
    hour: u8,
    active_minutes: Option<i64>,
    unfinished_tasks: Option<usize>,
    needs_key: bool,
    max_daily_calls: u32,
) -> Result<ai::MusicSuggestion, String> {
    let path = state.database_path.clone();
    let runtime = state.ai.clone();
    tauri::async_runtime::spawn_blocking(move || {
        runtime.recommend(
            &path,
            ai::AiConfig {
                provider,
                base_url,
                model,
                needs_key,
                max_daily_calls,
            },
            ai::MusicContext {
                preferred_category,
                scene,
                mood,
                hour,
                active_minutes,
                unfinished_tasks,
            },
        )
    })
    .await
    .map_err(|_| "AI 请求未能完成，请稍后重试".to_string())?
}

#[tauri::command]
async fn list_ai_models(
    state: State<'_, AppState>,
    provider: String,
    base_url: String,
    needs_key: bool,
    max_daily_calls: u32,
) -> Result<ai::ModelCatalog, String> {
    let path = state.database_path.clone();
    let runtime = state.ai.clone();
    tauri::async_runtime::spawn_blocking(move || {
        runtime.list_models(
            &path,
            ai::AiConfig {
                provider,
                base_url,
                model: String::new(),
                needs_key,
                max_daily_calls,
            },
        )
    })
    .await
    .map_err(|_| "模型目录请求未能完成，请稍后重试".to_string())?
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
async fn generate_encouragement(
    state: State<'_, AppState>,
    provider: String,
    base_url: String,
    model: String,
    needs_key: bool,
    max_daily_calls: u32,
    scene: String,
    mood: String,
    hour: u8,
    tone: String,
) -> Result<ai::Encouragement, String> {
    let path = state.database_path.clone();
    let runtime = state.ai.clone();
    tauri::async_runtime::spawn_blocking(move || {
        runtime.encourage(
            &path,
            ai::AiConfig {
                provider,
                base_url,
                model,
                needs_key,
                max_daily_calls,
            },
            ai::EncouragementContext {
                scene,
                mood,
                hour,
                tone,
            },
        )
    })
    .await
    .map_err(|_| "AI 鼓励未能完成，已保留本地文案".to_string())?
}

#[tauri::command]
fn get_ai_usage(state: State<'_, AppState>) -> Result<ai::AiUsage, String> {
    ai::usage(&state.database_path)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            show_main_window(app);
        }))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .setup(|app| {
            let argument_data_dir = system::data_dir_from_args().map_err(std::io::Error::other)?;
            let data_dir = std::env::var_os("DAYMATE_DATA_DIR")
                .map(PathBuf::from)
                .or(argument_data_dir)
                .unwrap_or(app.path().app_data_dir()?);
            std::fs::create_dir_all(&data_dir)?;
            app.handle().plugin(system::autostart_plugin(&data_dir))?;
            let database_path = data_dir.join("daymate.sqlite3");
            initialize_database(&database_path).map_err(std::io::Error::other)?;
            let state = AppState {
                ai: Arc::new(ai::AiRuntime::default()),
                database_path,
                tracking_enabled: Arc::new(AtomicBool::new(false)),
                title_capture_enabled: Arc::new(AtomicBool::new(false)),
                idle_detection_enabled: Arc::new(AtomicBool::new(true)),
                reset_requested: Arc::new(AtomicBool::new(false)),
                activity_gate: Arc::new(Mutex::new(())),
                tracking_changed: Arc::new(AtomicBool::new(false)),
                input_counters: Arc::new(InputCounters::default()),
                icon_cache: Mutex::new(HashMap::new()),
            };
            start_input_counter(state.input_counters.clone(), state.tracking_enabled.clone());
            start_activity_tracker(&state);
            app.manage(state);

            let show_item = MenuItemBuilder::with_id("show", "显示主窗口").build(app)?;
            let quit_item = MenuItemBuilder::with_id("quit", "退出 DayMate").build(app)?;
            let menu = MenuBuilder::new(app)
                .item(&show_item)
                .separator()
                .item(&quit_item)
                .build()?;

            let mut tray = TrayIconBuilder::new()
                .tooltip("DayMate 日伴")
                .menu(&menu)
                .show_menu_on_left_click(false);
            if let Some(icon) = app.default_window_icon() {
                tray = tray.icon(icon.clone());
            }
            tray.on_tray_icon_event(|tray, event| {
                use tauri::tray::TrayIconEvent;
                if let TrayIconEvent::Click {
                    button: tauri::tray::MouseButton::Left,
                    button_state: tauri::tray::MouseButtonState::Up,
                    ..
                } = event
                {
                    show_main_window(tray.app_handle());
                }
            })
            .on_menu_event(|app, event| match event.id().as_ref() {
                "show" => {
                    show_main_window(app);
                }
                "quit" => {
                    app.exit(0);
                }
                "hide_companion" => {
                    if let Some(window) = app.get_webview_window("companion") {
                        let _ = window.hide();
                    }
                }
                _ => {}
            })
            .build(app)?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            set_tracking,
            get_today_stats,
            delete_activity_data,
            data_location,
            show_companion_menu,
            save_ai_key,
            get_ai_key_status,
            delete_ai_key,
            test_ai_connection,
            recommend_music_with_ai,
            list_ai_models,
            generate_encouragement,
            get_ai_usage,
            system::get_system_integration_status,
            system::set_system_autostart,
            system::send_test_notification,
            system::send_focus_completed_notification
        ])
        .run(tauri::generate_context!())
        .expect("error while running DayMate");
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn sample_duration_uses_monotonic_time_and_rejects_sleep_or_clock_jumps() {
        assert_eq!(
            measured_sample_seconds(3010, Duration::from_millis(3010)),
            3
        );
        assert_eq!(
            measured_sample_seconds(7010, Duration::from_millis(3010)),
            0
        );
        assert_eq!(measured_sample_seconds(-1000, Duration::from_secs(3)), 0);
        assert_eq!(measured_sample_seconds(90_000, Duration::from_secs(90)), 0);
    }

    #[test]
    fn midnight_splits_duration_and_does_not_show_previous_day_pending_counts() {
        assert_eq!(split_midnight_sample(3, 1), (2, 1));
        assert_eq!(split_midnight_sample(3, 0), (3, 0));
        assert_eq!(split_midnight_sample(3, 3), (0, 3));
        let counters = InputCounters::default();
        counters.pending_day.store(100, Ordering::Relaxed);
        counters.pending_mouse_clicks.store(7, Ordering::Relaxed);
        counters.pending_key_presses.store(11, Ordering::Relaxed);
        assert_eq!(pending_counts_for_day(&counters, 100), (7, 11));
        assert_eq!(pending_counts_for_day(&counters, 101), (0, 0));
    }

    #[test]
    fn idle_time_handles_long_uptime_wrap_and_non_monotonic_input() {
        assert_eq!(idle_elapsed_seconds(20_000, 15_000), 5);
        assert_eq!(
            idle_elapsed_seconds(u64::from(u32::MAX) + 2_001, u32::MAX - 999),
            3
        );
        assert_eq!(idle_elapsed_seconds((1u64 << 32) + 10_000, 9_000), 1);
        assert_eq!(idle_elapsed_seconds(10_000, 10_500), 0);
        assert!(discard_sample_interval(3, true));
        assert!(discard_sample_interval(-10, false));
        assert!(discard_sample_interval(3_600, false));
        assert!(!discard_sample_interval(3, false));
        assert_eq!(input_press_transition(&mut [false; 256], 256, true), None);
    }

    #[test]
    fn icon_paths_reject_remote_devices_and_alternate_streams() {
        assert!(is_local_executable_path(r"D:\应用 文件\DayMate.exe"));
        for path in [
            r"\\server\share\app.exe",
            r"\\?\C:\app.exe",
            r"C:app.exe",
            r"C:\app.exe:stream.exe",
            r"C:\..\app.exe",
            r"https://example.com/app.exe",
            r"C:\app.dll",
        ] {
            assert!(!is_local_executable_path(path), "{path}");
        }
    }

    #[test]
    fn deletion_resets_pending_counts_without_removing_ai_usage() {
        let suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = std::env::temp_dir().join(format!("daymate-delete-{suffix}.sqlite3"));
        initialize_database(&path).unwrap();
        let db = Connection::open(&path).unwrap();
        db.execute_batch("INSERT INTO app_usage_sessions(app_name,started_at,ended_at,created_at) VALUES('test.exe','2026-01-01','2026-01-01','2026-01-01'); INSERT INTO ai_daily_usage VALUES('2026-01-01',2);").unwrap();
        let counters = InputCounters::default();
        counters.pending_key_presses.store(100, Ordering::Relaxed);
        counters.pending_mouse_clicks.store(50, Ordering::Relaxed);
        let reset = AtomicBool::new(false);
        clear_activity_records(&path, &reset, &counters).unwrap();
        assert!(reset.load(Ordering::Acquire));
        assert_eq!(counters.pending_key_presses.load(Ordering::Relaxed), 0);
        assert_eq!(counters.pending_mouse_clicks.load(Ordering::Relaxed), 0);
        assert_eq!(
            db.query_row("SELECT COUNT(*) FROM app_usage_sessions", [], |row| row
                .get::<_, i64>(0))
                .unwrap(),
            0
        );
        assert_eq!(
            db.query_row("SELECT calls FROM ai_daily_usage", [], |row| row
                .get::<_, i64>(0))
                .unwrap(),
            2
        );
        drop(db);
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn permissions_keep_the_companion_away_from_personal_data_and_credentials() {
        let main: serde_json::Value =
            serde_json::from_str(include_str!("../capabilities/default.json")).unwrap();
        let companion: serde_json::Value =
            serde_json::from_str(include_str!("../capabilities/companion.json")).unwrap();
        assert_eq!(main["windows"], serde_json::json!(["main"]));
        assert_eq!(companion["windows"], serde_json::json!(["companion"]));
        for capability in [&main, &companion] {
            assert!(capability.get("remote").is_none());
            assert!(!capability["permissions"]
                .as_array()
                .unwrap()
                .iter()
                .any(|value| value
                    .as_str()
                    .is_some_and(|id| id.ends_with(":default") || id.contains("allow-create"))));
        }
        let personal = [
            "allow-save-ai-key",
            "allow-get-ai-key-status",
            "allow-delete-ai-key",
            "allow-list-ai-models",
            "allow-generate-encouragement",
            "allow-get-today-stats",
            "allow-delete-activity-data",
            "allow-set-system-autostart",
        ];
        for permission in personal {
            assert!(main["permissions"]
                .as_array()
                .unwrap()
                .contains(&serde_json::json!(permission)));
            assert!(!companion["permissions"]
                .as_array()
                .unwrap()
                .contains(&serde_json::json!(permission)));
        }
        let source = include_str!("lib.rs");
        let registered = source
            .split("tauri::generate_handler![")
            .nth(1)
            .unwrap()
            .split(']')
            .next()
            .unwrap();
        let build = include_str!("../build.rs");
        for command in registered
            .split(',')
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            let name = command.rsplit("::").next().unwrap();
            assert!(
                build.contains(&format!("\"{name}\"")),
                "Unrestricted custom command: {name}"
            );
        }
    }

    #[test]
    fn migrates_existing_activity_database_to_input_metrics() {
        let suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time")
            .as_nanos();
        let path = std::env::temp_dir().join(format!("daymate-migration-{suffix}.sqlite3"));
        let connection = Connection::open(&path).expect("create test database");
        connection
            .execute_batch(
                "CREATE TABLE migration_history (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
                 CREATE TABLE app_usage_sessions (
                   id INTEGER PRIMARY KEY AUTOINCREMENT,
                   app_name TEXT NOT NULL,
                   window_title TEXT,
                   started_at TEXT NOT NULL,
                   ended_at TEXT NOT NULL,
                   active_seconds INTEGER NOT NULL DEFAULT 0,
                   idle_seconds INTEGER NOT NULL DEFAULT 0,
                   created_at TEXT NOT NULL
                 );
                 INSERT INTO migration_history(version, applied_at) VALUES (1, datetime('now'));",
            )
            .expect("create v1 schema");
        drop(connection);

        initialize_database(&path).expect("migrate database");
        let connection = Connection::open(&path).expect("open migrated database");
        let mut statement = connection
            .prepare("PRAGMA table_info(app_usage_sessions)")
            .expect("read columns");
        let columns: Vec<String> = statement
            .query_map([], |row| row.get(1))
            .expect("query columns")
            .filter_map(Result::ok)
            .collect();
        assert!(columns.contains(&"mouse_clicks".to_string()));
        assert!(columns.contains(&"key_presses".to_string()));
        assert!(columns.contains(&"executable_path".to_string()));
        let version: i64 = connection
            .query_row("SELECT MAX(version) FROM migration_history", [], |row| {
                row.get(0)
            })
            .expect("read migration version");
        assert_eq!(version, 5);
        drop(statement);
        drop(connection);
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn counts_only_new_keyboard_and_mouse_press_transitions() {
        let mut states = [false; 256];
        assert_eq!(
            input_press_transition(&mut states, 0x41, true),
            Some(InputKind::Keyboard)
        );
        assert_eq!(input_press_transition(&mut states, 0x41, true), None);
        assert_eq!(input_press_transition(&mut states, 0x41, false), None);
        assert_eq!(
            input_press_transition(&mut states, 0x41, true),
            Some(InputKind::Keyboard)
        );
        assert_eq!(
            input_press_transition(&mut states, 0x01, true),
            Some(InputKind::Mouse)
        );
        assert_eq!(input_press_transition(&mut states, 0x10, true), None);
        assert_eq!(
            input_press_transition(&mut states, 0xA0, true),
            Some(InputKind::Keyboard)
        );
    }

    #[test]
    fn migration_discards_unreliable_keyboard_counts_only() {
        let suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time")
            .as_nanos();
        let path = std::env::temp_dir().join(format!("daymate-input-reset-{suffix}.sqlite3"));
        let connection = Connection::open(&path).expect("create v2 database");
        connection
            .execute_batch(
                "CREATE TABLE migration_history (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
                 CREATE TABLE app_usage_sessions (
                   id INTEGER PRIMARY KEY AUTOINCREMENT,
                   app_name TEXT NOT NULL,
                   window_title TEXT,
                   started_at TEXT NOT NULL,
                   ended_at TEXT NOT NULL,
                   active_seconds INTEGER NOT NULL DEFAULT 0,
                   idle_seconds INTEGER NOT NULL DEFAULT 0,
                   created_at TEXT NOT NULL,
                   mouse_clicks INTEGER NOT NULL DEFAULT 0,
                   key_presses INTEGER NOT NULL DEFAULT 0
                 );
                 INSERT INTO migration_history(version, applied_at) VALUES (2, datetime('now'));
                 INSERT INTO app_usage_sessions
                   (app_name, started_at, ended_at, created_at, mouse_clicks, key_presses)
                 VALUES ('test.exe', datetime('now'), datetime('now'), datetime('now'), 42, 999);",
            )
            .expect("create v2 schema and data");
        drop(connection);

        initialize_database(&path).expect("migrate database");
        let connection = Connection::open(&path).expect("open migrated database");
        let (mouse_clicks, key_presses): (i64, i64) = connection
            .query_row(
                "SELECT mouse_clicks, key_presses FROM app_usage_sessions LIMIT 1",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .expect("read migrated input counts");
        assert_eq!(mouse_clicks, 42);
        assert_eq!(key_presses, 0);
        let version: i64 = connection
            .query_row("SELECT MAX(version) FROM migration_history", [], |row| {
                row.get(0)
            })
            .expect("read migration version");
        assert_eq!(version, 5);
        initialize_database(&path).expect("reopening keeps the migrated database intact");
        drop(connection);
        let _ = std::fs::remove_file(path);
    }

    #[test]
    #[cfg(windows)]
    fn extracts_and_caches_a_windows_application_icon() {
        let windows_dir = std::env::var("WINDIR").expect("Windows directory");
        let executable = PathBuf::from(windows_dir)
            .join("System32")
            .join("notepad.exe");
        let cache = Mutex::new(HashMap::new());
        let icon = application_icon_data_url(executable.to_str(), &cache)
            .expect("extract notepad application icon");
        assert!(icon.starts_with("data:image/png;base64,"));
        assert_eq!(cache.lock().expect("icon cache").len(), 1);
        assert_eq!(
            application_icon_data_url(executable.to_str(), &cache),
            Some(icon)
        );
    }
}
