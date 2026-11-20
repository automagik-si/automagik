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

-- The register endpoints always create an account. The provider's credential INSERT
-- and this claim succeed or roll back as one statement, even across Worker instances.
CREATE TRIGGER admission_on_passkey AFTER INSERT ON passkey
BEGIN
  UPDATE admission_ticket SET state = 'used'
    WHERE userId = NEW.userId AND state = 'pending' AND ceremonies > 0
      AND expiresAt > (SELECT cutoff FROM admission_clock);
  SELECT RAISE(ABORT, 'passkey admission refused') WHERE changes() <> 1;
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
