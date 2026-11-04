DELETE FROM "sessions" WHERE "expires_at" <= CURRENT_TIMESTAMP;
