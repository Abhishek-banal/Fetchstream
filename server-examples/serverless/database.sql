CREATE TABLE IF NOT EXISTS Jobs (
    job_id TEXT PRIMARY KEY,
    payload TEXT NOT NULL,
    created_at INTEGER NOT NULL
);
