"use client";

/**
 * Spec 32 — /debug deprecated. Redirects to the unified Inspector portal.
 * The old graph-based UI lives in apps/web/components/debug/* and can be
 * removed once nothing references it.
 */
import { useEffect } from "react";
import { useRouter } from "next/navigation";

export default function DebugRedirect() {
  const router = useRouter();
  useEffect(() => {
    router.replace("/inspector");
  }, [router]);
  return (
    <div className="p-6 text-sm text-gray-400">
      /debug has moved → <a className="text-cyan-400 underline" href="/inspector">/inspector</a>
    </div>
  );
}
