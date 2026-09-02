import dotenv from "dotenv";
dotenv.config();

export const AGENT_GOAL =
  "Keep FileFlow's processing pipeline healthy and recover eligible failed jobs while requiring human approval for consequential workspace operations.";

/**
 * System prompt defining the FileFlow AI Operations Agent decision engine.
 */
const AGENT_SYSTEM_PROMPT = `You are the FileFlow AI Operations Agent.
Your persistent goal is: "${AGENT_GOAL}"

FileFlow is a distributed file processing pipeline (BullMQ queues, Redis worker heartbeat, PostgreSQL uploads table, S3 storage).
When consequential multi-service infrastructure is required (such as creating dedicated tenant databases, compute runtimes, routing endpoints, and consoles), FileFlow coordinates execution via @mcpxx/sdk and MCPx.

Operating Rules:
1. AUTONOMOUS ACTIONS (Low-Risk):
   - You may choose "replay_failed_job" when:
     a) There is at least 1 job in the DLQ (Dead-Letter Queue), AND
     b) The pipeline worker is HEALTHY (workerOnline === true).
   - If workerOnline is FALSE, you must NOT replay jobs (set status to BLOCKED with clear explanation).

2. CONSEQUENTIAL ACTIONS (Approval-Required):
   - When dedicated workspace infrastructure is requested or needed for isolated workloads, you may choose "provision_processing_workspace".
   - You must mark status as "APPROVAL_REQUIRED". Consequential multi-service mutations NEVER execute without human authorization.
   - Do NOT claim workspace provisioning restores local worker capacity. Workspaces provide isolated tenant processing environments.

3. IDLE / HEALTHY:
   - When queues have no DLQ failures and pipeline is operating normally, choose status "NO_ACTION_REQUIRED".

4. BLOCKED:
   - When worker is offline and files are waiting/failed, choose status "BLOCKED".

Response Format:
You must respond with valid JSON adhering to this exact schema:
{
  "status": "NO_ACTION_REQUIRED" | "AUTONOMOUS_ACTION" | "APPROVAL_REQUIRED" | "BLOCKED",
  "reason": "Concise 1-2 sentence explanation of your observation and rationale.",
  "action": {
    "tool": "replay_failed_job" | "provision_processing_workspace" | "none",
    "arguments": { ... }
  }
}`;

export const AGENT_TOOLS = [
  {
    name: "replay_failed_job",
    description: "Re-enqueue an eligible failed job from the Dead-Letter Queue (DLQ) back to active processing queues. Only executable when worker is online.",
    parameters: {
      type: "object",
      properties: {
        jobId: {
          type: "string",
          description: "ID of the DLQ job to replay",
        },
        uploadId: {
          type: "string",
          description: "ID of the associated upload record",
        },
        filename: {
          type: "string",
          description: "Filename of the failed upload",
        },
        reason: {
          type: "string",
          description: "Operational reason for triggering the replay",
        },
      },
      required: ["jobId"],
    },
  },
  {
    name: "provision_processing_workspace",
    description: "Propose provisioning an isolated FileFlow processing workspace (database, runtime, routing, console) via MCPx. Requires human approval.",
    parameters: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "Unique name of the workspace (e.g., invoices-prod, media-staging)",
        },
        environment: {
          type: "string",
          enum: ["Production", "Staging", "Development"],
          description: "Target environment classification",
        },
        region: {
          type: "string",
          description: "Geographic deployment region (e.g., Europe West, US East, US West, Asia Pacific)",
        },
        workerConcurrency: {
          type: "integer",
          description: "Number of worker concurrency slots allocated for the workspace (e.g., 4)",
        },
      },
      required: ["name", "environment", "region", "workerConcurrency"],
    },
  },
  {
    name: "get_pipeline_telemetry",
    description: "Read-only inspection of pipeline queue depths, active jobs, and worker heartbeat health.",
    parameters: { type: "object", properties: {} },
  },
  {
    name: "get_workspace_status",
    description: "Check the status, health, and MCPx transaction state of an existing FileFlow processing workspace.",
    parameters: {
      type: "object",
      properties: {
        workspaceName: { type: "string", description: "Name of workspace" },
      },
    },
  },
];

