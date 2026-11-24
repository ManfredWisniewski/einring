import { spawn } from "node:child_process";
import { existsSync, mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import { basename, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { AppContext } from "../app.js";
import type { MusicdlJobRow } from "../db.js";
import type { BffModule } from "./types.js";

/**
 * musicdl (spec einmusic-ytdl): YouTube downloads into the shared EinMusic
 * track store via the wit_pytools ytdlptools wrapper. Persisted background
 * jobs, polled by the app.
 */

const WORKER = fileURLToPath(new URL("../../scripts/musicdl_worker.py", import.meta.url));

const YT_HOSTS = new Set([
  "youtube.com",
  "www.youtube.com",
  "m.youtube.com",
  "music.youtube.com",
  "youtu.be",
  "www.youtu.be",
]);

/** Only YouTube http(s) links reach the child process (SSRF/injection guard). */
function isYouTubeUrl(raw: string): boolean {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return false;
  return YT_HOSTS.has(u.hostname.toLowerCase());
}

interface JobItem {
  url: string;
  title?: string;
  videoId?: string;
  ok: boolean;
  deduped?: boolean;
  trackId?: number;
  error?: string;
}

interface WorkerItem {
  type: string;
  url?: string;
  title?: string;
  video_id?: string;
  ok?: boolean;
  file_path?: string;
  error?: string;
  count?: number;
}

function mediaDir(ctx: AppContext): string {
  const dir = resolve(ctx.config.DATA_DIR, "einmusic");
  mkdirSync(dir, { recursive: true });
  return dir;
}

function serializeJob(job: Omit<MusicdlJobRow, "sub">) {
  return {
    id: job.id,
    url: job.url,
    state: job.state,
    total: job.total,
    done: (JSON.parse(job.items) as JobItem[]).length,
    items: JSON.parse(job.items) as JobItem[],
    error: job.error,
    createdAt: job.createdAt,
    finishedAt: job.finishedAt,
  };
}

const configSchema = z.object({
  /** Python executable override; default python3 (python on Windows). */
  PYTHON: z.string().optional(),
  /** Reject submissions resolving to more items than this. */
  MAX_ITEMS: z.coerce.number().int().positive().default(50),
  /** Per-user aggregate quota, same semantics as the einmusic upload quota. */
  MAX_TOTAL_BYTES: z.coerce
    .number()
    .int()
    .positive()
    .default(2 * 1024 * 1024 * 1024),
  MAX_TRACKS: z.coerce.number().int().positive().default(500),
});

type MusicdlConfig = z.infer<typeof configSchema>;

/** Import one downloaded item into the user's track store (dedupe → quota → move). */
function importItem(
  ctx: AppContext,
  config: MusicdlConfig,
  sub: string,
  item: WorkerItem,
): JobItem {
  const base: JobItem = {
    url: item.url ?? "",
    title: item.title,
    videoId: item.video_id,
    ok: false,
  };
  const file = item.file_path;
  if (!item.ok || !file || !existsSync(file)) {
    return { ...base, error: item.error ?? "download failed" };
  }
  if (item.video_id) {
    const existing = ctx.store.getMusicTrackByVideoId(sub, item.video_id);
    if (existing) {
      rmSync(file, { force: true });
      return { ...base, ok: true, deduped: true, trackId: existing.id };
    }
  }
  const size = statSync(file).size;
  const usage = ctx.store.musicUsage(sub);
  if (usage.bytes + size > config.MAX_TOTAL_BYTES || usage.tracks + 1 > config.MAX_TRACKS) {
    rmSync(file, { force: true });
    return { ...base, error: "upload quota exceeded" };
  }
  const title = item.title || basename(file).replace(/\.[^.]+$/, "");
  const track = ctx.store.createMusicTrack(sub, title, size, item.video_id ?? null);
  renameSync(file, resolve(mediaDir(ctx), `${track.id}.mp3`));
  return { ...base, ok: true, trackId: track.id };
}

/** Drive the worker process and fold its JSON-lines into the persisted job. */
function runJob(ctx: AppContext, config: MusicdlConfig, sub: string, jobId: number, url: string) {
  const items: JobItem[] = [];
  let total = 0;
  const save = (
    patch: Partial<{
      state: string;
      total: number;
      error: string | null;
      finishedAt: string | null;
    }>,
  ) => {
    if (patch.total !== undefined) total = patch.total;
    ctx.store.updateMusicdlJob(jobId, {
      state: patch.state ?? "running",
      total,
      items: JSON.stringify(items),
      error: patch.error ?? null,
      finishedAt: patch.finishedAt ?? null,
    });
  };
  const fail = (error: string) =>
    save({ state: "failed", error, finishedAt: new Date().toISOString() });

  const staging = resolve(ctx.config.DATA_DIR, "musicdl", String(jobId));
  try {
    mkdirSync(staging, { recursive: true });
  } catch (e) {
    fail(`staging dir: ${String(e)}`);
    return;
  }

  const python = config.PYTHON ?? (process.platform === "win32" ? "python" : "python3");
  const spawnFn = ctx.spawnChild ?? spawn;
  let killed = false;
  const child = spawnFn(python, [WORKER, url, staging], {
    env: {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? "",
      USERPROFILE: process.env.USERPROFILE ?? "",
      SYSTEMROOT: process.env.SYSTEMROOT ?? "",
      TEMP: process.env.TEMP ?? "",
      TMP: process.env.TMP ?? "",
      PYTHONUTF8: "1",
      PYTHONIOENCODING: "utf-8",
      NO_COLOR: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  const cleanup = () => {
    try {
      rmSync(staging, { recursive: true, force: true });
    } catch {
      /* staging cleanup is best-effort */
    }
  };

  let stderrTail = "";
  child.stderr?.on("data", (d: Buffer) => {
    stderrTail = (stderrTail + d.toString()).slice(-2000);
  });

  // Finalize only once the child exited AND stdout was fully drained —
  // otherwise trailing item lines would flip a finished job back to running.
  let childCode: number | null = null;
  let rlDone = false;
  const finish = () => {
    if (childCode === null || !rlDone || killed) return;
    killed = true;
    const job = ctx.store.getMusicdlJob(sub, jobId);
    if (job?.state === "failed") return cleanup();
    if (childCode !== 0 && !job?.error) {
      save({
        state: "failed",
        error: stderrTail.trim().split("\n").pop() || `worker exited ${childCode}`,
        finishedAt: new Date().toISOString(),
      });
    } else {
      save({ state: "done", finishedAt: new Date().toISOString() });
    }
    cleanup();
  };

  if (!child.stdout) throw new Error("musicdl worker spawned without stdout");
  const rl = createInterface({ input: child.stdout });
  rl.on("close", () => {
    rlDone = true;
    finish();
  });
  child.on("close", (code) => {
    childCode = code;
    finish();
  });
  child.on("error", (e) => {
    killed = true;
    fail(`download runtime unavailable: ${e.message}`);
    cleanup();
  });

  rl.on("line", (line) => {
    let msg: WorkerItem;
    try {
      msg = JSON.parse(line) as WorkerItem;
    } catch {
      return;
    }
    if (msg.type === "resolved") {
      const total = msg.count ?? 0;
      if (total > config.MAX_ITEMS) {
        killed = true;
        child.kill();
        save({
          state: "failed",
          total,
          error: `playlist has ${total} items (max ${config.MAX_ITEMS})`,
          finishedAt: new Date().toISOString(),
        });
        cleanup();
        return;
      }
      save({ state: "running", total });
    } else if (msg.type === "item") {
      items.push(importItem(ctx, config, sub, msg));
      save({});
    } else if (msg.type === "error") {
      killed = true;
      child.kill();
      fail(msg.error ?? "worker error");
      cleanup();
    }
  });
}

export const musicdlModule: BffModule<MusicdlConfig> = {
  id: "musicdl",
  version: "0.1.0",
  configSchema,

  register(api, ctx, config) {
    api.post("/downloads", async (req, reply) => {
      const url = (req.body as { url?: unknown } | undefined)?.url;
      if (typeof url !== "string" || !isYouTubeUrl(url)) {
        return reply.code(400).send({ error: "expected a YouTube http(s) URL" });
      }
      const job = ctx.store.createMusicdlJob(req.user.sub, url);
      void runJob(ctx, config, req.user.sub, job.id, url);
      return reply.code(201).send({ job: serializeJob(job) });
    });

    api.get("/downloads", async (req) => ({
      jobs: ctx.store.listMusicdlJobs(req.user.sub, 20).map(serializeJob),
    }));

    api.get("/downloads/:id", async (req, reply) => {
      const id = Number((req.params as { id: string }).id);
      const job = Number.isInteger(id) ? ctx.store.getMusicdlJob(req.user.sub, id) : undefined;
      if (!job) return reply.code(404).send({ error: "not found" });
      return { job: serializeJob(job) };
    });
  },
};
