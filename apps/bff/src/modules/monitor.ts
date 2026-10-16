import { NextcloudError, type ServerInfoData, type UsersDetails } from "../nextcloud/client.js";
import type { BffModule } from "./types.js";

export interface ServerHealth {
  version: string | null;
  webserver: string | null;
  phpVersion: string | null;
  database: { type: string | null; version: string | null; sizeBytes: number | null } | null;
  /** Load averages [1m, 5m, 15m] when the host reports them. */
  cpuLoad: number[] | null;
  memory: { totalBytes: number; freeBytes: number } | null;
  swap: { totalBytes: number; freeBytes: number } | null;
  freeSpaceBytes: number | null;
  users: {
    total: number | null;
    last5min: number | null;
    last1h: number | null;
    last24h: number | null;
  };
  apps: { installed: number | null; updatesAvailable: number | null };
}

export function toServerHealth(d: ServerInfoData): ServerHealth {
  const db = d.server?.database;
  return {
    version: d.nextcloud?.system?.version ?? null,
    webserver: d.server?.webserver ?? null,
    phpVersion: d.server?.php?.version ?? null,
    database: db
      ? { type: db.type ?? null, version: db.version ?? null, sizeBytes: db.size ?? null }
      : null,
    cpuLoad: d.system?.cpuload ?? null,
    memory:
      d.system?.mem_total != null
        ? { totalBytes: d.system.mem_total, freeBytes: d.system.mem_free ?? 0 }
        : null,
    swap:
      d.system?.swap_total != null
        ? { totalBytes: d.system.swap_total, freeBytes: d.system.swap_free ?? 0 }
        : null,
    freeSpaceBytes: d.system?.freespace ?? null,
    users: {
      total: d.nextcloud?.storage?.num_users ?? null,
      last5min: d.activeUsers?.last5minutes ?? null,
      last1h: d.activeUsers?.last1hour ?? null,
      last24h: d.activeUsers?.last24hours ?? null,
    },
    apps: {
      installed: d.system?.apps?.num_installed ?? null,
      updatesAvailable: d.system?.apps?.num_updates_available ?? null,
    },
  };
}

/** Server data visible to any authenticated user (capabilities + own quota). */
export interface ServerBasics {
  product: string | null;
  version: string | null;
  /** Own storage quota; `totalBytes` null means unlimited. */
  quota: { usedBytes: number; freeBytes: number; totalBytes: number | null } | null;
  /** Installed apps relevant to Einring modules, from the capabilities map. */
  apps: { talk: string | null; userStatus: boolean; collectives: boolean; tables: boolean };
}

export interface ServerHealthResponse {
  /** False when the account lacks admin rights for the serverinfo API. */
  available: boolean;
  health: ServerHealth | null;
  basics: ServerBasics | null;
}

export interface TalkUserStatus {
  userId: string;
  displayName: string | null;
  status: string;
  message: string | null;
  icon: string | null;
  groups: string[];
  /** Epoch ms of the user's last login; only available with provisioning (admin) access. */
  lastSeenAt: number | null;
}

export interface TalkStatus {
  users: TalkUserStatus[];
  /** Groups available for filtering; empty when `groupsScope` is "none". */
  groups: string[];
  /**
   * "all" — full provisioning access (server admin): every user's groups.
   * "partial" — group admin (subadmin): only managed groups are visible.
   * "none" — no group data available for this account.
   */
  groupsScope: "all" | "partial" | "none";
}

