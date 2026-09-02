"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import {
  ServerStackIcon,
  CheckCircleIcon,
  XCircleIcon,
  ArrowPathIcon,
  ExclamationTriangleIcon,
  ArrowTopRightOnSquareIcon,
  ShieldCheckIcon,
  CubeTransparentIcon,
  PaperAirplaneIcon,
  ClockIcon,
  CommandLineIcon,
} from "@heroicons/react/24/outline";
import {
  getAgentObserve,
  evaluateAgent,
  provisionWorkspace,
  approveWorkspaceRollback,
  subscribeWorkspaceEvents,
} from "@/lib/api";

interface AgentObservationData {
  timestamp: string;
  goal: string;
  pipeline: {
    workerOnline: boolean;
    workerLastSeenSecondsAgo: number | null;
    queues: {
      waiting: number;
      active: number;
      failed: number;
      dlqWaiting: number;
      details?: Record<string, unknown>;
    };
  };
  workload: {
    pendingCount: number;
    pendingFiles: Array<{ id: string; filename: string; mimeType: string; status: string }>;
    failedCount: number;
    failedFiles: Array<{ id: string; filename: string; mimeType: string; errorMessage?: string }>;
  };
  dlq: Array<{
    jobId: string;
    uploadId?: string;
    filename: string;
    queue: string;
    attemptsMade: number;
    errorMessage: string;
    failedAt?: string;
  }>;
  workspace: {
    latest?: {
      id: string;
      name: string;
      environment: string;
      region: string;
      worker_concurrency: number;
      transaction_id: string | null;
      status: string;
      console_url: string | null;
      updated_at: string;
    } | null;
  };
}

interface AgentDecisionData {
  status: "NO_ACTION_REQUIRED" | "AUTONOMOUS_ACTION" | "APPROVAL_REQUIRED" | "BLOCKED";
  reason: string;
  action?: {
    tool: string;
    arguments: Record<string, unknown>;
  };
  provider?: string;
  model?: string;
}

interface ActivityEvent {
  id: string;
  type: "OBSERVED" | "DECIDED" | "ACTED" | "VERIFIED" | "ERROR";
  summary: string;
  detail?: string;
  timestamp: string;
}

interface NodeState {
  id: string;
  nodeId?: string;
  label?: string;
  fileflowLabel: string;
  state: "PENDING" | "WAITING" | "EXECUTING" | "SUCCEEDED" | "IN_DOUBT" | "RECONCILING" | "RECOVERED" | "FAILED" | "COMPENSATING" | "COMPENSATED";
  error?: string | null;
}

interface ActiveTransaction {
  workspaceId: string;
  workspaceName: string;
  transactionId: string;
  consoleUrl: string;
  status: string;
  nodes: NodeState[];
  isAwaitingApproval: boolean;
  compensationDone: boolean;
}

