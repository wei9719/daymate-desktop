"""Synthetic v4 SQLite data for GitHub-hosted Windows installation tests only."""

import argparse
import os
from pathlib import Path
import sqlite3


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("operation", choices=("create", "verify"))
    parser.add_argument("database", type=Path)
    args = parser.parse_args()
    if (
        os.environ.get("GITHUB_ACTIONS") != "true"
        or os.environ.get("RUNNER_ENVIRONMENT") != "github-hosted"
        or os.environ.get("RUNNER_OS") != "Windows"
    ):
        raise SystemExit("Fixtures may only be used on GitHub-hosted Windows runners.")
    temp_value = os.environ.get("RUNNER_TEMP")
    if not temp_value or not Path(temp_value).is_absolute():
        raise SystemExit("RUNNER_TEMP must be an absolute path.")
    path = args.database.resolve()
    path.relative_to(Path(temp_value).resolve())
    if args.operation == "create":
        if path.exists():
            raise SystemExit("Refusing to replace an existing database.")
        with sqlite3.connect(path) as connection:
            connection.executescript(r"""
                CREATE TABLE migration_history (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
                INSERT INTO migration_history VALUES (1, '2099-01-01'), (2, '2099-01-01'),
                    (3, '2099-01-01'), (4, '2099-01-01');
                CREATE TABLE app_usage_sessions (
                    id INTEGER PRIMARY KEY AUTOINCREMENT, app_name TEXT NOT NULL,
                    window_title TEXT, started_at TEXT NOT NULL, ended_at TEXT NOT NULL,
                    active_seconds INTEGER NOT NULL DEFAULT 0, idle_seconds INTEGER NOT NULL DEFAULT 0,
                    created_at TEXT NOT NULL, mouse_clicks INTEGER NOT NULL DEFAULT 0,
                    key_presses INTEGER NOT NULL DEFAULT 0, executable_path TEXT
                );
                INSERT INTO app_usage_sessions
                    (app_name, started_at, ended_at, active_seconds, idle_seconds, created_at,
                     mouse_clicks, key_presses, executable_path)
                VALUES ('fixture-editor.exe', '2099-01-01T10:00:00Z', '2099-01-01T10:02:48Z',
                    123, 45, '2099-01-01T10:02:48Z', 7, 11, 'D:\合成 测试\editor.exe');
            """)
        print("PASS: created synthetic v4 data; no personal records were used.")
    else:
        with sqlite3.connect(path.as_uri() + "?mode=ro", uri=True) as connection:
            assert connection.execute("PRAGMA quick_check").fetchone() == ("ok",), "Database integrity failed"
            version = connection.execute("SELECT MAX(version) FROM migration_history").fetchone()[0]
            assert version >= 5, "The v4 database was not migrated"
            row = connection.execute("""
                SELECT active_seconds, idle_seconds, mouse_clicks, key_presses, executable_path
                FROM app_usage_sessions WHERE app_name = 'fixture-editor.exe'
            """).fetchall()
            assert row == [(123, 45, 7, 11, "D:\\合成 测试\\editor.exe")], "Synthetic history changed or disappeared"
            connection.execute("SELECT date, calls FROM ai_daily_usage LIMIT 1").fetchall()
        print("PASS: v4 history survived migration and the AI usage table exists.")


if __name__ == "__main__":
    main()
