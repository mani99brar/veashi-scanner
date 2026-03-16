"use client";

import { use } from "react";
import { useRouter } from "next/navigation";
import Header from "@/components/Header";
import ChainBadge from "@/components/ChainBadge";
import BridgeStatusCard from "@/components/BridgeStatusCard";
import CopyButton from "@/components/CopyButton";
import { useTransaction } from "@/hooks/useTransaction";
import type { Message } from "@/lib/types";
import { useAdapterStatuses } from "@/hooks/useAdapters";
import { useExecutionStatus } from "@/hooks/useExecutionStatus"
import { getBridgeName } from "@/lib/veashiHelpers";

// ─── Page ─────────────────────────────────────────────────────────────────────
// Handles two URL shapes:
//   /tx/[hash]              → no chainId known (e.g. from SearchBar)
//   /tx/[chainId]/[hash]    → full detail (e.g. from messages table)

export default function TransactionPage({
  params,
}: {
  params: Promise<{ params: string[] }>;
}) {
  const { params: segments } = use(params);
  // const {statuses, isLoading} = useAdapterStatuses(params.)
  const router = useRouter();

  // Resolve segments → (chainId?, hash)
  const hasChainId = segments.length >= 2;
  const chainId    = hasChainId ? Number(segments[0]) : null;
  const txHash = hasChainId ? segments[1] : segments[0];
  

  return (
    <div className="min-h-screen">
      <Header />
      <main className="max-w-4xl mx-auto px-6 py-8 space-y-4">

        <button
          onClick={() => router.push("/")}
          className="flex items-center gap-2 text-sm text-(--text-muted) hover:text-(--text-primary) transition-colors animate-fade-in"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
          </svg>
          Back to Messages
        </button>

        {/* Always show the hash header */}
        <div
          className="glass rounded-xl border border-(--border) p-5 animate-fade-in"
          style={{ animationDelay: "0.05s" }}
        >
          <p className="text-xs font-semibold uppercase tracking-wider text-(--text-muted) mb-1">
            Source Transaction
          </p>
          <CopyButton text={txHash} displayText={txHash} className="font-mono text-sm break-all" />
        </div>

        {/* No chainId: show informational message */}
        {!hasChainId ? (
          <NoChainIdCard />
        ) : (
          <TxDetail chainId={chainId!} txHash={txHash} />
        )}
      </main>
    </div>
  );
}

// ─── No-chainId fallback ───────────────────────────────────────────────────────

function NoChainIdCard() {
  return (
    <div
      className="glass rounded-xl border border-(--border) p-10 text-center animate-fade-in"
      style={{ animationDelay: "0.1s" }}
    >
      <div className="w-12 h-12 mx-auto mb-4 rounded-full bg-amber-500/10 flex items-center justify-center">
        <svg className="w-6 h-6 text-amber-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
            d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
        </svg>
      </div>
      <p className="text-sm font-medium mb-1">Source chain required</p>
      <p className="text-xs text-(--text-muted) max-w-xs mx-auto">
        Navigate to this transaction from the messages table, which includes the source chain ID
        in the URL (<span className="font-mono">/tx/chainId/hash</span>).
      </p>
    </div>
  );
}

// ─── Main Data Fetcher ────────────────────────────────────────────────────────
function TxDetail({ chainId, txHash }: { chainId: number; txHash: string }) {
  const { message, isLoading, error, source } = useTransaction(chainId, txHash);

  if (isLoading) {
    return (
      <div className="glass rounded-xl border border-(--border) p-10 text-center animate-fade-in">
        {/* ... existing loading SVG ... */}
        <p className="text-sm text-(--text-muted)">Loading transaction…</p>
      </div>
    );
  }

  if (error || !message) {
    return (
      <div className="glass rounded-xl border border-red-500/20 p-10 text-center animate-fade-in">
         {/* ... existing error SVG ... */}
        <p className="text-sm font-medium text-red-400 mb-1">Not found</p>
        <p className="text-xs text-(--text-muted)">{error ?? "Transaction could not be loaded."}</p>
      </div>
    );
  }

  // Pass the guaranteed message to the content component
  return <TxDetailContent message={message} source={source} />;
}

