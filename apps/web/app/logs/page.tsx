"use client";

/**
 * Spec 32 — /logs deprecated. Redirects to the unified Inspector portal,
 * which streams the typed ArceusEvent log instead of the legacy
 * employee-activity feed.
 */
import { useEffect } from "react";
import { useRouter } from "next/navigation";

export default function LogsRedirect() {
  const router = useRouter();
  useEffect(() => {
    router.replace("/inspector");
  }, [router]);
  return (
    <div className="p-6 text-sm text-gray-400">
      /logs has moved → <a className="text-cyan-400 underline" href="/inspector">/inspector</a>
    </div>
  );
}