/**
 * Evaluates the current FileFlow observation against the agent goal.
 * Returns structured decision: { status, reason, action, provider, model }
 */
export async function evaluateAgentDecision({
  observation,
  goal = AGENT_GOAL,
  userMessage = "",
  provider = process.env.LLM_PROVIDER || "gemini",
}) {
  const geminiKey = process.env.GEMINI_API_KEY;
  const openaiKey = process.env.OPENAI_API_KEY;

  if ((provider === "gemini" || !openaiKey) && geminiKey) {
    try {
      return await evaluateWithGemini({ observation, goal, userMessage, apiKey: geminiKey });
    } catch (err) {
      console.warn("[Agent] Gemini decision failed, falling back to deterministic local evaluator:", err.message);
    }
  }

  if (provider === "openai" && openaiKey) {
    try {
      return await evaluateWithOpenAI({ observation, goal, userMessage, apiKey: openaiKey });
    } catch (err) {
      console.warn("[Agent] OpenAI decision failed, falling back to deterministic local evaluator:", err.message);
    }
  }

  return evaluateWithLocalFallback({ observation, goal, userMessage });
}

async function evaluateWithGemini({ observation, goal, userMessage, apiKey }) {
  const model = process.env.GEMINI_MODEL || "gemini-2.0-flash";
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

  const userPrompt = `GOAL: ${goal}

CURRENT OBSERVATION:
${JSON.stringify(observation, null, 2)}
${userMessage ? `\nOPERATOR INSTRUCTION: "${userMessage}"` : ""}

Analyze the observation against the operating rules and return your decision JSON.`;

  const body = {
    contents: [
      {
        role: "user",
        parts: [{ text: userPrompt }],
      },
    ],
    systemInstruction: {
      parts: [{ text: AGENT_SYSTEM_PROMPT }],
    },
    generationConfig: {
      temperature: 0.1,
      responseMimeType: "application/json",
    },
  };

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(`Gemini API error (${res.status}): ${errorText}`);
  }

  const data = await res.json();
  const rawJson = data.candidates?.[0]?.content?.parts?.[0]?.text || "{}";
  const parsed = JSON.parse(rawJson);

  return {
    provider: "gemini",
    model,
    status: parsed.status || "NO_ACTION_REQUIRED",
    reason: parsed.reason || "Observation evaluated.",
    action: parsed.action || { tool: "none", arguments: {} },
  };
}

async function evaluateWithOpenAI({ observation, goal, userMessage, apiKey }) {
  const model = process.env.OPENAI_MODEL || "gpt-4o-mini";
  const url = "https://api.openai.com/v1/chat/completions";

  const userPrompt = `GOAL: ${goal}

CURRENT OBSERVATION:
${JSON.stringify(observation, null, 2)}
${userMessage ? `\nOPERATOR INSTRUCTION: "${userMessage}"` : ""}

Analyze the observation and return your decision in valid JSON format adhering to the schema.`;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: AGENT_SYSTEM_PROMPT },
        { role: "user", content: userPrompt },
      ],
      response_format: { type: "json_object" },
      temperature: 0.1,
    }),
  });

  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(`OpenAI API error (${res.status}): ${errorText}`);
  }

  const data = await res.json();
  const content = data.choices?.[0]?.message?.content || "{}";
  const parsed = JSON.parse(content);

  return {
    provider: "openai",
    model,
    status: parsed.status || "NO_ACTION_REQUIRED",
    reason: parsed.reason || "Observation evaluated.",
    action: parsed.action || { tool: "none", arguments: {} },
  };
}

/**
 * Deterministic local evaluator implementing exact autonomous rules.
 */