export default function OperatorPage() {
  const [observation, setObservation] = useState<AgentObservationData | null>(null);
  const [decision, setDecision] = useState<AgentDecisionData | null>(null);
  const [evaluating, setEvaluating] = useState(false);
  const [agentStatus, setAgentStatus] = useState<"ACTIVE" | "EVALUATING" | "WAITING_APPROVAL" | "BLOCKED" | "IDLE">("IDLE");
  const [activityLog, setActivityLog] = useState<ActivityEvent[]>([]);
  const [workspaceProposal, setWorkspaceProposal] = useState<{
    name: string;
    environment: string;
    region: string;
    workerConcurrency: number;
  } | null>(null);

  // MCPx Active Workflow State
  const [activeTx, setActiveTx] = useState<ActiveTransaction | null>(null);
  const [approving, setApproving] = useState(false);

  // Manual prompt fallback
  const [inputPrompt, setInputPrompt] = useState("");
  const [manualLoading, setManualLoading] = useState(false);

  const eventSourceCleanupRef = useRef<(() => void) | null>(null);

  function getFileFlowLabel(nodeKey: string, fallback: string = "") {
    const key = (nodeKey || "").toLowerCase();
    if (key.includes("database") || key === "db") return "Workspace Database";
    if (key.includes("compute")) return "Processing Runtime";
    if (key.includes("routing")) return "Public Endpoint";
    if (key.includes("frontend")) return "Workspace Console";
    return fallback || nodeKey;
  }

  // Add event to activity log
  const pushActivity = useCallback((type: ActivityEvent["type"], summary: string, detail?: string) => {
    setActivityLog((prev) => [
      {
        id: `act_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
        type,
        summary,
        detail,
        timestamp: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }),
      },
      ...prev.slice(0, 19),
    ]);
  }, []);

  // Fetch live observation from backend
  const fetchObservation = useCallback(async () => {
    try {
      const data = await getAgentObserve();
      setObservation(data as unknown as AgentObservationData);
      return data as unknown as AgentObservationData;
    } catch (err: unknown) {
      console.error("Failed to fetch observation", err);
      return null;
    }
  }, []);

  // Run structured evaluation cycle (OBSERVE -> DECIDE -> ACT/PROPOSE -> VERIFY)
  const runAgentEvaluation = useCallback(async (customMessage?: string) => {
    if (evaluating) return;
    setEvaluating(true);
    setAgentStatus("EVALUATING");

    try {
      const preObs = await fetchObservation();
      const workerState = preObs?.pipeline.workerOnline ? "Online" : "Offline";
      const dlqCount = preObs?.dlq.length || 0;
      pushActivity(
        "OBSERVED",
        `Worker ${workerState} (${preObs?.pipeline.workerLastSeenSecondsAgo != null ? `${preObs.pipeline.workerLastSeenSecondsAgo}s ago` : "heartbeat absent"}), Queues: ${preObs?.pipeline.queues.waiting || 0} waiting, ${preObs?.pipeline.queues.active || 0} active, ${dlqCount} in DLQ.`
      );

      const evalRes = (await evaluateAgent({
        mode: "auto_execute",
        userMessage: customMessage || "",
      })) as {
        observation: AgentObservationData;
        decision: AgentDecisionData;
        executedAction?: { tool: string; jobId?: string; result?: Record<string, unknown>; error?: string } | null;
        postObservation?: AgentObservationData;
      };

      const dec = evalRes.decision;
      setDecision(dec);

      pushActivity(
        "DECIDED",
        `${dec.status}: ${dec.reason}`
      );

      if (dec.status === "AUTONOMOUS_ACTION" && evalRes.executedAction) {
        pushActivity(
          "ACTED",
          `Autonomous mutation executed: ${evalRes.executedAction.tool}`,
          JSON.stringify(evalRes.executedAction.result || evalRes.executedAction.error)
        );

        if (evalRes.postObservation) {
          setObservation(evalRes.postObservation);
          pushActivity(
            "VERIFIED",
            `DLQ count is now ${evalRes.postObservation.dlq.length}, job transitioned back to active processing queue.`
          );
        }
        setAgentStatus("ACTIVE");
      } else if (dec.status === "APPROVAL_REQUIRED" && dec.action?.tool === "provision_processing_workspace") {
        setWorkspaceProposal({
          name: String(dec.action.arguments.name || "invoices-prod"),
          environment: String(dec.action.arguments.environment || "Production"),
          region: String(dec.action.arguments.region || "Europe West"),
          workerConcurrency: Number(dec.action.arguments.workerConcurrency || 4),
        });
        setAgentStatus("WAITING_APPROVAL");
      } else if (dec.status === "BLOCKED") {
        setAgentStatus("BLOCKED");
      } else {
        setAgentStatus("ACTIVE");
      }
    } catch (err: unknown) {
      console.error("Agent evaluation failed", err);
      pushActivity("ERROR", "Evaluation cycle failed", err instanceof Error ? err.message : String(err));
      setAgentStatus("IDLE");
    } finally {
      setEvaluating(false);
    }
  }, [evaluating, fetchObservation, pushActivity]);

  // Initial load: observe and run first clean evaluation
  useEffect(() => {
    fetchObservation().then(() => {
      runAgentEvaluation();
    });
    return () => {
      if (eventSourceCleanupRef.current) eventSourceCleanupRef.current();
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Handle workspace provisioning approval -> invokes MCPx via @mcpxx/sdk
  async function handleConfirmProvision() {
    if (!workspaceProposal) return;
    const proposal = workspaceProposal;
    setWorkspaceProposal(null);
    setApproving(true);
    setAgentStatus("ACTIVE");

    pushActivity(
      "ACTED",
      `Operator authorized workspace provisioning: ${proposal.name} (${proposal.environment}, ${proposal.region}, ${proposal.workerConcurrency} workers). Delegating to MCPx.`
    );

    try {
      const res = (await provisionWorkspace({
        name: proposal.name,
        environment: proposal.environment,
        region: proposal.region,
        workerConcurrency: proposal.workerConcurrency,
      })) as {
        workspace: { id: string; name: string };
        transactionId: string;
        consoleUrl: string;
      };

      const workspaceId = res.workspace.id;
      const transactionId = res.transactionId;
      const consoleUrl = res.consoleUrl || `${process.env.NEXT_PUBLIC_MCPX_CONSOLE_URL || "http://localhost:3000"}/app/transactions/${transactionId}`;

      setActiveTx({
        workspaceId,
        workspaceName: proposal.name,
        transactionId,
        consoleUrl,
        status: "PROVISIONING",
        nodes: [],
        isAwaitingApproval: false,
        compensationDone: false,
      });

      // Subscribe to live SSE events from FileFlow backend
      const cleanup = subscribeWorkspaceEvents(
        workspaceId,
        (data: Record<string, unknown>) => {
          const snap = (data.snapshot as Record<string, unknown>) || data;
          const rawNodes = (snap?.nodes as Array<{ id: string; label?: string; state: string; error?: string }>) || [];
          const snapState = (snap?.state as string) || (data.status as string) || (data.finalState as string) || "";

          if (rawNodes.length > 0) {
            setActiveTx((prev) => {
              if (!prev) return null;
              return {
                ...prev,
                status: snapState || prev.status,
                nodes: rawNodes.map((n) => ({
                  id: n.id,
                  fileflowLabel: getFileFlowLabel(n.id, n.label || n.id),
                  state: n.state as NodeState["state"],
                  error: n.error || null,
                })),
                isAwaitingApproval: snapState === "AWAITING_COMPENSATION_APPROVAL",
                compensationDone: snapState === "COMPENSATED",
              };
            });
          }

          if (snapState === "AWAITING_COMPENSATION_APPROVAL") {
            pushActivity(
              "DECIDED",
              "MCPx reported downstream failure during workspace provisioning. Saga rollback is awaiting operator authorization."
            );
          } else if (snapState === "COMPENSATED") {
            pushActivity(
              "VERIFIED",
              "Saga reverse compensation completed cleanly. All provisioned reference resources verified absent."
            );
          }
        },
        (err) => {
          console.warn("SSE stream closed", err);
        }
      );

      eventSourceCleanupRef.current = cleanup;
    } catch (err: unknown) {
      console.error("Workspace provision failed", err);
      pushActivity("ERROR", "Workspace provisioning failed via @mcpxx/sdk", err instanceof Error ? err.message : String(err));
    } finally {
      setApproving(false);
    }
  }

  // Handle manual prompt submission
  async function handleManualSubmit() {
    const text = inputPrompt.trim();
    if (!text || manualLoading) return;
    setInputPrompt("");
    setManualLoading(true);

    try {
      pushActivity("OBSERVED", `Operator instruction received: "${text}"`);
      await runAgentEvaluation(text);
    } catch (err: unknown) {
      console.error("Manual evaluation failed", err);
    } finally {
      setManualLoading(false);
    }
  }

  // Handle Rollback Approval
  async function handleApproveRollback() {
    if (!activeTx) return;
    setApproving(true);
    try {
      await approveWorkspaceRollback(activeTx.workspaceId, "Operator approved compensation via Agent Console");
      pushActivity("ACTED", `Operator approved compensation rollback for transaction ${activeTx.transactionId}`);
    } catch (err: unknown) {
      console.error("Rollback approval failed", err);
    } finally {
      setApproving(false);
    }
  }

  const workerOnline = observation?.pipeline.workerOnline === true;
  const queues = observation?.pipeline.queues || { waiting: 0, active: 0, failed: 0, dlqWaiting: 0 };
  const dlqItems = observation?.dlq || [];

  return (
    <div className="min-h-[calc(100vh-64px)] w-full bg-[#0a0a0a] text-white p-6 sm:p-10 font-sans">
      <div className="max-w-6xl mx-auto flex flex-col gap-6">
        {/* Top Header / Status Section */}
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-6 border-b border-white/10">
          <div>
            <div className="inline-flex items-center gap-2 px-2.5 py-1 rounded-full bg-white/5 border border-white/10 text-xs font-medium text-zinc-400 mb-2">
              <CommandLineIcon className="w-3.5 h-3.5 text-zinc-300" />
              Autonomous Operations
            </div>
            <h1 className="text-2xl font-bold tracking-tight text-white">Operations Agent</h1>
            <p className="text-xs text-zinc-400 mt-1">
              Supervised queue telemetry, autonomous DLQ failure recovery, and governed workspace operations.
            </p>
          </div>

          <div className="flex items-center gap-3">
            <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-zinc-900 border border-zinc-800 text-xs">
              <span className="text-zinc-400">Status:</span>
              {agentStatus === "ACTIVE" && (
                <span className="inline-flex items-center gap-1.5 text-emerald-400 font-medium">
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
                  Active
                </span>
              )}
              {agentStatus === "EVALUATING" && (
                <span className="inline-flex items-center gap-1.5 text-blue-400 font-medium">
                  <ArrowPathIcon className="w-3.5 h-3.5 animate-spin" />
                  Evaluating
                </span>
              )}
              {agentStatus === "WAITING_APPROVAL" && (
                <span className="inline-flex items-center gap-1.5 text-amber-400 font-medium">
                  <ClockIcon className="w-3.5 h-3.5" />
                  Approval Required
                </span>
              )}
              {agentStatus === "BLOCKED" && (
                <span className="inline-flex items-center gap-1.5 text-rose-400 font-medium">
                  <ExclamationTriangleIcon className="w-3.5 h-3.5" />
                  Blocked
                </span>
              )}
              {agentStatus === "IDLE" && (
                <span className="inline-flex items-center gap-1.5 text-zinc-400 font-medium">
                  Idle
                </span>
              )}
            </div>

            <button
              onClick={() => runAgentEvaluation()}
              disabled={evaluating}
              className="inline-flex items-center gap-2 px-3.5 py-1.5 rounded-lg bg-white hover:bg-zinc-200 disabled:opacity-50 text-black text-xs font-semibold transition"
            >
              <ArrowPathIcon className={`w-3.5 h-3.5 ${evaluating ? "animate-spin" : ""}`} />
              Run Evaluation
            </button>
          </div>
        </div>

        {/* Goal Statement Banner */}
        <div className="px-4 py-3 rounded-lg bg-white/3 border border-white/10 flex items-start gap-3 text-xs text-zinc-300">
          <span className="text-xs font-semibold text-white uppercase tracking-wider bg-white/10 px-2 py-0.5 rounded shrink-0">
            Goal
          </span>
          <span className="leading-relaxed">
            Keep FileFlow&apos;s processing pipeline healthy and recover eligible failed jobs while requiring human approval for consequential workspace operations.
          </span>
        </div>

        {/* Main Grid */}
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
          {/* Left Column: Telemetry & Activity (5 cols) */}
          <div className="lg:col-span-5 flex flex-col gap-6">
            {/* Live Telemetry Card */}
            <div className="bg-[#111111] border border-white/10 rounded-xl p-5">
              <div className="flex items-center justify-between mb-4">
                <h2 className="text-sm font-semibold text-white flex items-center gap-2">
                  <ServerStackIcon className="w-4 h-4 text-zinc-400" />
                  Live Telemetry Observation
                </h2>
                <span className="text-[11px] text-zinc-500 font-mono">
                  {observation ? new Date(observation.timestamp).toLocaleTimeString() : "--:--:--"}
                </span>
              </div>

              {/* Grid of Real Metric Cards */}
              <div className="grid grid-cols-2 gap-3 mb-4">
                <div className="bg-black/60 border border-white/5 rounded-lg p-3">
                  <span className="text-[11px] text-zinc-400 block mb-1">Worker Heartbeat</span>
                  {workerOnline ? (
                    <div className="flex items-center gap-1.5 text-emerald-400 text-xs font-medium">
                      <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
                      Online ({observation?.pipeline.workerLastSeenSecondsAgo ?? 0}s ago)
                    </div>
                  ) : (
                    <div className="flex items-center gap-1.5 text-rose-400 text-xs font-medium">
                      <span className="w-1.5 h-1.5 rounded-full bg-rose-400" />
                      Offline (Heartbeat absent)
                    </div>
                  )}
                </div>

                <div className="bg-black/60 border border-white/5 rounded-lg p-3">
                  <span className="text-[11px] text-zinc-400 block mb-1">Queue Backlog</span>
                  <div className="text-xs font-medium text-zinc-200">
                    {queues.waiting} waiting • {queues.active} active
                  </div>
                </div>

                <div className="bg-black/60 border border-white/5 rounded-lg p-3">
                  <span className="text-[11px] text-zinc-400 block mb-1">Dead-Letter Queue</span>
                  <div className={`text-xs font-medium ${dlqItems.length > 0 ? "text-amber-400 font-semibold" : "text-zinc-300"}`}>
                    {dlqItems.length} job(s) in DLQ
                  </div>
                </div>

                <div className="bg-black/60 border border-white/5 rounded-lg p-3">
                  <span className="text-[11px] text-zinc-400 block mb-1">Active Workspaces</span>
                  <div className="text-xs font-medium text-zinc-300 truncate">
                    {observation?.workspace.latest ? observation.workspace.latest.name : "None"}
                  </div>
                </div>
              </div>

              {/* DLQ Detailed Items if present */}
              {dlqItems.length > 0 && (
                <div className="border-t border-white/5 pt-3">
                  <span className="text-[11px] text-amber-400 font-medium block mb-2">
                    Eligible DLQ Jobs for Recovery:
                  </span>
                  <div className="space-y-2">
                    {dlqItems.slice(0, 3).map((job) => (
                      <div key={job.jobId} className="bg-amber-500/5 border border-amber-500/10 rounded-md p-2 text-xs">
                        <div className="flex justify-between items-center text-zinc-200 font-medium">
                          <span className="truncate">{job.filename}</span>
                          <span className="text-[10px] text-amber-400 px-1.5 py-0.5 bg-amber-500/10 rounded">
                            DLQ #{job.jobId}
                          </span>
                        </div>
                        <p className="text-[11px] text-zinc-400 truncate mt-0.5">{job.errorMessage}</p>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>

            {/* Activity Log (Observable Sequence) */}
            <div className="bg-[#111111] border border-white/10 rounded-xl p-5 flex-1 flex flex-col">
              <h2 className="text-sm font-semibold text-white mb-3 flex items-center gap-2">
                <ClockIcon className="w-4 h-4 text-zinc-400" />
                Agent Activity Sequence
              </h2>
              <div className="space-y-2.5 overflow-y-auto max-h-80 pr-1 flex-1">
                {activityLog.length === 0 ? (
                  <p className="text-xs text-zinc-500 italic">No agent actions recorded yet.</p>
                ) : (
                  activityLog.map((act) => (
                    <div key={act.id} className="text-xs border-l-2 pl-3 py-1 border-zinc-800">
                      <div className="flex items-center gap-2 mb-0.5">
                        <span
                          className={`text-[10px] font-mono px-1.5 py-0.5 rounded uppercase ${act.type === "OBSERVED"
                              ? "bg-zinc-800 text-zinc-300"
                              : act.type === "DECIDED"
                                ? "bg-zinc-800 text-zinc-200 border border-zinc-700"
                                : act.type === "ACTED"
                                  ? "bg-emerald-500/10 text-emerald-400 border border-emerald-500/20"
                                  : act.type === "VERIFIED"
                                    ? "bg-blue-500/10 text-blue-400 border border-blue-500/20"
                                    : "bg-rose-500/10 text-rose-400"
                            }`}
                        >
                          {act.type}
                        </span>
                        <span className="text-[10px] text-zinc-500 font-mono">{act.timestamp}</span>
                      </div>
                      <p className="text-zinc-300 leading-snug">{act.summary}</p>
                      {act.detail && (
                        <p className="text-[11px] text-zinc-500 font-mono mt-0.5 truncate">{act.detail}</p>
                      )}
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>

          {/* Right Column: Decision, Proposal, Timeline, Command Bar (7 cols) */}
          <div className="lg:col-span-7 flex flex-col gap-6">
            {/* Agent Decision Card */}
            <div className="bg-[#111111] border border-white/10 rounded-xl p-5">
              <div className="flex items-center justify-between mb-3">
                <h2 className="text-sm font-semibold text-white flex items-center gap-2">
                  <CommandLineIcon className="w-4 h-4 text-zinc-400" />
                  Latest Decision & Rationale
                </h2>
                {decision && (
                  <span
                    className={`text-xs px-2.5 py-0.5 rounded-full font-medium border ${decision.status === "AUTONOMOUS_ACTION"
                        ? "bg-emerald-500/10 border-emerald-500/20 text-emerald-400"
                        : decision.status === "APPROVAL_REQUIRED"
                          ? "bg-amber-500/10 border-amber-500/20 text-amber-400"
                          : decision.status === "BLOCKED"
                            ? "bg-rose-500/10 border-rose-500/20 text-rose-400"
                            : "bg-zinc-800 border-zinc-700 text-zinc-300"
                      }`}
                  >
                    {decision.status}
                  </span>
                )}
              </div>

              <p className="text-xs text-zinc-300 leading-relaxed bg-black/50 p-3.5 rounded-lg border border-white/5 mb-3">
                {decision ? decision.reason : "Evaluating telemetry against persistent goal..."}
              </p>

              {decision?.action && decision.action.tool !== "none" && (
                <div className="flex items-center gap-2 text-xs text-zinc-400 bg-black/30 px-3 py-2 rounded-lg border border-white/5">
                  <span className="font-semibold text-zinc-300">Action:</span>
                  <code className="text-zinc-200 font-mono">{decision.action.tool}</code>
                  {decision.action.arguments && (
                    <span className="text-[11px] text-zinc-500 truncate">
                      ({Object.entries(decision.action.arguments).map(([k, v]) => `${k}=${v}`).join(", ")})
                    </span>
                  )}
                </div>
              )}
            </div>

            {/* Proposal Confirmation Card (when APPROVAL_REQUIRED) */}
            {workspaceProposal && (
              <div className="bg-[#111111] border-2 border-white/20 rounded-xl p-5 shadow-xl">
                <div className="flex items-center gap-2.5 mb-3 text-zinc-200">
                  <CubeTransparentIcon className="w-5 h-5 text-zinc-400" />
                  <h3 className="text-sm font-bold text-white">Proposal: Provision Processing Workspace</h3>
                </div>
                <p className="text-xs text-zinc-400 mb-4 leading-relaxed">
                  The agent proposes provisioning an isolated multi-service processing environment for dedicated workloads. Multi-service workspace operations across independent WebMCP reference services are consequential and require explicit operator authorization.
                </p>

                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-4">
                  <div className="bg-black/60 p-2.5 rounded-lg border border-white/5">
                    <span className="text-[10px] text-zinc-500 block">Workspace</span>
                    <span className="text-xs font-medium text-white">{workspaceProposal.name}</span>
                  </div>
                  <div className="bg-black/60 p-2.5 rounded-lg border border-white/5">
                    <span className="text-[10px] text-zinc-500 block">Environment</span>
                    <span className="text-xs font-medium text-white">{workspaceProposal.environment}</span>
                  </div>
                  <div className="bg-black/60 p-2.5 rounded-lg border border-white/5">
                    <span className="text-[10px] text-zinc-500 block">Region</span>
                    <span className="text-xs font-medium text-white">{workspaceProposal.region}</span>
                  </div>
                  <div className="bg-black/60 p-2.5 rounded-lg border border-white/5">
                    <span className="text-[10px] text-zinc-500 block">Concurrency</span>
                    <span className="text-xs font-medium text-white">{workspaceProposal.workerConcurrency} workers</span>
                  </div>
                </div>

                <div className="flex items-center gap-3">
                  <button
                    onClick={handleConfirmProvision}
                    disabled={approving}
                    className="flex-1 flex items-center justify-center gap-2 px-4 py-2 bg-white hover:bg-zinc-200 disabled:opacity-50 text-black text-xs font-semibold rounded-lg transition"
                  >
                    <CheckCircleIcon className="w-4 h-4" />
                    {approving ? "Initiating @mcpxx/sdk..." : "Approve & Provision via MCPx"}
                  </button>
                  <button
                    onClick={() => {
                      setWorkspaceProposal(null);
                      setAgentStatus("IDLE");
                      pushActivity("DECIDED", "Operator dismissed workspace provisioning proposal.");
                    }}
                    disabled={approving}
                    className="px-4 py-2 bg-zinc-800 hover:bg-zinc-700 disabled:opacity-50 text-zinc-300 text-xs font-medium rounded-lg transition border border-white/5"
                  >
                    Dismiss
                  </button>
                </div>
              </div>
            )}

            {/* Live MCPx Orchestration Timeline */}
            {activeTx && (
              <div className="bg-[#111111] border border-white/10 rounded-xl p-5">
                <div className="flex items-center justify-between mb-3 border-b border-white/10 pb-3">
                  <div className="flex items-center gap-2">
                    <ShieldCheckIcon className="w-5 h-5 text-zinc-400" />
                    <div>
                      <h3 className="text-sm font-bold text-white">
                        MCPx Orchestration: {activeTx.workspaceName}
                      </h3>
                      <span className="text-[11px] text-zinc-500 font-mono">
                        Tx: {activeTx.transactionId}
                      </span>
                    </div>
                  </div>
                  <a
                    href={activeTx.consoleUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center gap-1 text-xs text-zinc-400 hover:text-white font-medium transition"
                  >
                    Console <ArrowTopRightOnSquareIcon className="w-3.5 h-3.5" />
                  </a>
                </div>

                {/* DAG Nodes visualizer */}
                <div className="space-y-2 mb-4">
                  {activeTx.nodes.length === 0 ? (
                    <p className="text-xs text-zinc-500 italic">Initializing WebMCP workflow nodes...</p>
                  ) : (
                    activeTx.nodes.map((node) => (
                      <div
                        key={node.id}
                        className="flex items-center justify-between p-2.5 rounded-lg bg-black/60 border border-white/5 text-xs"
                      >
                        <div className="flex items-center gap-2">
                          <span className="font-medium text-zinc-200">{node.fileflowLabel}</span>
                          <span className="text-[10px] text-zinc-500 font-mono">({node.id})</span>
                        </div>
                        <span
                          className={`text-[11px] font-medium px-2 py-0.5 rounded border ${node.state === "SUCCEEDED"
                              ? "bg-emerald-500/10 text-emerald-400 border-emerald-500/20"
                              : node.state === "RECOVERED"
                                ? "bg-teal-500/10 text-teal-400 border-teal-500/20"
                                : node.state === "IN_DOUBT"
                                  ? "bg-amber-500/10 text-amber-400 border-amber-500/20 animate-pulse"
                                  : node.state === "FAILED"
                                    ? "bg-rose-500/10 text-rose-400 border-rose-500/20"
                                    : node.state === "COMPENSATED"
                                      ? "bg-purple-500/10 text-purple-400 border-purple-500/20"
                                      : "bg-zinc-800 text-zinc-400 border-zinc-700"
                            }`}
                        >
                          {node.state}
                        </span>
                      </div>
                    ))
                  )}
                </div>

                {/* Compensation Approval Banner if Awaiting Approval */}
                {activeTx.isAwaitingApproval && !activeTx.compensationDone && (
                  <div className="bg-amber-500/10 border border-amber-500/20 rounded-lg p-3.5 mt-3">
                    <div className="flex items-center gap-2 text-amber-400 text-xs font-semibold mb-1">
                      <ExclamationTriangleIcon className="w-4 h-4" />
                      Human Authorization Required for Saga Rollback
                    </div>
                    <p className="text-xs text-zinc-300 mb-3 leading-relaxed">
                      Downstream frontend deployment failed. To prevent orphaned state, MCPx is prepared to reverse-compensate upstream resources in topological order.
                    </p>
                    <button
                      onClick={handleApproveRollback}
                      disabled={approving}
                      className="w-full flex items-center justify-center gap-2 px-3.5 py-2 bg-amber-500 hover:bg-amber-400 disabled:opacity-50 text-black text-xs font-semibold rounded-lg transition"
                    >
                      <ArrowPathIcon className={`w-3.5 h-3.5 ${approving ? "animate-spin" : ""}`} />
                      {approving ? "Executing Rollback..." : "Authorize Saga Reverse Compensation"}
                    </button>
                  </div>
                )}

                {activeTx.compensationDone && (
                  <div className="bg-purple-500/10 border border-purple-500/20 rounded-lg p-3 mt-3 text-xs text-purple-400 flex items-center gap-2">
                    <CheckCircleIcon className="w-4 h-4 text-purple-400" />
                    Saga rollback verified. Resources created by this transaction were verified absent after compensation.
                  </div>
                )}
              </div>
            )}

            {/* Manual Operator Instruction Bar */}
            <div className="bg-[#111111] border border-white/10 rounded-xl p-3 flex items-center gap-2">
              <input
                type="text"
                value={inputPrompt}
                onChange={(e) => setInputPrompt(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") handleManualSubmit();
                }}
                placeholder='Direct operator command (e.g., "Provision a production workspace called invoices-prod with 4 workers")'
                className="flex-1 bg-black border border-white/10 rounded-lg px-3.5 py-2 text-xs text-white placeholder-zinc-500 focus:outline-none focus:border-white/30 transition"
              />
              <button
                onClick={handleManualSubmit}
                disabled={manualLoading || !inputPrompt.trim()}
                className="px-3.5 py-2 bg-white hover:bg-zinc-200 disabled:opacity-30 text-black rounded-lg text-xs font-semibold flex items-center gap-1.5 transition"
              >
                <PaperAirplaneIcon className="w-3.5 h-3.5" />
                Send
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
