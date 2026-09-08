fn main() {
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "set_tracking",
            "get_today_stats",
            "delete_activity_data",
            "data_location",
            "show_companion_menu",
            "save_ai_key",
            "get_ai_key_status",
            "delete_ai_key",
            "test_ai_connection",
            "recommend_music_with_ai",
            "list_ai_models",
            "generate_encouragement",
            "get_ai_usage",
            "get_system_integration_status",
            "set_system_autostart",
            "send_test_notification",
            "send_focus_completed_notification",
        ]),
    ))
    .expect("failed to build the application permission manifest");
}
