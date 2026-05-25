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
 * Serialize any thrown value (including Cloudinary's nested `error` objects) for logs.
 */
export function serializeError(error) {
  if (error == null) {
    return String(error);
  }
  if (typeof error === "string") {
    return error;
  }

  const nested = error.error ?? error.response?.body?.error ?? null;

  if (nested != null) {
    if (typeof nested === "string") {
      return nested;
    }
    if (typeof nested.message === "string" && nested.message) {
      return nested.message;
    }
    try {
      return JSON.stringify(nested);
    } catch {
      // fall through
    }
  }

  if (error instanceof Error) {
    const msg = error.message;
    if (typeof msg === "string" && msg && msg !== "[object Object]") {
      return msg;
    }
  }

  if (typeof error.message === "string" && error.message && error.message !== "[object Object]") {
    return error.message;
  }

  try {
    const seen = new WeakSet();
    return JSON.stringify(error, (_key, value) => {
      if (typeof value === "object" && value !== null) {
        if (seen.has(value)) {
          return "[Circular]";
        }
        seen.add(value);
      }
      return value;
    });
  } catch {
    try {
      return JSON.stringify({
        message: error.message,
        http_code: error.http_code,
        error: nested,
      });
    } catch {
      return String(error);
    }
  }
}

/**
 * Normalise Cloudinary SDK / API errors for logging.
 */
export function extractCloudinaryError(error) {
  if (!error) {
    return { message: "Unknown error (null)", serialized: "null" };
  }

  const nested = error.error ?? error.response?.body?.error ?? null;
  const serialized = serializeError(error);
  const cloudinaryMessage =
    typeof nested?.message === "string"
      ? nested.message
      : nested?.message != null
        ? serializeError(nested.message)
        : serialized;

  return {
    name: error.name ?? nested?.name ?? null,
    message:
      typeof error.message === "string" && error.message !== "[object Object]"
        ? error.message
        : cloudinaryMessage,
    serialized,
    http_code:
      error.http_code ??
      error.statusCode ??
      nested?.http_code ??
      nested?.status ??
      null,
    cloudinaryMessage,
    cloudinaryError:
      nested != null
        ? typeof nested === "object"
          ? JSON.parse(JSON.stringify(nested))
          : nested
        : undefined,
    requestId: error.request_id ?? nested?.request_id ?? null,
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
    const errorMessage = cloudinaryDetails.cloudinaryMessage || cloudinaryDetails.serialized;

    console.error("[cloudinary] Operation failed", {
      operation,
      ...context,
      errorMessage,
      errorSerialized: cloudinaryDetails.serialized,
      http_code: cloudinaryDetails.http_code,
      cloudinaryMessage: cloudinaryDetails.cloudinaryMessage,
      cloudinaryError: cloudinaryDetails.cloudinaryError,
      stack: error instanceof Error ? error.stack : undefined,
    });

    const wrapped = new Error(`[cloudinary:${operation}] ${errorMessage}`, {
      cause: error,
    });
    wrapped.cloudinaryDetails = cloudinaryDetails;
    throw wrapped;
  }
}

/**
 * Upload a local video file to Cloudinary (e.g. FFmpeg final output).
 */
export async function uploadLocalVideo(filePath, publicId) {
  return withCloudinaryCall(
    "uploadLocalVideo",
    { publicId, filePath },
    () =>
      cloudinary.uploader.upload(filePath, {
        resource_type: "video",
        public_id: publicId,
        overwrite: true,
        timeout: 300000,
      }),
  );
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
