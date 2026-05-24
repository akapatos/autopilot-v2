import Link from "next/link";

const links = [
  { href: "/dashboard", label: "Dashboard" },
  { href: "/generate", label: "Generate" },
  { href: "/library", label: "Library" },
];

export default function Home() {
  return (
    <main className="flex flex-1 flex-col items-center justify-center gap-8 px-6 py-24">
      <div className="text-center">
        <h1 className="text-4xl font-bold tracking-tight">AUTOPILOT</h1>
        <p className="mt-2 text-zinc-600 dark:text-zinc-400">
          YouTube video automation
        </p>
      </div>
      <nav className="flex flex-wrap justify-center gap-4">
        {links.map(({ href, label }) => (
          <Link
            key={href}
            href={href}
            className="rounded-full border border-zinc-200 px-6 py-2 text-sm font-medium transition-colors hover:bg-zinc-100 dark:border-zinc-800 dark:hover:bg-zinc-900"
          >
            {label}
          </Link>
        ))}
      </nav>
    </main>
  );
}
