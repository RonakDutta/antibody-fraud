ALTER TABLE memory_publications DROP CONSTRAINT memory_publications_state_check;
ALTER TABLE memory_publications ADD CONSTRAINT memory_publications_state_check
  CHECK (state IN ('pending', 'sending', 'indexing', 'uncertain', 'published', 'failed'));
ALTER TABLE memory_publications
  ADD COLUMN write_acknowledged_at timestamptz,
  ADD COLUMN last_operation text,
  ADD COLUMN last_checked_at timestamptz;
