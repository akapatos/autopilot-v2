export const maxDuration = 300;
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

import fs from "fs";
import { createRequire } from "module";
import { NextResponse } from "next/server";

const require = createRequire(import.meta.url);

/** Log installer binary paths and whether they exist on disk (Vercel debugging). */
function logInstallerBinaryPaths() {
  const ffprobePath = require("@ffprobe-installer/ffprobe").path;
  const ffmpegPath = require("@ffmpeg-installer/ffmpeg").path;

  console.log("[assemble] Installer binary debug", {
    ffprobePath,
    ffprobeExists: fs.existsSync(ffprobePath),
    ffmpegPath,
    ffmpegExists: fs.existsSync(ffmpegPath),
    vercel: Boolean(process.env.VERCEL),
    platform: process.platform,
    arch: process.arch,
  });
}
import {
  concatenateSegmentsCloudinary,
  createSceneSegment,
  extractCloudinaryError,
  getClipTrimDuration,
  serializeError,
} from "@/lib/pipeline/cloudinary";
import { concatenateSegmentsWithFfmpeg } from "@/lib/pipeline/ffmpeg-concat";
import {
  checkFfmpegAvailability,
  isFfmpegAvailable,
} from "@/lib/pipeline/ffmpeg-check";

const CROSSFADE_SECONDS = 0.5;

const ASSEMBLY_STEPS = {
  PARSE_REQUEST: "parse_request",
  VALIDATE_CLIPS: "validate_clips",
  CHECK_FFMPEG: "check_ffmpeg",
  BUILD_SCENES: "build_scenes",
  SCENE_CREATE_SEGMENT: "scene_create_segment",
  FINALIZE_VIDEO: "finalize_video",
  FINALIZE_FFMPEG: "finalize_ffmpeg_concat",
  FINALIZE_CLOUDINARY: "finalize_cloudinary_splice",
};

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

function summarizeClipForLog(clip, index) {
  return {
    index,
    file_url: clip?.file_url ?? null,
    voice_url: clip?.voice_url ?? null,
    trim_start: clip?.trim_start ?? null,
    voice_duration: clip?.voice_duration ?? null,
    duration: clip?.duration ?? null,
    trim_end: clip?.trim_end ?? null,
    source: clip?.source ?? null,
    pexels_id: clip?.pexels_id ?? null,
  };
}

function summarizeClipsForLog(clips) {
  return clips.map((clip, index) => summarizeClipForLog(clip, index));
}

function formatErrorForLog(error) {
  const serialized = serializeError(error);

  if (!(error instanceof Error)) {
    return { message: serialized, serialized };
  }

  const cloudinary =
    error.cloudinaryDetails ?? extractCloudinaryError(error.cause ?? error);

  return {
    name: error.name,
    message:
      error.message && error.message !== "[object Object]"
        ? error.message
        : cloudinary.cloudinaryMessage || serialized,
    serialized,
    stack: error.stack,
    step: error.assemblyStep ?? null,
    clipIndex: error.assemblyClipIndex ?? null,
    cloudinary,
    cause: error.cause
      ? {
          serialized: serializeError(error.cause),
          cloudinary: extractCloudinaryError(error.cause),
        }
      : null,
  };
}

function wrapAssemblyError(error, context) {
  const serialized = serializeError(error);
  const wrapped =
    error instanceof Error ? error : new Error(serialized);

  if (!wrapped.message || wrapped.message === "[object Object]") {
    wrapped.message = serialized;
  }

  if (context.step) wrapped.assemblyStep = context.step;
  if (context.clipIndex != null) wrapped.assemblyClipIndex = context.clipIndex;
  if (context.clips) wrapped.assemblyClips = context.clips;
  if (context.videoId) wrapped.assemblyVideoId = context.videoId;

  wrapped.cloudinaryDetails = extractCloudinaryError(wrapped.cause ?? wrapped);

  return wrapped;
}

async function runStep(step, context, fn) {
  try {
    return await fn();
  } catch (error) {
    const enriched = wrapAssemblyError(error, { ...context, step });

    console.error("[assemble] Step failed", {
      step,
      videoId: context.videoId ?? null,
      clipIndex: context.clipIndex ?? null,
      clip: context.clip ? summarizeClipForLog(context.clip, context.clipIndex) : null,
      clips: context.clips ? summarizeClipsForLog(context.clips) : null,
      message: enriched.message,
      cloudinary: enriched.cloudinaryDetails,
      error: formatErrorForLog(enriched),
    });

    throw enriched;
  }
}

