
CREATE TABLE scripts (
 id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
 runtime TEXT NOT NULL CHECK(runtime IN ('nodejs','shell')),
 status TEXT NOT NULL CHECK(status IN ('draft','published','archived')),
 current_draft_version_id TEXT, current_published_version_id TEXT,
 created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, archived_at INTEGER
);
CREATE TABLE script_versions (
 id TEXT PRIMARY KEY, script_id TEXT NOT NULL REFERENCES scripts(id), version_no INTEGER NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('draft','published')), revision INTEGER NOT NULL DEFAULT 0 CHECK(revision >= 0),
 entry_file TEXT NOT NULL, input_schema_json TEXT NOT NULL, output_schema_json TEXT NOT NULL,
 source_ref TEXT NOT NULL, content_hash TEXT NOT NULL, validation_json TEXT NOT NULL,
 created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, published_at INTEGER,
 UNIQUE(script_id,version_no)
);
CREATE UNIQUE INDEX one_script_draft ON script_versions(script_id) WHERE status='draft';
CREATE TABLE script_tests (
 id TEXT PRIMARY KEY, script_id TEXT NOT NULL REFERENCES scripts(id), script_version_id TEXT REFERENCES script_versions(id),
 draft_revision INTEGER, status TEXT NOT NULL CHECK(status IN ('queued','running','succeeded','failed','cancelled')),
 input_ref TEXT NOT NULL, output_ref TEXT, error_json TEXT, stdout_ref TEXT, stderr_ref TEXT, exit_code INTEGER,
 duration_ms INTEGER, created_at INTEGER NOT NULL, started_at INTEGER, ended_at INTEGER,
 CHECK ((script_version_id IS NULL AND draft_revision IS NOT NULL AND draft_revision >= 0)
   OR (script_version_id IS NOT NULL AND draft_revision IS NULL))
);
CREATE INDEX script_versions_by_script ON script_versions(script_id,version_no DESC);
CREATE INDEX script_tests_by_script ON script_tests(script_id,created_at DESC);
CREATE TRIGGER script_draft_owner_insert BEFORE INSERT ON scripts
WHEN NEW.current_draft_version_id IS NOT NULL
 AND NOT EXISTS(SELECT 1 FROM script_versions WHERE id=NEW.current_draft_version_id AND script_id=NEW.id)
BEGIN SELECT RAISE(ABORT,'script draft owner mismatch'); END;
CREATE TRIGGER script_published_version_immutable BEFORE UPDATE ON script_versions
WHEN OLD.status='published'
BEGIN SELECT RAISE(ABORT,'published script version is immutable'); END;
PRAGMA user_version = 5;