export function evaluateWithLocalFallback({ observation, userMessage = "" }) {
  const lowerMsg = (userMessage || "").toLowerCase();

  // 1. Explicit user request for workspace provisioning
  if (lowerMsg.includes("provision") || lowerMsg.includes("create workspace") || lowerMsg.includes("new workspace")) {
    let name = "invoices-prod";
    const namedMatch = userMessage.match(/(?:called|named)\s+([a-zA-Z0-9_-]+)/i);
    const workspaceMatch = userMessage.match(/workspace\s+(?:called\s+|named\s+)?([a-zA-Z0-9_-]+)/i);
    const candidateName = namedMatch?.[1] || workspaceMatch?.[1];

    if (candidateName && !["a", "the", "new", "workspace", "called", "named", "production", "staging", "dev"].includes(candidateName.toLowerCase())) {
      name = candidateName;
    }

    let environment = "Production";
    if (lowerMsg.includes("staging")) environment = "Staging";
    else if (lowerMsg.includes("development") || lowerMsg.includes("dev")) environment = "Development";

    let region = "Europe West";
    if (lowerMsg.includes("us east") || lowerMsg.includes("us-east")) region = "US East";
    else if (lowerMsg.includes("us west") || lowerMsg.includes("us-west")) region = "US West";
    else if (lowerMsg.includes("asia")) region = "Asia Pacific";
    else if (lowerMsg.includes("europe") || lowerMsg.includes("eu")) region = "Europe West";

    let workerConcurrency = 4;
    const concurrencyMatch = userMessage.match(/(\d+)\s*workers?/i) || userMessage.match(/concurrency\s*(?:of\s*)?(\d+)/i);
    if (concurrencyMatch) {
      workerConcurrency = parseInt(concurrencyMatch[1], 10);
    } else if (lowerMsg.includes("four")) workerConcurrency = 4;
    else if (lowerMsg.includes("two")) workerConcurrency = 2;
    else if (lowerMsg.includes("eight")) workerConcurrency = 8;

    return {
      provider: "development-fallback",
      model: "local-rule-engine",
      status: "APPROVAL_REQUIRED",
      reason: `Operator requested workspace provisioning for "${name}". Multi-service infrastructure provisioning is consequential and requires explicit approval.`,
      action: {
        tool: "provision_processing_workspace",
        arguments: { name, environment, region, workerConcurrency },
      },
    };
  }

  const { pipeline, dlq, workload } = observation || {};
  const isWorkerOnline = pipeline?.workerOnline === true;
  const dlqJobs = Array.isArray(dlq) ? dlq : [];

  // 2. Worker is Offline check
  if (!isWorkerOnline) {
    const pendingCount = (workload?.pendingFiles || []).length;
    const failedCount = (workload?.failedFiles || []).length;
    return {
      provider: "development-fallback",
      model: "local-rule-engine",
      status: "BLOCKED",
      reason: `Processing worker is currently offline (heartbeat absent). ${pendingCount} pending and ${failedCount} failed files are blocked until worker process is restarted.`,
      action: { tool: "none", arguments: {} },
    };
  }

  // 3. Eligible DLQ Job exists and worker is online -> AUTONOMOUS REPLAY
  if (dlqJobs.length > 0) {
    const target = dlqJobs[0];
    return {
      provider: "development-fallback",
      model: "local-rule-engine",
      status: "AUTONOMOUS_ACTION",
      reason: `Found ${dlqJobs.length} failed job(s) in Dead-Letter Queue while worker is online and healthy. Proactively recovering job "${target.filename || target.jobId}".`,
      action: {
        tool: "replay_failed_job",
        arguments: {
          jobId: String(target.jobId || target.dlqJobId),
          uploadId: target.uploadId,
          filename: target.filename,
          reason: target.errorMessage || "Automated recovery of transient failure from DLQ",
        },
      },
    };
  }

  // 4. Healthy pipeline
  const activeCount = pipeline?.queues?.active || 0;
  const waitingCount = pipeline?.queues?.waiting || 0;
  return {
    provider: "development-fallback",
    model: "local-rule-engine",
    status: "NO_ACTION_REQUIRED",
    reason: `Pipeline is healthy. Worker is online with ${activeCount} active and ${waitingCount} waiting jobs. Zero failed jobs in DLQ.`,
    action: { tool: "none", arguments: {} },
  };
}

