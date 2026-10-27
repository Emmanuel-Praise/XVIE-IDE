import { useEffect, useState } from "react";
import { useFileSystemStore } from "@/Editor/fs/fileSystemStore";

/** Lazy-loads the raw bytes of a binary file (cached in the fs store). */
export function useDocumentBytes(path: string): {
  bytes: Uint8Array | null;
  loading: boolean;
  failed: boolean;
} {
  const [bytes, setBytes] = useState<Uint8Array | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setBytes(null);
    setLoading(true);
    setFailed(false);
    void useFileSystemStore
      .getState()
      .readBinary(path)
      .then((data) => {
        if (cancelled) return;
        if (!data) {
          setFailed(true);
        } else {
          setBytes(data);
        }
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [path]);

  return { bytes, loading, failed };
}

/** Retry after a failed read (drops the cache entry, refetches from disk). */
export function retryDocumentBytes(path: string): void {
  useFileSystemStore.getState().invalidateBinary(path);
}