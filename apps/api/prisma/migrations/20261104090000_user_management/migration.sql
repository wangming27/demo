CREATE TYPE "UserRole" AS ENUM ('USER', 'ADMIN');
ALTER TABLE "users" ADD COLUMN "role" "UserRole" NOT NULL DEFAULT 'USER';
CREATE INDEX "users_created_at_id_idx" ON "users" ("created_at" DESC, "id" DESC);
