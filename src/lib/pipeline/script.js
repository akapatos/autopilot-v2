import Anthropic from "@anthropic-ai/sdk";

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

const MIN_SCENE_SEC = 8;
const MAX_SCENE_SEC = 12;

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

function wordCount(text) {
  return String(text)
    .trim()
    .split(/\s+/)
    .filter(Boolean).length;
}

/**
 * duration ≈ (wordCount / 130) * 60 seconds at 130 words per minute.
 */
function durationFromWordCount(narration) {
  const n = wordCount(narration);
  const raw = (n / 130) * 60;
  const rounded = Math.round(raw * 10) / 10;
  return Math.min(MAX_SCENE_SEC, Math.max(MIN_SCENE_SEC, rounded));
}

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

/**
 * Per-scene duration from (wordCount / 130) × 60, clamped [MIN_SCENE_SEC, MAX_SCENE_SEC].
 * If total runtime ≠ target, absorb the gap on the last scene (or proportionally scale once if needed).
 */
function alignDurationsToTarget(scenes, targetSeconds) {
  const LAST_MAX = Math.max(MAX_SCENE_SEC + 6, 36);

  const out = scenes.map((s) => ({
    ...s,
    duration: durationFromWordCount(s.narration),
  }));

  let sum = out.reduce((acc, s) => acc + s.duration, 0);
  let diff = Math.round((targetSeconds - sum) * 10) / 10;

  if (Math.abs(diff) < 0.05 || out.length === 0) {
    return out;
  }

  const lastIdx = out.length - 1;
  let lastDur = Math.round((out[lastIdx].duration + diff) * 10) / 10;
  if (lastDur >= MIN_SCENE_SEC && lastDur <= LAST_MAX) {
    out[lastIdx] = { ...out[lastIdx], duration: lastDur };
    return out;
  }

  /** Proportional allocation from word-timing weights */
  const weights = scenes.map((s) => {
    const n = wordCount(s.narration);
    return Math.max(0.01, (n / 130) * 60);
  });
  const wsum = weights.reduce((a, b) => a + b, 0) || scenes.length;

  for (let i = 0; i < out.length; i++) {
    let sec = ((weights[i] / wsum) * targetSeconds);
    sec = Math.round(sec * 10) / 10;
    out[i].duration = Math.min(LAST_MAX, Math.max(MIN_SCENE_SEC, sec));
  }

  sum = out.reduce((acc, s) => acc + s.duration, 0);
  diff = Math.round((targetSeconds - sum) * 10) / 10;
  lastDur = Math.round((out[lastIdx].duration + diff) * 10) / 10;
  lastDur = Math.min(LAST_MAX * 2, Math.max(MIN_SCENE_SEC, lastDur));
  out[lastIdx] = { ...out[lastIdx], duration: lastDur };

  return out;
}

function sanitizeScene(scene) {
  let mood = String(scene.visualMood || scene.visual_mood || "").toLowerCase();
  if (!VALID_MOODS.has(mood))
    mood = "dramatic";

  let cam = String(
    scene.cameraStyle || scene.camera_style || "",
  ).toLowerCase();
  if (!VALID_CAMERA.has(cam)) cam = "wide";

  return {
    narration: String(scene.narration || "").trim(),
    visualKeyword: String(scene.visualKeyword || scene.visual_keyword || "").trim(),
    visualDescription: String(
      scene.visualDescription || scene.visual_description || "",
    ).trim(),
    visualMood: mood,
    cameraStyle: cam,
    duration:
      typeof scene.duration === "number"
        ? scene.duration
        : Number(scene.duration) || MIN_SCENE_SEC,
  };
}

/**
 * @param {{ topic: string, niche: string, length: number, style: string }} params
 * @returns {Promise<Array<{
 *   narration: string,
 *   visualKeyword: string,
 *   visualDescription: string,
 *   visualMood: string,
 *   cameraStyle: string,
 *   duration: number,
 * }>>}
 */
export async function generateScript({ topic, niche, length, style }) {
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
   • Aim for spoken length ≈ ${MIN_SCENE_SEC}–${MAX_SCENE_SEC} seconds per scene based on pacing (don't stuff one scene with a monologue).

5) RULE — NO CONSECUTIVE ECHOES: Scene N must NOT begin with the same FIRST WORD as scene N−1's FIRST WORD (trim leading punctuation/spaces).

6) RULE — SCENE ENDINGS: EVERY scene narration must END on a micro-hook—a question, teaser, withheld answer, paradox, or "but then…" beat that pulls the viewer into the next scene.

7) VISUALS: Each shot must SUPPORT the narration beat. Keywords must be SEARCHABLE stock terms (nouns / places / subjects), never vague ("nice video").

8) Duration math (YOU MUST APPLY): For EACH scene separately,
   • Count words ONLY in **narration** (excluding stage directions—you must not include stage directions in narration JSON).
   • duration_seconds = ROUND( ( word_count / 130 ) × 60, to one decimal ).
   • Then clamp EACH scene duration to BETWEEN ${MIN_SCENE_SEC} AND ${MAX_SCENE_SEC} seconds (inclusive) unless the TOTAL of all durations would massively exceed ${targetSeconds}; if so, shorten narrations/scene count so the LOGICAL total lands near ${targetSeconds}. The SUM of ALL scene durations should equal exactly ${targetSeconds}.

OUTPUT FORMAT — Return ONLY valid JSON (no markdown, no prose outside JSON):
{
  "scenes": [
    {
      "narration": "2-4 spoken sentences ending on a hook. No labels like 'Voice:'",
      "visualKeyword": "3-5 concise search words e.g. ancient Rome colosseum aerial sunset",
      "visualDescription": "One or two vivid sentences stating exactly what the viewer should SEE (composition, era, subjects, motion, time of day if relevant)",
      "visualMood": "one word: dramatic | calm | tense | uplifting | mysterious | shocking",
      "cameraStyle": "exactly one of: wide | closeup | aerial | tracking | static",
      "duration": 10.5
    }
  ]
}

FINAL CHECK before you output JSON:
• Sum(scene.duration) === ${targetSeconds} (floating point ±0.5 acceptable; we'll align in code—but get close).
• No two consecutive scenes start with identical first words.
• First scene honours the HOOK principle.
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

  let scenes = rawScenes.map((s) => sanitizeScene(s));

  /** Primary: word-derived duration; then match target runtime (see alignDurationsToTarget) */
  scenes = alignDurationsToTarget(scenes, targetSeconds);

  console.log("[script] Documentary script generated", {
    sceneCount: scenes.length,
    targetSeconds,
    durationsSample: scenes.slice(0, 3).map((s) => ({
      wc: wordCount(s.narration),
      duration: s.duration,
    })),
  });

  return scenes;
}
