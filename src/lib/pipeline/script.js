import Anthropic from "@anthropic-ai/sdk";
import {
  durationFromWordCount,
  enforceSceneRules,
  MAX_SCENE_DURATION,
  MIN_SCENE_DURATION,
  wordCount,
} from "@/lib/pipeline/scene-rules";

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

const VALID_MOODS = new Set([
  "dramatic",
  "calm",
  "tense",
  "uplifting",
  "mysterious",
  "shocking",
]);

const VALID_CAMERA = new Set([
  "wide",
  "closeup",
  "aerial",
  "tracking",
  "static",
]);

const VALID_COMPOSITION_TYPES = new Set([
  "animated-map",
  "timeline",
  "data-chart",
  "title-card",
  "lower-third",
  "stock",
]);

/**
 * Niche-specific writing notes for the system prompt.
 */
function getNicheGuidance(niche) {
  const n = String(niche || "").toLowerCase();

  if (/crime|true crime|murder|investigation|detective/.test(n)) {
    return `NICHE: TRUE CRIME — Prioritize suspense and unease. Use present tense for key dramatic beats. Name real or plausible dates, places, and people when it serves the story. Build dread with concrete detail; avoid sensationalism that feels cheap.`;
  }
  if (/history|historical|ancient|medieval|empire|war/.test(n)) {
    return `NICHE: HISTORY — Open scenes with a surprising or little-known fact when possible. Use vivid sensory detail (sight, sound, texture). Tie the past explicitly to questions or parallels in the modern day.`;
  }
  if (/space|science|physics|biology|cosmos|nasa|universe|astronom/.test(n)) {
    return `NICHE: SPACE / SCIENCE — Use clear analogies for abstract ideas (scale, forces, time). Invite wonder without hand-waving; keep claims accurate. Ramp from concrete observation toward bigger implications.`;
  }
  if (/finance|money|invest|econom|market|stock|business/.test(n)) {
    return `NICHE: FINANCE — Use specific figures, percentages, or magnitudes where they strengthen the narrative. Always connect numbers to human outcomes (jobs, savings, inequality, behaviour). Avoid jargon without a plain-English gloss.`;
  }
  if (/tech|technology|software|ai|gadget|internet|coding|digital/.test(n)) {
    return `NICHE: TECHNOLOGY — Explain mechanisms in plain language. Focus on how the tech changes behaviour, relationships, power, or daily life. Prefer “what it means” over specs.`;
  }

  return `NICHE (GENERAL) — Write for a curious general audience. Be clear, vivid, and honest; tailor examples to "${niche}".`;
}

function sanitizeCompositionType(rawType, sceneIndex) {
  const t = String(
    rawType || "",
  )
    .toLowerCase()
    .trim()
    .replace(/_/g, "-");

  if (sceneIndex === 0) {
    return "title-card";
  }

  if (t === "title-card") {
    return "stock";
  }

  if (VALID_COMPOSITION_TYPES.has(t) && t !== "title-card") {
    return t;
  }

  return "stock";
}

function sanitizeCompositionProps(compositionType, props, videoMeta) {
  const p =
    props && typeof props === "object" && !Array.isArray(props) ? props : {};
  const videoTitle = String(videoMeta.title || videoMeta.topic || "").trim();
  const videoSubtitle = String(
    videoMeta.niche || videoMeta.style || "",
  ).trim();

  switch (compositionType) {
    case "animated-map":
      return {
        location: String(p.location || videoMeta.topic || "Location").trim(),
        lat: Number(p.lat) || 0,
        lng: Number(p.lng) || 0,
        zoomLevel: Math.min(10, Math.max(1, Number(p.zoomLevel ?? p.zoom_level) || 4)),
      };
    case "timeline": {
      const events = Array.isArray(p.events) ? p.events : [];
      return {
        events: events
          .slice(0, 8)
          .map((e) => ({
            year: String(e?.year ?? "").trim(),
            title: String(e?.title ?? "").trim(),
            description: String(e?.description ?? "").trim(),
          }))
          .filter((e) => e.year && e.title),
      };
    }
    case "data-chart": {
      const data = Array.isArray(p.data) ? p.data : [];
      return {
        title: String(p.title || videoMeta.topic || "Data").trim(),
        unit: String(p.unit || "").trim(),
        data: data
          .slice(0, 12)
          .map((row) => ({
            label: String(row?.label ?? "").trim(),
            value: Number(row?.value) || 0,
          }))
          .filter((row) => row.label),
      };
    }
    case "title-card":
      return {
        title: String(p.title || videoTitle || "Untitled").trim(),
        subtitle: String(p.subtitle || videoSubtitle || "").trim(),
      };
    case "lower-third":
      return {
        name: String(p.name ?? "").trim(),
        title: String(p.title ?? p.role ?? "").trim(),
      };
    case "stock":
    default:
      return null;
  }
}

