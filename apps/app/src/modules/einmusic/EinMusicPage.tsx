import { useEffect, useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router";
import { ApiError } from "@/api/client";
import {
  useApi,
  useCreatePlaylist,
  useDeletePlaylist,
  useDeleteTrack,
  useEinMusicPlaylist,
  useEinMusicPlaylists,
  useEinMusicTracks,
  useModuleRegistry,
  useNavidromePlaylist,
  useNavidromePlaylists,
  useSavePlaylist,
  useUploadTrack,
} from "@/api/hooks";
import type { EinMusicPlaylistDetail, EinMusicTrack } from "@/api/types";
import { Button } from "@/components/ui/button";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

/** A playable item — `path` is fetched through the BFF and played via object URL (D48). */
interface PlayItem {
  path: string;
  title: string;
}

const localItem = (t: Pick<EinMusicTrack, "id" | "title">): PlayItem => ({
  path: `/einmusic/tracks/${t.id}/stream`,
  title: t.title,
});

function Player({
  queue,
  index,
  onPrev,
  onNext,
}: {
  queue: PlayItem[];
  index: number;
  onPrev: () => void;
  onNext: () => void;
}) {
  const { t } = useTranslation();
  const api = useApi();
  const item = queue[index];
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    if (!item) return;
    setUrl(null);
    setError(false);
    let objectUrl: string | null = null;
    void api
      .blob(item.path)
      .then((b) => {
        objectUrl = URL.createObjectURL(b);
        setUrl(objectUrl);
      })
      .catch(() => setError(true));
    return () => {
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [api, item]);

  if (!item) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{item.title}</CardTitle>
        <CardDescription>
          {index + 1} / {queue.length}
        </CardDescription>
      </CardHeader>
      <div className="row">
        <Button variant="outline" size="sm" onClick={onPrev} disabled={index === 0}>
          {t("modules.einmusic.prev")}
        </Button>
        {error ? (
          <span className="muted">{t("modules.einmusic.playError")}</span>
        ) : url ? (
          // biome-ignore lint/a11y/useMediaCaption: uploaded MP3s carry no caption tracks
          <audio key={item.path} controls autoPlay src={url} onEnded={onNext} />
        ) : (
          <span className="muted">{t("common.loading")}</span>
        )}
        <Button variant="outline" size="sm" onClick={onNext} disabled={index >= queue.length - 1}>
          {t("modules.einmusic.next")}
        </Button>
      </div>
    </Card>
  );
}

