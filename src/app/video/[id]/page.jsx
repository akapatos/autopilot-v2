"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";

export default function VideoPage() {
  const params = useParams();
  const id = params?.id;
  const [video, setVideo] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!id) return;

    async function load() {
      try {
        const res = await fetch(`/api/videos/${id}`);
        const data = await res.json();
        if (!res.ok) {
          throw new Error(data.error || "Video not found");
        }
        setVideo(data);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to load video");
      } finally {
        setLoading(false);
      }
    }

    load();
  }, [id]);

  return (
    <main className="mx-auto flex min-h-full w-full max-w-4xl flex-1 flex-col px-6 py-12">
      <header className="mb-8">
        <p className="text-sm text-zinc-500">
          <Link href="/" className="transition hover:text-zinc-300">
            AUTOPILOT
          </Link>
        </p>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight text-white">
          {video?.topic ?? "Your video"}
        </h1>
        {video && (
          <p className="mt-2 text-zinc-400">
            {video.niche} · {video.style}
          </p>
        )}
      </header>

      {loading && (
        <div className="flex flex-1 items-center justify-center text-zinc-500">
          Loading video…
        </div>
      )}

      {error && (
        <div className="rounded-xl border border-red-500/30 bg-red-500/10 p-6 text-red-200">
          {error}
        </div>
      )}

      {video?.file_url && (
        <div className="overflow-hidden rounded-2xl border border-zinc-800 bg-zinc-900/80 shadow-2xl shadow-black/40">
          <video
            src={video.file_url}
            controls
            className="aspect-video w-full bg-black"
            playsInline
          />
        </div>
      )}

      <div className="mt-8 flex gap-4">
        <Link
          href="/generate"
          className="rounded-lg border border-zinc-700 px-5 py-2.5 text-sm font-medium text-zinc-300 transition hover:border-zinc-500 hover:text-white"
        >
          Generate another
        </Link>
        <Link
          href="/library"
          className="rounded-lg border border-zinc-700 px-5 py-2.5 text-sm font-medium text-zinc-300 transition hover:border-zinc-500 hover:text-white"
        >
          Library
        </Link>
      </div>
    </main>
  );
}
