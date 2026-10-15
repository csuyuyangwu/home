CREATE TABLE IF NOT EXISTS likes (
    visitor TEXT PRIMARY KEY,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE TABLE IF NOT EXISTS comments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    reference TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 40),
    message TEXT NOT NULL CHECK(length(message) BETWEEN 1 AND 1000),
    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'approved', 'rejected')),
    created_at TEXT NOT NULL,
    reviewed_at TEXT,
    notified INTEGER NOT NULL DEFAULT 0,
    notification_attempts INTEGER NOT NULL DEFAULT 0,
    notification_next_at INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS comments_public ON comments(status, id DESC);
CREATE INDEX IF NOT EXISTS comments_notifications ON comments(notified, notification_next_at);
CREATE TABLE IF NOT EXISTS rate_limits (
    key TEXT PRIMARY KEY,
    count INTEGER NOT NULL DEFAULT 1,
    expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS owner_tokens (
    token_hash TEXT PRIMARY KEY,
    kind TEXT NOT NULL CHECK(kind IN ('login', 'session')),
    expires_at INTEGER NOT NULL
);
