import Anthropic from "@anthropic-ai/sdk";

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

/**
 * @param {{ topic: string, niche: string, length: number, style: string }} params
 * @returns {Promise<Array<{ narration: string, visualKeyword: string, duration: number }>>}
 */
export async function generateScript({ topic, niche, length, style }) {
  const targetSeconds = Math.round(Number(length) * 60);

  console.log("[script] Generating script via Claude", {
    topic,
    niche,
    lengthMinutes: length,
    targetSeconds,
    style,
  });

  const prompt = `You are a YouTube video scriptwriter. Write a script for a ${length}-minute video.

Topic: ${topic}
Niche: ${niche}
Style: ${style}

Return ONLY valid JSON (no markdown) in this exact shape:
{
  "scenes": [
    {
      "narration": "spoken narration for this scene",
      "visualKeyword": "2-4 word stock footage search term",
      "duration": 12
    }
  ]
}

Rules:
- Each scene duration must be between 8 and 15 seconds (integers).
- The sum of all scene durations must equal exactly ${targetSeconds} seconds.
- visualKeyword must be 2-4 words, optimized for stock video search.
- narration should match the style and be natural when spoken aloud.
- Use enough scenes to fill the full ${targetSeconds} seconds.`;

  const message = await anthropic.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 8192,
    messages: [{ role: "user", content: prompt }],
  });

  const textBlock = message.content.find((block) => block.type === "text");
  if (!textBlock || textBlock.type !== "text") {
    throw new Error("Claude returned no text content");
  }

  let parsed;
  try {
    const raw = textBlock.text.trim().replace(/^```json\s*/i, "").replace(/```$/i, "");
    parsed = JSON.parse(raw);
  } catch (parseError) {
    console.error("[script] Failed to parse Claude JSON", textBlock.text.slice(0, 500));
    throw new Error("Failed to parse script JSON from Claude");
  }

  const scenes = parsed.scenes;
  if (!Array.isArray(scenes) || scenes.length === 0) {
    throw new Error("Script must contain at least one scene");
  }

  const totalDuration = scenes.reduce((sum, s) => sum + Number(s.duration), 0);
  console.log("[script] Script generated", {
    sceneCount: scenes.length,
    totalDuration,
    targetSeconds,
  });

  if (totalDuration !== targetSeconds) {
    console.warn("[script] Duration mismatch; adjusting last scene", {
      totalDuration,
      targetSeconds,
    });
    const diff = targetSeconds - totalDuration;
    scenes[scenes.length - 1].duration =
      Number(scenes[scenes.length - 1].duration) + diff;
  }

  return scenes.map((scene) => ({
    narration: String(scene.narration).trim(),
    visualKeyword: String(scene.visualKeyword).trim(),
    duration: Math.min(15, Math.max(8, Math.round(Number(scene.duration)))),
  }));
}
