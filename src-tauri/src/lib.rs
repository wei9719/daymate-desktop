use chrono::{DateTime, Local, Utc};
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
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
    database_path: PathBuf,
    tracking_enabled: Arc<AtomicBool>,
    title_capture_enabled: Arc<AtomicBool>,
    idle_detection_enabled: Arc<AtomicBool>,
    reset_requested: Arc<AtomicBool>,
    input_counters: Arc<InputCounters>,
    icon_cache: Mutex<HashMap<String, Option<String>>>,
}

#[derive(Default)]
struct InputCounters {
    mouse_clicks: AtomicU64,
    key_presses: AtomicU64,
    pending_mouse_clicks: AtomicU64,
    pending_key_presses: AtomicU64,
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

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct AiMusicSuggestion {
    category: String,
    reason: String,
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
    let was_down = previous_states[virtual_key];
    previous_states[virtual_key] = is_down;
    (!was_down && is_down)
        .then(|| input_kind(virtual_key))
        .flatten()
}

fn initialize_database(path: &Path) -> Result<(), String> {
    let connection = Connection::open(path).map_err(|error| error.to_string())?;
    connection
        .execute_batch(
            "PRAGMA journal_mode = WAL;
             PRAGMA foreign_keys = ON;
             CREATE TABLE IF NOT EXISTS migration_history (
               version INTEGER PRIMARY KEY,
               applied_at TEXT NOT NULL
             );
             CREATE TABLE IF NOT EXISTS app_usage_sessions (
               id INTEGER PRIMARY KEY AUTOINCREMENT,
               app_name TEXT NOT NULL,
               window_title TEXT,
               started_at TEXT NOT NULL,
               ended_at TEXT NOT NULL,
               active_seconds INTEGER NOT NULL DEFAULT 0,
               idle_seconds INTEGER NOT NULL DEFAULT 0,
               created_at TEXT NOT NULL
             );
             CREATE INDEX IF NOT EXISTS idx_usage_started_at ON app_usage_sessions(started_at);
             CREATE INDEX IF NOT EXISTS idx_usage_app_name ON app_usage_sessions(app_name);
             INSERT OR IGNORE INTO migration_history(version, applied_at) VALUES (1, datetime('now'));",
        )
        .map_err(|error| error.to_string())?;
    let version: i64 = connection
        .query_row(
            "SELECT COALESCE(MAX(version), 0) FROM migration_history",
            [],
            |row| row.get(0),
        )
        .map_err(|error| error.to_string())?;
    if version < 2 {
        connection
            .execute_batch(
                "ALTER TABLE app_usage_sessions ADD COLUMN mouse_clicks INTEGER NOT NULL DEFAULT 0;
                 ALTER TABLE app_usage_sessions ADD COLUMN key_presses INTEGER NOT NULL DEFAULT 0;
                 INSERT INTO migration_history(version, applied_at) VALUES (2, datetime('now'));",
            )
            .map_err(|error| error.to_string())?;
    }
    if version < 3 {
        connection
            .execute_batch(
                "UPDATE app_usage_sessions SET key_presses = 0;
                 INSERT INTO migration_history(version, applied_at) VALUES (3, datetime('now'));",
            )
            .map_err(|error| error.to_string())?;
    }
    if version < 4 {
        connection
            .execute_batch(
                "ALTER TABLE app_usage_sessions ADD COLUMN executable_path TEXT;
                 INSERT INTO migration_history(version, applied_at) VALUES (4, datetime('now'));",
            )
            .map_err(|error| error.to_string())?;
    }
    Ok(())
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
        GetTickCount64().saturating_sub(info.dwTime as u64) / 1000
    }
}

#[cfg(windows)]
fn start_input_counter(counters: Arc<InputCounters>) {
    thread::spawn(move || {
        use windows_sys::Win32::UI::Input::KeyboardAndMouse::GetAsyncKeyState;
        let mut previous_states = [false; 256];
        loop {
            for virtual_key in 1..=254 {
                let is_down = unsafe { GetAsyncKeyState(virtual_key as i32) } as u16 & 0x8000 != 0;
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
            thread::sleep(Duration::from_millis(20));
        }
    });
}

#[cfg(not(windows))]
fn start_input_counter(_counters: Arc<InputCounters>) {}

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

        loop {
            thread::sleep(Duration::from_secs(3));
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
            }
            let total_mouse_clicks = input_counters.mouse_clicks.load(Ordering::Relaxed);
            let total_key_presses = input_counters.key_presses.load(Ordering::Relaxed);
            let mouse_delta = total_mouse_clicks.saturating_sub(previous_mouse_clicks) as i64;
            let key_delta = total_key_presses.saturating_sub(previous_key_presses) as i64;
            previous_mouse_clicks = total_mouse_clicks;
            previous_key_presses = total_key_presses;
            if !tracking_enabled.load(Ordering::Relaxed) {
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
            let day_changed = Local::now().date_naive() != current_day;
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
                    Utc::now(),
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
                started_at = Utc::now();
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
                current_day = Local::now().date_naive();
            }
            if current_app.is_empty() {
                current_app = app_name;
                current_title = title;
                current_executable_path = executable_path;
                started_at = Utc::now();
            }
            if is_idle {
                inactive_seconds += 3;
            } else if !current_app.eq_ignore_ascii_case("daymate-desktop.exe") {
                active_seconds += 3;
            }
            mouse_clicks += mouse_delta;
            key_presses += key_delta;
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
) {
    state.tracking_enabled.store(enabled, Ordering::Relaxed);
    state
        .title_capture_enabled
        .store(include_titles, Ordering::Relaxed);
    state
        .idle_detection_enabled
        .store(detect_idle, Ordering::Relaxed);
}

