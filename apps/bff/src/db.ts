import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

export interface NextcloudCredential {
  sub: string;
  server: string;
  loginName: string;
  appPasswordSealed: string;
}

export interface PendingLoginFlow {
  sub: string;
  pollToken: string;
  pollEndpoint: string;
}

export interface Store {
  getCredential(sub: string): NextcloudCredential | undefined;
  saveCredential(cred: NextcloudCredential): void;
  deleteCredential(sub: string): void;
  getPendingFlow(sub: string): PendingLoginFlow | undefined;
  savePendingFlow(flow: PendingLoginFlow): void;
  deletePendingFlow(sub: string): void;
  close(): void;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS nextcloud_credentials (
  sub TEXT PRIMARY KEY,
  server TEXT NOT NULL,
  login_name TEXT NOT NULL,
  app_password_sealed TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS login_flows (
  sub TEXT PRIMARY KEY,
  poll_token TEXT NOT NULL,
  poll_endpoint TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`;

/** `path` may be ":memory:" for tests. */
export function openStore(path: string): Store {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec(SCHEMA);

  const getCred = db.prepare(
    "SELECT sub, server, login_name AS loginName, app_password_sealed AS appPasswordSealed FROM nextcloud_credentials WHERE sub = ?",
  );
  const putCred = db.prepare(
    `INSERT INTO nextcloud_credentials (sub, server, login_name, app_password_sealed) VALUES (?, ?, ?, ?)
     ON CONFLICT(sub) DO UPDATE SET server = excluded.server, login_name = excluded.login_name,
       app_password_sealed = excluded.app_password_sealed, created_at = datetime('now')`,
  );
  const delCred = db.prepare("DELETE FROM nextcloud_credentials WHERE sub = ?");
  const getFlow = db.prepare(
    "SELECT sub, poll_token AS pollToken, poll_endpoint AS pollEndpoint FROM login_flows WHERE sub = ?",
  );
  const putFlow = db.prepare(
    `INSERT INTO login_flows (sub, poll_token, poll_endpoint) VALUES (?, ?, ?)
     ON CONFLICT(sub) DO UPDATE SET poll_token = excluded.poll_token, poll_endpoint = excluded.poll_endpoint,
       created_at = datetime('now')`,
  );
  const delFlow = db.prepare("DELETE FROM login_flows WHERE sub = ?");

  return {
    getCredential: (sub) => getCred.get(sub) as NextcloudCredential | undefined,
    saveCredential: (c) => void putCred.run(c.sub, c.server, c.loginName, c.appPasswordSealed),
    deleteCredential: (sub) => void delCred.run(sub),
    getPendingFlow: (sub) => getFlow.get(sub) as PendingLoginFlow | undefined,
    savePendingFlow: (f) => void putFlow.run(f.sub, f.pollToken, f.pollEndpoint),
    deletePendingFlow: (sub) => void delFlow.run(sub),
    close: () => db.close(),
  };
}
