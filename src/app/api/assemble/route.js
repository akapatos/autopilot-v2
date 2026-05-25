export const maxDuration = 300;
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

import { NextResponse } from "next/server";
import {
  concatenateSegmentsCloudinary,
  createSceneSegment,
  createSceneSegmentFromRemote,
  extractCloudinaryError,
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

const ASSEMBLY_STEPS = {
  PARSE_REQUEST: "parse_request",
  VALIDATE_CLIPS: "validate_clips",
  CHECK_FFMPEG: "check_ffmpeg",
  BUILD_SCENES: "build_scenes",
  SCENE_UPLOAD_AUDIO: "scene_upload_audio",
  SCENE_FFMPEG_PREPARE: "scene_ffmpeg_prepare",
  SCENE_CREATE_SEGMENT: "scene_create_segment",
  SCENE_CREATE_SEGMENT_REMOTE: "scene_create_segment_remote",
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
  if (!(error instanceof Error)) {
    return { message: String(error) };
  }

  return {
    name: error.name,
    message: error.message,
    stack: error.stack,
    step: error.assemblyStep ?? null,
    clipIndex: error.assemblyClipIndex ?? null,
    cloudinary: error.cloudinaryDetails ?? extractCloudinaryError(error),
    cause:
      error.cause instanceof Error
        ? {
            name: error.cause.name,
            message: error.cause.message,
            stack: error.cause.stack,
            cloudinary: extractCloudinaryError(error.cause),
          }
        : error.cause,
  };
}

function wrapAssemblyError(error, context) {
  const wrapped =
    error instanceof Error ? error : new Error(String(error));

  if (context.step) wrapped.assemblyStep = context.step;
  if (context.clipIndex != null) wrapped.assemblyClipIndex = context.clipIndex;
  if (context.clips) wrapped.assemblyClips = context.clips;
  if (context.videoId) wrapped.assemblyVideoId = context.videoId;

  wrapped.cloudinaryDetails = extractCloudinaryError(
    wrapped.cause ?? wrapped,
  );

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
 * Build one scene: FFmpeg-normalised stock when available, else Cloudinary remote upload.
 */
async function buildSceneSegment(clip, videoId, index, ffmpegStatus, allClips) {
  const voiceDuration = getClipTrimDuration(clip);
  const trimStart = Number(clip.trim_start ?? 0);
  const audioPublicId = `autopilot/${videoId}/raw/scene_${index}_audio`;
  const segmentPublicId = `autopilot/${videoId}/segments/scene_${index}`;
  const stepContext = {
    videoId,
    clipIndex: index,
    clip,
    clips: allClips,
  };

  console.log("[assemble] Building scene", {
    videoId,
    index,
    step: ASSEMBLY_STEPS.BUILD_SCENES,
    clip: summarizeClipForLog(clip, index),
    voiceDuration,
    trimStart,
    ffmpegAvailable: isFfmpegAvailable(ffmpegStatus),
  });

  await runStep(ASSEMBLY_STEPS.SCENE_UPLOAD_AUDIO, stepContext, () =>
    uploadRemoteAudio(clip.voice_url, audioPublicId),
  );

  if (isFfmpegAvailable(ffmpegStatus)) {
    try {
      const prepared = await runStep(
        ASSEMBLY_STEPS.SCENE_FFMPEG_PREPARE,
        stepContext,
        () => prepareStockClip(clip.file_url, voiceDuration, trimStart),
      );

      try {
        const segment = await runStep(
          ASSEMBLY_STEPS.SCENE_CREATE_SEGMENT,
          { ...stepContext, segmentPublicId, audioPublicId },
          () =>
            createSceneSegment({
              videoSource: prepared.path,
              audioPublicId,
              trimStart,
              duration: voiceDuration,
              segmentPublicId,
            }),
        );

        return {
          public_id: segment.public_id,
          secure_url: segment.secure_url,
          method: "ffmpeg-prepare",
        };
      } finally {
        await prepared.cleanup();
      }
    } catch (error) {
      if (error.assemblyStep === ASSEMBLY_STEPS.SCENE_CREATE_SEGMENT) {
        throw error;
      }

      logFfmpegError("assemble-scene-prepare", error, {
        videoId,
        index,
        file_url: clip.file_url,
        voice_url: clip.voice_url,
      });
      console.warn(
        "[assemble] FFmpeg scene prep failed — falling back to Cloudinary remote segment",
        {
          videoId,
          index,
          step: error.assemblyStep ?? ASSEMBLY_STEPS.SCENE_FFMPEG_PREPARE,
          message: error.message,
          clip: summarizeClipForLog(clip, index),
        },
      );
    }
  } else {
    console.log(
      "[assemble] Skipping FFmpeg scene prep (unavailable) — using Cloudinary remote segment",
      { videoId, index, clip: summarizeClipForLog(clip, index) },
    );
  }

  const segment = await runStep(
    ASSEMBLY_STEPS.SCENE_CREATE_SEGMENT_REMOTE,
    { ...stepContext, segmentPublicId, audioPublicId, fileUrl: clip.file_url },
    () =>
      createSceneSegmentFromRemote({
        fileUrl: clip.file_url,
        audioPublicId,
        trimStart,
        duration: voiceDuration,
        segmentPublicId,
      }),
  );

  return {
    public_id: segment.public_id,
    secure_url: segment.secure_url,
    method: "cloudinary-remote",
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
 * Final concat: FFmpeg xfade when possible; Cloudinary splice on failure or no FFmpeg.
 */
async function finalizeVideo(segments, videoId, ffmpegStatus) {
  const finalPublicId = `autopilot/${videoId}/final`;
  const segmentUrls = segments.map((s) => s.secure_url);
  const segmentPublicIds = segments.map((s) => s.public_id);
  const stepContext = { videoId, segmentPublicIds, segmentUrls };

  if (isFfmpegAvailable(ffmpegStatus)) {
    try {
      console.log("[assemble] Concatenating with FFmpeg xfade", {
        videoId,
        step: ASSEMBLY_STEPS.FINALIZE_FFMPEG,
        segmentCount: segmentUrls.length,
        segmentUrls,
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
    } catch (error) {
      if (error.assemblyStep === ASSEMBLY_STEPS.FINALIZE_FFMPEG) {
        logFfmpegError("assemble-final-concat", error, {
          videoId,
          segmentCount: segmentUrls.length,
          segmentUrls,
        });
        console.warn(
          "[assemble] FFmpeg final concat failed — falling back to Cloudinary splice",
          {
            videoId,
            step: ASSEMBLY_STEPS.FINALIZE_FFMPEG,
            message: error.message,
            segmentUrls,
            cloudinary: error.cloudinaryDetails,
          },
        );
      } else {
        throw error;
      }
    }
  } else {
    console.log(
      "[assemble] Skipping FFmpeg final concat (unavailable) — using Cloudinary splice",
      { videoId, segmentPublicIds, segmentUrls },
    );
  }

  const finalVideo = await runStep(
    ASSEMBLY_STEPS.FINALIZE_CLOUDINARY,
    stepContext,
    () => concatenateSegmentsCloudinary(segmentPublicIds, finalPublicId),
  );

  return { finalVideo, concatMethod: "cloudinary-splice" };
}

export async function POST(request) {
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
        ? "ffmpeg-prepare + ffmpeg-xfade"
        : "cloudinary-remote + cloudinary-splice",
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
      cloudinaryHttpCode: enriched.cloudinaryDetails?.http_code ?? null,
      cloudinary: enriched.cloudinaryDetails,
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
