/**
 * BULLPANE_CONNECTIONS seeding: create each configured connection that does not
 * exist yet, matched by name. Never updates or deletes, so a connection edited
 * in the UI keeps its edits across restarts. Runs before read-only mode matters:
 * it is the operator's configuration, not a request, which is exactly why a
 * read-only install can still be given its Redis this way.
 */
import type { CreateConnectionInput } from "@bullpane/shared";
import type { AppContext } from "./context";

export interface SeedConnectionsLogger {
  info(obj: object, msg: string): void;
}

export async function seedConnections(
  connections: Pick<AppContext["connections"], "findByName" | "create">,
  wanted: CreateConnectionInput[],
  log: SeedConnectionsLogger,
): Promise<number> {
  let created = 0;
  for (const input of wanted) {
    if (await connections.findByName(input.name)) continue;
    await connections.create(input);
    created++;
    // Name only: the URL may carry a password.
    log.info({ name: input.name }, "connection created from BULLPANE_CONNECTIONS");
  }
  return created;
}
