export const maxDuration = 300;
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase";
import { waitUntil } from "@/lib/wait-until";
import { runVideoGenerationPipeline } from "@/lib/pipeline/generate-video";
import {
  GENERATION_STAGES,
  VIDEO_STATUS,
} from "@/lib/pipeline/constants";

export async function POST(request) {
  console.log("[generate] POST /api/generate received");

  try {
    const body = await request.json();
    const { topic, niche, length, style, voice } = body;

    if (!topic || !niche || length == null || !style) {
      console.log("[generate] Validation failed — missing fields", body);
      return NextResponse.json(
        { error: "topic, niche, length, and style are required" },
        { status: 400 },
      );
    }

    const lengthMinutes = Number(length);
    if (Number.isNaN(lengthMinutes) || lengthMinutes <= 0) {
      return NextResponse.json(
        { error: "length must be a positive number (minutes)" },
        { status: 400 },
      );
    }

    const supabase = createServiceClient();

    console.log("[generate] Creating video record in Supabase", {
      topic,
      niche,
      length: lengthMinutes,
      style,
      voice: voice || "default",
    });

    const { data: video, error: insertError } = await supabase
      .from("videos")
      .insert({
        topic,
        niche,
        length_minutes: lengthMinutes,
        style,
        voice: voice || null,
        status: VIDEO_STATUS.GENERATING,
        generation_stage: GENERATION_STAGES.SCRIPT,
        scenes: [],
        clips: [],
      })
      .select("id")
      .single();

    if (insertError) {
      console.error("[generate] Supabase insert failed", insertError);
      return NextResponse.json(
        { error: insertError.message },
        { status: 500 },
      );
    }

    const videoId = video.id;
    console.log("[generate] Video record created", { videoId });

    const pipelinePromise = runVideoGenerationPipeline({
      videoId,
      topic,
      niche,
      length: lengthMinutes,
      style,
      voice,
    }).catch((error) => {
      console.error("[generate] Background pipeline error", {
        videoId,
        message: error instanceof Error ? error.message : String(error),
      });
    });

    waitUntil(pipelinePromise);

    console.log("[generate] Returning video ID; pipeline running in background", {
      videoId,
    });

    return NextResponse.json({
      videoId,
      status: VIDEO_STATUS.GENERATING,
      message: "Video generation started",
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Generation request failed";
    console.error("[generate] Request handler error", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
