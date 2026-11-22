CREATE TABLE events (
    id uuid PRIMARY KEY,
    occurred_at timestamptz NOT NULL,
    account_id text NOT NULL,
    kind text NOT NULL CHECK (kind IN ('login', 'login_failed', 'password_reset', 'payee_added', 'transfer')),
    device_id text NOT NULL,
    network_id text NOT NULL,
    payee_id text,
    amount_minor integer,
    latitude double precision NOT NULL CHECK (latitude BETWEEN -90 AND 90),
    longitude double precision NOT NULL CHECK (longitude BETWEEN -180 AND 180),
    dwell_ms double precision,
    flight_ms double precision,
    interaction_ms double precision,
    payload jsonb NOT NULL,
    received_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    CHECK ((kind = 'transfer' AND amount_minor > 0 AND amount_minor IS NOT NULL)
        OR (kind <> 'transfer' AND amount_minor IS NULL)),
    CHECK ((kind IN ('transfer', 'payee_added')) = (payee_id IS NOT NULL))
);

CREATE INDEX events_account_history_idx ON events (account_id, occurred_at DESC);
CREATE INDEX events_device_history_idx ON events (device_id, occurred_at DESC);
CREATE INDEX events_network_history_idx ON events (network_id, occurred_at DESC);
CREATE INDEX events_account_payee_idx ON events (account_id, payee_id, occurred_at DESC)
    WHERE payee_id IS NOT NULL;

CREATE TABLE cases (
    id uuid PRIMARY KEY REFERENCES events(id),
    status text NOT NULL CHECK (status IN ('pending', 'decided')),
    action text CHECK (action IN ('ALLOW', 'STEP_UP_VERIFICATION', 'BLOCK')),
    trace jsonb NOT NULL,
    lease_token uuid,
    lease_until timestamptz,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    decided_at timestamptz,
    CHECK (
      (status = 'pending' AND action IS NULL AND lease_token IS NOT NULL AND lease_until IS NOT NULL AND decided_at IS NULL)
      OR
      (status = 'decided' AND action IS NOT NULL AND lease_token IS NULL AND lease_until IS NULL AND decided_at IS NOT NULL)
    )
);
