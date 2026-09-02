"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import {
  SparklesIcon,
  ServerStackIcon,
  CheckCircleIcon,
  XCircleIcon,
  ArrowPathIcon,
  ExclamationTriangleIcon,
  ArrowTopRightOnSquareIcon,
  ShieldCheckIcon,
  CubeTransparentIcon,
  PaperAirplaneIcon,
  BoltIcon,
  ClockIcon,
  DocumentDuplicateIcon,
} from "@heroicons/react/24/outline";
import {
  getAgentObserve,
  evaluateAgent,
  sendAgentChat,
  provisionWorkspace,
  approveWorkspaceRollback,
  rejectWorkspaceRollback,
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
  const [runnerOffline, setRunnerOffline] = useState(false);
  const [runnerWaiting, setRunnerWaiting] = useState(false);

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
          if (data.type === "init") {
            const rawNodes = (data.nodes as Array<{ id: string; label?: string; state: string; error?: string }>) || [];
            setActiveTx((prev) => {
              if (!prev) return null;
              return {
                ...prev,
                status: (data.status as string) || prev.status,
                nodes: rawNodes.map((n) => ({
                  id: n.id,
                  fileflowLabel: getFileFlowLabel(n.id, n.label || n.id),
                  state: n.state as NodeState["state"],
                  error: n.error || null,
                })),
              };
            });
          } else if (data.type === "node_update") {
            const node = data.node as { id: string; label?: string; state: string; error?: string };
            if (!node) return;
            setActiveTx((prev) => {
              if (!prev) return null;
              const exists = prev.nodes.some((n) => n.id === node.id);
              const updatedNodes: NodeState[] = exists
                ? prev.nodes.map((n) =>
                    n.id === node.id
                      ? { ...n, state: node.state as NodeState["state"], error: node.error || null }
                      : n
                  )
                : [
                    ...prev.nodes,
                    {
                      id: node.id,
                      fileflowLabel: getFileFlowLabel(node.id, node.label || node.id),
                      state: node.state as NodeState["state"],
                      error: node.error || null,
                    },
                  ];

              return {
                ...prev,
                status: (data.overallState as string) || prev.status,
                nodes: updatedNodes,
              };
            });
          } else if (data.type === "awaiting_approval") {
            setActiveTx((prev) => (prev ? { ...prev, isAwaitingApproval: true } : null));
            pushActivity(
              "DECIDED",
              "MCPx reported downstream failure during workspace provisioning. Saga rollback is awaiting operator authorization."
            );
          } else if (data.type === "compensated") {
            setActiveTx((prev) =>
              prev ? { ...prev, isAwaitingApproval: false, compensationDone: true, status: "COMPENSATED" } : null
            );
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
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col font-sans">
      {/* Top Header / Agent Goal Banner */}
      <header className="border-b border-slate-800 bg-slate-900/80 backdrop-blur-md px-6 py-4 sticky top-0 z-30">
        <div className="max-w-7xl mx-auto flex flex-col md:flex-row md:items-center md:justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-gradient-to-tr from-indigo-600 via-purple-600 to-cyan-400 p-0.5 shadow-lg shadow-indigo-500/20">
              <div className="w-full h-full bg-slate-950 rounded-[10px] flex items-center justify-center">
                <SparklesIcon className="w-5 h-5 text-indigo-400" />
              </div>
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h1 className="text-lg font-bold text-white tracking-tight">FileFlow AI Operations Agent</h1>
                <span className="text-xs px-2 py-0.5 rounded-full border bg-indigo-950/60 border-indigo-700/50 text-indigo-300 font-mono">
                  Supervised Autonomy
                </span>
              </div>
              <p className="text-xs text-slate-400">
                Continuous Telemetry • Autonomous DLQ Recovery • Governed MCPx Workspaces
              </p>
            </div>
          </div>

          {/* Goal & Status Pill */}
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-slate-900 border border-slate-800 text-xs">
              <span className="text-slate-400">Status:</span>
              {agentStatus === "ACTIVE" && (
                <span className="flex items-center gap-1.5 text-emerald-400 font-semibold">
                  <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
                  ACTIVE
                </span>
              )}
              {agentStatus === "EVALUATING" && (
                <span className="flex items-center gap-1.5 text-cyan-400 font-semibold">
                  <ArrowPathIcon className="w-3.5 h-3.5 animate-spin" />
                  EVALUATING
                </span>
              )}
              {agentStatus === "WAITING_APPROVAL" && (
                <span className="flex items-center gap-1.5 text-amber-400 font-semibold">
                  <ClockIcon className="w-3.5 h-3.5" />
                  APPROVAL REQUIRED
                </span>
              )}
              {agentStatus === "BLOCKED" && (
                <span className="flex items-center gap-1.5 text-rose-400 font-semibold">
                  <ExclamationTriangleIcon className="w-3.5 h-3.5" />
                  BLOCKED
                </span>
              )}
              {agentStatus === "IDLE" && (
                <span className="flex items-center gap-1.5 text-slate-400 font-semibold">
                  IDLE
                </span>
              )}
            </div>

            <button
              onClick={() => runAgentEvaluation()}
              disabled={evaluating}
              className="flex items-center gap-2 px-3.5 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white text-xs font-semibold shadow-md shadow-indigo-600/20 transition"
            >
              <ArrowPathIcon className={`w-3.5 h-3.5 ${evaluating ? "animate-spin" : ""}`} />
              Run Evaluation
            </button>
          </div>
        </div>

        {/* Persistent Goal Statement Banner */}
        <div className="max-w-7xl mx-auto mt-3 px-3 py-2 rounded-lg bg-indigo-950/40 border border-indigo-900/60 flex items-center gap-2 text-xs text-indigo-200">
          <BoltIcon className="w-4 h-4 text-indigo-400 shrink-0" />
          <span className="font-semibold text-indigo-300">Agent Goal:</span>
          <span>
            Keep FileFlow&apos;s processing pipeline healthy and recover eligible failed jobs while requiring human approval for consequential workspace operations.
          </span>
        </div>
      </header>

      {/* Main Agent Console Grid */}
      <main className="max-w-7xl mx-auto w-full p-6 grid grid-cols-1 lg:grid-cols-12 gap-6 flex-1">
        {/* Left Column: Live Observation & Activity Log (5 cols) */}
        <div className="lg:col-span-5 flex flex-col gap-6">
          {/* Live Telemetry Card */}
          <div className="bg-slate-900 border border-slate-800 rounded-xl p-5 shadow-sm">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-sm font-semibold text-white flex items-center gap-2">
                <ServerStackIcon className="w-4 h-4 text-indigo-400" />
                Live Telemetry Observation
              </h2>
              <span className="text-[11px] text-slate-400 font-mono">
                {observation ? new Date(observation.timestamp).toLocaleTimeString() : "--:--:--"}
              </span>
            </div>

            {/* Grid of Real Metric Cards */}
            <div className="grid grid-cols-2 gap-3 mb-4">
              <div className="bg-slate-950/60 border border-slate-800/80 rounded-lg p-3">
                <span className="text-[11px] text-slate-400 block mb-1">Worker Heartbeat</span>
                {workerOnline ? (
                  <div className="flex items-center gap-1.5 text-emerald-400 text-xs font-semibold">
                    <span className="w-2 h-2 rounded-full bg-emerald-400" />
                    Online ({observation?.pipeline.workerLastSeenSecondsAgo ?? 0}s ago)
                  </div>
                ) : (
                  <div className="flex items-center gap-1.5 text-rose-400 text-xs font-semibold">
                    <span className="w-2 h-2 rounded-full bg-rose-400" />
                    Offline (Heartbeat absent)
                  </div>
                )}
              </div>

              <div className="bg-slate-950/60 border border-slate-800/80 rounded-lg p-3">
                <span className="text-[11px] text-slate-400 block mb-1">Queue Backlog</span>
                <div className="text-xs font-semibold text-slate-200">
                  {queues.waiting} waiting • {queues.active} active
                </div>
              </div>

              <div className="bg-slate-950/60 border border-slate-800/80 rounded-lg p-3">
                <span className="text-[11px] text-slate-400 block mb-1">Dead-Letter Queue (DLQ)</span>
                <div className={`text-xs font-semibold ${dlqItems.length > 0 ? "text-amber-400 font-bold" : "text-slate-300"}`}>
                  {dlqItems.length} job(s) in DLQ
                </div>
              </div>

              <div className="bg-slate-950/60 border border-slate-800/80 rounded-lg p-3">
                <span className="text-[11px] text-slate-400 block mb-1">Active Workspaces</span>
                <div className="text-xs font-semibold text-slate-300 truncate">
                  {observation?.workspace.latest ? observation.workspace.latest.name : "None"}
                </div>
              </div>
            </div>

            {/* DLQ Detailed Items if present */}
            {dlqItems.length > 0 && (
              <div className="border-t border-slate-800/80 pt-3">
                <span className="text-[11px] text-amber-400 font-semibold block mb-2">
                  Eligible DLQ Jobs for Recovery:
                </span>
                <div className="space-y-2">
                  {dlqItems.slice(0, 3).map((job) => (
                    <div key={job.jobId} className="bg-amber-950/20 border border-amber-900/40 rounded-md p-2 text-xs">
                      <div className="flex justify-between items-center text-slate-200 font-medium">
                        <span className="truncate">{job.filename}</span>
                        <span className="text-[10px] text-amber-400 px-1.5 py-0.5 bg-amber-900/40 rounded">
                          DLQ #{job.jobId}
                        </span>
                      </div>
                      <p className="text-[11px] text-slate-400 truncate mt-0.5">{job.errorMessage}</p>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* Activity Log (Observable Sequence) */}
          <div className="bg-slate-900 border border-slate-800 rounded-xl p-5 shadow-sm flex-1 flex flex-col">
            <h2 className="text-sm font-semibold text-white mb-3 flex items-center gap-2">
              <ClockIcon className="w-4 h-4 text-indigo-400" />
              Agent Activity Sequence
            </h2>
            <div className="space-y-2.5 overflow-y-auto max-h-[320px] pr-1 flex-1">
              {activityLog.length === 0 ? (
                <p className="text-xs text-slate-400 italic">No agent actions recorded yet.</p>
              ) : (
                activityLog.map((act) => (
                  <div key={act.id} className="text-xs border-l-2 pl-3 py-1 border-slate-700">
                    <div className="flex items-center gap-2 mb-0.5">
                      <span
                        className={`text-[10px] font-mono px-1.5 py-0.2 rounded uppercase ${
                          act.type === "OBSERVED"
                            ? "bg-slate-800 text-slate-300"
                            : act.type === "DECIDED"
                            ? "bg-indigo-950 text-indigo-300 border border-indigo-800/40"
                            : act.type === "ACTED"
                            ? "bg-emerald-950 text-emerald-300 border border-emerald-800/40"
                            : act.type === "VERIFIED"
                            ? "bg-cyan-950 text-cyan-300 border border-cyan-800/40"
                            : "bg-rose-950 text-rose-300"
                        }`}
                      >
                        {act.type}
                      </span>
                      <span className="text-[10px] text-slate-400">{act.timestamp}</span>
                    </div>
                    <p className="text-slate-200 leading-snug">{act.summary}</p>
                    {act.detail && (
                      <p className="text-[11px] text-slate-400 font-mono mt-0.5 truncate">{act.detail}</p>
                    )}
                  </div>
                ))
              )}
            </div>
          </div>
        </div>

        {/* Right Column: Agent Decision, Proposal Card, & Live Orchestration (7 cols) */}
        <div className="lg:col-span-7 flex flex-col gap-6">
          {/* Agent Decision Card */}
          <div className="bg-slate-900 border border-slate-800 rounded-xl p-5 shadow-sm">
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-sm font-semibold text-white flex items-center gap-2">
                <SparklesIcon className="w-4 h-4 text-indigo-400" />
                Latest Decision & Rationale
              </h2>
              {decision && (
                <span
                  className={`text-xs px-2.5 py-0.5 rounded-full font-semibold border ${
                    decision.status === "AUTONOMOUS_ACTION"
                      ? "bg-emerald-950/60 border-emerald-700/50 text-emerald-300"
                      : decision.status === "APPROVAL_REQUIRED"
                      ? "bg-amber-950/60 border-amber-700/50 text-amber-300"
                      : decision.status === "BLOCKED"
                      ? "bg-rose-950/60 border-rose-700/50 text-rose-300"
                      : "bg-slate-800 border-slate-700 text-slate-300"
                  }`}
                >
                  {decision.status}
                </span>
              )}
            </div>

            <p className="text-xs text-slate-300 leading-relaxed bg-slate-950/60 p-3.5 rounded-lg border border-slate-800/80 mb-3">
              {decision ? decision.reason : "Evaluating telemetry against persistent goal..."}
            </p>

            {decision?.action && decision.action.tool !== "none" && (
              <div className="flex items-center gap-2 text-xs text-slate-400 bg-slate-950/40 px-3 py-2 rounded-lg border border-slate-800/60">
                <span className="font-semibold text-slate-300">Action:</span>
                <code className="text-indigo-300 font-mono">{decision.action.tool}</code>
                {decision.action.arguments && (
                  <span className="text-[11px] text-slate-400 truncate">
                    ({Object.entries(decision.action.arguments).map(([k, v]) => `${k}=${v}`).join(", ")})
                  </span>
                )}
              </div>
            )}
          </div>

          {/* Proposal Confirmation Card (when APPROVAL_REQUIRED) */}
          {workspaceProposal && (
            <div className="bg-gradient-to-b from-indigo-950/60 to-slate-900 border-2 border-indigo-600/50 rounded-xl p-5 shadow-xl shadow-indigo-950/50 animate-in fade-in zoom-in-95 duration-200">
              <div className="flex items-center gap-2.5 mb-3 text-indigo-300">
                <CubeTransparentIcon className="w-5 h-5 text-indigo-400" />
                <h3 className="text-sm font-bold text-white">Proposal: Provision Processing Workspace</h3>
              </div>
              <p className="text-xs text-slate-300 mb-4 leading-relaxed">
                The agent proposes provisioning an isolated multi-service processing environment for dedicated workloads. Multi-service workspace operations across independent WebMCP reference services are consequential and require explicit operator authorization.
              </p>

              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-4">
                <div className="bg-slate-950/80 p-2.5 rounded-lg border border-slate-800">
                  <span className="text-[10px] text-slate-400 block">Workspace</span>
                  <span className="text-xs font-semibold text-white">{workspaceProposal.name}</span>
                </div>
                <div className="bg-slate-950/80 p-2.5 rounded-lg border border-slate-800">
                  <span className="text-[10px] text-slate-400 block">Environment</span>
                  <span className="text-xs font-semibold text-white">{workspaceProposal.environment}</span>
                </div>
                <div className="bg-slate-950/80 p-2.5 rounded-lg border border-slate-800">
                  <span className="text-[10px] text-slate-400 block">Region</span>
                  <span className="text-xs font-semibold text-white">{workspaceProposal.region}</span>
                </div>
                <div className="bg-slate-950/80 p-2.5 rounded-lg border border-slate-800">
                  <span className="text-[10px] text-slate-400 block">Concurrency</span>
                  <span className="text-xs font-semibold text-white">{workspaceProposal.workerConcurrency} workers</span>
                </div>
              </div>

              <div className="flex items-center gap-3">
                <button
                  onClick={handleConfirmProvision}
                  disabled={approving}
                  className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white text-xs font-bold rounded-lg shadow-lg shadow-indigo-600/30 transition"
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
                  className="px-4 py-2.5 bg-slate-800 hover:bg-slate-700 disabled:opacity-50 text-slate-300 text-xs font-semibold rounded-lg transition"
                >
                  Dismiss
                </button>
              </div>
            </div>
          )}

          {/* Live MCPx Orchestration Timeline */}
          {activeTx && (
            <div className="bg-slate-900 border border-slate-800 rounded-xl p-5 shadow-sm">
              <div className="flex items-center justify-between mb-3 border-b border-slate-800 pb-3">
                <div className="flex items-center gap-2">
                  <ShieldCheckIcon className="w-5 h-5 text-indigo-400" />
                  <div>
                    <h3 className="text-sm font-bold text-white">
                      MCPx Orchestration: {activeTx.workspaceName}
                    </h3>
                    <span className="text-[11px] text-slate-400 font-mono">
                      Tx: {activeTx.transactionId}
                    </span>
                  </div>
                </div>
                <a
                  href={activeTx.consoleUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-1 text-xs text-indigo-400 hover:text-indigo-300 font-medium transition"
                >
                  Console <ArrowTopRightOnSquareIcon className="w-3.5 h-3.5" />
                </a>
              </div>

              {/* DAG Nodes visualizer */}
              <div className="space-y-2 mb-4">
                {activeTx.nodes.length === 0 ? (
                  <p className="text-xs text-slate-400 italic">Initializing WebMCP workflow nodes...</p>
                ) : (
                  activeTx.nodes.map((node) => (
                    <div
                      key={node.id}
                      className="flex items-center justify-between p-2.5 rounded-lg bg-slate-950/60 border border-slate-800/80 text-xs"
                    >
                      <div className="flex items-center gap-2">
                        <span className="font-semibold text-slate-200">{node.fileflowLabel}</span>
                        <span className="text-[10px] text-slate-400 font-mono">({node.id})</span>
                      </div>
                      <span
                        className={`text-[11px] font-semibold px-2 py-0.5 rounded ${
                          node.state === "SUCCEEDED"
                            ? "bg-emerald-950 text-emerald-300 border border-emerald-800/50"
                            : node.state === "RECOVERED"
                            ? "bg-teal-950 text-teal-300 border border-teal-800/50"
                            : node.state === "IN_DOUBT"
                            ? "bg-amber-950 text-amber-300 border border-amber-800/50 animate-pulse"
                            : node.state === "FAILED"
                            ? "bg-rose-950 text-rose-300 border border-rose-800/50"
                            : node.state === "COMPENSATED"
                            ? "bg-purple-950 text-purple-300 border border-purple-800/50"
                            : "bg-slate-800 text-slate-400"
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
                <div className="bg-amber-950/40 border border-amber-800/60 rounded-lg p-3.5 mt-3">
                  <div className="flex items-center gap-2 text-amber-400 text-xs font-bold mb-1">
                    <ExclamationTriangleIcon className="w-4 h-4" />
                    Human Authorization Required for Saga Rollback
                  </div>
                  <p className="text-xs text-slate-300 mb-3">
                    Downstream frontend deployment failed. To prevent orphaned state, MCPx is prepared to reverse-compensate upstream resources in topological order.
                  </p>
                  <button
                    onClick={handleApproveRollback}
                    disabled={approving}
                    className="w-full flex items-center justify-center gap-2 px-3.5 py-2 bg-amber-600 hover:bg-amber-500 disabled:opacity-50 text-white text-xs font-bold rounded-lg transition shadow-md shadow-amber-950/50"
                  >
                    <ArrowPathIcon className={`w-3.5 h-3.5 ${approving ? "animate-spin" : ""}`} />
                    {approving ? "Executing Rollback..." : "Authorize Saga Reverse Compensation"}
                  </button>
                </div>
              )}

              {activeTx.compensationDone && (
                <div className="bg-purple-950/40 border border-purple-800/60 rounded-lg p-3 mt-3 text-xs text-purple-300 flex items-center gap-2">
                  <CheckCircleIcon className="w-4 h-4 text-purple-400" />
                  Saga rollback verified. Resources created by this transaction were verified absent after compensation.
                </div>
              )}
            </div>
          )}

          {/* Manual Operator Instruction Bar */}
          <div className="bg-slate-900 border border-slate-800 rounded-xl p-3 shadow-sm flex items-center gap-2">
            <input
              type="text"
              value={inputPrompt}
              onChange={(e) => setInputPrompt(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") handleManualSubmit();
              }}
              placeholder='Direct operator command (e.g., "Provision a production workspace called invoices-prod with 4 workers")'
              className="flex-1 bg-slate-950 border border-slate-800 rounded-lg px-3.5 py-2 text-xs text-white placeholder-slate-400 focus:outline-none focus:border-indigo-500 transition"
            />
            <button
              onClick={handleManualSubmit}
              disabled={manualLoading || !inputPrompt.trim()}
              className="px-3.5 py-2 bg-slate-800 hover:bg-slate-700 disabled:opacity-40 text-white rounded-lg text-xs font-semibold flex items-center gap-1.5 transition"
            >
              <PaperAirplaneIcon className="w-3.5 h-3.5" />
              Send
            </button>
          </div>
        </div>
      </main>
    </div>
  );
}