/**
 * Build one scene: FFmpeg downloads stock + voice, muxes locally, plain upload to Cloudinary.
 */
async function buildSceneSegment(clip, videoId, index, ffmpegStatus, allClips) {
  const voiceDuration = getClipTrimDuration(clip);
  const trimStart = Number(clip.trim_start ?? 0);
  const segmentPublicId = `autopilot/${videoId}/segments/scene_${index}`;
  const stepContext = {
    videoId,
    clipIndex: index,
    clip,
    clips: allClips,
  };

  if (!isFfmpegAvailable(ffmpegStatus)) {
    throw new Error(
      "FFmpeg is required to build scene segments (download stock, trim, mux voice)",
    );
  }

  console.log("[assemble] Building scene with FFmpeg (no Cloudinary transforms)", {
    videoId,
    index,
    clip: summarizeClipForLog(clip, index),
    voiceDuration,
    trimStart,
    segmentPublicId,
  });

  const segment = await runStep(
    ASSEMBLY_STEPS.SCENE_CREATE_SEGMENT,
    { ...stepContext, segmentPublicId },
    () =>
      createSceneSegment({
        stockUrl: clip.file_url,
        voiceUrl: clip.voice_url,
        trimStart,
        duration: voiceDuration,
        segmentPublicId,
      }),
  );

  return {
    public_id: segment.public_id,
    secure_url: segment.secure_url,
    method: "ffmpeg-local",
  };
}

async function buildAllSceneSegments(clips, videoId, ffmpegStatus) {
  const segments = [];

  for (let i = 0; i < clips.length; i++) {
    segments.push(
      await buildSceneSegment(clips[i], videoId, i, ffmpegStatus, clips),
    );
  }

  return segments;
}

/**
 * Final concat: FFmpeg downloads Cloudinary scene MP4s and concatenates locally.
 * Cloudinary splice is only used when FFmpeg is unavailable in this environment.
 */
async function finalizeVideo(segments, videoId, ffmpegStatus) {
  const finalPublicId = `autopilot/${videoId}/final`;
  const segmentUrls = segments.map((s) => s.secure_url);
  const segmentPublicIds = segments.map((s) => s.public_id);
  const stepContext = { videoId, segmentPublicIds, segmentUrls };

  if (isFfmpegAvailable(ffmpegStatus)) {
    console.log("[assemble] Final concat via FFmpeg (download scene MP4s from Cloudinary)", {
      videoId,
      step: ASSEMBLY_STEPS.FINALIZE_FFMPEG,
      segmentCount: segmentUrls.length,
      segmentUrls,
      segmentPublicIds,
      crossfadeSeconds: CROSSFADE_SECONDS,
    });

    const finalVideo = await runStep(
      ASSEMBLY_STEPS.FINALIZE_FFMPEG,
      stepContext,
      () =>
        concatenateSegmentsWithFfmpeg(
          segmentUrls,
          finalPublicId,
          CROSSFADE_SECONDS,
        ),
    );

    return { finalVideo, concatMethod: "ffmpeg-xfade" };
  }

  console.warn(
    "[assemble] FFmpeg unavailable — falling back to Cloudinary splice (no local concat)",
    { videoId, segmentPublicIds, segmentUrls },
  );

  const finalVideo = await runStep(
    ASSEMBLY_STEPS.FINALIZE_CLOUDINARY,
    stepContext,
    () => concatenateSegmentsCloudinary(segmentPublicIds, finalPublicId),
  );

  return { finalVideo, concatMethod: "cloudinary-splice" };
}

