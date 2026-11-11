
ALTER TABLE dictionaries ADD COLUMN deleted_at INTEGER
  CHECK(deleted_at IS NULL OR (typeof(deleted_at) = 'integer' AND deleted_at > 0));
DROP TRIGGER dictionary_versions_no_delete;
CREATE TRIGGER dictionary_versions_no_delete
BEFORE DELETE ON dictionary_versions
WHEN NOT EXISTS (SELECT 1 FROM dictionaries WHERE id=OLD.dictionary_id AND deleted_at IS NOT NULL)
 OR EXISTS (SELECT 1 FROM run_dictionary_bindings WHERE dictionary_id=OLD.dictionary_id)
 OR EXISTS (SELECT 1 FROM script_test_dictionary_bindings WHERE dictionary_id=OLD.dictionary_id)
BEGIN
  SELECT RAISE(ABORT, 'DICTIONARY_VERSION_IMMUTABLE');
END;
PRAGMA user_version = 10;
