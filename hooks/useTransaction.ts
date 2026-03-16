import { useState, useEffect } from "react";
import type { Address, Hash } from "viem";
import { getMessageFromTxHash } from "@/lib/hashi";
import { getYaho, getDestinationChains } from "@kleros/veashi-sdk";
import { findMessageInCache } from "@/lib/scannerCache";
import type { Message } from "@/lib/types";

/**
 * Fetches a cross-chain message by (sourceChainId, txHash).
 *
 * Strategy:
 *  1. Look in the local scanner cache (instant, no network).
 *  2. If not cached, iterate through all known destination chains for
 *     `sourceChainId`, try each Yaho address, and call `getMessageFromTxHash`
 *     until one returns a result.
 *
 * Placeholders — not yet implemented:
 *  - `thresholdCurrent`: fetching confirmed adapters from the destination chain.
 *  - `bridgeStatuses`: per-bridge verification status from the destination chain.
 */
export function useTransaction(sourceChainId: number, txHash: string) {
  const [message, setMessage] = useState<Message | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [source, setSource] = useState<"cache" | "chain" | null>(null);

  useEffect(() => {
    if (!sourceChainId || !txHash) return;

    let cancelled = false;

    const load = async () => {
      setIsLoading(true);
      setError(null);
      setMessage(null);
      setSource(null);

      // ── 1. Cache lookup ────────────────────────────────────────────────────
      const cached = findMessageInCache(sourceChainId, txHash);
      if (cached) {
        if (!cancelled) {
          setMessage(cached);
          setSource("cache");
          setIsLoading(false);
        }
        return;
      }

      // ── 2. On-chain fetch ──────────────────────────────────────────────────
      // We don't know the destination chain yet, so try all possible pairs.
      try {
        let destChainIds: number[] = [];
        try {
          destChainIds = getDestinationChains(sourceChainId);
        } catch {
          // SDK may not recognise this source chain.
        }

        let found: Awaited<ReturnType<typeof getMessageFromTxHash>> = null;

        for (const dstId of destChainIds) {
          if (cancelled) return;
          const yahoAddress = getYaho(sourceChainId, dstId);
          if (!yahoAddress) continue;
          try {
            found = await getMessageFromTxHash(
              yahoAddress as Address,
              sourceChainId,
              txHash as Hash,
            );
            if (found) break;
          } catch {
            // This dest chain didn't have the tx — try the next one.
            continue;
          }
        }

        if (cancelled) return;

        if (!found) {
          setError("Transaction not found. It may not exist on this chain or be outside the scanned range.");
          return;
        }

        const msg: Message = {
          txHash:             found.txHash,
          sourceChain:        sourceChainId,
          destinationChain:   found.message.targetChainId,
          thresholdRequired:  found.message.threshold,
          thresholdCurrent:   0,           // TODO: fetch from dest chain adapters
          bridges:            undefined,   // TODO: map adapter addresses → Bridge names
          bridgeStatuses:     undefined,   // TODO: per-bridge status from dest chain
          sourceAddress:      found.message.sender,
          destinationAddress: found.message.receiver,
          blockNumber:        found.blockNumber,
          messageId:          found.messageId,
          adapters:           found.message.adapters,
          reporters:          found.message.reporters,
          nonce:              found.message.nonce,
        };

        setMessage(msg);
        setSource("chain");
      } catch (err: any) {
        if (!cancelled) {
          console.error("useTransaction failed:", err);
          setError("Failed to fetch transaction details.");
        }
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    };

    load();
    return () => { cancelled = true; };
  }, [sourceChainId, txHash]);

  return { message, isLoading, error, source };
}
