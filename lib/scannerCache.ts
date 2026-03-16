/**
 * Local cache for blockchain scan results.
 *
 * Keyed by (sourceChainId, destChainId).  Persists to localStorage so results
 * survive page reloads.  Tracks exactly which block ranges have been scanned
 * so the scanner can skip them on subsequent runs.
 */

import type { Message } from "@/lib/types";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ScannedRange {
  start: number;
  end: number;
}

interface CacheEntry {
  scannedRanges: ScannedRange[];
  messages: Message[];
  lastUpdated: number; // unix ms
}

// ─── Constants ────────────────────────────────────────────────────────────────

const CACHE_PREFIX = "veashi_v1_";

/**
 * Cap on how many messages to retain per chain pair.
 * Oldest (lowest blockNumber) are evicted first.
 */
const MAX_CACHED_MESSAGES = 500;

// ─── Storage helpers ──────────────────────────────────────────────────────────

function storageKey(srcId: number, dstId: number): string {
  return `${CACHE_PREFIX}${srcId}_${dstId}`;
}

export function getCache(srcId: number, dstId: number): CacheEntry | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(storageKey(srcId, dstId));
    return raw ? (JSON.parse(raw) as CacheEntry) : null;
  } catch {
    return null;
  }
}

function setCache(srcId: number, dstId: number, entry: CacheEntry): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(storageKey(srcId, dstId), JSON.stringify(entry));
  } catch {
    // Storage full or unavailable — silently skip.
  }
}

export function clearCache(srcId: number, dstId: number): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.removeItem(storageKey(srcId, dstId));
  } catch {
    /* ignore */
  }
}

// ─── Range utilities ──────────────────────────────────────────────────────────

/**
 * Merge overlapping / adjacent ranges and return them sorted ascending by start.
 */
export function mergeRanges(ranges: ScannedRange[]): ScannedRange[] {
  if (ranges.length === 0) return [];
  const sorted = [...ranges].sort((a, b) => a.start - b.start);
  const merged: ScannedRange[] = [{ ...sorted[0] }];
  for (let i = 1; i < sorted.length; i++) {
    const last = merged[merged.length - 1];
    const curr = sorted[i];
    if (curr.start <= last.end + 1) {
      last.end = Math.max(last.end, curr.end);
    } else {
      merged.push({ ...curr });
    }
  }
  return merged;
}

/**
 * Return the sub-ranges of `desired` not yet covered by `cached`.
 * These are the block intervals that still need to be fetched from the chain.
 */
export function getUncachedSubranges(
  desired: ScannedRange,
  cached: ScannedRange[],
): ScannedRange[] {
  // Only consider cached ranges that overlap the desired window.
  const relevant = mergeRanges(
    cached.filter((r) => r.end >= desired.start && r.start <= desired.end),
  );

  if (relevant.length === 0) return [desired];

  const gaps: ScannedRange[] = [];
  let cursor = desired.start;

  for (const r of relevant) {
    if (r.start > cursor) {
      gaps.push({ start: cursor, end: r.start - 1 });
    }
    cursor = Math.max(cursor, r.end + 1);
  }

  if (cursor <= desired.end) {
    gaps.push({ start: cursor, end: desired.end });
  }

  return gaps;
}

// ─── Cache read helpers ───────────────────────────────────────────────────────

/**
 * Search all cache entries for the given source chain and return the message
 * matching `txHash`, or null if not found.  Used by the tx-detail page to
 * avoid a network round-trip when the message was already loaded by the scanner.
 */
export function findMessageInCache(
  srcChainId: number,
  txHash: string,
): Message | null {
  if (typeof window === "undefined") return null;
  const prefix = `${CACHE_PREFIX}${srcChainId}_`;
  const normalized = txHash.toLowerCase();
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key?.startsWith(prefix)) continue;
      const raw = localStorage.getItem(key);
      if (!raw) continue;
      const entry = JSON.parse(raw) as CacheEntry;
      const found = entry.messages.find(
        (m) => m.txHash.toLowerCase() === normalized,
      );
      if (found) return found;
    }
  } catch {
    return null;
  }
  return null;
}

/**
 * Return cached messages that fall within `range`, sorted newest-first.
 */
export function getCachedMessages(
  srcId: number,
  dstId: number,
  range: ScannedRange,
): Message[] {
  const entry = getCache(srcId, dstId);
  if (!entry) return [];
  return entry.messages
    .filter((m) => m.blockNumber >= range.start && m.blockNumber <= range.end)
    .sort((a, b) => b.blockNumber - a.blockNumber);
}

// ─── Cache write helpers ──────────────────────────────────────────────────────

/**
 * Persist a newly-scanned chunk (range + its messages) into the cache.
 *
 * - Merges `newRange` into the existing scanned-ranges list.
 * - Deduplicates messages by txHash.
 * - Sorts newest-first and trims to MAX_CACHED_MESSAGES.
 *
 * Call this after every chunk (even empty ones) so we don't rescan them.
 */
export function updateCache(
  srcId: number,
  dstId: number,
  newRange: ScannedRange,
  newMessages: Message[],
): void {
  const existing = getCache(srcId, dstId) ?? {
    scannedRanges: [],
    messages: [],
    lastUpdated: 0,
  };

  const mergedRanges = mergeRanges([...existing.scannedRanges, newRange]);

  // Deduplicate by txHash (existing messages take precedence for metadata).
  const seen = new Set<string>(existing.messages.map((m) => m.txHash));
  const fresh = newMessages.filter((m) => {
    if (seen.has(m.txHash)) return false;
    seen.add(m.txHash);
    return true;
  });

  const allMessages = [...existing.messages, ...fresh]
    .sort((a, b) => b.blockNumber - a.blockNumber)
    .slice(0, MAX_CACHED_MESSAGES);

  setCache(srcId, dstId, {
    scannedRanges: mergedRanges,
    messages: allMessages,
    lastUpdated: Date.now(),
  });
}
