import { NextResponse } from "next/server";
import {
  createSceneSegment,
  getClipTrimDuration,
  uploadRemoteAudio,
} from "@/lib/pipeline/cloudinary";
import { concatenateSegmentsWithFfmpeg } from "@/lib/pipeline/ffmpeg-concat";
import { prepareStockClip } from "@/lib/pipeline/ffmpeg-prepare";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const CROSSFADE_SECONDS = 0.5;

function clipsWithVoiceSync(clips) {
  return clips.map((clip) => {
    const voiceDuration = getClipTrimDuration(clip);
    return {
      ...clip,
      trim_start: Number(clip.trim_start ?? 0),
      duration: voiceDuration,
      trim_end: voiceDuration,
    };
  });
}

/**
 * FFmpeg-normalise stock footage, then upload each scene to Cloudinary.
 */
async function buildSceneSegmentsWithFfmpeg(clips, videoId) {
  const segments = [];

  for (let i = 0; i < clips.length; i++) {
    const clip = clips[i];
    const voiceDuration = getClipTrimDuration(clip);
    const trimStart = Number(clip.trim_start ?? 0);
    const audioPublicId = `autopilot/${videoId}/raw/scene_${i}_audio`;
    const segmentPublicId = `autopilot/${videoId}/segments/scene_${i}`;

    console.log("[assemble] Preparing scene", {
      videoId,
      index: i,
      voice_duration: clip.voice_duration,
      voiceDuration,
      source: clip.source,
    });

    await uploadRemoteAudio(clip.voice_url, audioPublicId);

    const prepared = await prepareStockClip(
      clip.file_url,
      voiceDuration,
      trimStart,
    );

    try {
      const segment = await createSceneSegment({
        videoSource: prepared.path,
        audioPublicId,
        trimStart,
        duration: voiceDuration,
        segmentPublicId,
      });

      segments.push({
        public_id: segment.public_id,
        secure_url: segment.secure_url,
      });
    } finally {
      await prepared.cleanup();
    }
  }

  return segments;
}

export async function POST(request) {
  console.log("[assemble] POST /api/assemble received");

  try {
    const body = await request.json();
    const { clips: rawClips, videoId } = body;

    if (!videoId) {
      return NextResponse.json({ error: "videoId is required" }, { status: 400 });
    }

    if (!Array.isArray(rawClips) || rawClips.length === 0) {
      return NextResponse.json(
        { error: "clips must be a non-empty array" },
        { status: 400 },
      );
    }

    for (let i = 0; i < rawClips.length; i++) {
      const clip = rawClips[i];
      if (!clip.file_url) {
        throw new Error(`Clip ${i} is missing file_url`);
      }
      if (!clip.voice_url) {
        throw new Error(`Clip ${i} is missing voice_url`);
      }
    }

    const clips = clipsWithVoiceSync(rawClips);

    console.log("[assemble] Starting assembly", {
      videoId,
      clipCount: clips.length,
      scenes: clips.map((c, i) => ({
        index: i,
        voice_duration: c.voice_duration,
        trimDuration: getClipTrimDuration(c),
      })),
      ffmpegPrepare: "1920x1080, h264, CRF 28, stream_loop when voice > clip",
      finalConcat: `${CROSSFADE_SECONDS}s xfade between clips`,
    });

    const segments = await buildSceneSegmentsWithFfmpeg(clips, videoId);
    const segmentUrls = segments.map((s) => s.secure_url);

    console.log("[assemble] Concatenating with FFmpeg xfade", {
      videoId,
      segmentCount: segmentUrls.length,
      crossfadeSeconds: CROSSFADE_SECONDS,
    });

    const finalVideo = await concatenateSegmentsWithFfmpeg(
      segmentUrls,
      `autopilot/${videoId}/final`,
      CROSSFADE_SECONDS,
    );

    console.log("[assemble] Assembly complete", {
      videoId,
      file_url: finalVideo.secure_url,
    });

    return NextResponse.json({
      videoId,
      file_url: finalVideo.secure_url,
      public_id: finalVideo.public_id,
      duration: finalVideo.duration,
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Assembly failed";
    console.error("[assemble] Assembly error", message, error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