// ─── Section components ───────────────────────────────────────────────────────

// ─── Content Renderer & Adapter Fetcher ───────────────────────────────────────
function TxDetailContent({ message, source }: { message: Message, source: "cache" | "chain" | null }) {
  const { statuses, isLoading: adaptersLoading } = useAdapterStatuses(message);
const {
  status: execStatus,
  isLoading: execLoading,
} = useExecutionStatus(message);
  return (
    <>
      <TxMeta message={message} source={source} />

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <ChainRouteCard message={message} />

        {/* 2. Pass the statuses and loading state to ThresholdCard */}
        <ThresholdCard
          message={message}
          statuses={statuses}
          isLoading={adaptersLoading}
        />
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <AddressesCard message={message} />
        {/* Note: I noticed MetadataCard renders `message.adapters.length`. 
            You could pass statuses here too if you wanted to show "3/5 adapters verified" */}
        <MetadataCard message={message} />
      </div>

      <ExecutionCard
        status={execStatus}
        isLoading={execLoading}
      />

      {/* 3. Pass the statuses and loading state to AdaptersCard */}
      <AdaptersCard
        message={message}
        statuses={statuses}
        isLoading={adaptersLoading}
      />

      {message.bridgeStatuses && message.bridgeStatuses.length > 0 && (
        <BridgesCard message={message} />
      )}
    </>
  );
}

function TxMeta({
  message,
  source,
}: {
  message: Message;
  source: "cache" | "chain" | null;
}) {
  return (
    <div className="glass rounded-xl border border-(--border) p-4 animate-fade-in flex flex-wrap items-center gap-4"
      style={{ animationDelay: "0.08s" }}
    >
      <div className="flex items-center gap-2">
        <span className="text-xs text-(--text-muted) uppercase tracking-wide">Block</span>
        <span className="font-mono text-sm font-medium">#{message.blockNumber.toLocaleString()}</span>
      </div>
      {message.nonce !== undefined && (
        <div className="flex items-center gap-2">
          <span className="text-xs text-(--text-muted) uppercase tracking-wide">Nonce</span>
          <span className="font-mono text-sm">{message.nonce}</span>
        </div>
      )}
      {source && (
        <span className={`ml-auto text-xs font-medium px-2 py-0.5 rounded-full ${
          source === "cache"
            ? "bg-purple-500/10 text-purple-400"
            : "bg-blue-500/10 text-blue-400"
        }`}>
          {source === "cache" ? "From cache" : "Fetched on-chain"}
        </span>
      )}
    </div>
  );
}

function ChainRouteCard({ message }: { message: Message }) {
  return (
    <div className="glass rounded-xl border border-(--border) p-5 animate-fade-in"
      style={{ animationDelay: "0.1s" }}
    >
      <SectionLabel icon="route" label="Chain Route" />
      <div className="flex items-center gap-4 mt-4">
        <div className="flex-1 min-w-0">
          <p className="text-xs text-(--text-muted) mb-2">From</p>
          <ChainBadge chainId={message.sourceChain} className="text-sm" />
        </div>
        <div className="shrink-0 px-2">
          <div className="w-8 h-8 rounded-full bg-purple-500/10 flex items-center justify-center">
            <svg className="w-4 h-4 text-purple-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 7l5 5m0 0l-5 5m5-5H6" />
            </svg>
          </div>
        </div>
        <div className="flex-1 min-w-0 text-right">
          <p className="text-xs text-(--text-muted) mb-2">To</p>
          <ChainBadge chainId={message.destinationChain} className="text-sm" />
        </div>
      </div>
    </div>
  );
}

