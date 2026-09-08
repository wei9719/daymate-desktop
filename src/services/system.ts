import { invoke, isTauri } from "@tauri-apps/api/core";

export interface SystemIntegrationStatus {
  autostartEnabled: boolean;
  notificationPermission: "granted" | "denied" | "prompt" | "unknown";
  notificationStatusNote: string;
  autostartLaunch: boolean;
}

function requireDesktop() {
  if (!isTauri())
    throw new Error("请在 DayMate 桌面版中使用系统启动与通知功能");
}

export async function getSystemIntegrationStatus() {
  requireDesktop();
  return invoke<SystemIntegrationStatus>("get_system_integration_status");
}

export async function setSystemAutostart(enabled: boolean) {
  requireDesktop();
  return invoke<boolean>("set_system_autostart", { enabled });
}

export async function sendTestNotification() {
  requireDesktop();
  await invoke<void>("send_test_notification");
}

export async function sendFocusCompletedNotification() {
  requireDesktop();
  await invoke<void>("send_focus_completed_notification");
}
