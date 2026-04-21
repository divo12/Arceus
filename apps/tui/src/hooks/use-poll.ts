import { useState, useEffect, useRef, useCallback } from "react";

/**
 * Poll an API endpoint at a fixed interval and return parsed JSON.
 */
export function usePoll<T>(path: string, intervalMs: number) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Import dynamically to avoid circular issues at module level
  const fetchData = useCallback(async () => {
    try {
      const { api } = await import("../api/client.js");
      const result = await api<T>(path);
      setData(result);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [path]);

  useEffect(() => {
    fetchData();
    timerRef.current = setInterval(fetchData, intervalMs);
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [fetchData, intervalMs]);

  return { data, error, loading, refetch: fetchData };
}
