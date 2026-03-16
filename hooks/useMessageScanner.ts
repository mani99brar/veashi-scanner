import { useState, useEffect, useRef } from "react";
import { createPublicClient, http, Address } from "viem";
import {
  NO_CHAIN,
  type ChainFilter,
  type BlockRange,
} from "@/components/ChainFilterPanel";
import { getMessageDispatchedLogs } from "@/lib/hashi";
import { getYaho } from "@kleros/veashi-sdk";
import type { Message } from "@/lib/types";
import {
  getCache,
  getCachedMessages,
  getUncachedSubranges,
  updateCache,
  type ScannedRange,
} from "@/lib/scannerCache";
import { getViemChain } from "@/lib/chains";

// ─── Constants ────────────────────────────────────────────────────────────────

/** Default look-back window when no block range is specified. */
const SCAN_WINDOW_BLOCKS = BigInt(1_000_000);

/** RPC batch size per getLogs call. */
const CHUNK_SIZE = BigInt(10_000);

/** Max *new* messages fetched per scan session (cached messages don't count). */
const MAX_NEW_MESSAGES = 10;

// ─── Helpers ──────────────────────────────────────────────────────────────────


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
    // ── Guard: require both chains to be selected ──────────────────────────
    if (sourceChain === NO_CHAIN || destinationChain === NO_CHAIN) {
      setMessages([]);
      setBlockRange(null);
      setIsScanning(false);
      return;
    }

    const srcId = sourceChain as number;
    const dstId = destinationChain as number;

    const scan = async () => {
      // Cancel any in-flight scan for the previous filter combination.
      if (abortRef.current) abortRef.current.abort();
      abortRef.current = new AbortController();
      const signal = abortRef.current.signal;

      setIsScanning(true);
      setError(null);
      setMessages([]); // clear stale results immediately

      try {
        const chainConfig = getViemChain(srcId);
        if (!chainConfig) throw new Error(`Unsupported chain ${srcId}`);

        const publicClient = createPublicClient({ chain: chainConfig, transport: http() });

        // ── Determine the desired scan window ────────────────────────────
        let startBlock: bigint;
        let endBlock: bigint;

        if (fromBlock !== undefined && toBlock !== undefined) {
          // Both bounds provided — no getBlockNumber() call needed.
          startBlock = BigInt(fromBlock);
          endBlock   = BigInt(toBlock);
        } else {
          // Need the current block to anchor the rolling window.
          const currentBlock = await publicClient.getBlockNumber();
          if (signal.aborted) return;

          endBlock   = toBlock   !== undefined ? BigInt(toBlock)   : currentBlock;
          startBlock = fromBlock !== undefined
            ? BigInt(fromBlock)
            : (endBlock - SCAN_WINDOW_BLOCKS > BigInt(0) ? endBlock - SCAN_WINDOW_BLOCKS : BigInt(1));
        }

        const desiredRange: ScannedRange = {
          start: Number(startBlock),
          end:   Number(endBlock),
        };

        setBlockRange({
          chain:      chainConfig.name,
          start:      desiredRange.start,
          end:        desiredRange.end,
          windowSize: desiredRange.end - desiredRange.start,
        });

        // ── Serve cached messages immediately ────────────────────────────
        const cacheEntry     = getCache(srcId, dstId);
        const cachedMessages = getCachedMessages(srcId, dstId, desiredRange);
        const uncachedRanges = getUncachedSubranges(
          desiredRange,
          cacheEntry?.scannedRanges ?? [],
        );

        setMessages(cachedMessages);

        if (uncachedRanges.length === 0) {
          // Entire window is already cached — nothing to fetch.
          setIsScanning(false);
          return;
        }

        // publicClient is only used for getBlockNumber above; getMessageDispatchedLogs
        // creates its own client internally via srcId.
        // ── Scan uncached sub-ranges, newest first ───────────────────────
        const yahoAddress = getYaho(srcId, dstId);

        // Sort so we surface the most-recent messages first.
        const rangesNewestFirst = [...uncachedRanges].sort((a, b) => b.end - a.end);

        let totalNew = 0;

        outer: for (const subrange of rangesNewestFirst) {
          let chunkEnd  = BigInt(subrange.end);
          const subStart = BigInt(subrange.start);

          while (chunkEnd >= subStart) {
            if (signal.aborted) break outer;

            let chunkStart = chunkEnd - CHUNK_SIZE + BigInt(1);
            if (chunkStart < subStart) chunkStart = subStart;

            const chunkRange: ScannedRange = {
              start: Number(chunkStart),
              end:   Number(chunkEnd),
            };

            const rawLogs = await getMessageDispatchedLogs(
              yahoAddress as Address,
              chunkStart,
              chunkEnd,
              srcId,
            );
            console.log(rawLogs, "RAW LOGS");
            if (signal.aborted) break outer;
            const formatted: Message[] = rawLogs
              .sort((a, b) => b.blockNumber - a.blockNumber)
              .map((log) => ({
                txHash:             log.txHash,
                sourceChain:        srcId,
                destinationChain:   log.message.targetChainId,
                thresholdRequired:  log.message.threshold,
                thresholdCurrent:   0,
                bridges:            undefined,
                bridgeStatuses:     undefined,
                sourceAddress:      log.message.sender,
                destinationAddress: log.message.receiver,
                blockNumber:        log.blockNumber,
                messageId:          log.messageId,
                adapters:           log.message.adapters,
                reporters:          log.message.reporters,
                nonce:              log.message.nonce,
              }));

            // Persist the chunk — even if empty — so we don't rescan it.
            updateCache(srcId, dstId, chunkRange, formatted);

            if (formatted.length > 0) {
              const toAdd = formatted.slice(0, MAX_NEW_MESSAGES - totalNew);

              setMessages((prev) => {
                const seen  = new Set(prev.map((m) => m.txHash));
                const fresh = toAdd.filter((m) => !seen.has(m.txHash));
                return [...prev, ...fresh].sort((a, b) => b.blockNumber - a.blockNumber);
              });

              totalNew += toAdd.length;
            }

            if (totalNew >= MAX_NEW_MESSAGES) break outer;

            chunkEnd = chunkStart - BigInt(1);
            await new Promise((r) => setTimeout(r, 500));
          }
        }
      } catch (err: any) {
        if (err.name !== "AbortError") {
          console.error("Scanning failed:", err);
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
