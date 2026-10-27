import { useEffect, useState } from "react";
import type { GitHubRepo } from "../../../../shared/ipc-types";

// Session-wide memory cache so remounts/scroll-backs never refetch.
const memory = new Map<string, string | null>();
const pending = new Map<string, Promise<string | null>>();

// Shared limiter: at most 4 single preview IPCs in flight.
const SINGLE_LIMIT = 4;
let singleActive = 0;
const singleQueue: Array<() => void> = [];

function runSingle<T>(task: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const run = (): void => {
      singleActive += 1;
      task().then(resolve, reject).finally(() => {
        singleActive -= 1;
        const next = singleQueue.shift();
        if (next) next();
      });
    };
    if (singleActive < SINGLE_LIMIT) run();
    else singleQueue.push(run);
  });
}

function keyOf(repo: GitHubRepo): string {
  return repo.full_name;
}

export function peekPreview(repo: GitHubRepo): string | null | undefined {
  return memory.get(keyOf(repo));
}

function storePreview(repo: GitHubRepo, value: string | null): void {
  memory.set(keyOf(repo), value);
  if (memory.size > 400) {
    const oldest = memory.keys().next().value;
    if (oldest) memory.delete(oldest);
  }
}

export function getPreview(repo: GitHubRepo): Promise<string | null> {
  const key = keyOf(repo);
  const hit = memory.get(key);
  if (hit !== undefined) return Promise.resolve(hit);
  const flight = pending.get(key);
  if (flight) return flight;
  const task = runSingle(() =>
    window.api.github.previewImage(repo).catch(() => null)
  ).then((value) => {
    storePreview(repo, value);
    pending.delete(key);
    return value;
  });
  pending.set(key, task);
  return task;
}

/** Batch-fetch previews for a list (uses the batched IPC when available). */
export function prefetchPreviews(repos: GitHubRepo[]): void {
  const missing = repos.filter((repo) => memory.get(keyOf(repo)) === undefined && !pending.get(keyOf(repo)));
  if (!missing.length) return;
  const batch = window.api.github.previewImages;
  if (typeof batch !== "function") {
    // Older preload: fall back to queued singles.
    for (const repo of missing.slice(0, 12)) void getPreview(repo);
    return;
  }
  const chunk = missing.slice(0, 12);
  const task = (async () => {
    try {
      const out = await batch(chunk);
      for (const repo of chunk) {
        const value = out[keyOf(repo)] ?? null;
        storePreview(repo, value);
      }
    } catch {
      for (const repo of chunk) {
        if (memory.get(keyOf(repo)) === undefined) storePreview(repo, null);
      }
    }
  })();
  for (const repo of chunk) {
    const key = keyOf(repo);
    if (!pending.has(key)) {
      pending.set(
        key,
        task.then(() => memory.get(key) ?? null).finally(() => {
          if (pending.get(key)?.then) pending.delete(key);
        }) as Promise<string | null>
      );
    }
  }
}

/**
 * undefined = not asked yet / loading, null = no preview, string = image URL.
 * Pass `undefined` before the card is near the viewport to defer the fetch.
 */
export function usePreviewImage(repo: GitHubRepo | undefined | null): string | null | undefined {
  const key = repo?.full_name ?? "";
  const [value, setValue] = useState<string | null | undefined>(() =>
    repo ? memory.get(key) : undefined
  );
  useEffect(() => {
    if (!repo) {
      setValue(repo === null ? null : undefined);
      return;
    }
    const hit = memory.get(key);
    if (hit !== undefined) {
      setValue(hit);
      return;
    }
    let cancelled = false;
    setValue(undefined);
    void getPreview(repo).then((result) => {
      if (!cancelled) setValue(result);
    });
    return () => {
      cancelled = true;
    };
  }, [key, repo]);
  return value;
}
