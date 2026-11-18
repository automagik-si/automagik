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
ALTER TABLE whatsapp_challenge ADD COLUMN admissionExpiresAt INTEGER
