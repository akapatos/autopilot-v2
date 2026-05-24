import Link from "next/link";

export default function GeneratePage() {
  return (
    <main className="mx-auto w-full max-w-5xl flex-1 px-6 py-12">
      <header className="mb-8">
        <p className="text-sm text-zinc-500">
          <Link href="/" className="hover:underline">
            AUTOPILOT
          </Link>
        </p>
        <h1 className="mt-2 text-3xl font-semibold">Generate</h1>
        <p className="mt-2 text-zinc-600 dark:text-zinc-400">
          Create a new automated YouTube video from a topic or script.
        </p>
      </header>
      <section className="rounded-xl border border-dashed border-zinc-300 p-12 text-center text-zinc-500 dark:border-zinc-700">
        Generation form coming soon. API:{" "}
        <code className="text-sm">POST /api/generate</code>
      </section>
    </main>
  );
}
