import "server-only";
import { prisma } from "../db/client";

/**
 * The one query the readiness probe needs (`GET /api/health/ready`) — a
 * bare `SELECT 1` against the app runtime connection (`pfw_runtime`,
 * `APP_DATABASE_URL`), the same connection path every real request
 * uses. Lives in the DAL, not inlined into the route handler, so this
 * app's `dal-boundary` guard test (route handlers never import Prisma
 * directly) holds with no exception carved out for this route — a
 * health check is exactly the kind of thing that's easy to special-case
 * as "too trivial to need the DAL," and that's precisely the instinct
 * this guard exists to catch.
 */
export async function checkDatabaseConnectivity(): Promise<void> {
  await prisma.$queryRaw`SELECT 1`;
}
