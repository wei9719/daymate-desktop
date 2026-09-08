use rusqlite::{Connection, TransactionBehavior};
use std::{path::Path, time::Duration};

pub const SCHEMA_VERSION: i64 = 5;

fn columns(connection: &Connection) -> rusqlite::Result<Vec<String>> {
    connection
        .prepare("PRAGMA table_info(app_usage_sessions)")?
        .query_map([], |row| row.get(1))?
        .collect()
}

pub fn initialize_database(path: &Path) -> Result<(), String> {
    let mut connection = Connection::open(path)
        .map_err(|_| "无法打开本地数据库，请检查数据目录权限和可用空间".to_string())?;
    connection
        .busy_timeout(Duration::from_secs(2))
        .map_err(|_| "无法初始化数据库等待策略".to_string())?;
    let has_history: bool = connection
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='migration_history')",
            [],
            |row| row.get(0),
        )
        .map_err(|_| "数据库无法读取，请保留文件并从备份恢复".to_string())?;
    let version: i64 = if has_history {
        connection
            .query_row(
                "SELECT COALESCE(MAX(version), 0) FROM migration_history",
                [],
                |row| row.get(0),
            )
            .map_err(|_| "数据库版本信息无效，已停止修改".to_string())?
    } else {
        0
    };
    if !(0..=SCHEMA_VERSION).contains(&version) {
        return Err(
            "数据库来自更新版本或版本信息无效；请使用匹配的 DayMate，原数据未被修改".into(),
        );
    }
    // Check the version before any schema or journal change. Each upgrade commits as a unit.
    let mut migrate = || -> rusqlite::Result<()> {
        connection.execute_batch("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;")?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        transaction.execute_batch(
            "CREATE TABLE IF NOT EXISTS migration_history (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
             CREATE TABLE IF NOT EXISTS app_usage_sessions (
               id INTEGER PRIMARY KEY AUTOINCREMENT, app_name TEXT NOT NULL, window_title TEXT,
               started_at TEXT NOT NULL, ended_at TEXT NOT NULL,
               active_seconds INTEGER NOT NULL DEFAULT 0, idle_seconds INTEGER NOT NULL DEFAULT 0,
               created_at TEXT NOT NULL
             );",
        )?;
        let known_columns = columns(&transaction)?;
        for name in [
            "id",
            "app_name",
            "window_title",
            "started_at",
            "ended_at",
            "active_seconds",
            "idle_seconds",
            "created_at",
        ] {
            if !known_columns.iter().any(|column| column == name) {
                return Err(rusqlite::Error::InvalidColumnName(name.into()));
            }
        }
        transaction.execute_batch(
            "CREATE INDEX IF NOT EXISTS idx_usage_started_at ON app_usage_sessions(started_at);
             CREATE INDEX IF NOT EXISTS idx_usage_app_name ON app_usage_sessions(app_name);
             INSERT OR IGNORE INTO migration_history(version, applied_at) VALUES (1, datetime('now'));",
        )?;
        if version < 2 {
            // Recover old partially applied ALTER statements without discarding valid rows.
            for name in ["mouse_clicks", "key_presses"] {
                if !known_columns.iter().any(|column| column == name) {
                    transaction.execute_batch(&format!("ALTER TABLE app_usage_sessions ADD COLUMN {name} INTEGER NOT NULL DEFAULT 0;"))?;
                }
            }
            transaction.execute(
                "INSERT INTO migration_history VALUES (2, datetime('now'))",
                [],
            )?;
        }
        if version < 3 {
            transaction.execute_batch("UPDATE app_usage_sessions SET key_presses=0; INSERT INTO migration_history VALUES (3, datetime('now'));")?;
        }
        if version < 4 {
            if !known_columns
                .iter()
                .any(|column| column == "executable_path")
            {
                transaction.execute_batch(
                    "ALTER TABLE app_usage_sessions ADD COLUMN executable_path TEXT;",
                )?;
            }
            transaction.execute(
                "INSERT INTO migration_history VALUES (4, datetime('now'))",
                [],
            )?;
        }
        if version < 5 {
            transaction.execute_batch("CREATE TABLE IF NOT EXISTS ai_daily_usage (date TEXT PRIMARY KEY, calls INTEGER NOT NULL DEFAULT 0 CHECK(calls >= 0)); INSERT INTO migration_history VALUES (5, datetime('now'));")?;
        }
        // A broken current-version schema must not be silently treated as a fresh database.
        transaction.prepare(
            "SELECT mouse_clicks, key_presses, executable_path FROM app_usage_sessions LIMIT 0",
        )?;
        transaction.prepare("SELECT date, calls FROM ai_daily_usage LIMIT 0")?;
        transaction.commit()
    };
    migrate().map_err(|_| "数据库升级未完成，事务已回滚；请保留原文件并检查权限或恢复备份".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn path(label: &str) -> std::path::PathBuf {
        let id = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!("daymate-{label}-{id}.sqlite3"))
    }

    #[test]
    fn refuses_newer_schema_without_recreating_tables() {
        let file = path("future");
        let db = Connection::open(&file).unwrap();
        db.execute_batch("CREATE TABLE migration_history(version INTEGER PRIMARY KEY, applied_at TEXT); INSERT INTO migration_history VALUES (6, 'future');").unwrap();
        assert!(initialize_database(&file).unwrap_err().contains("更新版本"));
        assert_eq!(
            db.query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE name='app_usage_sessions'",
                [],
                |row| row.get::<_, i64>(0)
            )
            .unwrap(),
            0
        );
        drop(db);
        let _ = std::fs::remove_file(file);
    }

    #[test]
    fn broken_schema_rolls_back_migration_metadata() {
        let file = path("rollback");
        let db = Connection::open(&file).unwrap();
        db.execute_batch("CREATE TABLE app_usage_sessions(id INTEGER PRIMARY KEY, app_name TEXT);")
            .unwrap();
        assert!(initialize_database(&file).is_err());
        assert_eq!(
            db.query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE name='migration_history'",
                [],
                |row| row.get::<_, i64>(0)
            )
            .unwrap(),
            0
        );
        assert_eq!(columns(&db).unwrap(), vec!["id", "app_name"]);
        drop(db);
        let _ = std::fs::remove_file(file);
    }

    #[test]
    fn repairs_a_partial_legacy_upgrade_and_preserves_valid_metrics() {
        let file = path("partial");
        let db = Connection::open(&file).unwrap();
        db.execute_batch("CREATE TABLE migration_history(version INTEGER PRIMARY KEY, applied_at TEXT); INSERT INTO migration_history VALUES (1, 'legacy');
          CREATE TABLE app_usage_sessions(id INTEGER PRIMARY KEY, app_name TEXT, window_title TEXT, started_at TEXT, ended_at TEXT, active_seconds INTEGER, idle_seconds INTEGER, created_at TEXT, mouse_clicks INTEGER);
          INSERT INTO app_usage_sessions VALUES(1,'legacy.exe',NULL,'2026-01-01','2026-01-01',123,4,'2026-01-01',7);").unwrap();
        initialize_database(&file).unwrap();
        initialize_database(&file).unwrap();
        assert_eq!(
            db.query_row(
                "SELECT active_seconds, mouse_clicks, key_presses FROM app_usage_sessions",
                [],
                |row| Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, i64>(2)?
                ))
            )
            .unwrap(),
            (123, 7, 0)
        );
        assert_eq!(
            db.query_row("SELECT MAX(version) FROM migration_history", [], |row| row
                .get::<_, i64>(
                0
            ))
            .unwrap(),
            SCHEMA_VERSION
        );
        drop(db);
        let _ = std::fs::remove_file(file);
    }
}
