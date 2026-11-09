
CREATE TABLE dictionaries (
  id TEXT NOT NULL PRIMARY KEY,
  name TEXT NOT NULL COLLATE NOCASE UNIQUE
    CHECK(name = trim(name) AND length(name) BETWEEN 1 AND 100),
  kind TEXT NOT NULL CHECK(kind IN ('plain','encrypted')),
  current_version_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK(typeof(revision) = 'integer' AND revision > 0),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(id, kind),
  FOREIGN KEY(id, current_version_id, name, kind)
    REFERENCES dictionary_versions(dictionary_id, id, name, kind)
    DEFERRABLE INITIALLY DEFERRED
);
CREATE TABLE dictionary_versions (
  id TEXT NOT NULL PRIMARY KEY,
  dictionary_id TEXT NOT NULL,
  version_no INTEGER NOT NULL CHECK(typeof(version_no) = 'integer' AND version_no > 0),
  name TEXT NOT NULL
    CHECK(name = trim(name) AND length(name) BETWEEN 1 AND 100),
  description TEXT NOT NULL CHECK(length(description) <= 2000),
  kind TEXT NOT NULL CHECK(kind IN ('plain','encrypted')),
  enabled INTEGER NOT NULL CHECK(enabled IN (0,1)),
  entries_json TEXT NOT NULL
    CHECK(CASE WHEN json_valid(entries_json) THEN json_type(entries_json) = 'object' ELSE 0 END),
  content_hash TEXT NOT NULL
    CHECK(length(content_hash) = 64 AND content_hash NOT GLOB '*[^0-9a-f]*'),
  created_at INTEGER NOT NULL,
  UNIQUE(dictionary_id, version_no),
  UNIQUE(dictionary_id, id),
  UNIQUE(dictionary_id, id, name, kind),
  FOREIGN KEY(dictionary_id, kind) REFERENCES dictionaries(id, kind)
);
CREATE TABLE run_dictionary_bindings (
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  dictionary_id TEXT NOT NULL,
  dictionary_version_id TEXT NOT NULL,
  keys_json TEXT NOT NULL
    CHECK(CASE WHEN json_valid(keys_json)
      THEN json_type(keys_json) = 'array' AND json_array_length(keys_json) > 0 ELSE 0 END),
  created_at INTEGER NOT NULL,
  PRIMARY KEY(run_id, dictionary_id),
  FOREIGN KEY(dictionary_id, dictionary_version_id)
    REFERENCES dictionary_versions(dictionary_id, id)
);
CREATE INDEX run_dictionary_bindings_by_version
  ON run_dictionary_bindings(dictionary_id, dictionary_version_id);
CREATE TABLE script_test_dictionary_bindings (
  test_id TEXT NOT NULL REFERENCES script_tests(id) ON DELETE CASCADE,
  dictionary_id TEXT NOT NULL,
  dictionary_version_id TEXT NOT NULL,
  keys_json TEXT NOT NULL
    CHECK(CASE WHEN json_valid(keys_json)
      THEN json_type(keys_json) = 'array' AND json_array_length(keys_json) > 0 ELSE 0 END),
  created_at INTEGER NOT NULL,
  PRIMARY KEY(test_id, dictionary_id),
  FOREIGN KEY(dictionary_id, dictionary_version_id)
    REFERENCES dictionary_versions(dictionary_id, id)
);
CREATE INDEX script_test_dictionary_bindings_by_version
  ON script_test_dictionary_bindings(dictionary_id, dictionary_version_id);
CREATE TRIGGER dictionary_versions_no_update
BEFORE UPDATE ON dictionary_versions
BEGIN
  SELECT RAISE(ABORT, 'DICTIONARY_VERSION_IMMUTABLE');
END;
CREATE TRIGGER dictionary_versions_no_delete
BEFORE DELETE ON dictionary_versions
BEGIN
  SELECT RAISE(ABORT, 'DICTIONARY_VERSION_IMMUTABLE');
END;
CREATE TRIGGER dictionaries_identity_immutable
BEFORE UPDATE OF id, kind ON dictionaries
WHEN NEW.id IS NOT OLD.id OR NEW.kind IS NOT OLD.kind
BEGIN
  SELECT RAISE(ABORT, 'DICTIONARY_IDENTITY_IMMUTABLE');
END;
 PRAGMA user_version = 9;