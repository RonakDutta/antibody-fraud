CREATE INDEX events_graph_payee_time_idx ON events (payee_id, occurred_at DESC, id DESC)
    WHERE payee_id IS NOT NULL;

CREATE INDEX events_graph_session_time_idx ON events ((payload->>'sessionId'), occurred_at DESC, id DESC)
    WHERE payload->>'sessionId' IS NOT NULL;