function ThresholdCard({ 
  message, 
  statuses, 
  isLoading 
}: { 
  message: Message; 
  statuses: Record<string, any>; // Adjust this type to match your hook!
  isLoading: boolean;
}) {
  const required = message.thresholdRequired;
  
  // Dynamically calculate the current threshold from the hook's statuses.
  // Assuming a value of true, "Verified", or "Success" means it passed.
  const verifiedCount = statuses 
    ? Object.values(statuses).filter(s => s === 'Confirmed' || s === true).length 
    : 0;

  // Fallback to message.thresholdCurrent if the hook is still loading, 
  // otherwise use our live verified count.
  const current = isLoading ? (message.thresholdCurrent ?? 0) : verifiedCount;

  const pct = required > 0 ? Math.round((current / required) * 100) : 0;
  
  // Optional: tweak the status meta if it's currently loading
  const { label, dotClass, barClass } = getStatusMeta(current, required);
  const displayLabel = isLoading ? "Verifying..." : label;
  const displayDotClass = isLoading ? "bg-purple-400 animate-pulse" : dotClass;

  return (
    <div className="glass rounded-xl border border-(--border) p-5 animate-fade-in"
      style={{ animationDelay: "0.1s" }}
    >
      <SectionLabel icon="threshold" label="Bridge Threshold" />
      <div className="mt-4">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-baseline gap-1">
            <span className="text-3xl font-bold font-mono">{current}</span>
            <span className="text-(--text-muted) text-lg">/ {required}</span>
          </div>
          <div className="flex items-center gap-1.5">
            <span className={`w-2 h-2 rounded-full ${displayDotClass}`} />
            <span className="text-sm font-medium">{displayLabel}</span>
          </div>
        </div>
        <div className="h-1.5 rounded-full bg-(--surface) overflow-hidden">
          <div
            className={`h-full rounded-full transition-all duration-700 ${isLoading ? 'bg-purple-400/50 animate-pulse' : barClass}`}
            style={{ width: `${pct}%` }}
          />
        </div>
        <p className="text-xs text-(--text-muted) mt-1.5">
          {pct}% of threshold met
          {(current === 0 && !isLoading) && (
            <span className="ml-2 text-amber-400/70">· on-chain verification pending</span>
          )}
        </p>
      </div>
    </div>
  );
}

function AddressesCard({ message }: { message: Message }) {
  return (
    <div className="glass rounded-xl border border-(--border) p-5 animate-fade-in"
      style={{ animationDelay: "0.15s" }}
    >
      <SectionLabel icon="address" label="Addresses" />
      <div className="mt-4 space-y-3">
        <AddressRow label="Sender" address={message.sourceAddress} />
        <AddressRow label="Receiver" address={message.destinationAddress} />
      </div>
    </div>
  );
}

function MetadataCard({ message }: { message: Message }) {
  return (
    <div className="glass rounded-xl border border-(--border) p-5 animate-fade-in"
      style={{ animationDelay: "0.15s" }}
    >
      <SectionLabel icon="info" label="Details" />
      <dl className="mt-4 space-y-3">
        <MetaRow label="Block">
          <span className="font-mono text-sm">#{message.blockNumber.toLocaleString()}</span>
        </MetaRow>
        {message.messageId && (
          <MetaRow label="Message ID">
            <span className="font-mono text-xs break-all text-right">{message.messageId}</span>
          </MetaRow>
        )}
        {message.adapters && (
          <MetaRow label="Adapters">
            <span className="font-mono text-sm">{message.adapters.length}</span>
          </MetaRow>
        )}
        {message.reporters && (
          <MetaRow label="Reporters">
            <span className="font-mono text-sm">{message.reporters.length}</span>
          </MetaRow>
        )}
      </dl>
    </div>
  );
}

