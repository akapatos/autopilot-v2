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
 * Upload voiceover (MP3). Audio assets use resource_type `video` in Cloudinary.
 */
export async function uploadRemoteAudio(url, publicId) {
  console.log("[cloudinary] Uploading remote audio", { publicId, url });

  const result = await cloudinary.uploader.upload(url, {
    resource_type: "video",
    public_id: publicId,
    overwrite: true,
    timeout: 120000,
  });

  console.log("[cloudinary] Audio uploaded", {
    publicId: result.public_id,
    duration: result.duration,
  });

  return result;
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

  console.log("[cloudinary] Creating scene segment", {
    segmentPublicId,
    audioOverlay,
    trimStart,
    duration,
  });

  const result = await cloudinary.uploader.upload(videoSource, {
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
  });

  console.log("[cloudinary] Scene segment ready", {
    publicId: result.public_id,
    url: result.secure_url,
    duration: result.duration,
  });

  return result;
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
  console.log("[cloudinary] Creating scene segment from remote URL (no FFmpeg)", {
    segmentPublicId,
    trimStart,
    duration,
    fileUrl: fileUrl?.slice?.(0, 120),
  });

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
    console.log("[cloudinary] Single segment — copying to final public_id", {
      finalPublicId,
      sourcePublicId: segmentPublicIds[0],
    });

    return cloudinary.uploader.upload(sourceUrl, {
      resource_type: "video",
      public_id: finalPublicId,
      overwrite: true,
      timeout: 300000,
    });
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

  console.log("[cloudinary] Concatenating segments with splice (no xfade)", {
    finalPublicId,
    segmentCount: segmentPublicIds.length,
    basePublicId: segmentPublicIds[0],
    spliceCount: segmentPublicIds.length - 1,
  });

  const result = await cloudinary.uploader.upload(sourceUrl, {
    resource_type: "video",
    public_id: finalPublicId,
    overwrite: true,
    timeout: 300000,
    transformation,
  });

  console.log("[cloudinary] Splice concat complete", {
    publicId: result.public_id,
    url: result.secure_url,
    duration: result.duration,
    bytes: result.bytes,
  });

  return result;
}