function sanitizeScene(scene, sceneIndex, videoMeta) {
  let mood = String(scene.visualMood || scene.visual_mood || "").toLowerCase();
  if (!VALID_MOODS.has(mood))
    mood = "dramatic";

  let cam = String(
    scene.cameraStyle || scene.camera_style || "",
  ).toLowerCase();
  if (!VALID_CAMERA.has(cam)) cam = "wide";

  let compositionType = sanitizeCompositionType(
    scene.compositionType || scene.composition_type,
    sceneIndex,
  );
  let compositionProps = sanitizeCompositionProps(
    compositionType,
    scene.compositionProps || scene.composition_props,
    videoMeta,
  );

  if (compositionType === "lower-third" && !compositionProps?.name) {
    compositionType = "stock";
    compositionProps = null;
  }
  if (compositionType === "timeline" && !compositionProps?.events?.length) {
    compositionType = "stock";
    compositionProps = null;
  }
  if (compositionType === "data-chart" && !compositionProps?.data?.length) {
    compositionType = "stock";
    compositionProps = null;
  }
  if (
    compositionType === "animated-map" &&
    (!compositionProps?.location ||
      (compositionProps.lat === 0 && compositionProps.lng === 0))
  ) {
    compositionType = "stock";
    compositionProps = null;
  }

  return {
    narration: String(scene.narration || "").trim(),
    visualKeyword: String(scene.visualKeyword || scene.visual_keyword || "").trim(),
    visualDescription: String(
      scene.visualDescription || scene.visual_description || "",
    ).trim(),
    visualMood: mood,
    cameraStyle: cam,
    compositionType,
    compositionProps,
    duration: durationFromWordCount(
      String(scene.narration || "").trim(),
    ),
  };
}

function sanitizeTagList(tags, topic, niche) {
  const arr = Array.isArray(tags) ? tags : [];
  const cleaned = arr
    .map((t) => String(t || "").trim().toLowerCase())
    .filter(Boolean);

  const fallback = [topic, niche, "youtube documentary", "explainer"]
    .map((t) => String(t || "").trim().toLowerCase())
    .filter(Boolean);

  const merged = [...cleaned, ...fallback];
  return [...new Set(merged)].slice(0, 20);
}

/**
 * @param {{ topic: string, niche: string, length: number, style: string }} params
 * @returns {Promise<{
 *   title: string,
 *   description: string,
 *   tags: string[],
 *   thumbnailConcept: string,
 *   fullScript: string,
 *   scenes: Array<{
 *     narration: string,
 *     visualKeyword: string,
 *     visualDescription: string,
 *     visualMood: string,
 *     cameraStyle: string,
 *     productionNotes: string,
 *     duration: number,
 *     compositionType: "animated-map" | "timeline" | "data-chart" | "title-card" | "lower-third" | "stock",
 *     compositionProps: object | null,
 *   }>
 * }>}
 */