export async function POST(request) {
  logInstallerBinaryPaths();

  console.log("[assemble] POST /api/assemble received", {
    vercel: Boolean(process.env.VERCEL),
    region: process.env.VERCEL_REGION ?? null,
  });

  let ffmpegStatus = null;
  let currentStep = ASSEMBLY_STEPS.PARSE_REQUEST;
  let videoId = null;
  let clips = [];

  try {
    currentStep = ASSEMBLY_STEPS.PARSE_REQUEST;
    const body = await request.json();
    const { clips: rawClips, videoId: bodyVideoId } = body;
    videoId = bodyVideoId;

    if (!videoId) {
      return NextResponse.json({ error: "videoId is required" }, { status: 400 });
    }

    if (!Array.isArray(rawClips) || rawClips.length === 0) {
      return NextResponse.json(
        { error: "clips must be a non-empty array" },
        { status: 400 },
      );
    }

    currentStep = ASSEMBLY_STEPS.VALIDATE_CLIPS;
    for (let i = 0; i < rawClips.length; i++) {
      const clip = rawClips[i];
      if (!clip.file_url) {
        throw wrapAssemblyError(new Error(`Clip ${i} is missing file_url`), {
          step: currentStep,
          videoId,
          clipIndex: i,
          clips: summarizeClipsForLog(rawClips),
        });
      }
      if (!clip.voice_url) {
        throw wrapAssemblyError(new Error(`Clip ${i} is missing voice_url`), {
          step: currentStep,
          videoId,
          clipIndex: i,
          clips: summarizeClipsForLog(rawClips),
        });
      }
    }

    clips = clipsWithVoiceSync(rawClips);

    console.log("[assemble] Clips to process", {
      videoId,
      clipCount: clips.length,
      clips: summarizeClipsForLog(clips),
    });

    currentStep = ASSEMBLY_STEPS.CHECK_FFMPEG;
    ffmpegStatus = await checkFfmpegAvailability();

    console.log("[assemble] Starting assembly", {
      videoId,
      step: currentStep,
      clipCount: clips.length,
      clips: summarizeClipsForLog(clips),
      ffmpeg: {
        available: ffmpegStatus.available,
        workingPath: ffmpegStatus.workingPath,
        version: ffmpegStatus.versionLine,
        vercel: ffmpegStatus.vercel,
        probeErrors: ffmpegStatus.probeErrors,
      },
      preferredPath: isFfmpegAvailable(ffmpegStatus)
        ? "ffmpeg-scene-mux + ffmpeg-final-concat"
        : "unavailable (FFmpeg required for scenes)",
    });

    currentStep = ASSEMBLY_STEPS.BUILD_SCENES;
    const segments = await buildAllSceneSegments(clips, videoId, ffmpegStatus);

    console.log("[assemble] Scene segments ready", {
      videoId,
      step: currentStep,
      segments: segments.map((s, i) => ({
        index: i,
        method: s.method,
        public_id: s.public_id,
        secure_url: s.secure_url,
      })),
    });

    currentStep = ASSEMBLY_STEPS.FINALIZE_VIDEO;
    const { finalVideo, concatMethod } = await finalizeVideo(
      segments,
      videoId,
      ffmpegStatus,
    );

    console.log("[assemble] Assembly complete", {
      videoId,
      step: currentStep,
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
    const enriched = wrapAssemblyError(error, {
      step: error.assemblyStep ?? currentStep,
      videoId,
      clips,
    });

    const message =
      enriched instanceof Error ? enriched.message : "Assembly failed";

    console.error("[assemble] Assembly failed — full diagnostic", {
      videoId: enriched.assemblyVideoId ?? videoId,
      failedStep: enriched.assemblyStep ?? currentStep,
      clipIndex: enriched.assemblyClipIndex ?? null,
      message,
      cloudinaryMessage: enriched.cloudinaryDetails?.cloudinaryMessage ?? null,
      cloudinarySerialized: enriched.cloudinaryDetails?.serialized ?? null,
      cloudinaryHttpCode: enriched.cloudinaryDetails?.http_code ?? null,
      cloudinary: enriched.cloudinaryDetails,
      errorSerialized: serializeError(enriched),
      clips: enriched.assemblyClips?.length
        ? enriched.assemblyClips
        : summarizeClipsForLog(clips),
      clipAtFailure: enriched.assemblyClipIndex != null && clips.length
        ? summarizeClipForLog(clips[enriched.assemblyClipIndex], enriched.assemblyClipIndex)
        : null,
      error: formatErrorForLog(enriched),
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
        step: enriched.assemblyStep ?? currentStep,
        cloudinaryMessage: enriched.cloudinaryDetails?.cloudinaryMessage ?? null,
        ffmpegAvailable: ffmpegStatus?.available ?? null,
      },
      { status: 500 },
    );
  }
}
