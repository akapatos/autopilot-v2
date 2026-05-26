import { createServiceClient } from "@/lib/supabase";
import { generateScript } from "@/lib/pipeline/script";
import { fetchStockVideo } from "@/lib/pipeline/stock";
import {
  applyVoiceTimingToClip,
  generateVoiceover,
} from "@/lib/pipeline/voice";
import {
  GENERATION_STAGES,
  VIDEO_STATUS,
} from "@/lib/pipeline/constants";

async function updateVideo(supabase, videoId, patch) {
  console.log("[pipeline] Updating video record", { videoId, patch });

  const { error } = await supabase
    .from("videos")
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq("id", videoId);

  if (error) {
    console.error("[pipeline] Supabase update failed", { videoId, error });
    throw error;
  }
}

async function callAssembleEndpoint(clips, videoId) {
  const assemblyBase = process.env.ASSEMBLY_SERVER_URL?.replace(/\/$/, "");
  if (!assemblyBase) {
    throw new Error(
      "ASSEMBLY_SERVER_URL is not set — cannot reach the assembly microservice",
    );
  }

  const url = `${assemblyBase}/assemble`;

  console.log("[pipeline] Calling assembly server", {
    videoId,
    url,
    clipCount: clips.length,
  });

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      clips,
      videoId,
      cloudinaryConfig: {
        cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
        api_key: process.env.CLOUDINARY_API_KEY,
        api_secret: process.env.CLOUDINARY_API_SECRET,
      },
    }),
  });

  const data = await response.json();

  if (!response.ok) {
    console.error("[pipeline] Assemble endpoint failed", {
      videoId,
      status: response.status,
      data,
    });
    throw new Error(data.error || "Assembly failed");
  }

  console.log("[pipeline] Assemble endpoint succeeded", { videoId, data });
  return data;
}

/**
 * Full background generation pipeline for a single video.
 */
export async function runVideoGenerationPipeline({
  videoId,
  topic,
  niche,
  length,
  style,
  voice,
}) {
  const supabase = createServiceClient();

  try {
    console.log("[pipeline] Starting generation", { videoId, topic });

    // --- Script ---
    await updateVideo(supabase, videoId, {
      generation_stage: GENERATION_STAGES.SCRIPT,
    });

    const scenes = await generateScript({ topic, niche, length, style });

    await updateVideo(supabase, videoId, {
      scenes,
      generation_stage: GENERATION_STAGES.SCRIPT,
    });

    console.log("[pipeline] Script stage complete", {
      videoId,
      sceneCount: scenes.length,
    });

    const clips = [];
    const usedPexelsIds = new Set();

    // --- Footage ---
    await updateVideo(supabase, videoId, {
      generation_stage: GENERATION_STAGES.FOOTAGE,
    });

    for (let i = 0; i < scenes.length; i++) {
      const scene = scenes[i];
      console.log("[pipeline] Fetching footage for scene", {
        videoId,
        index: i,
        visualKeyword: scene.visualKeyword,
      });

      const stock = await fetchStockVideo(scene.visualKeyword, {
        usedPexelsIds,
        neededDuration: scene.duration,
      });

      if (stock.pexels_id) {
        usedPexelsIds.add(stock.pexels_id);
      }

      clips.push({
        file_url: stock.file_url,
        narration: scene.narration,
        visual_keyword: scene.visualKeyword,
        script_duration: scene.duration,
        duration: scene.duration,
        trim_start: stock.trim_start ?? 0,
        trim_end: scene.duration,
        source: stock.source,
        pexels_id: stock.pexels_id ?? null,
        stock_duration: stock.stock_duration ?? null,
        voice_url: null,
        voice_duration: null,
      });

      await updateVideo(supabase, videoId, { clips: [...clips] });
    }

    console.log("[pipeline] Footage stage complete", {
      videoId,
      clipCount: clips.length,
    });

    // --- Voiceover ---
    await updateVideo(supabase, videoId, {
      generation_stage: GENERATION_STAGES.VOICEOVER,
    });

    for (let i = 0; i < clips.length; i++) {
      const clip = clips[i];
      console.log("[pipeline] Generating voiceover for scene", {
        videoId,
        index: i,
      });

      const voiceResult = await generateVoiceover(
        clip.narration,
        voice,
        videoId,
        i,
      );

      clips[i] = applyVoiceTimingToClip(clip, voiceResult);
      await updateVideo(supabase, videoId, { clips: [...clips] });
    }

    console.log("[pipeline] Voiceover stage complete", { videoId });

    // --- Assembly ---
    await updateVideo(supabase, videoId, {
      generation_stage: GENERATION_STAGES.ASSEMBLY,
    });

    const assembleResult = await callAssembleEndpoint(clips, videoId);

    await updateVideo(supabase, videoId, {
      file_url: assembleResult.file_url,
      status: VIDEO_STATUS.COMPLETED,
      generation_stage: GENERATION_STAGES.ASSEMBLY,
      clips,
    });

    console.log("[pipeline] Video generation completed", {
      videoId,
      file_url: assembleResult.file_url,
    });

    return { videoId, file_url: assembleResult.file_url };
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unknown pipeline error";

    console.error("[pipeline] Generation failed", { videoId, message, error });

    await updateVideo(supabase, videoId, {
      status: VIDEO_STATUS.FAILED,
      error_message: message,
    }).catch((updateError) => {
      console.error("[pipeline] Failed to mark video as failed", updateError);
    });

    throw error;
  }
}