export async function generateScript({ topic, niche, length, style }) {
  try {
  const targetSeconds = Math.round(Number(length) * 60);

  const nicheBlock = getNicheGuidance(niche);

  console.log("[script] Generating documentary script via Claude", {
    topic,
    niche,
    lengthMinutes: length,
    targetSeconds,
    style,
  });

  const prompt = `You are an elite documentary scriptwriter for YouTube. Voice: professional narration—clear, gripping, cinematic.

VIDEO CONTEXT
• Topic: ${topic}
• Niche angle: ${niche}
• Target length: ${length} minute(s) (≈ ${targetSeconds} seconds of spoken narration across all scenes)
• Creative style / tone label: ${style}

${nicheBlock}

DOCUMENTARY CRAFT (MANDATORY)
1) HOOK: The FIRST scene total must GRAB attention within ~10 seconds of video time—immediate curiosity, tension, contradiction, or a sharp question. No slow warm-up.

2) TONE: Conversational but authoritative. SHORT, punchy sentences. Use rhetorical questions sparingly—for impact—not every line. Use em dash or ellipsis only where you'd actually pause aloud.

3) STORY ARC (map scenes across the full runtime):
   Opening hook → Context (why this matters) → Rising tension (complications, stakes) → Climax → Resolution → Closing call-to-action or forward-looking question.

4) EACH SCENE (narration):
   • Exactly 2–4 sentences MAX per scene—no paragraphs.
   • Keep each scene between ${MIN_SCENE_DURATION} and ${MAX_SCENE_DURATION} seconds when spoken (split long beats across scenes if needed).

5) RULE — NO CONSECUTIVE ECHOES: Scene N must NOT begin with the same FIRST WORD as scene N−1's FIRST WORD (trim leading punctuation/spaces).

6) RULE — SCENE ENDINGS: EVERY scene narration must END on a micro-hook—a question, teaser, withheld answer, paradox, or "but then…" beat that pulls the viewer into the next scene.

7) VISUAL KEYWORDS (CRITICAL — clip must match narration):
   • visualKeyword must be HIGHLY SPECIFIC to what is said in THAT EXACT scene's narration—never generic.
   • If talking about Julius Caesar, use "Julius Caesar Roman general marble bust" not "history" or "Rome".
   • If talking about the ocean, use "deep ocean waves underwater sunlight" not "nature" or "water".
   • Include subject + setting + action or era when relevant. Minimum 4–6 specific words per keyword.
   • Each scene MUST use a DIFFERENT visualKeyword from every other scene (no reuse).

8) DURATION (CRITICAL — you control clip timing):
   • Each scene's duration must EXACTLY match how long the narration takes to speak at 130 words per minute.
   • Calculate: duration_seconds = (word_count / 130) * 60 — round to one decimal.
   • Count words ONLY in the narration field. Never estimate or guess duration—ALWAYS calculate from word count.
   • Do NOT clamp or round to "about 10 seconds"; use the formula result.

9) MOTION GRAPHICS (compositionType + compositionProps) — Pick EXACTLY ONE type per scene:
   • "title-card" — OPENING SCENE ONLY (scene index 0). Props: { "title", "subtitle" }.
   • "animated-map" — Scene mentions a specific location, country, city, or geography. Props: { "location", "lat", "lng", "zoomLevel" } (real coordinates; zoomLevel 1–10).
   • "timeline" — Scene mentions specific dates, years, or a sequence of historical events. Props: { "events": [{ "year", "title", "description" }] } (1–6 events).
   • "data-chart" — Scene mentions statistics, numbers, percentages, or comparative data. Props: { "title", "data": [{ "label", "value" }], "unit" } (2–8 rows; value numeric).
   • "lower-third" — First time a named person is introduced in the video. Props: { "name", "title" } (person's role/credential as title).
   • "stock" — DEFAULT for all other scenes (B-roll with Pexels). Use compositionProps: null.
   Do NOT use "title-card" after scene 0. Prefer "stock" when unsure.

OUTPUT FORMAT — Return ONLY valid JSON (no markdown, no prose outside JSON):
{
  "title": "Compelling click-worthy title under 60 chars",
  "description": "150-200 words including topic keywords, CTA, and a timestamps placeholder block (e.g. 00:00 Intro, 00:45 ...)",
  "tags": ["15-20 lowercase relevant youtube tags"],
  "thumbnailConcept": "Detailed concept with main image, text overlay suggestion, and colour scheme",
  "fullScript": "[SCENE 1] ... [SCENE 2] ...",
  "scenes": [
    {
      "narration": "2-4 spoken sentences ending on a hook. No labels like 'Voice:'",
      "visualKeyword": "4-8 highly specific search words matching THIS scene's narration exactly",
      "visualDescription": "One or two vivid sentences stating exactly what the viewer should SEE (composition, era, subjects, motion, time of day if relevant)",
      "visualMood": "one word: dramatic | calm | tense | uplifting | mysterious | shocking",
      "cameraStyle": "exactly one of: wide | closeup | aerial | tracking | static",
      "productionNotes": "Editor notes: exact shot progression, text overlays, pacing direction, and music mood changes for this scene",
      "compositionType": "stock | animated-map | timeline | data-chart | title-card | lower-third",
      "compositionProps": null,
      "duration": 10.5
    }
  ]
}

compositionProps examples (match compositionType):
• title-card: { "title": "Video title", "subtitle": "Hook line or niche" }
• animated-map: { "location": "Paris, France", "lat": 48.8566, "lng": 2.3522, "zoomLevel": 4 }
• timeline: { "events": [{ "year": "1789", "title": "Fall of the Bastille", "description": "..." }] }
• data-chart: { "title": "Global emissions", "unit": "%", "data": [{ "label": "2010", "value": 48 }] }
• lower-third: { "name": "Dr. Jane Smith", "title": "Historian" }
• stock: null


FINAL CHECK before you output JSON:
• Every scene.duration === round((word_count/130)*60, 1) from its narration (never estimated).
• Sum(scene.duration) ≈ ${targetSeconds} (±5% acceptable).
• No two scenes share the same visualKeyword.
• No two consecutive scenes start with identical first words.
• First scene honours the HOOK principle and uses compositionType "title-card".
`;

  const message = await anthropic.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 8192,
    messages: [{ role: "user", content: prompt }],
  });

  const textBlock = message.content.find((block) => block.type === "text");
  if (!textBlock || textBlock.type !== "text") {
    throw new Error("Claude returned no text content");
  }

  let parsed;
  try {
    const raw = textBlock.text
      .trim()
      .replace(/^```json\s*/i, "")
      .replace(/```$/i, "");
    parsed = JSON.parse(raw);
  } catch (_parseError) {
    console.error(
      "[script] Failed to parse Claude JSON",
      textBlock.text.slice(0, 800),
    );
    throw new Error("Failed to parse script JSON from Claude");
  }

  const rawScenes = parsed.scenes;
  if (!Array.isArray(rawScenes) || rawScenes.length === 0) {
    throw new Error("Script must contain at least one scene");
  }

  const title = String(parsed.title || "").trim().slice(0, 60) || `The Untold Truth About ${topic}`.slice(0, 60);

  const videoMeta = { topic, niche, style, title };

  let scenes = rawScenes.map((s, index) => ({
    ...sanitizeScene(s, index, videoMeta),
    productionNotes: String(
      s.productionNotes || s.production_notes || "",
    ).trim(),
  }));

  scenes = enforceSceneRules(scenes, targetSeconds);

  console.log("[script] Documentary script generated", {
    sceneCount: scenes.length,
    targetSeconds,
    compositionTypes: scenes.map((s) => s.compositionType),
    durationsSample: scenes.slice(0, 3).map((s) => ({
      wc: wordCount(s.narration),
      duration: s.duration,
      compositionType: s.compositionType,
    })),
  });
  const description = String(parsed.description || "").trim();
  const tags = sanitizeTagList(parsed.tags, topic, niche);
  const thumbnailConcept = String(
    parsed.thumbnailConcept || parsed.thumbnail_concept || "",
  ).trim();

  const fallbackFullScript = scenes
    .map((scene, idx) => `[SCENE ${idx + 1}] ${scene.narration}`)
    .join("\n\n");
  const fullScript =
    String(parsed.fullScript || parsed.full_script || "").trim() ||
    fallbackFullScript;

  return {
    title,
    description,
    tags,
    thumbnailConcept,
    fullScript,
    scenes,
  };
  } catch (error) {
    console.error("[script] Error:", JSON.stringify(error, null, 2));
    throw error;
  }
}
