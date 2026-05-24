"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";

const NICHES = [
  "Technology",
  "Science",
  "History",
  "True Crime",
  "Finance",
  "Health",
  "Travel",
  "Nature",
  "Space",
  "Business",
];

const STYLES = [
  "Documentary",
  "Educational",
  "Cinematic",
  "Fast-Paced",
  "Storytelling",
  "News Report",
];

const VOICES = [
  { label: "Rachel", id: "21m00Tcm4TlvDq8ikWAM" },
  { label: "Domi", id: "AZnzlk1XvdvUeBnXmlld" },
  { label: "Bella", id: "EXAVITQu4vr4xnSDxMaL" },
  { label: "Antoni", id: "ErXwobaYiN019PkySvjV" },
  { label: "Josh", id: "TxGEqnHWrfWFTfGW9XjX" },
  { label: "Mark", id: "UgBBYS2sOqTuMpoF3BR0" },
];

const STAGE_LABELS = {
  script: "Writing script with Claude…",
  footage: "Fetching stock footage…",
  voiceover: "Generating voiceovers…",
  assembly: "Assembling final video…",
};

const POLL_INTERVAL_MS = 3000;

const defaultForm = {
  topic: "",
  niche: NICHES[0],
  length: 5,
  style: STYLES[0],
  voice: VOICES[0].id,
};

