use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use serde::Serialize;
use std::path::{Path, PathBuf};
use tauri::AppHandle;
use tauri_plugin_autostart::ManagerExt;
use tauri_plugin_notification::NotificationExt;

const DATA_DIR_ARGUMENT: &str = "--daymate-data-dir-base64=";

#[derive(Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum NotificationPermission {
    Granted,
    Denied,
    Unknown,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemIntegrationStatus {
    autostart_enabled: bool,
    notification_permission: NotificationPermission,
    notification_status_note: String,
    autostart_launch: bool,
}

fn autostart_arguments(data_dir: &Path) -> Vec<String> {
    vec![
        "--autostart".into(),
        format!(
            "{DATA_DIR_ARGUMENT}{}",
            URL_SAFE_NO_PAD.encode(data_dir.to_string_lossy().as_bytes())
        ),
    ]
}

pub fn autostart_plugin(data_dir: &Path) -> tauri::plugin::TauriPlugin<tauri::Wry> {
    tauri_plugin_autostart::Builder::new()
        .app_name("DayMate")
        .args(autostart_arguments(data_dir))
        .build()
}

fn parse_data_dir_arguments(
    arguments: impl IntoIterator<Item = String>,
) -> Result<Option<PathBuf>, String> {
    let mut result = None;
    for argument in arguments {
        let Some(encoded) = argument.strip_prefix(DATA_DIR_ARGUMENT) else {
            continue;
        };
        if result.is_some() {
            return Err("启动参数重复指定了数据目录".into());
        }
        let decoded = URL_SAFE_NO_PAD
            .decode(encoded)
            .map_err(|_| "启动数据目录参数无效".to_string())?;
        let value = String::from_utf8(decoded).map_err(|_| "启动数据目录编码无效".to_string())?;
        let path = PathBuf::from(value);
        if !path.is_absolute() {
            return Err("启动数据目录必须使用完整路径".into());
        }
        result = Some(path);
    }
    Ok(result)
}

pub fn data_dir_from_args() -> Result<Option<PathBuf>, String> {
    parse_data_dir_arguments(std::env::args().skip(1))
}

pub fn is_autostart_launch() -> bool {
    std::env::args()
        .skip(1)
        .any(|argument| argument == "--autostart")
}

fn notification_setting(setting: Option<i32>) -> (NotificationPermission, &'static str) {
    match setting {
        Some(0) => (
            NotificationPermission::Granted,
            "Windows 允许通知；勿扰模式仍可能隐藏横幅。",
        ),
        Some(1) => (
            NotificationPermission::Denied,
            "Windows 已关闭 DayMate 通知，请在系统设置中开启。",
        ),
        Some(2) => (
            NotificationPermission::Denied,
            "Windows 已关闭当前用户的通知，请检查系统通知设置。",
        ),
        Some(3) => (NotificationPermission::Denied, "通知受到系统管理策略限制。"),
        Some(4) => (
            NotificationPermission::Denied,
            "当前程序尚未注册 Windows 通知，请安装正式版本后重试。",
        ),
        _ => (
            NotificationPermission::Unknown,
            "暂时无法确认系统通知状态；请使用测试按钮并检查 Windows 通知设置。",
        ),
    }
}

#[cfg(windows)]
fn system_notification_permission(app: &AppHandle) -> (NotificationPermission, &'static str) {
    use windows::{core::HSTRING, UI::Notifications::ToastNotificationManager};
    // The official plugin returns Granted on desktop without querying Windows.
    // Read the same application identifier used by the installed notification sender.
    let setting = ToastNotificationManager::CreateToastNotifierWithId(&HSTRING::from(
        app.config().identifier.as_str(),
    ))
    .and_then(|notifier| notifier.Setting())
    .ok()
    .map(|setting| setting.0);
    notification_setting(setting)
}

#[cfg(not(windows))]
fn system_notification_permission(_app: &AppHandle) -> (NotificationPermission, &'static str) {
    notification_setting(None)
}

#[tauri::command]
pub fn get_system_integration_status(app: AppHandle) -> Result<SystemIntegrationStatus, String> {
    let autostart_enabled = app
        .autolaunch()
        .is_enabled()
        .map_err(|_| "无法读取系统开机启动状态，请稍后重试".to_string())?;
    let (notification_permission, note) = system_notification_permission(&app);
    Ok(SystemIntegrationStatus {
        autostart_enabled,
        notification_permission,
        notification_status_note: note.into(),
        autostart_launch: is_autostart_launch(),
    })
}

#[tauri::command]
pub fn set_system_autostart(app: AppHandle, enabled: bool) -> Result<bool, String> {
    let manager = app.autolaunch();
    if enabled {
        manager.enable()
    } else {
        manager.disable()
    }
    .map_err(|_| "修改开机启动失败，请检查系统权限后重试".to_string())?;
    manager
        .is_enabled()
        .map_err(|_| "无法确认修改后的开机启动状态，请重新打开设置检查".to_string())
}

fn submit_notification(app: &AppHandle, title: &str, body: &str) -> Result<(), String> {
    let (permission, note) = system_notification_permission(app);
    if permission == NotificationPermission::Denied {
        return Err(note.into());
    }
    app.notification()
        .builder()
        .title(title)
        .body(body)
        .show()
        .map_err(|_| "通知请求未能提交，请检查 Windows 通知设置".to_string())
}

#[tauri::command]
pub fn send_test_notification(app: AppHandle) -> Result<(), String> {
    submit_notification(
        &app,
        "DayMate 日伴 · 通知测试",
        "看到这条消息，就说明提醒可以送达。你随时可以在设置中关闭提醒。",
    )
}

#[tauri::command]
pub fn send_focus_completed_notification(app: AppHandle) -> Result<(), String> {
    submit_notification(
        &app,
        "DayMate 日伴 · 专注结束",
        "这一段专注已经完成，喝口水、活动一下吧。",
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preserves_unicode_and_spaces_in_autostart_data_directory() {
        let path = if cfg!(windows) {
            PathBuf::from(r"D:\DayMate 测试\个人数据")
        } else {
            PathBuf::from("/tmp/DayMate 测试/个人数据")
        };
        let arguments = autostart_arguments(&path);
        assert_eq!(arguments[0], "--autostart");
        assert!(!arguments[1].contains(' '));
        assert_eq!(parse_data_dir_arguments(arguments), Ok(Some(path)));
    }

    #[test]
    fn rejects_invalid_relative_and_duplicate_data_directory_arguments() {
        assert!(parse_data_dir_arguments([format!("{DATA_DIR_ARGUMENT}???")]).is_err());
        assert!(parse_data_dir_arguments([format!(
            "{DATA_DIR_ARGUMENT}{}",
            URL_SAFE_NO_PAD.encode("relative/data")
        )])
        .is_err());
        let path = std::env::current_dir().expect("test directory");
        let mut arguments = autostart_arguments(&path);
        arguments.push(arguments[1].clone());
        assert!(parse_data_dir_arguments(arguments).is_err());
        assert_eq!(parse_data_dir_arguments(["--autostart".into()]), Ok(None));
    }

    #[test]
    fn maps_windows_notification_policy_without_assuming_permission() {
        assert_eq!(
            notification_setting(Some(0)).0,
            NotificationPermission::Granted
        );
        for setting in 1..=4 {
            assert_eq!(
                notification_setting(Some(setting)).0,
                NotificationPermission::Denied
            );
        }
        assert_eq!(
            notification_setting(None).0,
            NotificationPermission::Unknown
        );
        assert_eq!(
            notification_setting(Some(99)).0,
            NotificationPermission::Unknown
        );
    }
}
