CREATE TABLE analyst_feedback (
    case_id uuid PRIMARY KEY REFERENCES cases(id),
    request jsonb NOT NULL,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE memory_publications (
    id uuid PRIMARY KEY,
    case_id uuid NOT NULL REFERENCES cases(id),
    pack text NOT NULL CHECK (pack IN ('risk', 'confirmed')),
    kind text NOT NULL CHECK (kind IN ('observation', 'fingerprint')),
    document jsonb NOT NULL,
    state text NOT NULL DEFAULT 'pending'
        CHECK (state IN ('pending', 'sending', 'indexing', 'uncertain', 'published')),
    remote_id uuid,
    attempts integer NOT NULL DEFAULT 0,
    next_check_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    superseded_at timestamptz,
    verified_at timestamptz,
    last_error text,
    CHECK ((kind = 'observation') = (pack = 'risk')),
    CHECK (state <> 'published' OR (remote_id IS NOT NULL AND verified_at IS NOT NULL)),
    CHECK (document ? 'originAgent')
);
CREATE UNIQUE INDEX memory_publications_fingerprint_case_idx ON memory_publications (case_id) WHERE kind = 'fingerprint';
CREATE UNIQUE INDEX memory_publications_observation_case_idx ON memory_publications (case_id, (document->>'originAgent')) WHERE kind = 'observation';
CREATE UNIQUE INDEX memory_publications_remote_idx ON memory_publications (pack, remote_id) WHERE remote_id IS NOT NULL;
CREATE INDEX memory_publications_queue_idx ON memory_publications (next_check_at) WHERE state <> 'published';
