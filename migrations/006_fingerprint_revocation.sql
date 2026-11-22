ALTER TABLE memory_publications
    ADD COLUMN revoked_at timestamptz,
    ADD COLUMN revocation_reason text,
    ADD CONSTRAINT valid_fingerprint_revocation CHECK (
        (revoked_at IS NULL AND revocation_reason IS NULL)
        OR (pack = 'confirmed' AND kind = 'fingerprint' AND revoked_at IS NOT NULL
            AND revocation_reason IS NOT NULL
            AND revocation_reason IN ('invalid_confirmation', 'incorrect_generalization'))
    );