/**
 * Conversational LLM adapter for direct operator queries.
 */
export async function callLLM({ messages, provider = process.env.LLM_PROVIDER || "gemini" }) {
  const geminiKey = process.env.GEMINI_API_KEY;
  const openaiKey = process.env.OPENAI_API_KEY;

  if ((provider === "gemini" || !openaiKey) && geminiKey) {
    try {
      return await callGeminiChat({ messages, apiKey: geminiKey });
    } catch (err) {
      console.warn("[LLM] Gemini chat failed, falling back to local adapter:", err.message);
    }
  }

  if (provider === "openai" && openaiKey) {
    try {
      return await callOpenAIChat({ messages, apiKey: openaiKey });
    } catch (err) {
      console.warn("[LLM] OpenAI chat failed, falling back to local adapter:", err.message);
    }
  }

  return callDevelopmentFallbackChat({ messages });
}

async function callGeminiChat({ messages, apiKey }) {
  const model = process.env.GEMINI_MODEL || "gemini-2.0-flash";
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

  const contents = messages.map((m) => ({
    role: m.role === "user" ? "user" : "model",
    parts: [{ text: m.content }],
  }));

  const functionDeclarations = AGENT_TOOLS.map((t) => ({
    name: t.name,
    description: t.description,
    parameters: t.parameters,
  }));

  const body = {
    contents,
    systemInstruction: { parts: [{ text: AGENT_SYSTEM_PROMPT }] },
    tools: [{ functionDeclarations }],
    generationConfig: { temperature: 0.1 },
  };

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(`Gemini API error (${res.status}): ${errorText}`);
  }

  const data = await res.json();
  const candidate = data.candidates?.[0]?.content?.parts || [];

  let textContent = "";
  let toolCalls = [];

  for (const part of candidate) {
    if (part.text) textContent += part.text;
    if (part.functionCall) {
      toolCalls.push({
        id: `call_${Date.now()}`,
        name: part.functionCall.name,
        arguments: part.functionCall.args || {},
      });
    }
  }

  return {
    provider: "gemini",
    model,
    text: textContent.trim(),
    toolCalls,
  };
}

async function callOpenAIChat({ messages, apiKey }) {
  const model = process.env.OPENAI_MODEL || "gpt-4o-mini";
  const url = "https://api.openai.com/v1/chat/completions";

  const formattedMessages = [
    { role: "system", content: AGENT_SYSTEM_PROMPT },
    ...messages.map((m) => ({
      role: m.role === "assistant" ? "assistant" : "user",
      content: m.content,
    })),
  ];

  const tools = AGENT_TOOLS.map((t) => ({
    type: "function",
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    },
  }));

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: formattedMessages,
      tools,
      tool_choice: "auto",
      temperature: 0.1,
    }),
  });

  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(`OpenAI API error (${res.status}): ${errorText}`);
  }

  const data = await res.json();
  const message = data.choices?.[0]?.message;

  const toolCalls = (message?.tool_calls || []).map((tc) => ({
    id: tc.id,
    name: tc.function.name,
    arguments: JSON.parse(tc.function.arguments || "{}"),
  }));

  return {
    provider: "openai",
    model,
    text: message?.content || "",
    toolCalls,
  };
}

function callDevelopmentFallbackChat({ messages }) {
  const lastMsg = [...messages].reverse().find((m) => m.role === "user")?.content || "";
  const decision = evaluateWithLocalFallback({ observation: null, userMessage: lastMsg });

  if (decision.action && decision.action.tool === "provision_processing_workspace") {
    return {
      provider: "development-fallback",
      model: "local-operator-adapter",
      text: decision.reason,
      toolCalls: [
        {
          id: `call_${Date.now()}`,
          name: "provision_workspace",
          arguments: decision.action.arguments,
        },
      ],
    };
  }

  return {
    provider: "development-fallback",
    model: "local-operator-adapter",
    text: decision.reason || "I am the FileFlow Operations Agent. I monitor pipeline health, autonomously recover DLQ jobs, and govern workspace provisioning.",
    toolCalls: [],
  };
}
