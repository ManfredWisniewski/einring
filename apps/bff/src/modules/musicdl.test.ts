import { EventEmitter } from "node:events";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../config.js";
import { testApp, testEnv } from "../test-utils.js";

const VIDEO = "https://www.youtube.com/watch?v=v1";
const PLAYLIST = "https://www.youtube.com/playlist?list=X";

interface WorkerMsg {
  type: string;
  [k: string]: unknown;
}

/**
 * Fake child process: emits the scripted JSON-lines on stdout, then closes.
 */

function fakeSpawn(
  script: (args: string[]) => { lines: WorkerMsg[]; code?: number; stderr?: string },
): typeof import("node:child_process").spawn {
  return ((_cmd: string, args: string[]) => {
    const child = new EventEmitter() as unknown as import("node:child_process").ChildProcess;
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    Object.assign(child, {
      stdout,
      stderr,
      kill: () => true,
      killed: false,
    });
    const out = script(args);
    process.nextTick(() => {
      for (const line of out.lines) stdout.write(`${JSON.stringify(line)}\n`);
      if (out.stderr) stderr.write(out.stderr);
      stdout.end();
      stderr.end();
      child.emit("close", out.code ?? 0);
    });
    return child;
  }) as typeof import("node:child_process").spawn;
}

/** The worker's staging dir arrives as argv[2] — the fake spawn must see it. */
function stagingDir(args: string[]): string {
  const dir = args[2];
  if (!dir) throw new Error("fakeSpawn: staging dir arg missing");
  return dir;
}

/** Write a fake audio file into the job's staging dir and return its path. */
function stageFile(stagingDir: string, name: string, bytes = 10): string {
  const p = resolve(stagingDir, name);
  writeFileSync(p, Buffer.alloc(bytes));
  return p;
}

async function dlApp(
  spawnChild: ReturnType<typeof fakeSpawn> | typeof import("node:child_process").spawn,
  extraEnv: Record<string, string> = {},
) {
  const dataDir = mkdtempSync(join(tmpdir(), "musicdl-"));
  const config = loadConfig({ ...testEnv(), DATA_DIR: dataDir, ...extraEnv });
  const { app, store, auth } = await testApp({ config, spawnChild });
  return { app, store, auth, dataDir };
}

