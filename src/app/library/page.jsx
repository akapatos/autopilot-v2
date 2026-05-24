import Link from "next/link";

export default function LibraryPage() {
  return (
    <main className="mx-auto w-full max-w-5xl flex-1 px-6 py-12">
      <header className="mb-8">
        <p className="text-sm text-zinc-500">
          <Link href="/" className="hover:underline">
            AUTOPILOT
          </Link>
        </p>
        <h1 className="mt-2 text-3xl font-semibold">Library</h1>
        <p className="mt-2 text-zinc-600 dark:text-zinc-400">
          Browse and manage your generated videos.
        </p>
      </header>
      <section className="rounded-xl border border-dashed border-zinc-300 p-12 text-center text-zinc-500 dark:border-zinc-700">
        Your video library will appear here.
      </section>
    </main>
  );
}
