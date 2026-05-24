import { NextResponse } from "next/server";
import { assembleVideoFromClips } from "@/lib/pipeline/cloudinary";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(request) {
  console.log("[assemble] POST /api/assemble received");

  try {
    const body = await request.json();
    const { clips, videoId } = body;

    if (!videoId) {
      return NextResponse.json({ error: "videoId is required" }, { status: 400 });
    }

    if (!Array.isArray(clips) || clips.length === 0) {
      return NextResponse.json(
        { error: "clips must be a non-empty array" },
        { status: 400 },
      );
    }

    for (let i = 0; i < clips.length; i++) {
      const clip = clips[i];
      if (!clip.file_url) {
        throw new Error(`Clip ${i} is missing file_url`);
      }
      if (!clip.voice_url) {
        throw new Error(`Clip ${i} is missing voice_url`);
      }
    }

    console.log("[assemble] Starting assembly", {
      videoId,
      clipCount: clips.length,
    });

    const finalVideo = await assembleVideoFromClips(clips, videoId);

    console.log("[assemble] Assembly complete", {
      videoId,
      file_url: finalVideo.secure_url,
    });

    return NextResponse.json({
      videoId,
      file_url: finalVideo.secure_url,
      public_id: finalVideo.public_id,
      duration: finalVideo.duration,
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Assembly failed";
    console.error("[assemble] Assembly error", message, error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
