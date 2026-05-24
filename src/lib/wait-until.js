import { after } from "next/server";

/**
 * Extends the serverless invocation until `promise` settles (Vercel waitUntil).
 * Falls back to Next.js `after()` when waitUntil is not on the request context.
 */
export function waitUntil(promise) {
  const RequestContext = globalThis[Symbol.for("@next/request-context")];
  const contextWaitUntil = RequestContext?.get?.()?.waitUntil;

  if (typeof contextWaitUntil === "function") {
    console.log("[waitUntil] Scheduling background work via platform waitUntil");
    contextWaitUntil(promise);
    return;
  }

  console.log("[waitUntil] Platform waitUntil unavailable; using after()");
  after(() => promise);
}
