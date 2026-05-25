import { v2 as cloudinary } from "cloudinary";

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
  secure: true,
});

/** Cloudinary overlays use `:` instead of `/` in public IDs. */
export function toOverlayPublicId(publicId) {
  return publicId.replace(/\//g, ":");
}

/** Scene length from measured voiceover (supports legacy field names). */
export function getClipTrimDuration(clip) {
  return Number(
    clip.voice_duration ??
      clip.actual_voice_duration ??
      clip.duration ??
      clip.trim_end ??
      10,
  );
}

/**
 * Normalise Cloudinary SDK / API errors for logging.
 */
export function extractCloudinaryError(error) {
  if (!error) {
    return { message: "Unknown error (null)" };
  }

  const nested = error.error ?? error.response?.body?.error ?? null;

  return {
    name: error.name ?? nested?.name ?? null,
    message: error.message ?? String(error),
    http_code:
      error.http_code ??
      error.statusCode ??
      nested?.http_code ??
      nested?.status ??
      null,
    cloudinaryMessage:
      nested?.message ?? error.message ?? String(error),
    cloudinaryError: nested ?? undefined,
    requestId: error.request_id ?? nested?.request_id ?? null,
    raw:
      typeof error === "object" && error !== null
        ? {
            keys: Object.keys(error),
            ...(nested && typeof nested === "object"
              ? { nestedKeys: Object.keys(nested) }
              : {}),
          }
        : String(error),
  };
}

/**
 * Run a Cloudinary operation with structured error logging before re-throw.
 */
async function withCloudinaryCall(operation, context, fn) {
  console.log("[cloudinary] Starting operation", { operation, ...context });

  try {
    const result = await fn();
    console.log("[cloudinary] Operation succeeded", {
      operation,
      publicId: result?.public_id ?? context.publicId ?? null,
      duration: result?.duration ?? null,
      bytes: result?.bytes ?? null,
    });
    return result;
  } catch (error) {
    const cloudinaryDetails = extractCloudinaryError(error);

    console.error("[cloudinary] Operation failed", {
      operation,
      ...context,
      ...cloudinaryDetails,
      stack: error instanceof Error ? error.stack : undefined,
    });

    throw error;
  }
}

/**
 * Upload voiceover (MP3). Audio assets use resource_type `video` in Cloudinary.
 */
export async function uploadRemoteAudio(url, publicId) {
  return withCloudinaryCall(
    "uploadRemoteAudio",
    { publicId, url },
    () =>
      cloudinary.uploader.upload(url, {
        resource_type: "video",
        public_id: publicId,
        overwrite: true,
        timeout: 120000,
      }),
  );
}

/**
 * Upload a prepared local MP4 and overlay voiceover for the scene duration.
 */
export async function createSceneSegment({
  videoSource,
  audioPublicId,
  trimStart,
  duration,
  segmentPublicId,
}) {
  const audioOverlay = toOverlayPublicId(audioPublicId);
  const videoSourceLabel =
    typeof videoSource === "string" && videoSource.startsWith("http")
      ? videoSource
      : typeof videoSource === "string"
        ? `[local:${videoSource}]`
        : String(videoSource);

  return withCloudinaryCall(
    "createSceneSegment",
    {
      segmentPublicId,
      audioPublicId,
      audioOverlay,
      trimStart,
      duration,
      videoSource: videoSourceLabel,
    },
    () =>
      cloudinary.uploader.upload(videoSource, {
        resource_type: "video",
        public_id: segmentPublicId,
        overwrite: true,
        timeout: 180000,
        transformation: [
          { start_offset: trimStart, duration },
          { audio_codec: "none" },
          { overlay: `audio:${audioOverlay}` },
          { flags: "layer_apply" },
          { format: "mp4", video_codec: "h264" },
        ],
      }),
  );
}

/**
 * Build a scene from remote stock URL (no local FFmpeg). Trims and overlays voice in Cloudinary.
 */
export async function createSceneSegmentFromRemote({
  fileUrl,
  audioPublicId,
  trimStart,
  duration,
  segmentPublicId,
}) {
  return createSceneSegment({
    videoSource: fileUrl,
    audioPublicId,
    trimStart,
    duration,
    segmentPublicId,
  });
}

/**
 * Concatenate uploaded scene segments with Cloudinary splice (hard cuts, no xfade).
 */
export async function concatenateSegmentsCloudinary(
  segmentPublicIds,
  finalPublicId,
) {
  if (!segmentPublicIds?.length) {
    throw new Error("No segments to concatenate");
  }

  const sourceUrl = cloudinary.url(segmentPublicIds[0], {
    resource_type: "video",
    secure: true,
    format: "mp4",
  });

  if (segmentPublicIds.length === 1) {
    return withCloudinaryCall(
      "concatenateSegmentsCloudinary.single",
      {
        finalPublicId,
        sourcePublicId: segmentPublicIds[0],
        sourceUrl,
      },
      () =>
        cloudinary.uploader.upload(sourceUrl, {
          resource_type: "video",
          public_id: finalPublicId,
          overwrite: true,
          timeout: 300000,
        }),
    );
  }

  const transformation = [];
  for (let i = 1; i < segmentPublicIds.length; i++) {
    transformation.push({
      overlay: {
        resource_type: "video",
        public_id: segmentPublicIds[i],
      },
    });
    transformation.push({ flags: "splice" });
  }

  return withCloudinaryCall(
    "concatenateSegmentsCloudinary.splice",
    {
      finalPublicId,
      segmentCount: segmentPublicIds.length,
      segmentPublicIds,
      basePublicId: segmentPublicIds[0],
      sourceUrl,
      transformation,
    },
    () =>
      cloudinary.uploader.upload(sourceUrl, {
        resource_type: "video",
        public_id: finalPublicId,
        overwrite: true,
        timeout: 300000,
        transformation,
      }),
  );
}
