---
title: Automated backups
nextjs:
  metadata:
    title: Automated backups
    description: Schedule daily SQLite backups with automatic retention using the cron scheduler.
---

Since Stanza uses a single SQLite file for all data, backups are trivially simple — use `db.Backup()` which calls `VACUUM INTO` to create a complete, consistent copy including all WAL data. This recipe sets up automated daily backups with a retention policy using the built-in cron scheduler.

---

## Daily backup cron job

Register a cron job that backs up the database to the backups directory every day at 2:00 AM:

```go
if err := scheduler.Add("daily-backup", "0 2 * * *", func(ctx context.Context) error {
    ts := time.Now().UTC().Format("20060102T150405Z")
    backupName := fmt.Sprintf("database.sqlite.%s.bak", ts)
    backupPath := filepath.Join(dir.Backups, backupName)

    if err := db.Backup(backupPath); err != nil {
        return fmt.Errorf("backup database: %w", err)
    }

    info, err := os.Stat(backupPath)
    if err != nil {
        return fmt.Errorf("stat backup: %w", err)
    }

    logger.Info("daily backup completed",
        log.String("file", backupName),
        log.Int64("size_bytes", info.Size()),
    )
    return nil
}); err != nil {
    return fmt.Errorf("cron add daily-backup: %w", err)
}
```

Key details:
- **VACUUM INTO:** `db.Backup()` uses `VACUUM INTO` internally — produces a complete, compacted copy including all WAL data, safe to call while the database is in use
- **Timestamp format:** `20060102T150405Z` — UTC, sortable, human-readable
- **File naming:** `database.sqlite.{timestamp}.bak` — easy to identify and sort
- **Logging:** File name and size are logged on success for monitoring

---

## Retention policy

A second cron job runs at 2:30 AM to purge backups older than 7 days:

```go
if err := scheduler.Add("purge-old-backups", "30 2 * * *", func(ctx context.Context) error {
    cutoff := time.Now().Add(-7 * 24 * time.Hour)
    entries, err := os.ReadDir(dir.Backups)
    if err != nil {
        return fmt.Errorf("read backups dir: %w", err)
    }

    var removed int
    for _, e := range entries {
        if e.IsDir() {
            continue
        }
        info, err := e.Info()
        if err != nil {
            continue
        }
        if info.ModTime().Before(cutoff) {
            if err := os.Remove(filepath.Join(dir.Backups, e.Name())); err == nil {
                removed++
            }
        }
    }
    if removed > 0 {
        logger.Info("purged old backups", log.Int("count", removed))
    }
    return nil
}); err != nil {
    return fmt.Errorf("cron add purge-old-backups: %w", err)
}
```

The purge runs 30 minutes after the backup to ensure the new backup is complete before old ones are cleaned up.

---

## Manual backup endpoint

Add an admin endpoint for on-demand backups — same `db.Backup()` call, triggered via API:

```go
func backupHandler(db *sqlite.DB, backupsDir string) func(http.ResponseWriter, *http.Request) {
    return func(w http.ResponseWriter, r *http.Request) {
        ts := time.Now().UTC().Format("20060102T150405Z")
        backupName := fmt.Sprintf("database.sqlite.%s.bak", ts)
        backupPath := filepath.Join(backupsDir, backupName)

        if err := db.Backup(backupPath); err != nil {
            http.WriteError(w, http.StatusInternalServerError, "failed to create backup")
            return
        }

        info, err := os.Stat(backupPath)
        if err != nil {
            http.WriteError(w, http.StatusInternalServerError, "failed to stat backup")
            return
        }

        http.WriteJSON(w, http.StatusOK, map[string]any{
            "file": backupName,
            "size": info.Size(),
        })
    }
}
```

Register under the admin group:

```go
group.HandleFunc("POST /database/backup", backupHandler(db, dir.Backups, logger))
```

---

## Download backup endpoint

Let admins download a backup file directly:

```go
func downloadHandler(backupsDir string) func(http.ResponseWriter, *http.Request) {
    return func(w http.ResponseWriter, r *http.Request) {
        filename := http.PathParam(r, "filename")

        // Prevent directory traversal
        if strings.Contains(filename, "/") || strings.Contains(filename, "..") {
            http.WriteError(w, http.StatusBadRequest, "invalid filename")
            return
        }

        path := filepath.Join(backupsDir, filename)
        f, err := os.Open(path)
        if err != nil {
            http.WriteError(w, http.StatusNotFound, "backup not found")
            return
        }
        defer f.Close()

        info, _ := f.Stat()
        w.Header().Set("Content-Type", "application/octet-stream")
        w.Header().Set("Content-Disposition", fmt.Sprintf("attachment; filename=%s", filename))
        w.Header().Set("Content-Length", strconv.FormatInt(info.Size(), 10))
        io.Copy(w, f)
    }
}
```

---

## Migration backup

The framework's migration system automatically backs up the database before running migrations. This happens transparently — no configuration needed:

```go
applied, err := db.Migrate()
// If migrations ran, db.LastBackupPath() returns the backup location
```

This is a separate safety mechanism from the daily cron backup. It ensures you can always roll back after a migration, even without scheduled backups.

---

## Monitoring

Both cron jobs are automatically tracked in the `cron_runs` table via the scheduler's `OnComplete` hook. The admin panel's Cron page shows:

- Last run time and duration
- Success/failure status
- Next scheduled run
- Run history with error output

If a backup fails (disk full, permissions, etc.), the error appears in the cron run history and structured logs.
