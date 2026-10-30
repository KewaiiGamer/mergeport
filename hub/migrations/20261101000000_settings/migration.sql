-- Small key/value settings owned by the hub (the GitHub App's webhook secret and slug).
CREATE TABLE setting (
  key TEXT PRIMARY KEY NOT NULL,
  value TEXT NOT NULL
);
