CREATE TABLE team (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  owner_github_id INTEGER NOT NULL
);
CREATE TABLE member (
  github_id INTEGER PRIMARY KEY NOT NULL,
  login TEXT NOT NULL,
  name TEXT,
  avatar_url TEXT,
  role TEXT NOT NULL,
  status TEXT NOT NULL,
  invited_by INTEGER,
  invited_at TEXT,
  joined_at TEXT
);
CREATE TABLE invite (
  id TEXT PRIMARY KEY NOT NULL,
  github_login TEXT NOT NULL,
  role TEXT NOT NULL,
  created_by INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT
);
CREATE TABLE space (
  id TEXT PRIMARY KEY NOT NULL,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  created_by INTEGER NOT NULL,
  seq INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE space_member (
  space_id TEXT NOT NULL,
  github_id INTEGER NOT NULL,
  can_write INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (space_id, github_id)
);
CREATE TABLE entity (
  space_id TEXT NOT NULL,
  type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0,
  data TEXT NOT NULL,
  applied_ops TEXT NOT NULL DEFAULT '[]',
  updated_at TEXT NOT NULL,
  updated_by INTEGER NOT NULL,
  seq INTEGER NOT NULL,
  PRIMARY KEY (space_id, type, entity_id)
);
CREATE TABLE entity_event (
  space_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0,
  data TEXT NOT NULL,
  op_id TEXT,
  actor_github_id INTEGER NOT NULL,
  at TEXT NOT NULL,
  PRIMARY KEY (space_id, seq)
);
CREATE TABLE session (
  id_hash TEXT PRIMARY KEY NOT NULL,
  github_id INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  client_name TEXT,
  cursor_json TEXT
);
