"use client";

import { useState, useEffect, useRef } from "react";
import {
  PaperAirplaneIcon,
  SparklesIcon,
  ServerStackIcon,
  CheckCircleIcon,
  XCircleIcon,
  ArrowPathIcon,
  ExclamationTriangleIcon,
  ArrowTopRightOnSquareIcon,
  ShieldCheckIcon,
  CubeTransparentIcon
} from "@heroicons/react/24/outline";
import {
  sendAgentChat,
  provisionWorkspace,
  approveWorkspaceRollback,
  rejectWorkspaceRollback,
  subscribeWorkspaceEvents
} from "@/lib/api";

interface StatusDetails {
  found?: boolean;
  message?: string;
  workspace?: {
    id: string;
    name: string;
    environment: string;
    region: string;
    worker_concurrency: number;
    transaction_id: string | null;
    status: string;
    console_url: string | null;
  };
  mcpxStatus?: string;
  nodes?: Array<{ id: string; label?: string; state: string }>;
  consoleUrl?: string | null;
}

interface Message {
  id: string;
  role: "user" | "assistant";
  content: string;
  timestamp: string;
  toolProposal?: {
    name: string;
    arguments: {
      name?: string;
      environment?: string;
      region?: string;
      workerConcurrency?: number;
      workspaceName?: string;
      transactionId?: string;
    };
  } | null;
  statusDetails?: StatusDetails | null;
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
  const [messages, setMessages] = useState<Message[]>([
    {
      id: "welcome",
      role: "assistant",
      content: "FileFlow AI Operations Agent ready.\n\nI can provision isolated processing workspaces with crash-resilient multi-step workflows and inspect live pipelines through MCPx.",
      timestamp: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
    },
  ]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [activeTx, setActiveTx] = useState<ActiveTransaction | null>(null);
  const [approving, setApproving] = useState(false);
  const [runnerOffline, setRunnerOffline] = useState(false);
  const [agentProvider, setAgentProvider] = useState<string>("Gemini");

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const eventSourceCleanupRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, activeTx]);

  useEffect(() => {
    return () => {
      if (eventSourceCleanupRef.current) {
        eventSourceCleanupRef.current();
      }
    };
  }, []);

  // Standard FileFlow domain label dictionary
  function getFileFlowLabel(nodeKey: string, fallback: string = "") {
    const key = (nodeKey || "").toLowerCase();
    if (key.includes("database") || key === "db") return "Workspace Database";
    if (key.includes("compute")) return "Processing Runtime";
    if (key.includes("routing")) return "Public Endpoint";
    if (key.includes("frontend")) return "Workspace Console";
    return fallback || nodeKey;
  }

  // Handle User Message Submission
  async function handleSend(textToSend?: string) {
    const text = (textToSend || input).trim();
    if (!text || loading) return;

    setInput("");
    const userMsg: Message = {
      id: `usr_${Date.now()}`,
      role: "user",
      content: text,
      timestamp: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
    };

    setMessages((prev) => [...prev, userMsg]);
    setLoading(true);

    try {
      const history = messages
        .filter((m) => m.id !== "welcome")
        .map((m) => ({ role: m.role, content: m.content }));

      const res = await sendAgentChat(text, history);

      const data = res as {
        reply?: string;
        toolCall?: Message["toolProposal"];
        toolExecutionResult?: StatusDetails;
        provider?: string;
      };

      if (data.provider) {
        setAgentProvider(data.provider === "gemini" ? "Gemini" : data.provider === "openai" ? "OpenAI" : "Local Adapter");
      }

      const agentMsg: Message = {
        id: `agent_${Date.now()}`,
        role: "assistant",
        content: data.reply || "Operation processed.",
        timestamp: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
        toolProposal: data.toolCall || null,
        statusDetails: data.toolExecutionResult || null,
      };

      setMessages((prev) => [...prev, agentMsg]);

      // If status tool returned workspace details and it has active transaction
      if (data.toolExecutionResult?.workspace?.transaction_id) {
        const ws = data.toolExecutionResult.workspace;
        if (ws.transaction_id) {
          startLiveTracking(ws.id, ws.name, ws.transaction_id, ws.console_url || "");
        }
      }
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : (err as { message?: string })?.message || "Unknown error";
      setMessages((prev) => [
        ...prev,
        {
          id: `err_${Date.now()}`,
          role: "assistant",
          content: `⚠️ Failed to execute agent request: ${errMsg}`,
          timestamp: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
        },
      ]);
    } finally {
      setLoading(false);
    }
  }

  // Handle User Confirming Provisioning from Action Plan Card
  async function handleConfirmProvision(proposal: Message["toolProposal"]) {
    if (!proposal || !proposal.arguments.name) return;

    const { name, environment, region, workerConcurrency } = proposal.arguments;
    setLoading(true);

    setMessages((prev) => [
      ...prev,
      {
        id: `confirm_${Date.now()}`,
        role: "user",
        content: `Confirmed: Provision workspace "${name}".`,
        timestamp: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
      },
      {
        id: `starting_${Date.now()}`,
        role: "assistant",
        content: `Dispatching canonical multi-step challenge workflow for **${name}** via @mcpxx/sdk...`,
        timestamp: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
      },
    ]);

    try {
      const res = await provisionWorkspace({
        name,
        environment: environment || "Production",
        region: region || "Europe West",
        workerConcurrency: Number(workerConcurrency) || 4,
      });

      const { workspace, transactionId, consoleUrl } = res as {
        workspace: { id: string };
        transactionId: string;
        consoleUrl: string;
      };
      startLiveTracking(workspace.id, name, transactionId, consoleUrl);
    } catch (err: unknown) {
      const errObj = err as { details?: string; message?: string };
      setMessages((prev) => [
        ...prev,
        {
          id: `fail_${Date.now()}`,
          role: "assistant",
          content: `❌ Provisioning initiation failed: ${errObj?.details || errObj?.message || "MCPx Coordinator unreachable"}`,
          timestamp: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
        },
      ]);
    } finally {
      setLoading(false);
    }
  }

  // Subscribe to live SSE events for active MCPx transaction
  function startLiveTracking(workspaceId: string, workspaceName: string, transactionId: string, consoleUrl: string) {
    if (eventSourceCleanupRef.current) {
      eventSourceCleanupRef.current();
    }

    const initialNodes: NodeState[] = [
      { id: "database", fileflowLabel: "Workspace Database", state: "WAITING" },
      { id: "compute", fileflowLabel: "Processing Runtime", state: "WAITING" },
      { id: "routing", fileflowLabel: "Public Endpoint", state: "WAITING" },
      { id: "frontend", fileflowLabel: "Workspace Console", state: "WAITING" },
    ];

    setActiveTx({
      workspaceId,
      workspaceName,
      transactionId,
      consoleUrl: consoleUrl || `http://localhost:3000/app/transactions/${transactionId}`,
      status: "RUNNING",
      nodes: initialNodes,
      isAwaitingApproval: false,
      compensationDone: false,
    });

    const cleanup = subscribeWorkspaceEvents(
      workspaceId,
      (data: Record<string, unknown>) => {
        if (data.error) {
          const errStr = String(data.error);
          if (errStr.includes("runner") || errStr.includes("offline")) {
            setRunnerOffline(true);
          }
          return;
        }

        const snapshot = data.snapshot as {
          state?: string;
          nodes?: Array<{ id?: string; nodeId?: string; label?: string; state?: string; error?: string }>;
        } | undefined;

        if (!snapshot) return;

        const rawNodes = snapshot.nodes || [];
        const mappedNodes: NodeState[] = rawNodes.map((n) => ({
          id: n.id || n.nodeId || "node",
          nodeId: n.nodeId || n.id,
          label: n.label,
          fileflowLabel: getFileFlowLabel(n.nodeId || n.id || "", n.label),
          state: (n.state || "PENDING").toUpperCase() as NodeState["state"],
          error: n.error || null,
        }));

        const isApprovalRequired = snapshot.state === "AWAITING_COMPENSATION_APPROVAL";
        const isCompensated = snapshot.state === "COMPENSATED";

        setActiveTx({
          workspaceId,
          workspaceName,
          transactionId,
          consoleUrl: consoleUrl || `http://localhost:3000/app/transactions/${transactionId}`,
          status: snapshot.state || "RUNNING",
          nodes: mappedNodes.length > 0 ? mappedNodes : initialNodes,
          isAwaitingApproval: isApprovalRequired,
          compensationDone: isCompensated,
        });
      },
      (err) => {
        console.warn("Workspace SSE stream interrupted:", err);
      }
    );

    eventSourceCleanupRef.current = cleanup;
  }

  // Handle Rollback Approval
  async function handleApproveRollback() {
    if (!activeTx) return;
    setApproving(true);

    try {
      await approveWorkspaceRollback(activeTx.workspaceId);
      setMessages((prev) => [
        ...prev,
        {
          id: `approve_${Date.now()}`,
          role: "user",
          content: "Approved rollback compensation.",
          timestamp: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
        },
        {
          id: `rolling_${Date.now()}`,
          role: "assistant",
          content: "Rollback approved. MCPx is removing provisioned resources in reverse dependency order...",
          timestamp: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
        },
      ]);
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : (err as { message?: string })?.message || "Unknown error";
      setMessages((prev) => [
        ...prev,
        {
          id: `err_${Date.now()}`,
          role: "assistant",
          content: `Failed to approve rollback: ${errMsg}`,
          timestamp: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
        },
      ]);
    } finally {
      setApproving(false);
    }
  }

  // Handle Rollback Rejection
  async function handleRejectRollback() {
    if (!activeTx) return;
    setApproving(true);
    try {
      await rejectWorkspaceRollback(activeTx.workspaceId);
      setMessages((prev) => [
        ...prev,
        {
          id: `reject_${Date.now()}`,
          role: "user",
          content: "Kept provisioned resources (rejected rollback).",
          timestamp: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
        },
      ]);
    } catch (err: unknown) {
      console.error(err);
    } finally {
      setApproving(false);
    }
  }

  return (
    <div className="min-h-[calc(100vh-64px)] w-full bg-[#0a0a0a] text-white flex flex-col font-sans selection:bg-indigo-500/30">

      {/* Top Header Bar */}
      <div className="border-b border-white/8 bg-[#0d0d0d] px-6 py-4 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-lg bg-indigo-500/10 border border-indigo-500/20 flex items-center justify-center text-indigo-400 shadow-sm">
            <SparklesIcon className="w-4 h-4" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-base font-semibold text-white tracking-tight">FileFlow Operator</h1>
              <span className="text-[10px] px-2 py-0.5 rounded bg-white/5 border border-white/10 text-gray-300 font-mono">
                Agent provider: {agentProvider}
              </span>
            </div>
            <p className="text-xs text-gray-400 mt-0.5">
              Manage FileFlow processing infrastructure with an AI operations agent.
            </p>
          </div>
        </div>

        <div className="flex items-center gap-3">
          {runnerOffline ? (
            <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-medium bg-amber-500/10 text-amber-400 border border-amber-500/20">
              <ExclamationTriangleIcon className="w-3.5 h-3.5" />
              Waiting for MCPx Browser Runner
            </span>
          ) : (
            <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-medium bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse"></span>
              MCPx Control Plane Ready
            </span>
          )}
        </div>
      </div>

      {/* Main Grid: Command Interface Left, Live Timeline Right */}
      <div className="flex-1 grid grid-cols-1 lg:grid-cols-12 max-w-7xl w-full mx-auto p-4 sm:p-6 gap-6">

        {/* Left Column: Command & Reasoning Stream */}
        <div className="lg:col-span-7 flex flex-col h-[calc(100vh-180px)] bg-[#0d0d0d] border border-white/8 rounded-2xl overflow-hidden shadow-2xl">

          {/* Messages Stream */}
          <div className="flex-1 overflow-y-auto p-5 space-y-4">
            {messages.map((m) => (
              <div
                key={m.id}
                className={`flex flex-col ${m.role === "user" ? "items-end" : "items-start"}`}
              >
                <div className="flex items-center gap-1.5 mb-1 px-1">
                  <span className="text-[11px] font-medium text-gray-400">
                    {m.role === "user" ? "You" : "Operator Agent"}
                  </span>
                  <span className="text-[10px] text-gray-600">{m.timestamp}</span>
                </div>

                <div
                  className={`max-w-[92%] rounded-2xl px-4 py-3 text-sm leading-relaxed border ${m.role === "user"
                      ? "bg-white text-black font-normal border-transparent rounded-tr-xs"
                      : "bg-white/3 text-gray-200 border-white/10 rounded-tl-xs backdrop-blur-md"
                    }`}
                >
                  <p className="whitespace-pre-wrap">{m.content}</p>

                  {/* Action Plan Card for provision_workspace */}
                  {m.toolProposal && m.toolProposal.name === "provision_workspace" && (
                    <div className="mt-4 p-4 rounded-xl bg-black/70 border border-indigo-500/30 text-white shadow-xl animate-in fade-in zoom-in-95 duration-200">
                      <div className="flex items-center gap-2 mb-3 pb-2 border-b border-white/10 text-xs font-semibold uppercase tracking-wider text-indigo-300">
                        <ServerStackIcon className="w-4 h-4 text-indigo-400" />
                        Provision Processing Workspace
                      </div>

                      <div className="grid grid-cols-2 gap-2 text-xs mb-4">
                        <div className="p-2.5 rounded-lg bg-white/5 border border-white/5">
                          <div className="text-gray-400 text-[10px] uppercase font-medium">Name</div>
                          <div className="font-semibold text-white font-mono mt-0.5">{m.toolProposal.arguments.name}</div>
                        </div>
                        <div className="p-2.5 rounded-lg bg-white/5 border border-white/5">
                          <div className="text-gray-400 text-[10px] uppercase font-medium">Environment</div>
                          <div className="font-semibold text-white mt-0.5">{m.toolProposal.arguments.environment || "Production"}</div>
                        </div>
                        <div className="p-2.5 rounded-lg bg-white/5 border border-white/5">
                          <div className="text-gray-400 text-[10px] uppercase font-medium">Workers</div>
                          <div className="font-semibold text-white mt-0.5">{m.toolProposal.arguments.workerConcurrency || 4} concurrency slots</div>
                        </div>
                        <div className="p-2.5 rounded-lg bg-white/5 border border-white/5">
                          <div className="text-gray-400 text-[10px] uppercase font-medium">Region</div>
                          <div className="font-semibold text-white mt-0.5">{m.toolProposal.arguments.region || "Europe West"}</div>
                        </div>
                      </div>

                      <div className="text-xs text-gray-300 mb-4 bg-white/3 p-2.5 rounded-lg border border-white/5">
                        <span className="text-gray-400 font-medium block mb-1.5">This operation will provision:</span>
                        <div className="grid grid-cols-2 gap-1 text-[11px] text-gray-300">
                          <div>• Workspace Database</div>
                          <div>• Processing Runtime</div>
                          <div>• Public Endpoint</div>
                          <div>• Workspace Console</div>
                        </div>
                      </div>

                      <div className="flex gap-2.5">
                        <button
                          onClick={() => handleConfirmProvision(m.toolProposal)}
                          disabled={loading}
                          className="flex-1 py-2.5 px-3 rounded-lg bg-indigo-500 text-white font-semibold text-xs hover:bg-indigo-600 transition-all shadow-md flex items-center justify-center gap-1.5"
                        >
                          <CheckCircleIcon className="w-4 h-4" />
                          Provision Workspace
                        </button>
                        <button
                          onClick={() => {
                            setMessages((prev) => [
                              ...prev,
                              {
                                id: `cancel_${Date.now()}`,
                                role: "user",
                                content: "Cancelled workspace provisioning.",
                                timestamp: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
                              },
                            ]);
                          }}
                          className="py-2.5 px-4 rounded-lg border border-white/10 bg-white/5 hover:bg-white/10 text-gray-400 hover:text-white text-xs font-medium transition-colors"
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  )}

                  {/* Status Details Card */}
                  {m.statusDetails && (
                    <div className="mt-3 p-3.5 rounded-xl bg-black/50 border border-white/10 text-xs">
                      {m.statusDetails.found && m.statusDetails.workspace ? (
                        <div>
                          <div className="flex items-center justify-between mb-2">
                            <span className="font-semibold text-white">{m.statusDetails.workspace.name}</span>
                            <span className="text-[10px] px-2 py-0.5 rounded bg-white/10 text-indigo-300 font-mono">
                              {m.statusDetails.mcpxStatus}
                            </span>
                          </div>
                          <p className="text-gray-400 text-[11px] mb-2">
                            Environment: {m.statusDetails.workspace.environment} • Region: {m.statusDetails.workspace.region}
                          </p>
                          {m.statusDetails.consoleUrl && (
                            <a
                              href={m.statusDetails.consoleUrl}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="inline-flex items-center gap-1 text-indigo-400 hover:underline text-[11px]"
                            >
                              View Transaction in MCPx →
                            </a>
                          )}
                        </div>
                      ) : (
                        <p className="text-gray-400">{m.statusDetails.message}</p>
                      )}
                    </div>
                  )}
                </div>
              </div>
            ))}

            {loading && (
              <div className="flex items-center gap-2 text-xs text-gray-400 italic py-2">
                <ArrowPathIcon className="w-3.5 h-3.5 animate-spin text-indigo-400" />
                Operator reasoning & evaluating tools...
              </div>
            )}
            <div ref={messagesEndRef} />
          </div>

          {/* Quick Command Prompt */}
          <div className="px-4 py-2.5 bg-black/40 border-t border-white/5 flex gap-2 overflow-x-auto text-[11px]">
            <button
              onClick={() => handleSend("Provision a production workspace called invoices-prod with four workers.")}
              className="whitespace-nowrap px-3 py-1.5 rounded-full border border-white/10 bg-white/5 hover:bg-white/10 text-gray-300 hover:text-white transition-colors"
            >
              + Provision a production workspace called invoices-prod with four workers.
            </button>
            <button
              onClick={() => handleSend("Check the status of invoices-prod.")}
              className="whitespace-nowrap px-3 py-1.5 rounded-full border border-white/10 bg-white/5 hover:bg-white/10 text-gray-300 hover:text-white transition-colors"
            >
              🔍 Check status of invoices-prod
            </button>
          </div>

          {/* Input Form */}
          <form
            onSubmit={(e) => {
              e.preventDefault();
              handleSend();
            }}
            className="p-3 bg-[#111] border-t border-white/8 flex items-center gap-2"
          >
            <input
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="Ask the operator to provision or inspect processing workspaces..."
              disabled={loading}
              className="flex-1 bg-white/5 border border-white/10 rounded-xl px-4 py-2.5 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-white/20 transition-all font-light"
            />
            <button
              type="submit"
              disabled={loading || !input.trim()}
              className="p-2.5 rounded-xl bg-white text-black font-semibold hover:bg-gray-200 disabled:opacity-40 disabled:hover:bg-white transition-all shadow-sm"
            >
              <PaperAirplaneIcon className="w-4 h-4" />
            </button>
          </form>
        </div>

        {/* Right Column: Live Multi-Step Execution Timeline */}
        <div className="lg:col-span-5 flex flex-col h-[calc(100vh-180px)] bg-[#0d0d0d] border border-white/8 rounded-2xl p-5 overflow-y-auto shadow-2xl">
          <div className="flex items-center justify-between pb-4 border-b border-white/8 mb-4">
            <div className="flex items-center gap-2">
              <CubeTransparentIcon className="w-4 h-4 text-indigo-400" />
              <h2 className="text-xs font-semibold uppercase tracking-wider text-gray-300">
                Live Orchestration Timeline
              </h2>
            </div>
            {activeTx && (
              <span className="font-mono text-[10px] text-gray-500 truncate max-w-35" title={activeTx.transactionId}>
                {activeTx.transactionId}
              </span>
            )}
          </div>

          {!activeTx ? (
            <div className="flex-1 flex flex-col items-center justify-center text-center p-6 text-gray-500">
              <ServerStackIcon className="w-10 h-10 mb-3 stroke-1 text-gray-600" />
              <p className="text-sm font-medium text-gray-400">No Active Provisioning Flow</p>
              <p className="text-xs text-gray-500 mt-1 max-w-xs leading-relaxed">
                Use the command prompt on the left to start workspace provisioning. Real-time multi-step state and fault reconciliation will appear here.
              </p>
            </div>
          ) : (
            <div className="space-y-4">
              {/* Workspace Header Info */}
              <div className="p-3.5 rounded-xl bg-white/2 border border-white/8">
                <div className="flex items-center justify-between mb-1">
                  <span className="text-xs text-gray-400">Workspace</span>
                  <span className="text-xs font-bold text-white font-mono">{activeTx.workspaceName}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-xs text-gray-400">Status</span>
                  <span className={`text-[11px] font-mono px-2 py-0.5 rounded font-medium ${activeTx.status === "COMPENSATED"
                      ? "bg-purple-500/10 text-purple-300 border border-purple-500/20"
                      : activeTx.status === "AWAITING_COMPENSATION_APPROVAL"
                        ? "bg-amber-500/10 text-amber-300 border border-amber-500/20 animate-pulse"
                        : activeTx.status === "FAILED"
                          ? "bg-red-500/10 text-red-300 border border-red-500/20"
                          : "bg-blue-500/10 text-blue-300 border border-blue-500/20"
                    }`}>
                    {activeTx.status === "AWAITING_COMPENSATION_APPROVAL" ? "Awaiting Rollback Approval" : activeTx.status}
                  </span>
                </div>
              </div>

              {/* Compact Vertical Sequence */}
              <div className="space-y-2.5">
                {activeTx.nodes.map((node) => {
                  const s = node.state;
                  return (
                    <div
                      key={node.id}
                      className={`p-3.5 rounded-xl border transition-all ${s === "SUCCEEDED" || s === "RECOVERED"
                          ? "bg-emerald-950/10 border-emerald-500/20"
                          : s === "FAILED"
                            ? "bg-red-950/15 border-red-500/30"
                            : s === "IN_DOUBT" || s === "RECONCILING"
                              ? "bg-amber-950/20 border-amber-500/40 shadow-[0_0_15px_rgba(245,158,11,0.1)]"
                              : s === "COMPENSATING"
                                ? "bg-purple-950/15 border-purple-500/30"
                                : s === "COMPENSATED"
                                  ? "bg-zinc-900/40 border-white/5 opacity-70"
                                  : s === "EXECUTING"
                                    ? "bg-blue-950/15 border-blue-500/30"
                                    : "bg-white/2 border-white/5"
                        }`}
                    >
                      <div className="flex items-center justify-between mb-1">
                        <div className="flex items-center gap-2">
                          {s === "SUCCEEDED" && <CheckCircleIcon className="w-4 h-4 text-emerald-400" />}
                          {s === "RECOVERED" && <CheckCircleIcon className="w-4 h-4 text-emerald-400" />}
                          {s === "FAILED" && <XCircleIcon className="w-4 h-4 text-red-400" />}
                          {(s === "IN_DOUBT" || s === "RECONCILING") && (
                            <ExclamationTriangleIcon className="w-4 h-4 text-amber-400 animate-spin" />
                          )}
                          {s === "EXECUTING" && <ArrowPathIcon className="w-4 h-4 text-blue-400 animate-spin" />}
                          {s === "COMPENSATING" && <ArrowPathIcon className="w-4 h-4 text-purple-400 animate-spin" />}
                          {s === "COMPENSATED" && <span className="text-xs text-purple-400 font-bold">✕</span>}
                          {s === "WAITING" && <span className="text-gray-600 text-xs">○</span>}

                          <span className="text-xs font-semibold text-white tracking-tight">
                            {node.fileflowLabel}
                          </span>
                        </div>

                        {/* Human-readable status with secondary technical badge */}
                        <div className="flex items-center gap-1.5 text-right">
                          <span className="text-[11px] font-medium text-gray-300">
                            {s === "WAITING" && "Waiting"}
                            {s === "EXECUTING" && "Provisioning"}
                            {s === "SUCCEEDED" && "Ready"}
                            {s === "IN_DOUBT" && "Confirmation lost"}
                            {s === "RECONCILING" && "Verifying remote state"}
                            {s === "RECOVERED" && "Verified"}
                            {s === "FAILED" && "Deployment failed"}
                            {s === "COMPENSATING" && "Removing"}
                            {s === "COMPENSATED" && "Removed"}
                          </span>
                          {s === "RECOVERED" && (
                            <span className="text-[9px] font-mono px-1 rounded bg-emerald-500/20 text-emerald-300 border border-emerald-500/30">
                              RECOVERED
                            </span>
                          )}
                          {s === "FAILED" && (
                            <span className="text-[9px] font-mono px-1 rounded bg-red-500/20 text-red-300 border border-red-500/30">
                              REJECTED
                            </span>
                          )}
                        </div>
                      </div>

                      {/* IN_DOUBT HERO MOMENT: Obvious, readable explanation */}
                      {s === "IN_DOUBT" && (
                        <div className="mt-2.5 text-[11px] text-amber-200 leading-relaxed bg-amber-500/10 p-2.5 rounded-lg border border-amber-500/30">
                          <strong>Confirmation lost:</strong> MCPx did not retry the mutation blindly. It is checking the routing provider for authoritative state.
                        </div>
                      )}

                      {s === "RECONCILING" && (
                        <div className="mt-2.5 text-[11px] text-amber-200 leading-relaxed bg-amber-500/10 p-2.5 rounded-lg border border-amber-500/30 flex items-center gap-2">
                          <ArrowPathIcon className="w-3.5 h-3.5 animate-spin" />
                          <span>Verifying remote endpoint state against authoritative provider...</span>
                        </div>
                      )}

                      {s === "RECOVERED" && (
                        <div className="mt-2 text-[11px] text-emerald-300/90 leading-relaxed bg-emerald-500/10 p-2 rounded-lg border border-emerald-500/20">
                          The route already existed remotely. MCPx recovered the operation without issuing another create request.
                        </div>
                      )}

                      {s === "FAILED" && (
                        <div className="mt-2 text-[11px] text-red-300/90 leading-relaxed bg-red-500/10 p-2 rounded-lg border border-red-500/20">
                          Deployment rejected before commit. Some upstream infrastructure was already created.
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>

              {/* Failure + Approval Gate */}
              {activeTx.isAwaitingApproval && (
                <div className="p-4 rounded-xl bg-amber-950/25 border border-amber-500/40 text-white shadow-2xl animate-in zoom-in-95 duration-200">
                  <div className="flex items-center gap-2 text-amber-400 text-xs font-bold uppercase tracking-wider mb-2">
                    <ShieldCheckIcon className="w-4 h-4" />
                    Rollback Approval Required
                  </div>
                  <p className="text-xs text-gray-300 mb-3 leading-relaxed">
                    Workspace provisioning could not complete because the <strong>Workspace Console</strong> deployment was rejected before commit.
                  </p>

                  <div className="bg-black/50 p-2.5 rounded-lg border border-white/5 mb-3">
                    <div className="text-[10px] text-gray-400 font-medium uppercase mb-1.5">Already provisioned:</div>
                    <div className="grid grid-cols-1 gap-1 text-xs">
                      <div className="flex items-center gap-1.5 text-emerald-400">
                        <CheckCircleIcon className="w-3.5 h-3.5" /> Workspace Database
                      </div>
                      <div className="flex items-center gap-1.5 text-emerald-400">
                        <CheckCircleIcon className="w-3.5 h-3.5" /> Processing Runtime
                      </div>
                      <div className="flex items-center gap-1.5 text-emerald-400">
                        <CheckCircleIcon className="w-3.5 h-3.5" /> Public Endpoint
                      </div>
                    </div>
                  </div>

                  <p className="text-xs text-gray-300 mb-3">
                    MCPx can remove these resources in reverse dependency order.
                  </p>

                  <div className="flex gap-2.5">
                    <button
                      onClick={handleApproveRollback}
                      disabled={approving}
                      className="flex-1 py-2.5 px-3 rounded-lg bg-amber-500 text-black font-semibold text-xs hover:bg-amber-400 transition-all flex items-center justify-center gap-1.5 shadow-md"
                    >
                      {approving ? <ArrowPathIcon className="w-3.5 h-3.5 animate-spin" /> : <CheckCircleIcon className="w-3.5 h-3.5" />}
                      Approve Rollback
                    </button>
                    <button
                      onClick={handleRejectRollback}
                      disabled={approving}
                      className="py-2.5 px-4 rounded-lg border border-white/10 bg-white/5 hover:bg-white/10 text-xs text-gray-300 transition-colors font-medium"
                    >
                      Keep Resources
                    </button>
                  </div>
                </div>
              )}

              {/* Final Compensation Complete Banner */}
              {activeTx.compensationDone && (
                <div className="p-4 rounded-xl bg-purple-950/25 border border-purple-500/40 text-white shadow-xl animate-in fade-in duration-300">
                  <div className="flex items-center gap-2 text-purple-300 text-xs font-bold uppercase tracking-wider mb-1.5">
                    <CheckCircleIcon className="w-4 h-4" />
                    Workspace Deployment Rolled Back
                  </div>
                  <p className="text-xs text-gray-300 leading-relaxed mb-3">
                    All resources created during this attempt were verified as removed.
                  </p>
                  <div className="text-[11px] font-mono text-gray-400 bg-black/50 p-2.5 rounded-lg border border-white/5 space-y-1">
                    <div>Transaction: <span className="text-white">{activeTx.transactionId}</span></div>
                    <div>Final state: <span className="text-purple-300 font-semibold">COMPENSATED</span></div>
                  </div>
                </div>
              )}

              {/* View in MCPx Action */}
              <div className="pt-2">
                <a
                  href={activeTx.consoleUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="w-full flex items-center justify-center gap-2 py-2.5 px-3 rounded-xl border border-white/10 bg-white/5 hover:bg-white/10 text-xs font-medium text-indigo-300 hover:text-white transition-all shadow-sm group"
                >
                  <span>View transaction in MCPx</span>
                  <ArrowTopRightOnSquareIcon className="w-3.5 h-3.5 group-hover:translate-x-0.5 transition-transform" />
                </a>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
