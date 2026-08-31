-- Adds real credential storage to User (AGENTS.md §3ff). Nullable on
-- purpose, not a transitional state to clean up later: NULL is what
-- marks the original seeded demo row as still unclaimed — every row
-- registerUser() ever creates or claims gets a real hash immediately,
-- so this column's nullability IS the "first registration inherits the
-- demo data" mechanism, not a separate flag.
--
-- AlterTable
ALTER TABLE "User" ADD COLUMN     "passwordHash" TEXT;