export default function GeneratePage() {
  const router = useRouter();
  const [phase, setPhase] = useState("form");
  const [form, setForm] = useState(defaultForm);
  const [videoId, setVideoId] = useState(null);
  const [stageText, setStageText] = useState("");
  const [errorMessage, setErrorMessage] = useState(null);
  const [submitting, setSubmitting] = useState(false);

  const pollVideo = useCallback(async (id) => {
    const res = await fetch(`/api/videos/${id}`);
    const data = await res.json();

    if (!res.ok) {
      throw new Error(data.error || "Failed to fetch video status");
    }

    return data;
  }, []);

  useEffect(() => {
    if (phase !== "progress" || !videoId) {
      return undefined;
    }

    let cancelled = false;

    async function checkStatus() {
      try {
        const video = await pollVideo(videoId);
        if (cancelled) return;

        if (video.status === "failed") {
          setErrorMessage(
            video.error_message || "Video generation failed. Please try again.",
          );
          setPhase("error");
          return;
        }

        if (video.generation_stage) {
          setStageText(
            STAGE_LABELS[video.generation_stage] ??
              `Processing: ${video.generation_stage}…`,
          );
        }

        if (video.status === "completed") {
          router.push(`/video/${videoId}`);
        }
      } catch (err) {
        if (!cancelled) {
          setErrorMessage(
            err instanceof Error ? err.message : "Status check failed",
          );
          setPhase("error");
        }
      }
    }

    checkStatus();
    const interval = setInterval(checkStatus, POLL_INTERVAL_MS);

    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [phase, videoId, pollVideo, router]);

  async function handleSubmit(e) {
    e.preventDefault();
    setSubmitting(true);
    setErrorMessage(null);

    try {
      const res = await fetch("/api/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          topic: form.topic.trim(),
          niche: form.niche,
          length: form.length,
          style: form.style,
          voice: form.voice,
        }),
      });

      const data = await res.json();

      if (!res.ok) {
        throw new Error(data.error || "Failed to start generation");
      }

      setVideoId(data.videoId);
      setStageText(STAGE_LABELS.script);
      setPhase("progress");
    } catch (err) {
      setErrorMessage(
        err instanceof Error ? err.message : "Something went wrong",
      );
      setPhase("error");
    } finally {
      setSubmitting(false);
    }
  }

  function handleRetry() {
    setPhase("form");
    setVideoId(null);
    setErrorMessage(null);
    setStageText("");
  }

  function updateField(key, value) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  return (
    <main className="mx-auto flex min-h-full w-full max-w-2xl flex-1 flex-col px-6 py-12">
      <header className="mb-10">
        <p className="text-sm font-medium text-zinc-500">
          <Link href="/" className="transition hover:text-emerald-400">
            AUTOPILOT
          </Link>
        </p>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight text-white">
          Generate
        </h1>
        <p className="mt-2 text-zinc-400">
          Create a new automated YouTube video from a topic.
        </p>
      </header>

      {phase === "form" && (
        <form
          onSubmit={handleSubmit}
          className="space-y-6 rounded-2xl border border-zinc-800 bg-zinc-900/60 p-8 shadow-xl shadow-black/20"
        >
          <div>
            <label
              htmlFor="topic"
              className="mb-2 block text-sm font-medium text-zinc-300"
            >
              Topic
            </label>
            <input
              id="topic"
              type="text"
              required
              value={form.topic}
              onChange={(e) => updateField("topic", e.target.value)}
              placeholder="e.g. The rise of artificial intelligence in healthcare"
              className="w-full rounded-lg border border-zinc-700 bg-zinc-950 px-4 py-3 text-white placeholder-zinc-600 outline-none transition focus:border-emerald-500/60 focus:ring-2 focus:ring-emerald-500/20"
            />
          </div>

          <div className="grid gap-6 sm:grid-cols-2">
            <div>
              <label
                htmlFor="niche"
                className="mb-2 block text-sm font-medium text-zinc-300"
              >
                Niche
              </label>
              <select
                id="niche"
                value={form.niche}
                onChange={(e) => updateField("niche", e.target.value)}
                className="w-full rounded-lg border border-zinc-700 bg-zinc-950 px-4 py-3 text-white outline-none transition focus:border-emerald-500/60 focus:ring-2 focus:ring-emerald-500/20"
              >
                {NICHES.map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label
                htmlFor="style"
                className="mb-2 block text-sm font-medium text-zinc-300"
              >
                Style
              </label>
              <select
                id="style"
                value={form.style}
                onChange={(e) => updateField("style", e.target.value)}
                className="w-full rounded-lg border border-zinc-700 bg-zinc-950 px-4 py-3 text-white outline-none transition focus:border-emerald-500/60 focus:ring-2 focus:ring-emerald-500/20"
              >
                {STYLES.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div>
            <div className="mb-2 flex items-center justify-between">
              <label htmlFor="length" className="text-sm font-medium text-zinc-300">
                Video length
              </label>
              <span className="rounded-md bg-emerald-500/15 px-2.5 py-0.5 text-sm font-semibold text-emerald-400">
                {form.length} min
              </span>
            </div>
            <input
              id="length"
              type="range"
              min={1}
              max={30}
              step={1}
              value={form.length}
              onChange={(e) => updateField("length", Number(e.target.value))}
              className="h-2 w-full cursor-pointer appearance-none rounded-full bg-zinc-800 accent-emerald-500"
            />
            <div className="mt-1 flex justify-between text-xs text-zinc-600">
              <span>1 min</span>
              <span>30 min</span>
            </div>
          </div>

          <div>
            <label
              htmlFor="voice"
              className="mb-2 block text-sm font-medium text-zinc-300"
            >
              Voice
            </label>
            <select
              id="voice"
              value={form.voice}
              onChange={(e) => updateField("voice", e.target.value)}
              className="w-full rounded-lg border border-zinc-700 bg-zinc-950 px-4 py-3 text-white outline-none transition focus:border-emerald-500/60 focus:ring-2 focus:ring-emerald-500/20"
            >
              {VOICES.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.label}
                </option>
              ))}
            </select>
          </div>

          <button
            type="submit"
            disabled={submitting || !form.topic.trim()}
            className="w-full rounded-lg bg-emerald-500 py-3.5 text-sm font-semibold text-zinc-950 transition hover:bg-emerald-400 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {submitting ? "Starting…" : "Generate video"}
          </button>
        </form>
      )}

      {phase === "progress" && (
        <section className="flex flex-1 flex-col items-center justify-center rounded-2xl border border-zinc-800 bg-zinc-900/60 px-8 py-16 text-center shadow-xl shadow-black/20">
          <div className="mb-6 h-12 w-12 animate-spin rounded-full border-2 border-zinc-700 border-t-emerald-500" />
          <h2 className="text-xl font-semibold text-white">
            Generating your video
          </h2>
          <p className="mt-3 max-w-sm text-zinc-400">{stageText}</p>
          <p className="mt-6 font-mono text-xs text-zinc-600">{videoId}</p>
        </section>
      )}

      {phase === "error" && (
        <section className="rounded-2xl border border-red-500/30 bg-red-500/10 px-8 py-10 text-center shadow-xl shadow-black/20">
          <h2 className="text-xl font-semibold text-red-200">
            Generation failed
          </h2>
          <p className="mt-3 text-sm text-red-300/90">{errorMessage}</p>
          <button
            type="button"
            onClick={handleRetry}
            className="mt-8 rounded-lg bg-zinc-800 px-6 py-2.5 text-sm font-medium text-white transition hover:bg-zinc-700"
          >
            Try again
          </button>
        </section>
      )}
    </main>
  );
}
