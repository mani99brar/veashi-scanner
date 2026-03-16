import { useState, useEffect, useRef } from "react";
import { createPublicClient, http, Address } from "viem";
import {
  NO_CHAIN,
  type ChainFilter,
  type BlockRange,
} from "@/components/ChainFilterPanel";
import { getMessageDispatchedLogs } from "@/lib/hashi";
import {
  getYaho,
  getAllSourceChains,
  getDestinationChains,
} from "@kleros/veashi-sdk";
import type { Message } from "@/lib/types";
import {
  getCache,
  getCachedMessages,
  getUncachedSubranges,
  updateCache,
  type ScannedRange,
} from "@/lib/scannerCache";
import { getViemChain } from "@/lib/chains";

// ─── Constants & Helpers ──────────────────────────────────────────────────────

const SCAN_WINDOW_BLOCKS = BigInt(1_000_000);
const CHUNK_SIZE = BigInt(10_000);
const MAX_NEW_MESSAGES = 10;

/** * Helper to merge overlapping block ranges.
 * This ensures that if multiple destinations share a Yaho contract,
 * we union their missing ranges and only fetch from the RPC once.
 */
function mergeRanges(ranges: ScannedRange[]): ScannedRange[] {
  if (ranges.length === 0) return [];
  const sorted = [...ranges].sort((a, b) => a.start - b.start);
  const merged: ScannedRange[] = [sorted[0]];

  for (let i = 1; i < sorted.length; i++) {
    const last = merged[merged.length - 1];
    const curr = sorted[i];
    if (curr.start <= last.end + 1) {
      last.end = Math.max(last.end, curr.end);
    } else {
      merged.push(curr);
    }
  }
  return merged;
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

export function useMessageScanner(
  sourceChain: ChainFilter,
  destinationChain: ChainFilter,
  fromBlock?: number,
  toBlock?: number,
) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [isScanning, setIsScanning] = useState(false);
  const [blockRange, setBlockRange] = useState<BlockRange | null>(null);
  const [error, setError] = useState<string | null>(null);

  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    // ── Guard ─────────────────────────────────────────────────────────────────
    // If BOTH are specific chains but it's the exact same chain, we can abort.
    // Otherwise, we allow fetching all sources/destinations.
    if (
      sourceChain !== NO_CHAIN &&
      destinationChain !== NO_CHAIN &&
      sourceChain === destinationChain
    ) {
      setMessages([]);
      setIsScanning(false);
      return;
    }

    // ── Determine which Source chains to scan ─────────────────────────────────
    const chainsToScan =
      sourceChain === NO_CHAIN ? getAllSourceChains() : [sourceChain as number];

    const scan = async () => {
      if (abortRef.current) abortRef.current.abort();
      abortRef.current = new AbortController();
      const signal = abortRef.current.signal;

      setIsScanning(true);
      setError(null);
      setMessages([]); // clear stale results immediately

      try {
        const scanPromises = chainsToScan.map(async (srcId) => {
          try {
            const chainConfig = getViemChain(srcId);
            if (!chainConfig) {
              console.warn(`Unsupported source chain ${srcId}`);
              return;
            }

            // ── Determine Target Destinations for this Source ────────────────
            const supportedDestinations = getDestinationChains(srcId);
            const targetDestIds =
              destinationChain === NO_CHAIN
                ? supportedDestinations
                : supportedDestinations.includes(destinationChain as number)
                  ? [destinationChain as number]
                  : [];

            if (targetDestIds.length === 0) return; // No valid routes for this source

            const publicClient = createPublicClient({
              chain: chainConfig,
              transport: http(),
            });

            // ── Determine the desired scan window ────────────────────────────
            let startBlock: bigint;
            let endBlock: bigint;

            if (fromBlock !== undefined && toBlock !== undefined) {
              startBlock = BigInt(fromBlock);
              endBlock = BigInt(toBlock);
            } else {
              const currentBlock = await publicClient.getBlockNumber();
              if (signal.aborted) return;

              endBlock = toBlock !== undefined ? BigInt(toBlock) : currentBlock;
              startBlock =
                fromBlock !== undefined
                  ? BigInt(fromBlock)
                  : endBlock - SCAN_WINDOW_BLOCKS > BigInt(0)
                    ? endBlock - SCAN_WINDOW_BLOCKS
                    : BigInt(1);
            }

            const desiredRange: ScannedRange = {
              start: Number(startBlock),
              end: Number(endBlock),
            };

            if (chainsToScan.length === 1) {
              setBlockRange({
                chain: chainConfig.name,
                start: desiredRange.start,
                end: desiredRange.end,
                windowSize: desiredRange.end - desiredRange.start,
              });
            } else {
              setBlockRange(null);
            }

            // ── Serve Cached Messages & Group Yaho Contracts ─────────────────
            const yahoToDestIds = new Map<string, number[]>();

            for (const dstId of targetDestIds) {
              // 1. Check cache and serve immediately
              const cachedMessages = getCachedMessages(
                srcId,
                dstId,
                desiredRange,
              );
              if (cachedMessages.length > 0) {
                setMessages((prev) => {
                  const seen = new Set(prev.map((m) => m.txHash));
                  const fresh = cachedMessages.filter(
                    (m) => !seen.has(m.txHash),
                  );
                  return [...prev, ...fresh].sort(
                    (a, b) => b.blockNumber - a.blockNumber,
                  );
                });
              }

              // 2. Map Destinations to their Yaho Contract
              const yaho = getYaho(srcId, dstId);
              if (yaho) {
                const normalizedYaho = yaho.toLowerCase();
                if (!yahoToDestIds.has(normalizedYaho))
                  yahoToDestIds.set(normalizedYaho, []);
                yahoToDestIds.get(normalizedYaho)!.push(dstId);
              }
            }

            // ── Scan Uncached Ranges per Yaho Address (Deduplicated) ─────────
            for (const [yahoAddr, dstIdsForYaho] of yahoToDestIds.entries()) {
              // Combine uncached ranges for all destinations sharing this contract
              const allUncached: ScannedRange[] = [];
              for (const dstId of dstIdsForYaho) {
                const cacheEntry = getCache(srcId, dstId);
                const uncached = getUncachedSubranges(
                  desiredRange,
                  cacheEntry?.scannedRanges ?? [],
                );
                allUncached.push(...uncached);
              }

              const mergedUncached = mergeRanges(allUncached);
              if (mergedUncached.length === 0) continue;

              const rangesNewestFirst = mergedUncached.sort(
                (a, b) => b.end - a.end,
              );
              let totalNew = 0;

              outer: for (const subrange of rangesNewestFirst) {
                let chunkEnd = BigInt(subrange.end);
                const subStart = BigInt(subrange.start);

                while (chunkEnd >= subStart) {
                  if (signal.aborted) break outer;

                  let chunkStart = chunkEnd - CHUNK_SIZE + BigInt(1);
                  if (chunkStart < subStart) chunkStart = subStart;

                  const chunkRange: ScannedRange = {
                    start: Number(chunkStart),
                    end: Number(chunkEnd),
                  };

                  const rawLogs = await getMessageDispatchedLogs(
                    yahoAddr as Address, // Use the grouped Yaho Address
                    chunkStart,
                    chunkEnd,
                    srcId,
                  );

                  if (signal.aborted) break outer;

                  const formatted: Message[] = rawLogs
                    .sort((a, b) => b.blockNumber - a.blockNumber)
                    .map((log) => ({
                      txHash: log.txHash,
                      sourceChain: srcId,
                      destinationChain: log.message.targetChainId, // Explicit target from log
                      thresholdRequired: log.message.threshold,
                      thresholdCurrent: 0,
                      sourceAddress: log.message.sender,
                      destinationAddress: log.message.receiver,
                      blockNumber: log.blockNumber,
                      messageId: log.messageId,
                      adapters: log.message.adapters,
                      reporters: log.message.reporters,
                      nonce: log.message.nonce,
                    }));

                  // Distribute the logs to the correct destination cache
                  for (const dstId of dstIdsForYaho) {
                    const logsForDst = formatted.filter(
                      (m) => m.destinationChain === dstId,
                    );
                    updateCache(srcId, dstId, chunkRange, logsForDst);
                  }

                  // Only render logs for the destinations we actively care about
                  const logsToDisplay = formatted.filter((m) =>
                    targetDestIds.includes(m.destinationChain),
                  );

                  if (logsToDisplay.length > 0) {
                    const toAdd = logsToDisplay.slice(
                      0,
                      MAX_NEW_MESSAGES - totalNew,
                    );
                    setMessages((prev) => {
                      const seen = new Set(prev.map((m) => m.txHash));
                      const fresh = toAdd.filter((m) => !seen.has(m.txHash));
                      return [...prev, ...fresh].sort(
                        (a, b) => b.blockNumber - a.blockNumber,
                      );
                    });
                    totalNew += toAdd.length;
                  }

                  if (totalNew >= MAX_NEW_MESSAGES) break outer;

                  chunkEnd = chunkStart - BigInt(1);
                  await new Promise((r) => setTimeout(r, 500)); // Rate limit buffer
                }
              }
            }
          } catch (chainErr: any) {
            if (chainErr.name !== "AbortError") {
              console.error(`Scanning failed for chain ${srcId}:`, chainErr);
            }
          }
        });

        await Promise.all(scanPromises);
      } catch (err: any) {
        if (err.name !== "AbortError") {
          console.error("Global scanning failed:", err);
          setError("Failed to scan blockchain.");
        }
      } finally {
        if (!signal.aborted) setIsScanning(false);
      }
    };

    scan();

    return () => {
      if (abortRef.current) abortRef.current.abort();
    };
  }, [sourceChain, destinationChain, fromBlock, toBlock]);

  return { messages, isScanning, blockRange, error };
}
