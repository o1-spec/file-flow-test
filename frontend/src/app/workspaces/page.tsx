"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import {
  ServerStackIcon,
  CpuChipIcon,
  GlobeAmericasIcon,
  ArrowTopRightOnSquareIcon,
  PlusIcon,
  ArrowPathIcon
} from "@heroicons/react/24/outline";
import { getWorkspaces } from "@/lib/api";

interface Workspace {
  id: string;
  name: string;
  environment: string;
  region: string;
  worker_concurrency: number;
  transaction_id: string | null;
  status: string;
  console_url: string | null;
  created_at: string;
  updated_at: string;
}

export default function WorkspacesPage() {
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function loadWorkspaces() {
    setLoading(true);
    setError(null);
    try {
      const res = (await getWorkspaces()) as { workspaces?: Workspace[] };
      setWorkspaces(res.workspaces || []);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to load workspaces");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadWorkspaces();
  }, []);

  function getStatusBadge(status: string) {
    const s = (status || "PENDING").toUpperCase();
    if (s === "COMMITTED" || s === "READY" || s === "ACTIVE") {
      return (
        <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-medium bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
          <span className="w-1.5 h-1.5 rounded-full bg-emerald-400"></span>
          Ready
        </span>
      );
    }
    if (s === "AWAITING_COMPENSATION_APPROVAL") {
      return (
        <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-medium bg-amber-500/10 text-amber-400 border border-amber-500/20">
          <span className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-ping"></span>
          Approval Required
        </span>
      );
    }
    if (s === "COMPENSATED" || s === "ROLLED_BACK") {
      return (
        <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-medium bg-purple-500/10 text-purple-400 border border-purple-500/20">
          <span className="w-1.5 h-1.5 rounded-full bg-purple-400"></span>
          Rolled Back
        </span>
      );
    }
    if (s === "PROVISIONING" || s === "RUNNING" || s === "EXECUTING" || s === "IN_DOUBT" || s === "RECONCILING") {
      return (
        <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-medium bg-blue-500/10 text-blue-400 border border-blue-500/20">
          <span className="w-1.5 h-1.5 rounded-full bg-blue-400 animate-pulse"></span>
          Provisioning
        </span>
      );
    }
    return (
      <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-medium bg-zinc-500/10 text-zinc-400 border border-zinc-500/20">
        <span className="w-1.5 h-1.5 rounded-full bg-zinc-400"></span>
        {s}
      </span>
    );
  }

  return (
    <div className="min-h-[calc(100vh-64px)] w-full bg-[#0a0a0a] text-white p-6 sm:p-10">
      <div className="max-w-6xl mx-auto">
        {/* Header */}
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-8 border-b border-white/10">
          <div>
            <div className="inline-flex items-center gap-2 px-2.5 py-1 rounded-full bg-white/5 border border-white/10 text-xs font-medium text-gray-400 mb-2">
              <ServerStackIcon className="w-3.5 h-3.5 text-indigo-400" />
              Isolated Environments
            </div>
            <h1 className="text-3xl font-bold tracking-tight text-white">Processing Workspaces</h1>
            <p className="text-gray-400 text-sm mt-1">
              Dedicated pipelines with isolated storage, Redis queues, and compute workers managed via MCPx.
            </p>
          </div>

          <div className="flex items-center gap-3">
            <button
              onClick={loadWorkspaces}
              className="p-2 rounded-lg border border-white/10 bg-white/5 text-gray-400 hover:text-white hover:bg-white/10 transition-colors"
              title="Refresh"
            >
              <ArrowPathIcon className={`w-4 h-4 ${loading ? "animate-spin" : ""}`} />
            </button>
            <Link
              href="/operator"
              className="flex items-center gap-2 px-4 py-2 rounded-lg bg-white text-black font-semibold text-sm hover:bg-gray-200 transition-all shadow-sm"
            >
              <PlusIcon className="w-4 h-4" />
              Provision via Operator
            </Link>
          </div>
        </div>

        {/* Content */}
        {error && (
          <div className="mt-6 p-4 rounded-xl bg-red-500/10 border border-red-500/20 text-red-400 text-sm">
            {error}
          </div>
        )}

        {loading && workspaces.length === 0 ? (
          <div className="py-20 flex flex-col items-center justify-center text-center">
            <ArrowPathIcon className="w-8 h-8 text-gray-500 animate-spin mb-3" />
            <p className="text-gray-400 text-sm">Loading workspaces...</p>
          </div>
        ) : workspaces.length === 0 ? (
          <div className="mt-12 py-16 px-6 rounded-2xl border border-white/10 bg-white/2 text-center max-w-xl mx-auto flex flex-col items-center">
            <div className="w-12 h-12 rounded-2xl bg-indigo-500/10 border border-indigo-500/20 flex items-center justify-center text-indigo-400 mb-4">
              <ServerStackIcon className="w-6 h-6" />
            </div>
            <h3 className="text-lg font-semibold text-white mb-1">No Processing Workspaces Yet</h3>
            <p className="text-gray-400 text-sm mb-6 leading-relaxed">
              Use the AI Operations Agent (Operator) to provision your first isolated processing workspace through MCPx reliable multi-step workflows.
            </p>
            <Link
              href="/operator"
              className="px-5 py-2.5 rounded-lg bg-white text-black font-semibold text-sm hover:bg-gray-200 transition-all shadow-md"
            >
              Open AI Operator
            </Link>
          </div>
        ) : (
          <div className="mt-8 grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
            {workspaces.map((ws) => (
              <div
                key={ws.id}
                className="flex flex-col justify-between p-5 rounded-xl border border-white/10 bg-white/3 hover:bg-white/5 transition-all group"
              >
                <div>
                  <div className="flex items-start justify-between gap-2 mb-3">
                    <h3 className="text-lg font-semibold text-white tracking-tight group-hover:text-indigo-300 transition-colors">
                      {ws.name}
                    </h3>
                    {getStatusBadge(ws.status)}
                  </div>

                  <div className="space-y-2 text-xs text-gray-400 mb-6">
                    <div className="flex items-center justify-between py-1 border-b border-white/5">
                      <span className="text-gray-500">Environment</span>
                      <span className="text-gray-200 font-medium">{ws.environment}</span>
                    </div>
                    <div className="flex items-center justify-between py-1 border-b border-white/5">
                      <span className="text-gray-500 flex items-center gap-1">
                        <GlobeAmericasIcon className="w-3.5 h-3.5" /> Region
                      </span>
                      <span className="text-gray-200 font-medium">{ws.region}</span>
                    </div>
                    <div className="flex items-center justify-between py-1 border-b border-white/5">
                      <span className="text-gray-500 flex items-center gap-1">
                        <CpuChipIcon className="w-3.5 h-3.5" /> Concurrency
                      </span>
                      <span className="text-gray-200 font-medium">{ws.worker_concurrency} workers</span>
                    </div>
                    {ws.transaction_id && (
                      <div className="flex items-center justify-between py-1">
                        <span className="text-gray-500">Transaction</span>
                        <span className="font-mono text-[10px] text-gray-400 truncate max-w-35">
                          {ws.transaction_id}
                        </span>
                      </div>
                    )}
                  </div>
                </div>

                <div className="flex items-center gap-2 pt-3 border-t border-white/8">
                  <Link
                    href={`/operator?workspace=${encodeURIComponent(ws.name)}`}
                    className="flex-1 py-1.5 px-3 rounded-lg border border-white/10 bg-white/5 hover:bg-white/10 text-xs font-medium text-center text-gray-300 hover:text-white transition-colors"
                  >
                    Inspect in Operator
                  </Link>
                  {ws.console_url && (
                    <a
                      href={ws.console_url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="p-1.5 rounded-lg border border-white/10 bg-white/5 hover:bg-white/10 text-gray-400 hover:text-white transition-colors"
                      title="View Transaction in MCPx Console"
                    >
                      <ArrowTopRightOnSquareIcon className="w-4 h-4" />
                    </a>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
