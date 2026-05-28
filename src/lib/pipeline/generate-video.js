import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createServiceClient } from "@/lib/supabase";
import { uploadLocalVideo } from "@/lib/pipeline/cloudinary";
import { enforceSceneRules } from "@/lib/pipeline/scene-rules";
import { generateScript } from "@/lib/pipeline/script";
import { renderSceneComposition } from "@/lib/pipeline/remotion";
import { fetchStockVideo } from "@/lib/pipeline/stock";
import {
  applyVoiceTimingToClip,
  generateVoiceover,
} from "@/lib/pipeline/voice";
import {
  GENERATION_STAGES,
  VIDEO_STATUS,
} from "@/lib/pipeline/constants";
import { getErrorMessage } from "@/lib/pipeline/error-message";

function isMotionGraphicScene(scene) {
  const type = String(scene.compositionType || "stock").toLowerCase();
  return type !== "stock";
}

function buildClipFromStock(scene, stock) {
  return {
    file_url: stock.file_url,
    narration: scene.narration,
    visual_keyword: scene.visualKeyword,
    visual_description: scene.visualDescription ?? null,
    visual_mood: scene.visualMood ?? null,
    camera_style: scene.cameraStyle ?? null,
    composition_type: scene.compositionType ?? "stock",
    composition_props: scene.compositionProps ?? null,
    remotion_composition_id: null,
    script_duration: scene.duration,
    duration: stock.duration ?? scene.duration,
    trim_start: stock.trim_start ?? 0,
    trim_end: stock.trim_end ?? scene.duration,
    source: stock.source,
    pexels_id: stock.pexels_id ?? null,
    stock_duration: stock.stock_duration ?? null,
    voice_url: null,
    voice_duration: null,
  };
}

/**
 * Motion graphic via Remotion + Cloudinary, or Pexels/Pixabay for stock scenes.
 * Falls back to stock if Remotion render/upload fails.
 */
async function fetchFootageForScene(
  scene,
  { videoId, sceneIndex, usedPexelsIds, usedPixabayIds, usedFileUrls },
) {
  const stockOptions = {
    usedPexelsIds,
    usedPixabayIds,
    usedFileUrls,
    neededDuration: scene.duration,
  };

  if (!isMotionGraphicScene(scene)) {
    console.log("[pipeline] Stock footage scene", {
      videoId,
      sceneIndex,
      compositionType: scene.compositionType || "stock",
      visualKeyword: scene.visualKeyword,
    });

    const stock = await fetchStockVideo(scene.visualKeyword, stockOptions);
    return buildClipFromStock(scene, stock);
  }

  const tmpDir = path.join(os.tmpdir(), "autopilot", videoId);
  await fs.mkdir(tmpDir, { recursive: true });
  const localPath = path.join(tmpDir, `scene-${sceneIndex}.mp4`);

  console.log("[pipeline] Motion graphic scene — rendering with Remotion", {
    videoId,
    sceneIndex,
    compositionType: scene.compositionType,
    compositionProps: scene.compositionProps,
  });

  try {
    const renderResult = await renderSceneComposition(scene, localPath);
    if (!renderResult) {
      throw new Error("Remotion returned null for a motion graphic scene");
    }

    const publicId = `autopilot/${videoId}/remotion-scene-${sceneIndex}`;
    const upload = await uploadLocalVideo(localPath, publicId);
    const duration = Number(scene.duration) || 10;

    console.log("[pipeline] Remotion scene uploaded to Cloudinary", {
      videoId,
      sceneIndex,
      compositionId: renderResult.compositionId,
      file_url: upload.secure_url,
    });

    return {
      file_url: upload.secure_url,
      narration: scene.narration,
      visual_keyword: scene.visualKeyword,
      visual_description: scene.visualDescription ?? null,
      visual_mood: scene.visualMood ?? null,
      camera_style: scene.cameraStyle ?? null,
      composition_type: scene.compositionType,
      composition_props: scene.compositionProps ?? null,
      remotion_composition_id: renderResult.compositionId,
      script_duration: scene.duration,
      duration,
      trim_start: 0,
      trim_end: duration,
      source: "remotion",
      pexels_id: null,
      stock_duration: upload.duration ?? duration,
      voice_url: null,
      voice_duration: null,
    };
  } catch (remotionError) {
    console.warn("[pipeline] Remotion failed — falling back to stock footage", {
      videoId,
      sceneIndex,
      compositionType: scene.compositionType,
      message: getErrorMessage(remotionError),
    });

    const stock = await fetchStockVideo(scene.visualKeyword, stockOptions);

    return buildClipFromStock(
      { ...scene, compositionType: "stock", compositionProps: null },
      stock,
    );
  } finally {
    await fs.unlink(localPath).catch(() => {});
  }
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

async function callAssembleEndpoint(clips, videoId, niche) {
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
      niche: niche ?? null,
      cloudinaryConfig: {
        cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
        api_key: process.env.CLOUDINARY_API_KEY,
        api_secret: process.env.CLOUDINARY_API_SECRET,
        pixabayApiKey: process.env.PIXABAY_API_KEY ?? null,
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
    const assembleErr =
      typeof data.error === "string"
        ? data.error
        : data.error != null
          ? JSON.stringify(data.error)
          : "Assembly failed";
    throw new Error(assembleErr || "Assembly failed");
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

    const targetSeconds = Math.round(Number(length) * 60);

    const scriptPackage = await generateScript({ topic, niche, length, style });
    let {
      scenes,
      title,
      description,
      tags,
      thumbnailConcept,
      fullScript,
    } = scriptPackage;

    scenes = enforceSceneRules(scenes, targetSeconds);

    console.log("[pipeline] Scene rules applied", {
      videoId,
      sceneCount: scenes.length,
      durations: scenes.map((s) => ({
        duration: s.duration,
        words: s.narration.split(/\s+/).filter(Boolean).length,
        keyword: s.visualKeyword,
      })),
    });

    await updateVideo(supabase, videoId, {
      scenes,
      title,
      description,
      tags,
      thumbnail_concept: thumbnailConcept,
      full_script: fullScript,
      generation_stage: GENERATION_STAGES.SCRIPT,
    });

    console.log("[pipeline] Script stage complete", {
      videoId,
      sceneCount: scenes.length,
    });

    const clips = [];
    const usedPexelsIds = new Set();
    const usedPixabayIds = new Set();
    const usedFileUrls = new Set();

    // --- Footage ---
    await updateVideo(supabase, videoId, {
      generation_stage: GENERATION_STAGES.FOOTAGE,
    });

    for (let i = 0; i < scenes.length; i++) {
      const scene = scenes[i];

      const clip = await fetchFootageForScene(scene, {
        videoId,
        sceneIndex: i,
        usedPexelsIds,
        usedPixabayIds,
        usedFileUrls,
      });

      clips.push(clip);
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

    const assembleResult = await callAssembleEndpoint(clips, videoId, niche);

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
    const message = getErrorMessage(error) || "Unknown pipeline error";

    console.error("[pipeline] Generation failed", { videoId, message });

    await updateVideo(supabase, videoId, {
      status: VIDEO_STATUS.FAILED,
      error_message: message,
    }).catch((updateError) => {
      console.error(
        "[pipeline] Failed to mark video as failed",
        getErrorMessage(updateError),
      );
    });

    throw error;
  }
}
