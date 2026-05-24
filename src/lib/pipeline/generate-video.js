import { createServiceClient } from "@/lib/supabase";
import { generateScript } from "@/lib/pipeline/script";
import { fetchStockVideo } from "@/lib/pipeline/stock";
import { generateVoiceover } from "@/lib/pipeline/voice";
import {
  GENERATION_STAGES,
  VIDEO_STATUS,
} from "@/lib/pipeline/constants";

function getAppBaseUrl() {
  if (process.env.VERCEL_URL) {
    return `https://${process.env.VERCEL_URL}`;
  }
  if (process.env.NEXT_PUBLIC_APP_URL) {
    return process.env.NEXT_PUBLIC_APP_URL.replace(/\/$/, "");
  }
  return "http://localhost:3000";
}

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
  const baseUrl = getAppBaseUrl();
  const url = `${baseUrl}/api/assemble`;

  console.log("[pipeline] Calling assemble endpoint", {
    videoId,
    url,
    clipCount: clips.length,
  });

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ clips, videoId }),
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

      const stock = await fetchStockVideo(scene.visualKeyword);

      clips.push({
        file_url: stock.file_url,
        narration: scene.narration,
        visual_keyword: scene.visualKeyword,
        duration: scene.duration,
        trim_start: 0,
        trim_end: scene.duration,
        source: stock.source,
        voice_url: null,
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

      const voiceUrl = await generateVoiceover(
        clip.narration,
        voice,
        videoId,
        i,
      );

      clips[i] = { ...clip, voice_url: voiceUrl };
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
