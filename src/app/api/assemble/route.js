export const maxDuration = 300;
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

import { NextResponse } from "next/server";
import {
  concatenateSegmentsCloudinary,
  createSceneSegment,
  createSceneSegmentFromRemote,
  getClipTrimDuration,
  uploadRemoteAudio,
} from "@/lib/pipeline/cloudinary";
import { concatenateSegmentsWithFfmpeg } from "@/lib/pipeline/ffmpeg-concat";
import {
  checkFfmpegAvailability,
  isFfmpegAvailable,
  logFfmpegError,
} from "@/lib/pipeline/ffmpeg-check";
import { prepareStockClip } from "@/lib/pipeline/ffmpeg-prepare";

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

function formatErrorForLog(error) {
  if (!(error instanceof Error)) {
    return { message: String(error) };
  }
  return {
    name: error.name,
    message: error.message,
    stack: error.stack,
    cause:
      error.cause instanceof Error
        ? { message: error.cause.message, stack: error.cause.stack }
        : error.cause,
  };
}

/**
 * Build one scene: FFmpeg-normalised stock when available, else Cloudinary remote upload.
 */
async function buildSceneSegment(clip, videoId, index, ffmpegStatus) {
  const voiceDuration = getClipTrimDuration(clip);
  const trimStart = Number(clip.trim_start ?? 0);
  const audioPublicId = `autopilot/${videoId}/raw/scene_${index}_audio`;
  const segmentPublicId = `autopilot/${videoId}/segments/scene_${index}`;

  console.log("[assemble] Building scene", {
    videoId,
    index,
    voice_duration: clip.voice_duration,
    voiceDuration,
    trimStart,
    ffmpegAvailable: isFfmpegAvailable(ffmpegStatus),
    source: clip.source,
  });

  await uploadRemoteAudio(clip.voice_url, audioPublicId);

  if (isFfmpegAvailable(ffmpegStatus)) {
    try {
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

        return {
          public_id: segment.public_id,
          secure_url: segment.secure_url,
          method: "ffmpeg-prepare",
        };
      } finally {
        await prepared.cleanup();
      }
    } catch (error) {
      logFfmpegError("assemble-scene-prepare", error, {
        videoId,
        index,
        file_url: clip.file_url,
      });
      console.warn(
        "[assemble] FFmpeg scene prep failed — falling back to Cloudinary remote segment",
        { videoId, index, message: error instanceof Error ? error.message : error },
      );
    }
  } else {
    console.log(
      "[assemble] Skipping FFmpeg scene prep (unavailable) — using Cloudinary remote segment",
      { videoId, index },
    );
  }

  const segment = await createSceneSegmentFromRemote({
    fileUrl: clip.file_url,
    audioPublicId,
    trimStart,
    duration: voiceDuration,
    segmentPublicId,
  });

  return {
    public_id: segment.public_id,
    secure_url: segment.secure_url,
    method: "cloudinary-remote",
  };
}

async function buildAllSceneSegments(clips, videoId, ffmpegStatus) {
  const segments = [];

  for (let i = 0; i < clips.length; i++) {
    segments.push(await buildSceneSegment(clips[i], videoId, i, ffmpegStatus));
  }

  return segments;
}

/**
 * Final concat: FFmpeg xfade when possible; Cloudinary splice on failure or no FFmpeg.
 */
async function finalizeVideo(segments, videoId, ffmpegStatus) {
  const finalPublicId = `autopilot/${videoId}/final`;
  const segmentUrls = segments.map((s) => s.secure_url);
  const segmentPublicIds = segments.map((s) => s.public_id);

  if (isFfmpegAvailable(ffmpegStatus)) {
    try {
      console.log("[assemble] Concatenating with FFmpeg xfade", {
        videoId,
        segmentCount: segmentUrls.length,
        crossfadeSeconds: CROSSFADE_SECONDS,
      });

      const finalVideo = await concatenateSegmentsWithFfmpeg(
        segmentUrls,
        finalPublicId,
        CROSSFADE_SECONDS,
      );

      return { finalVideo, concatMethod: "ffmpeg-xfade" };
    } catch (error) {
      logFfmpegError("assemble-final-concat", error, {
        videoId,
        segmentCount: segmentUrls.length,
      });
      console.warn(
        "[assemble] FFmpeg final concat failed — falling back to Cloudinary splice",
        { videoId, message: error instanceof Error ? error.message : error },
      );
    }
  } else {
    console.log(
      "[assemble] Skipping FFmpeg final concat (unavailable) — using Cloudinary splice",
      { videoId },
    );
  }

  const finalVideo = await concatenateSegmentsCloudinary(
    segmentPublicIds,
    finalPublicId,
  );

  return { finalVideo, concatMethod: "cloudinary-splice" };
}

export async function POST(request) {
  console.log("[assemble] POST /api/assemble received", {
    vercel: Boolean(process.env.VERCEL),
    region: process.env.VERCEL_REGION ?? null,
  });

  let ffmpegStatus = null;

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

    ffmpegStatus = await checkFfmpegAvailability();

    const clips = clipsWithVoiceSync(rawClips);

    console.log("[assemble] Starting assembly", {
      videoId,
      clipCount: clips.length,
      ffmpeg: {
        available: ffmpegStatus.available,
        workingPath: ffmpegStatus.workingPath,
        version: ffmpegStatus.versionLine,
        vercel: ffmpegStatus.vercel,
        probeErrors: ffmpegStatus.probeErrors,
      },
      scenes: clips.map((c, i) => ({
        index: i,
        voice_duration: c.voice_duration,
        trimDuration: getClipTrimDuration(c),
      })),
      preferredPath: isFfmpegAvailable(ffmpegStatus)
        ? "ffmpeg-prepare + ffmpeg-xfade"
        : "cloudinary-remote + cloudinary-splice",
    });

    const segments = await buildAllSceneSegments(clips, videoId, ffmpegStatus);

    console.log("[assemble] Scene segments ready", {
      videoId,
      segments: segments.map((s, i) => ({
        index: i,
        method: s.method,
        public_id: s.public_id,
      })),
    });

    const { finalVideo, concatMethod } = await finalizeVideo(
      segments,
      videoId,
      ffmpegStatus,
    );

    console.log("[assemble] Assembly complete", {
      videoId,
      concatMethod,
      sceneMethods: segments.map((s) => s.method),
      file_url: finalVideo.secure_url,
    });

    return NextResponse.json({
      videoId,
      file_url: finalVideo.secure_url,
      public_id: finalVideo.public_id,
      duration: finalVideo.duration,
      concatMethod,
      sceneMethods: segments.map((s) => s.method),
      ffmpegAvailable: ffmpegStatus.available,
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Assembly failed";

    console.error("[assemble] Assembly error", {
      message,
      error: formatErrorForLog(error),
      ffmpeg: ffmpegStatus
        ? {
            available: ffmpegStatus.available,
            workingPath: ffmpegStatus.workingPath,
            probeErrors: ffmpegStatus.probeErrors,
          }
        : null,
    });

    return NextResponse.json(
      {
        error: message,
        ffmpegAvailable: ffmpegStatus?.available ?? null,
      },
      { status: 500 },
    );
  }
}
