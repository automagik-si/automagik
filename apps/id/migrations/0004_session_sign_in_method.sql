-- The ceremony that created each session (passkey or whatsapp). Adding or deleting a passkey
-- needs a session made by a passkey ceremony in the last five minutes. Older sessions read null.
alter table "session" add column "signInMethod" text;