function AdaptersCard({
  message,
  statuses,
  isLoading,
}: {
  message: Message;
  statuses: Record<string, any>;
  isLoading: boolean;
}) {
  const adapters = message.adapters ?? [];
  const reporters = message.reporters ?? [];

  if (adapters.length === 0 && reporters.length === 0) {
    return (
      <div
        className="glass rounded-xl border border-(--border) p-5 animate-fade-in"
        style={{ animationDelay: "0.2s" }}
      >
        <SectionLabel icon="bridge" label="Adapters & Reporters" />
        <p className="mt-4 text-xs text-(--text-muted)">
          Adapter data unavailable — not yet fetched from chain.
        </p>
      </div>
    );
  }

  // 1. Group the adapters and reporters by their bridge name
  const bridgeGroups = new Map<
    string,
    { adapter?: string; reporter?: string; status?: any; bridgeName: string }
  >();

  // Process Adapters
  adapters.forEach((addr) => {
    const bridge = getBridgeName(
      message.sourceChain,
      message.destinationChain,
      addr,
      undefined,
    );
    const key = bridge !== null ? String(bridge) : `unknown-adapter-${addr}`;
    const current = bridgeGroups.get(key) || {
      bridgeName: bridge !== null ? String(bridge) : "Unknown",
    };

    bridgeGroups.set(key, {
      ...current,
      adapter: addr,
      status: statuses ? statuses[addr] : null,
    });
  });

  // Process Reporters
  reporters.forEach((addr) => {
    const bridge = getBridgeName(
      message.sourceChain,
      message.destinationChain,
      undefined,
      addr,
    );
    const key = bridge !== null ? String(bridge) : `unknown-reporter-${addr}`;
    const current = bridgeGroups.get(key) || {
      bridgeName: bridge !== null ? String(bridge) : "Unknown",
    };

    bridgeGroups.set(key, {
      ...current,
      reporter: addr,
    });
  });

  const pairedData = Array.from(bridgeGroups.values());

  return (
    <div
      className="glass rounded-xl border border-(--border) p-5 animate-fade-in"
      style={{ animationDelay: "0.2s" }}
    >
      <SectionLabel icon="bridge" label="Adapters & Reporters" />

      <div className="mt-4 space-y-3">
        {pairedData.map((pair, idx) => (
          <div
            key={idx}
            className="flex flex-col lg:flex-row lg:items-center justify-between gap-4 bg-(--surface) rounded-lg px-4 py-3 border border-(--border)"
          >
            {/* Left Side: Bridge Name & Addresses mapped in a row */}
            <div className="flex flex-col sm:flex-row sm:items-center gap-4 flex-1">
              {/* Bridge Name (Fixed width to keep rows aligned) */}
              <div className="w-24 shrink-0">
                <span className="text-xs font-bold uppercase tracking-wider text-(--text-primary)">
                  {pair.bridgeName}
                </span>
              </div>

              {/* Addresses (Side-by-side with flex-wrap) */}
              <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
                {pair.adapter && (
                  <div className="flex items-center gap-2">
                    <span className="text-[10px] font-semibold uppercase tracking-wider text-(--text-muted)">
                      Adapter
                    </span>
                    <CopyButton
                      text={pair.adapter}
                      displayText={`${pair.adapter.slice(0, 10)}…${pair.adapter.slice(-8)}`}
                      className="font-mono text-xs bg-(--background) px-2 py-1 rounded"
                    />
                  </div>
                )}

                {pair.reporter && (
                  <div className="flex items-center gap-2">
                    <span className="text-[10px] font-semibold uppercase tracking-wider text-(--text-muted)">
                      Reporter
                    </span>
                    <CopyButton
                      text={pair.reporter}
                      displayText={`${pair.reporter.slice(0, 10)}…${pair.reporter.slice(-8)}`}
                      className="font-mono text-xs bg-(--background) px-2 py-1 rounded"
                    />
                  </div>
                )}
              </div>
            </div>

            {/* Right Side: Shared Confirmation Status */}
            <div className="shrink-0 pt-3 lg:pt-0 border-t border-(--border) lg:border-0 flex items-center">
              {isLoading ? (
                <span className="text-xs font-medium text-(--text-muted) animate-pulse">
                  Loading...
                </span>
              ) : pair.status === "Verified" || pair.status === true ? (
                <span className="text-xs font-medium text-green-400">
                  Verified
                </span>
              ) : pair.status === "Failed" || pair.status === false ? (
                <span className="text-xs font-medium text-red-400">Failed</span>
              ) : (
                <span className="text-xs font-medium text-amber-400/80">
                  {pair.status || "Pending"}
                </span>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function BridgesCard({ message }: { message: Message }) {
  const statuses  = message.bridgeStatuses!;
  const confirmed = statuses.filter((b) => b.completed).length;
  return (
    <div className="glass rounded-xl border border-(--border) p-5 animate-fade-in"
      style={{ animationDelay: "0.25s" }}
    >
      <div className="flex items-center justify-between mb-4">
        <SectionLabel icon="bridge" label="Bridge Status" />
        <span className="text-xs text-(--text-muted) font-mono">
          {confirmed} / {statuses.length} confirmed
        </span>
      </div>
      <div className="space-y-2">
        {statuses.map((status) => (
          <BridgeStatusCard key={status.name} status={status} />
        ))}
      </div>
    </div>
  );
}

function ExecutionCard({
  status,
  isLoading,
}: {
  status: "pending" | "executed" | "failed";
  isLoading: boolean;
}) {
  return (
    <div
      className="glass rounded-xl border border-(--border) p-5 animate-fade-in"
      style={{ animationDelay: "0.18s" }}
    >
      <SectionLabel icon="route" label="Destination Execution" />

      <div className="mt-4 flex items-center justify-between bg-(--surface) rounded-lg px-4 py-3 border border-(--border)">
        <div className="flex items-center gap-3">
          {isLoading ? (
            <div className="w-2 h-2 rounded-full bg-purple-400 animate-pulse" />
          ) : status === "executed" ? (
            <div className="w-2 h-2 rounded-full bg-green-400" />
          ) : status === "failed" ? (
            <div className="w-2 h-2 rounded-full bg-red-400" />
          ) : (
            <div className="w-2 h-2 rounded-full bg-amber-400 animate-pulse" />
          )}

          <div>
            <p className="text-sm font-medium text-(--text-primary)">
              {isLoading
                ? "Checking status..."
                : status === "executed"
                  ? "Message Executed"
                  : status === "failed"
                    ? "Status Check Failed"
                    : "Awaiting Execution"}
            </p>
            <p className="text-xs text-(--text-muted) mt-0.5">
              {status === "executed"
                ? "Confirmed on destination chain"
                : "Checking Yaru contract mapping"}
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}


// ─── Atomic helpers ───────────────────────────────────────────────────────────

function AddressRow({ label, address }: { label: string; address: string }) {
  return (
    <div>
      <p className="text-xs text-(--text-muted) uppercase tracking-wide mb-1">{label}</p>
      <div className="bg-(--surface) rounded-lg px-3 py-2 border border-(--border)">
        <CopyButton text={address} displayText={address} className="text-sm font-mono break-all" />
      </div>
    </div>
  );
}

function MetaRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4">
      <dt className="text-xs text-(--text-muted) uppercase tracking-wide shrink-0 mt-0.5">{label}</dt>
      <dd className="text-right flex flex-col items-end gap-0.5 min-w-0">{children}</dd>
    </div>
  );
}



type IconType = "route" | "address" | "threshold" | "info" | "bridge";

function SectionLabel({ icon, label }: { icon: IconType; label: string }) {
  const icons: Record<IconType, React.ReactNode> = {
    route:     <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />,
    address:   <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />,
    threshold: <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />,
    info:      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />,
    bridge:    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7h12m0 0l-4-4m4 4l-4 4m0 6H4m0 0l4 4m-4-4l4-4" />,
  };
  return (
    <div className="flex items-center gap-2">
      <svg className="w-4 h-4 text-purple-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        {icons[icon]}
      </svg>
      <span className="text-sm font-semibold text-(--text-secondary)">{label}</span>
    </div>
  );
}

// ─── Utilities ────────────────────────────────────────────────────────────────

function getStatusMeta(current: number, required: number) {
  if (current >= required && required > 0) {
    return { label: "Confirmed",   dotClass: "bg-green-400 animate-pulse", barClass: "bg-green-400" };
  }
  if (current > 0) {
    return { label: "In Progress", dotClass: "bg-amber-400",               barClass: "bg-amber-400" };
  }
  return   { label: "Pending",     dotClass: "bg-red-400",                 barClass: "bg-red-400"   };
}
