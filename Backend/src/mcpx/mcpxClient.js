import { MCPx } from "@mcpxx/sdk";
import dotenv from "dotenv";
dotenv.config();

const MCPX_BASE_URL = process.env.MCPX_BASE_URL || "http://localhost:3000";

/**
 * Singleton MCPx SDK client instance.
 * FileFlow communicates strictly with MCPx through this SDK client.
 */
let mcpxInstance = null;

export function getMCPxClient() {
  if (!mcpxInstance) {
    mcpxInstance = new MCPx({
      endpoint: MCPX_BASE_URL,
      timeoutMs: 30000,
    });
  }
  return mcpxInstance;
}

/**
 * FileFlow domain dictionary mapping raw MCPx node identifiers to FileFlow terminology.
 */
export const NODE_NAME_MAPPING = {
  database: "Workspace Database",
  "database-app": "Workspace Database",
  "database-service": "Workspace Database",
  db: "Workspace Database",

  compute: "Processing Runtime",
  "compute-app": "Processing Runtime",
  "compute-service": "Processing Runtime",

  routing: "Public Endpoint",
  "routing-app": "Public Endpoint",
  "routing-service": "Public Endpoint",

  frontend: "Workspace Console",
  "frontend-app": "Workspace Console",
  "frontend-service": "Workspace Console",
};

/**
 * Translates an MCPx node object to FileFlow domain language.
 */
export function translateNode(node) {
  const fileflowLabel = NODE_NAME_MAPPING[node.nodeId?.toLowerCase()] || 
                        NODE_NAME_MAPPING[node.id?.toLowerCase()] || 
                        node.label || 
                        node.nodeId;

  return {
    ...node,
    fileflowLabel,
  };
}

/**
 * Translates an MCPx snapshot into FileFlow workspace presentation format.
 */
export function translateSnapshot(snapshot) {
  if (!snapshot) return null;

  const translatedNodes = (snapshot.nodes || []).map(translateNode);

  return {
    ...snapshot,
    nodes: translatedNodes,
  };
}

/**
 * Starts workspace provisioning by triggering the Reference 4-Service Challenge Workflow in MCPx.
 */
export async function startWorkspaceProvisioning({ name, environment, region, workerConcurrency }) {
  const client = getMCPxClient();

  // Try to find the challenge workflow from MCPx registry
  let workflowSlug = "challenge-workflow";
  try {
    const list = await client.workflows.list();
    const challengeWorkflow = list.find((w) => 
      w.name?.toLowerCase().includes("challenge") || 
      w.id?.toLowerCase().includes("challenge") ||
      w.name?.toLowerCase().includes("4-service") ||
      w.id?.toLowerCase().includes("4-service")
    );
    if (challengeWorkflow) {
      workflowSlug = challengeWorkflow.id;
    } else if (list.length > 0) {
      workflowSlug = list[0].id;
    }
  } catch (err) {
    console.warn("[MCPx] Could not list workflows, defaulting to 'challenge-workflow':", err.message);
  }

  const inputPayload = {
    workspaceName: name,
    environment: environment || "Production",
    region: region || "Europe West",
    workerConcurrency: Number(workerConcurrency) || 4,
    initiatedBy: "FileFlow AI Operations Agent",
  };

  try {
    const run = await client.workflows.run(workflowSlug, inputPayload);
    const snapshot = translateSnapshot(run.snapshot);

    return {
      transactionId: run.id,
      consoleUrl: run.consoleUrl || `${MCPX_BASE_URL}/app/transactions/${run.id}`,
      workflowId: run.workflowId,
      status: run.status || "RUNNING",
      snapshot,
    };
  } catch (err) {
    console.error("[MCPx] Workflow run initiation failed:", err.message);
    throw err;
  }
}

/**
 * Retrieves the current status snapshot of a transaction from MCPx.
 */
export async function getTransactionStatus(transactionId) {
  const client = getMCPxClient();
  const snapshot = await client.transactions.get(transactionId);
  return translateSnapshot(snapshot);
}

/**
 * Retrieves historical transaction events from MCPx.
 */
export async function getTransactionEvents(transactionId) {
  const client = getMCPxClient();
  return await client.transactions.getEvents(transactionId);
}

/**
 * Approves rollback compensation in MCPx for a transaction in AWAITING_COMPENSATION_APPROVAL state.
 */
export async function approveCompensation(transactionId, reason = "Approved by operator in FileFlow Console") {
  const client = getMCPxClient();
  const updatedSnapshot = await client.transactions.approveCompensation(transactionId, { reason });
  return translateSnapshot(updatedSnapshot);
}

/**
 * Rejects rollback compensation in MCPx.
 */
export async function rejectCompensation(transactionId, reason = "Rejected by operator in FileFlow Console") {
  const client = getMCPxClient();
  const updatedSnapshot = await client.transactions.rejectCompensation(transactionId, { reason });
  return translateSnapshot(updatedSnapshot);
}
