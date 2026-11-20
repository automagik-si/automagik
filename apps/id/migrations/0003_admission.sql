CREATE TABLE admission_ticket (
  jti TEXT PRIMARY KEY,
  userId TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'used')),
  ceremonies INTEGER NOT NULL DEFAULT 1,
  expiresAt INTEGER NOT NULL,
  createdAt INTEGER NOT NULL
);
CREATE INDEX admission_ticket_user ON admission_ticket(userId);
CREATE INDEX admission_ticket_expiry ON admission_ticket(expiresAt);
ALTER TABLE whatsapp_challenge ADD COLUMN admissionJti TEXT;
ALTER TABLE whatsapp_challenge ADD COLUMN admissionExpiresAt INTEGER;

-- Match verifyAdmission's 30-second issuer clock skew at the time SQLite writes the row.
CREATE VIEW admission_clock AS SELECT (unixepoch() - 30) * 1000 AS cutoff;

-- Written after WebAuthn verifies the exact credential, then consumed by its INSERT.
CREATE TABLE passkey_write_authorization (
  userId TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  credentialId TEXT NOT NULL,
  purpose TEXT NOT NULL CHECK (purpose IN ('signup', 'add')),
  sessionId TEXT REFERENCES session(id) ON DELETE CASCADE,
  expiresAt TEXT NOT NULL,
  CHECK ((purpose = 'add') = (sessionId IS NOT NULL)),
  PRIMARY KEY (userId, credentialId)
);
CREATE INDEX passkey_write_expiry ON passkey_write_authorization(expiresAt);

CREATE TRIGGER admission_on_passkey AFTER INSERT ON passkey
BEGIN
  UPDATE admission_ticket SET state = 'used'
    WHERE userId = NEW.userId AND state = 'pending' AND ceremonies > 0
      AND expiresAt > (SELECT cutoff FROM admission_clock)
      AND EXISTS (SELECT 1 FROM passkey_write_authorization
        WHERE userId = NEW.userId AND credentialId = NEW.credentialID AND purpose = 'signup'
          AND expiresAt > strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
  SELECT RAISE(ABORT, 'passkey authorization refused') WHERE changes() <> 1
    AND NOT EXISTS (SELECT 1 FROM passkey_write_authorization a JOIN session s ON s.id = a.sessionId
      WHERE a.userId = NEW.userId AND a.credentialId = NEW.credentialID AND a.purpose = 'add'
        AND s.userId = a.userId AND s.signInMethod = 'passkey'
        AND min(a.expiresAt, s.expiresAt) > strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
  DELETE FROM passkey_write_authorization WHERE userId = NEW.userId AND credentialId = NEW.credentialID;
END;

-- Identify the confirmed WhatsApp challenge for the provider's user INSERT.
ALTER TABLE whatsapp_challenge ADD COLUMN signupUserId TEXT;
CREATE UNIQUE INDEX whatsapp_challenge_signup ON whatsapp_challenge(signupUserId) WHERE signupUserId IS NOT NULL;

CREATE TRIGGER admission_on_phone AFTER INSERT ON "user"
WHEN NEW.phoneNumberVerified = 1
BEGIN
  INSERT INTO admission_ticket (jti, userId, state, ceremonies, expiresAt, createdAt)
    SELECT admissionJti, NEW.id, 'used', 0, admissionExpiresAt, unixepoch() * 1000
      FROM whatsapp_challenge WHERE signupUserId = NEW.id AND phoneNumber = NEW.phoneNumber
        AND state = 'used' AND admissionJti IS NOT NULL AND admissionExpiresAt > (SELECT cutoff FROM admission_clock)
    ON CONFLICT(jti) DO NOTHING;
  SELECT RAISE(ABORT, 'phone admission refused') WHERE changes() <> 1;
END;