function formatBytes(n: number): string {
  const units = ["B", "KiB", "MiB", "GiB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v.toFixed(v >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
}

function PlaylistSection({
  playlist,
  onPlay,
}: {
  playlist: { id: number; name: string; trackCount?: number };
  onPlay: (items: PlayItem[], index: number) => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const detail = useEinMusicPlaylist(open ? playlist.id : null);
  const save = useSavePlaylist();
  const del = useDeletePlaylist();
  const items = (detail.data?.tracks ?? []).map(localItem);

  const removeTrack = (trackId: number) => {
    if (!detail.data) return;
    save.mutate({
      id: playlist.id,
      trackIds: detail.data.tracks.map((t) => t.id).filter((id) => id !== trackId),
    });
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">
          <button type="button" onClick={() => setOpen(!open)} className="linklike">
            {playlist.name}
          </button>
        </CardTitle>
        <CardDescription>
          {t("modules.einmusic.trackCount", { count: playlist.trackCount ?? 0 })}
        </CardDescription>
      </CardHeader>
      <div className="row">
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            setOpen(true);
            onPlay(items, 0);
          }}
          disabled={items.length === 0}
        >
          {t("modules.einmusic.play")}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => del.mutate(playlist.id)}
          disabled={del.isPending}
        >
          {t("modules.einmusic.delete")}
        </Button>
      </div>
      {open && detail.data && (
        <ul className="status-list">
          {detail.data.tracks.length === 0 && (
            <li className="muted">{t("modules.einmusic.playlistEmpty")}</li>
          )}
          {detail.data.tracks.map((track, i) => (
            <li key={track.id} className="status-item">
              <button type="button" className="linklike" onClick={() => onPlay(items, i)}>
                {track.title}
              </button>
              <Button variant="ghost" size="sm" onClick={() => removeTrack(track.id)}>
                {t("modules.einmusic.remove")}
              </Button>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function TrackRow({
  track,
  playlists,
  onPlay,
}: {
  track: EinMusicTrack;
  playlists: { id: number; name: string }[];
  onPlay: () => void;
}) {
  const { t } = useTranslation();
  const api = useApi();
  const save = useSavePlaylist();
  const del = useDeleteTrack();

  const addTo = async (playlistId: string) => {
    const detail = await api.get<EinMusicPlaylistDetail>(`/einmusic/playlists/${playlistId}`);
    save.mutate({
      id: Number(playlistId),
      trackIds: [...detail.tracks.map((t) => t.id), track.id],
    });
  };

  return (
    <li className="status-item">
      <button type="button" className="linklike" onClick={onPlay}>
        {track.title}
      </button>
      <span className="muted">{formatBytes(track.bytes)}</span>
      {playlists.length > 0 && (
        <Select onValueChange={(v) => void addTo(v)}>
          <SelectTrigger aria-label={t("modules.einmusic.addToPlaylist")} className="w-44">
            <SelectValue placeholder={t("modules.einmusic.addToPlaylist")} />
          </SelectTrigger>
          <SelectContent>
            {playlists.map((p) => (
              <SelectItem key={p.id} value={String(p.id)}>
                {p.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
      <Button
        variant="ghost"
        size="sm"
        onClick={() => del.mutate(track.id)}
        disabled={del.isPending}
      >
        {t("modules.einmusic.delete")}
      </Button>
    </li>
  );
}

function NavidromeSection({ onPlay }: { onPlay: (items: PlayItem[], index: number) => void }) {
  const { t } = useTranslation();
  const registry = useModuleRegistry();
  const enabled = registry.data?.modules.some((m) => m.id === "navidrome") ?? false;
  const [openId, setOpenId] = useState<string | null>(null);
  const playlists = useNavidromePlaylists(enabled);
  const detail = useNavidromePlaylist(openId);

  if (!enabled) return null;

  const notConnected =
    playlists.isError && playlists.error instanceof ApiError && playlists.error.status === 424;
  const items: PlayItem[] = (detail.data?.tracks ?? []).map((tr) => ({
    path: `/einmusic/navidrome/stream?songId=${encodeURIComponent(tr.id)}`,
    title: tr.artist ? `${tr.artist} — ${tr.title}` : tr.title,
  }));

  return (
    <div className="stack">
      <h2 className="text-lg">{t("modules.einmusic.navidrome")}</h2>
      {notConnected && (
        <div className="stack">
          <p className="muted">{t("modules.einmusic.navidromeNotConnected")}</p>
          <div>
            <Button variant="outline" asChild>
              <Link to="/navidrome">{t("modules.einmusic.navidromeConfigure")}</Link>
            </Button>
          </div>
        </div>
      )}
      {playlists.isError && !notConnected && (
        <p className="alert alert--danger">
          {t("modules.einmusic.navidromeError", {
            status: playlists.error instanceof ApiError ? playlists.error.status : "?",
          })}
        </p>
      )}
      {playlists.data?.playlists.length === 0 && (
        <p className="muted">{t("modules.einmusic.navidromeEmpty")}</p>
      )}
      {playlists.data?.playlists.map((p) => (
        <Card key={p.id}>
          <CardHeader>
            <CardTitle className="text-base">
              <button
                type="button"
                className="linklike"
                onClick={() => setOpenId(openId === p.id ? null : p.id)}
              >
                {p.name}
              </button>
            </CardTitle>
            <CardDescription>
              {t("modules.einmusic.trackCount", { count: p.songCount })}
            </CardDescription>
          </CardHeader>
          <div className="row">
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setOpenId(p.id);
                onPlay(items, 0);
              }}
              disabled={openId !== p.id || items.length === 0}
            >
              {t("modules.einmusic.play")}
            </Button>
          </div>
          {openId === p.id && detail.data && (
            <ul className="status-list">
              {detail.data.tracks.map((tr, i) => (
                <li key={tr.id} className="status-item">
                  <button type="button" className="linklike" onClick={() => onPlay(items, i)}>
                    {tr.artist ? `${tr.artist} — ${tr.title}` : tr.title}
                  </button>
                  {tr.album && <span className="muted">{tr.album}</span>}
                </li>
              ))}
            </ul>
          )}
        </Card>
      ))}
    </div>
  );
}

export function EinMusicPage() {
  const { t } = useTranslation();
  const tracks = useEinMusicTracks();
  const playlists = useEinMusicPlaylists();
  const upload = useUploadTrack();
  const create = useCreatePlaylist();
  const fileId = useId();
  const nameId = useId();
  const [file, setFile] = useState<File | null>(null);
  const [fileKey, setFileKey] = useState(0);
  const [name, setName] = useState("");
  const [queue, setQueue] = useState<PlayItem[]>([]);
  const [index, setIndex] = useState(0);

  const play = (items: PlayItem[], i: number) => {
    setQueue(items);
    setIndex(i);
  };

  return (
    <div className="stack">
      {queue.length > 0 && (
        <Player
          queue={queue}
          index={index}
          onPrev={() => setIndex(Math.max(0, index - 1))}
          onNext={() => setIndex(Math.min(queue.length - 1, index + 1))}
        />
      )}

      <div className="stack">
        <h2 className="text-lg">{t("modules.einmusic.library")}</h2>
        <div className="row">
          <Input
            id={fileId}
            key={fileKey}
            type="file"
            accept="audio/mpeg,.mp3"
            aria-label={t("modules.einmusic.upload")}
            onChange={(e) => setFile(e.currentTarget.files?.[0] ?? null)}
          />
          <Button
            variant="outline"
            onClick={() => {
              if (file) {
                upload.mutate(file, {
                  onSuccess: () => {
                    setFile(null);
                    setFileKey((k) => k + 1);
                  },
                });
              }
            }}
            disabled={!file || upload.isPending}
          >
            {upload.isPending ? t("modules.einmusic.uploading") : t("modules.einmusic.upload")}
          </Button>
        </div>
        {upload.isError && (
          <p className="alert alert--danger">
            {t("modules.einmusic.uploadError", {
              status: upload.error instanceof ApiError ? upload.error.status : "?",
            })}
          </p>
        )}
        {tracks.isPending && <p className="muted">{t("common.loading")}</p>}
        {tracks.data?.tracks.length === 0 && <p className="muted">{t("modules.einmusic.empty")}</p>}
        <ul className="status-list">
          {tracks.data?.tracks.map((track, i, all) => (
            <TrackRow
              key={track.id}
              track={track}
              playlists={playlists.data?.playlists ?? []}
              onPlay={() => play(all.map(localItem), i)}
            />
          ))}
        </ul>
      </div>

      <div className="stack">
        <h2 className="text-lg">{t("modules.einmusic.playlists")}</h2>
        <div className="row">
          <div className="flex flex-col gap-1">
            <Label htmlFor={nameId}>{t("modules.einmusic.playlistName")}</Label>
            <Input
              id={nameId}
              className="w-56"
              value={name}
              onChange={(e) => setName(e.currentTarget.value)}
            />
          </div>
          <Button
            variant="outline"
            onClick={() => {
              const trimmed = name.trim();
              if (trimmed) create.mutate(trimmed, { onSuccess: () => setName("") });
            }}
            disabled={!name.trim() || create.isPending}
          >
            {t("modules.einmusic.create")}
          </Button>
        </div>
        {playlists.data?.playlists.length === 0 && (
          <p className="muted">{t("modules.einmusic.noPlaylists")}</p>
        )}
        {playlists.data?.playlists.map((p) => (
          <PlaylistSection key={p.id} playlist={p} onPlay={play} />
        ))}
      </div>

      <NavidromeSection onPlay={play} />
    </div>
  );
}