#[cfg(windows)]
fn application_icon_data_url(
    executable_path: Option<&str>,
    cache: &Mutex<HashMap<String, Option<String>>>,
) -> Option<String> {
    let path = executable_path?.trim();
    if path.is_empty() {
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
    let connection = Connection::open(&state.database_path).map_err(|error| error.to_string())?;
    let start = Local::now()
        .date_naive()
        .and_hms_opt(0, 0, 0)
        .expect("valid start of day")
        .and_local_timezone(Local)
        .single()
        .expect("valid local date")
        .with_timezone(&Utc)
        .to_rfc3339();
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
             FROM app_usage_sessions WHERE started_at >= ?1",
                [&start],
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
             FROM app_usage_sessions WHERE started_at >= ?1
             GROUP BY app_name HAVING SUM(active_seconds) > 0 ORDER BY seconds DESC",
        )
        .map_err(|error| error.to_string())?;
    let application_rows: Vec<(String, i64, Option<String>)> = statement
        .query_map([&start], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
        .map_err(|error| error.to_string())?
        .filter_map(Result::ok)
        .collect();
    let top_apps = application_rows
        .into_iter()
        .map(|(app_name, seconds, executable_path)| AppUsage {
            app_name,
            seconds,
            icon_data_url: application_icon_data_url(executable_path.as_deref(), &state.icon_cache),
        })
        .collect();
    let current_app = foreground_application(false).map(|value| value.app_name);
    let mouse_clicks = stored_mouse_clicks
        + state
            .input_counters
            .pending_mouse_clicks
            .load(Ordering::Relaxed) as i64;
    let key_presses = stored_key_presses
        + state
            .input_counters
            .pending_key_presses
            .load(Ordering::Relaxed) as i64;
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
    state.reset_requested.store(true, Ordering::Relaxed);
    Connection::open(&state.database_path)
        .and_then(|connection| connection.execute("DELETE FROM app_usage_sessions", []))
        .map(|_| ())
        .map_err(|error| error.to_string())
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
    if provider.is_empty()
        || !provider.chars().all(|character| {
            character.is_ascii_alphanumeric() || character == '-' || character == '_'
        })
    {
        return Err("无效的 AI 服务商标识".into());
    }
    keyring::Entry::new(AI_KEYRING_SERVICE, provider).map_err(|error| error.to_string())
}

#[tauri::command]
fn save_ai_key(provider: String, api_key: String) -> Result<(), String> {
    let api_key = api_key.trim();
    if api_key.is_empty() {
        return Err("API Key 不能为空".into());
    }
    ai_key_entry(&provider)?
        .set_password(api_key)
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn has_ai_key(provider: String) -> Result<bool, String> {
    Ok(ai_key_entry(&provider)?.get_password().is_ok())
}

#[tauri::command]
fn delete_ai_key(provider: String) -> Result<(), String> {
    let entry = ai_key_entry(&provider)?;
    if entry.get_password().is_ok() {
        entry
            .delete_credential()
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

fn send_ai_request(
    request: reqwest::blocking::RequestBuilder,
    error_prefix: &str,
) -> Result<reqwest::blocking::Response, String> {
    let retry = request.try_clone();
    match request.send() {
        Ok(response) => Ok(response),
        Err(error) if error.is_connect() || error.is_timeout() => {
            let Some(retry) = retry else {
                return Err(format!("{error_prefix}：{error}"));
            };
            thread::sleep(Duration::from_millis(350));
            retry
                .send()
                .map_err(|retry_error| format!("{error_prefix}：{retry_error}"))
        }
        Err(error) => Err(format!("{error_prefix}：{error}")),
    }
}

#[tauri::command]
fn test_ai_connection(
    provider: String,
    base_url: String,
    model: String,
    needs_key: bool,
) -> Result<String, String> {
    let base_url = base_url.trim().trim_end_matches('/');
    let is_local =
        base_url.starts_with("http://127.0.0.1") || base_url.starts_with("http://localhost");
    if !base_url.starts_with("https://") && !is_local {
        return Err("远程 AI 接口必须使用 HTTPS；仅本机 Ollama 可使用 HTTP".into());
    }
    if model.trim().is_empty() {
        return Err("模型名称不能为空".into());
    }
    let mut request = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(20))
        .build()
        .map_err(|error| error.to_string())?
        .post(format!("{base_url}/chat/completions"))
        .json(&serde_json::json!({
            "model": model.trim(),
            "messages": [{ "role": "user", "content": "请只回复：连接成功" }],
            "max_tokens": 16,
            "temperature": 0
        }));
    if needs_key {
        let key = ai_key_entry(&provider)?
            .get_password()
            .map_err(|_| "请先保存该服务商的 API Key".to_string())?;
        request = request.bearer_auth(key);
    }
    let response = send_ai_request(request, "连接失败")?;
    let status = response.status();
    if !status.is_success() {
        let detail = response.text().unwrap_or_default();
        let detail = detail.chars().take(180).collect::<String>();
        return Err(format!("接口返回 {status}：{detail}"));
    }
    Ok("连接成功，配置可以使用。".into())
}

#[tauri::command]
fn recommend_music_with_ai(
    provider: String,
    base_url: String,
    model: String,
    preferred_category: String,
    active_minutes: i64,
    unfinished_tasks: usize,
) -> Result<AiMusicSuggestion, String> {
    let base_url = base_url.trim().trim_end_matches('/');
    let is_local =
        base_url.starts_with("http://127.0.0.1") || base_url.starts_with("http://localhost");
    if !base_url.starts_with("https://") && !is_local {
        return Err("远程 AI 接口必须使用 HTTPS".into());
    }
    let prompt = format!(
        "你是温和的音乐陪伴助手。根据这些最小化汇总数据选择一个音乐类别：当前偏好={preferred_category}，今日电脑活跃={active_minutes}分钟，未完成任务={unfinished_tasks}项。只能从 smart、focus、chinese、classical、ambient、electronic 中选一个。只返回JSON：{{\"category\":\"focus\",\"reason\":\"一句不超过40字的中文理由\"}}。不要推荐具体商业歌曲。"
    );
    let mut request = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(25))
        .build()
        .map_err(|error| error.to_string())?
        .post(format!("{base_url}/chat/completions"))
        .json(&serde_json::json!({
            "model": model.trim(),
            "messages": [{ "role": "user", "content": prompt }],
            "max_tokens": 120,
            "temperature": 0.4
        }));
    if provider != "ollama" {
        let key = ai_key_entry(&provider)?
            .get_password()
            .map_err(|_| "请先在设置中保存该服务商的 API Key".to_string())?;
        request = request.bearer_auth(key);
    }
    let response = send_ai_request(request, "AI 推荐失败")?;
    if !response.status().is_success() {
        return Err(format!("AI 接口返回 {}", response.status()));
    }
    let body: serde_json::Value = response.json().map_err(|error| error.to_string())?;
    let content = body["choices"][0]["message"]["content"]
        .as_str()
        .ok_or("AI 没有返回可读取的推荐")?;
    let start = content.find('{').ok_or("AI 推荐格式不正确")?;
    let end = content.rfind('}').ok_or("AI 推荐格式不正确")?;
    let suggestion: AiMusicSuggestion =
        serde_json::from_str(&content[start..=end]).map_err(|_| "AI 推荐格式不正确")?;
    if ![
        "smart",
        "focus",
        "chinese",
        "classical",
        "ambient",
        "electronic",
    ]
    .contains(&suggestion.category.as_str())
    {
        return Err("AI 返回了不支持的音乐类别".into());
    }
    Ok(suggestion)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            show_main_window(app);
        }))
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let data_dir = std::env::var_os("DAYMATE_DATA_DIR")
                .map(PathBuf::from)
                .unwrap_or(app.path().app_data_dir()?);
            std::fs::create_dir_all(&data_dir)?;
            let database_path = data_dir.join("daymate.sqlite3");
            initialize_database(&database_path).map_err(std::io::Error::other)?;
            let state = AppState {
                database_path,
                tracking_enabled: Arc::new(AtomicBool::new(true)),
                title_capture_enabled: Arc::new(AtomicBool::new(false)),
                idle_detection_enabled: Arc::new(AtomicBool::new(true)),
                reset_requested: Arc::new(AtomicBool::new(false)),
                input_counters: Arc::new(InputCounters::default()),
                icon_cache: Mutex::new(HashMap::new()),
            };
            start_input_counter(state.input_counters.clone());
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
            has_ai_key,
            delete_ai_key,
            test_ai_connection,
            recommend_music_with_ai
        ])
        .run(tauri::generate_context!())
        .expect("error while running DayMate");
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

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
        assert_eq!(version, 4);
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
        assert_eq!(version, 4);
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
