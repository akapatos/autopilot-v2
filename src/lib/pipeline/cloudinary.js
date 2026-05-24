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

/**
 * Upload remote stock footage.
 */
export async function uploadRemoteVideo(url, publicId) {
  console.log("[cloudinary] Uploading remote video", { publicId, url });

  const result = await cloudinary.uploader.upload(url, {
    resource_type: "video",
    public_id: publicId,
    overwrite: true,
    timeout: 120000,
  });

  console.log("[cloudinary] Video uploaded", {
    publicId: result.public_id,
    duration: result.duration,
  });

  return result;
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
  });

  return result;
}

/**
 * Create one scene segment: trim stock video to duration and replace audio with voiceover.
 * Uses incoming transformation on upload (no derived URL fetch).
 */
export async function createSceneSegment({
  videoUrl,
  audioPublicId,
  trimStart,
  duration,
  segmentPublicId,
}) {
  const audioOverlay = toOverlayPublicId(audioPublicId);

  console.log("[cloudinary] Creating scene segment via upload + incoming transformation", {
    segmentPublicId,
    audioOverlay,
    trimStart,
    duration,
  });

  const result = await cloudinary.uploader.upload(videoUrl, {
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
 * Concatenate materialized scene segments using explicit + eager (fl_splice chain).
 */
export async function concatenateSceneSegments(segmentPublicIds, finalPublicId) {
  if (segmentPublicIds.length === 0) {
    throw new Error("No segments to concatenate");
  }

  if (segmentPublicIds.length === 1) {
    console.log("[cloudinary] Single segment — copying to final public ID", {
      finalPublicId,
    });
    const resource = await cloudinary.api.resource(segmentPublicIds[0], {
      resource_type: "video",
    });
    return cloudinary.uploader.upload(resource.secure_url, {
      resource_type: "video",
      public_id: finalPublicId,
      overwrite: true,
      timeout: 300000,
    });
  }

  const [baseId, ...rest] = segmentPublicIds;

  const eagerTransformation = [
    ...rest.flatMap((id) => [
      { flags: "splice", overlay: `video:${toOverlayPublicId(id)}` },
      { flags: "layer_apply" },
    ]),
    { format: "mp4", video_codec: "h264" },
  ];

  console.log("[cloudinary] Concatenating via explicit + eager", {
    baseId,
    spliceCount: rest.length,
    eagerTransformation,
  });

  const explicitResult = await cloudinary.uploader.explicit(baseId, {
    type: "upload",
    resource_type: "video",
    eager: eagerTransformation,
    eager_async: false,
  });

  const eagerEntry = explicitResult.eager?.[0];
  if (!eagerEntry?.secure_url) {
    console.error("[cloudinary] Explicit concat returned no eager output", explicitResult);
    throw new Error("Cloudinary concatenation eager transformation failed");
  }

  console.log("[cloudinary] Eager concat complete — storing final asset", {
    eagerUrl: eagerEntry.secure_url,
    finalPublicId,
  });

  const final = await cloudinary.uploader.upload(eagerEntry.secure_url, {
    resource_type: "video",
    public_id: finalPublicId,
    overwrite: true,
    timeout: 300000,
  });

  console.log("[cloudinary] Final video stored", {
    publicId: final.public_id,
    url: final.secure_url,
    duration: final.duration,
  });

  return final;
}

/**
 * Full assembly: per-scene trim + voiceover, then concatenate into one MP4.
 */
export async function assembleVideoFromClips(clips, videoId) {
  const segmentPublicIds = [];

  for (let i = 0; i < clips.length; i++) {
    const clip = clips[i];
    const trimStart = Number(clip.trim_start ?? 0);
    const duration = Number(clip.duration ?? clip.trim_end ?? 10);
    const audioPublicId = `autopilot/${videoId}/raw/scene_${i}_audio`;
    const segmentPublicId = `autopilot/${videoId}/segments/scene_${i}`;

    console.log("[cloudinary] Assembling scene", {
      videoId,
      index: i,
      duration,
      trimStart,
    });

    await uploadRemoteAudio(clip.voice_url, audioPublicId);

    const segment = await createSceneSegment({
      videoUrl: clip.file_url,
      audioPublicId,
      trimStart,
      duration,
      segmentPublicId,
    });

    segmentPublicIds.push(segment.public_id);
  }

  return concatenateSceneSegments(
    segmentPublicIds,
    `autopilot/${videoId}/final`,
  );
}
