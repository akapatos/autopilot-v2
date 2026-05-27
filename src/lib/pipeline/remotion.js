import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";

/** Remotion composition ids registered in world-trip/src/remotion/Root.tsx */
const COMPOSITION_TYPE_TO_ID = {
  "animated-map": "AnimatedMap",
  timeline: "Timeline",
  "data-chart": "DataChart",
  "title-card": "TitleCard",
  "lower-third": "LowerThird",
};

const REMOTION_FPS = 30;

/**
 * @param {string} compositionType
 * @returns {string | null} Remotion composition id, or null for stock (no Remotion render)
 */
export function getRemotionCompositionId(compositionType) {
  const type = String(compositionType || "stock").toLowerCase().trim();
  if (type === "stock") {
    return null;
  }
  return COMPOSITION_TYPE_TO_ID[type] ?? null;
}

/**
 * @param {{ compositionType?: string, compositionProps?: object | null, duration?: number }} scene
 * @returns {{ compositionId: string, inputProps: object, durationInFrames: number } | null}
 */
export function resolveRemotionRender(scene) {
  const compositionType = scene.compositionType || "stock";
  const compositionId = getRemotionCompositionId(compositionType);

  if (!compositionId) {
    return null;
  }

  const inputProps = scene.compositionProps ?? {};
  if (!inputProps || typeof inputProps !== "object") {
    throw new Error(
      `Scene with compositionType "${compositionType}" requires compositionProps`,
    );
  }

  const durationSec = Number(scene.duration) || 10;
  const durationInFrames = Math.max(
    REMOTION_FPS,
    Math.round(durationSec * REMOTION_FPS),
  );

  return { compositionId, inputProps, durationInFrames };
}

function getRemotionProjectRoot() {
  return (
    process.env.REMOTION_PROJECT_PATH ||
    path.join(os.homedir(), "Downloads", "world-trip")
  );
}

function runRemotionCli(projectRoot, args) {
  return new Promise((resolve, reject) => {
    const child = spawn("npx", args, {
      cwd: projectRoot,
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });

    let stdout = "";
    let stderr = "";

    child.stdout?.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      reject(
        new Error(
          `Remotion render failed (exit ${code}): ${stderr || stdout || "unknown error"}`,
        ),
      );
    });
  });
}

/**
 * Render a single scene's motion graphic to an MP4 file.
 * Stock scenes skip Remotion and return null.
 *
 * @param {object} scene — scene with compositionType, compositionProps, duration
 * @param {string} outputPath — absolute path for output .mp4
 * @returns {Promise<{ compositionId: string, inputProps: object, outputPath: string, durationInFrames: number } | null>}
 */
export async function renderSceneComposition(scene, outputPath) {
  const resolved = resolveRemotionRender(scene);
  if (!resolved) {
    console.log("[remotion] Skipping render — stock scene", {
      compositionType: scene.compositionType || "stock",
    });
    return null;
  }

  const { compositionId, inputProps, durationInFrames } = resolved;
  const projectRoot = getRemotionProjectRoot();

  console.log("[remotion] Rendering composition", {
    compositionType: scene.compositionType,
    compositionId,
    durationInFrames,
    outputPath,
    projectRoot,
  });

  const propsJson = JSON.stringify(inputProps);
  const args = [
    "remotion",
    "render",
    compositionId,
    outputPath,
    `--props=${propsJson}`,
    `--frames=0-${durationInFrames - 1}`,
    "--muted",
  ];

  await runRemotionCli(projectRoot, args);

  console.log("[remotion] Render complete", { compositionId, outputPath });

  return {
    compositionId,
    inputProps,
    outputPath,
    durationInFrames,
  };
}

/**
 * @deprecated Use renderSceneComposition — renders MyComp for legacy callers.
 */
export async function renderMyCompLegacy(props, outputPath) {
  const projectRoot = getRemotionProjectRoot();
  const args = [
    "remotion",
    "render",
    "MyComp",
    outputPath,
    `--props=${JSON.stringify(props)}`,
    "--muted",
  ];
  await runRemotionCli(projectRoot, args);
  return { compositionId: "MyComp", outputPath };
}

/**
 * Render using compositionType from the scene (preferred entry point).
 *
 * @param {object} scene
 * @param {string} outputPath
 */
export async function renderScene(scene, outputPath) {
  return renderSceneComposition(scene, outputPath);
}