/** Poll the job until it leaves pending/running (worker output is async). */
async function waitJob(
  app: Awaited<ReturnType<typeof dlApp>>["app"],
  auth: Record<string, string>,
  id: number,
) {
  for (let i = 0; i < 50; i++) {
    const res = await app.inject({
      method: "GET",
      url: `/api/musicdl/downloads/${id}`,
      headers: auth,
    });
    const job = res.json().job;
    if (job.state === "done" || job.state === "failed") return job;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("job did not finish");
}

describe("musicdl", () => {
  it("rejects non-YouTube URLs before spawning", async () => {
    let spawned = false;
    const { app, auth } = await dlApp(
      fakeSpawn(() => {
        spawned = true;
        return { lines: [] };
      }),
    );
    for (const url of ["https://evil.test/x", "not-a-url", "file:///etc/passwd"]) {
      const res = await app.inject({
        method: "POST",
        url: "/api/musicdl/downloads",
        headers: auth,
        payload: { url },
      });
      expect(res.statusCode).toBe(400);
    }
    expect(spawned).toBe(false);
  });

  it("rejects requests without auth", async () => {
    const { app } = await dlApp(fakeSpawn(() => ({ lines: [] })));
    const res = await app.inject({
      method: "POST",
      url: "/api/musicdl/downloads",
      payload: { url: VIDEO },
    });
    expect(res.statusCode).toBe(401);
  });

  it("imports one track per playlist item into the user's library", async () => {
    const { app, store, auth } = await dlApp(
      fakeSpawn((args) => {
        const staging = stagingDir(args);
        const f1 = stageFile(staging, "A [v1].mp3");
        const f2 = stageFile(staging, "B [v2].mp3");
        return {
          lines: [
            { type: "resolved", count: 2 },
            { type: "item", url: `${VIDEO}`, title: "A", video_id: "v1", ok: true, file_path: f1 },
            { type: "item", url: `${VIDEO}2`, title: "B", video_id: "v2", ok: true, file_path: f2 },
            { type: "done" },
          ],
        };
      }),
    );
    const res = await app.inject({
      method: "POST",
      url: "/api/musicdl/downloads",
      headers: auth,
      payload: { url: PLAYLIST },
    });
    expect(res.statusCode).toBe(201);
    const job = await waitJob(app, auth, res.json().job.id);
    expect(job.state).toBe("done");
    expect(job.total).toBe(2);
    expect(job.items.filter((i: { ok: boolean }) => i.ok)).toHaveLength(2);
    expect(store.listMusicTracks("user-1")).toHaveLength(2);
  });

  it("reports a failed item without losing the others", async () => {
    const { app, store, auth } = await dlApp(
      fakeSpawn((args) => ({
        lines: [
          { type: "resolved", count: 2 },
          {
            type: "item",
            url: VIDEO,
            title: "A",
            video_id: "v1",
            ok: true,
            file_path: stageFile(stagingDir(args), "A.mp3"),
          },
          {
            type: "item",
            url: `${VIDEO}2`,
            title: "B",
            video_id: "v2",
            ok: false,
            error: "unavailable",
          },
          { type: "done" },
        ],
      })),
    );
    const res = await app.inject({
      method: "POST",
      url: "/api/musicdl/downloads",
      headers: auth,
      payload: { url: PLAYLIST },
    });
    const job = await waitJob(app, auth, res.json().job.id);
    expect(job.state).toBe("done");
    expect(job.items[1]?.ok).toBe(false);
    expect(job.items[1]?.error).toContain("unavailable");
    expect(store.listMusicTracks("user-1")).toHaveLength(1);
  });

  it("dedupes by video id instead of duplicating the track", async () => {
    const { app, store, auth } = await dlApp(
      fakeSpawn((args) => ({
        lines: [
          { type: "resolved", count: 1 },
          {
            type: "item",
            url: VIDEO,
            title: "A",
            video_id: "v1",
            ok: true,
            file_path: stageFile(stagingDir(args), "A.mp3"),
          },
          { type: "done" },
        ],
      })),
    );
    for (let i = 0; i < 2; i++) {
      const res = await app.inject({
        method: "POST",
        url: "/api/musicdl/downloads",
        headers: auth,
        payload: { url: VIDEO },
      });
      const job = await waitJob(app, auth, res.json().job.id);
      expect(job.state).toBe("done");
    }
    expect(store.listMusicTracks("user-1")).toHaveLength(1);
    const jobs = store.listMusicdlJobs("user-1", 10);
    expect(JSON.parse(jobs[0]?.items ?? "[]")[0].deduped).toBe(true);
  });

  it("marks items beyond the quota as failed and keeps no file", async () => {
    const { app, store, auth } = await dlApp(
      fakeSpawn((args) => ({
        lines: [
          { type: "resolved", count: 2 },
          {
            type: "item",
            url: VIDEO,
            title: "A",
            video_id: "v1",
            ok: true,
            file_path: stageFile(stagingDir(args), "A.mp3"),
          },
          {
            type: "item",
            url: `${VIDEO}2`,
            title: "B",
            video_id: "v2",
            ok: true,
            file_path: stageFile(stagingDir(args), "B.mp3"),
          },
          { type: "done" },
        ],
      })),
      { MODULE_MUSICDL_MAX_TRACKS: "1" },
    );
    const res = await app.inject({
      method: "POST",
      url: "/api/musicdl/downloads",
      headers: auth,
      payload: { url: PLAYLIST },
    });
    const job = await waitJob(app, auth, res.json().job.id);
    expect(job.state).toBe("done");
    expect(job.items[0]?.ok).toBe(true);
    expect(job.items[1]?.ok).toBe(false);
    expect(job.items[1]?.error).toContain("quota");
    expect(store.listMusicTracks("user-1")).toHaveLength(1);
  });

  it("rejects playlists over the item cap before downloading", async () => {
    const { app, auth } = await dlApp(
      fakeSpawn(() => ({
        lines: [{ type: "resolved", count: 51 }, { type: "done" }],
      })),
    );
    const res = await app.inject({
      method: "POST",
      url: "/api/musicdl/downloads",
      headers: auth,
      payload: { url: PLAYLIST },
    });
    const job = await waitJob(app, auth, res.json().job.id);
    expect(job.state).toBe("failed");
    expect(job.error).toContain("51");
  });

  it("fails the job clearly when the worker binary is missing", async () => {
    const spawnChild = ((_cmd: string) => {
      const child = new EventEmitter() as unknown as import("node:child_process").ChildProcess;
      Object.assign(child, {
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        kill: () => true,
      });
      process.nextTick(() => {
        child.emit("error", Object.assign(new Error("spawn python3 ENOENT"), { code: "ENOENT" }));
      });
      return child;
    }) as typeof import("node:child_process").spawn;
    const { app, auth } = await dlApp(spawnChild);
    const res = await app.inject({
      method: "POST",
      url: "/api/musicdl/downloads",
      headers: auth,
      payload: { url: VIDEO },
    });
    const job = await waitJob(app, auth, res.json().job.id);
    expect(job.state).toBe("failed");
    expect(job.error).toContain("runtime unavailable");
  });
});