export const monitorModule: BffModule = {
  id: "monitor",
  requires: ["nextcloud"],
  register(api, ctx) {
    const { store, secrets, nextcloud } = ctx;

    api.get("/server", async (request, reply) => {
      const cred = store.getCredential(request.user.sub);
      if (!cred) return reply.code(424).send({ error: "nextcloud not connected" });
      const nc = nextcloud.withCredentials(cred.loginName, secrets.open(cred.appPasswordSealed));
      const forbidden = (e: unknown): null => {
        if (e instanceof NextcloudError && (e.status === 401 || e.status === 403)) return null;
        throw e;
      };
      const [info, caps, me] = await Promise.all([
        nc.getServerInfo().catch(forbidden),
        nc.getCapabilities().catch(() => null),
        nc.getOwnUser().catch(() => null),
      ]);

      let basics: ServerBasics | null = null;
      if (caps || me) {
        const capMap = caps?.ocs.data.capabilities ?? {};
        const quota = me?.ocs.data.quota;
        basics = {
          product: capMap.theming?.name ?? capMap.theming?.productname ?? null,
          version: caps?.ocs.data.version?.string ?? null,
          quota:
            quota?.used != null
              ? {
                  usedBytes: quota.used,
                  freeBytes: quota.free ?? 0,
                  // Nextcloud reports -3 for unlimited quota.
                  totalBytes: quota.total != null && quota.total >= 0 ? quota.total : null,
                }
              : null,
          apps: {
            talk:
              "spreed" in capMap
                ? ((capMap.spreed as { version?: string } | undefined)?.version ?? "")
                : null,
            userStatus: "user_status" in capMap,
            collectives: "collectives" in capMap,
            tables: "tables" in capMap,
          },
        };
      }

      return {
        available: info !== null,
        health: info ? toServerHealth(info.ocs.data) : null,
        basics,
      } satisfies ServerHealthResponse;
    });

    api.get("/talk-status", async (request, reply) => {
      const cred = store.getCredential(request.user.sub);
      if (!cred) return reply.code(424).send({ error: "nextcloud not connected" });
      const nc = nextcloud.withCredentials(cred.loginName, secrets.open(cred.appPasswordSealed));
      const forbidden = (e: unknown): null => {
        if (
          e instanceof NextcloudError &&
          (e.status === 401 || e.status === 403 || e.status === 404)
        ) {
          return null;
        }
        throw e;
      };

      const statuses = await nc.getUserStatuses();
      const detailsUsers: UsersDetails["users"] = {};
      const groupsByUser = new Map<string, string[]>();
      let groupsScope: TalkStatus["groupsScope"] = "none";

      // Three tiers: full provisioning (server admin) → managed groups (group admin) → none.
      const details = await nc.getUsersDetails().catch(forbidden);
      if (details) {
        Object.assign(detailsUsers, details.ocs.data.users);
        groupsScope = "all";
      } else {
        const managedGroups = await nc
          .getGroups()
          .then((r) => r.ocs.data.groups)
          .catch(forbidden);
        if (managedGroups?.length) {
          await Promise.all(
            managedGroups.map(async (group) => {
              const members = await nc.getGroupUsers(group).catch(forbidden);
              for (const uid of members?.ocs.data.users ?? []) {
                groupsByUser.set(uid, [...(groupsByUser.get(uid) ?? []), group]);
              }
            }),
          );
          if (groupsByUser.size) groupsScope = "partial";
        }
      }

      const statusByUser = new Map(statuses.ocs.data.map((s) => [s.userId, s]));
      const ids = [
        ...new Set([...Object.keys(detailsUsers), ...groupsByUser.keys(), ...statusByUser.keys()]),
      ];

      // Without provisioning access, resolve display names: DAV principals does an
      // exact user-id lookup (works for obfuscated ids), Talk autocomplete is the fallback.
      const names = new Map<string, string>();
      if (!details) {
        await Promise.all(
          ids.map(async (userId) => {
            try {
              const name = await nc.getPrincipalDisplayName("users", userId);
              if (name) {
                names.set(userId, name);
                return;
              }
            } catch {
              // principals denied — try autocomplete
            }
            try {
              const res = await nc.autocompleteUsers(userId);
              const hit = res.ocs.data.find((r) => r.id === userId && r.source === "users");
              if (hit?.label) names.set(userId, hit.label);
            } catch {
              // no name resolved — the app shows the userId
            }
          }),
        );
      }

      const users: TalkUserStatus[] = ids
        .map((userId) => ({
          userId,
          displayName: detailsUsers[userId]?.displayname ?? names.get(userId) ?? null,
          status: statusByUser.get(userId)?.status ?? "offline",
          message: statusByUser.get(userId)?.message ?? null,
          icon: statusByUser.get(userId)?.icon ?? null,
          groups: detailsUsers[userId]?.groups ?? groupsByUser.get(userId) ?? [],
          lastSeenAt: detailsUsers[userId]?.lastLogin ?? null,
        }))
        .sort((a, b) => (a.displayName ?? a.userId).localeCompare(b.displayName ?? b.userId));

      // Group ids are opaque too — resolve their display names via DAV principals.
      const gids = new Set(users.flatMap((u) => u.groups));
      const groupNames = new Map<string, string>();
      await Promise.all(
        [...gids].map(async (gid) => {
          try {
            const name = await nc.getPrincipalDisplayName("groups", gid);
            if (name) groupNames.set(gid, name);
          } catch {
            // unresolved — keep the gid
          }
        }),
      );
      const groupName = (gid: string) => groupNames.get(gid) ?? gid;
      for (const u of users) u.groups = u.groups.map(groupName);
      const groups = [...new Set(users.flatMap((u) => u.groups))].sort();
      return { users, groups, groupsScope } satisfies TalkStatus;
    });
  },
};
