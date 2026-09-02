import dotenv from "dotenv";
dotenv.config();

/**
 * System prompt defining the FileFlow AI Operations Agent persona and capabilities.
 */
const SYSTEM_PROMPT = `You are the FileFlow AI Operations Agent (Operator).
You assist infrastructure and platform engineers in managing FileFlow processing workspaces and observing distributed file pipelines.

FileFlow is a distributed, asynchronous multimedia pipeline (supporting image resizing, PDF extraction, and video transcoding via decoupled Redis workers and direct-to-S3 ingestion).

Processing Workspaces represent isolated FileFlow processing environments with their own Workspace Database, Processing Runtime, Public Endpoint, and Workspace Console.

Guidelines:
1. You have access to specific operational tools. When the user wants to perform an action, select and call the appropriate tool.
2. For provisioning a new workspace, call the "provision_workspace" tool with sensible extracted arguments:
   - name (string, e.g. "invoices-prod", "media-staging")
   - environment (e.g. "Production", "Staging", "Development")
   - region (e.g. "Europe West", "US East", "Asia Pacific")
   - workerConcurrency (integer, e.g. 4)
3. For checking status of a workspace or transaction, call the "get_workspace_status" tool.
4. Always be concise, clear, and professional. Do not invent fake infrastructure details. Explain that mutations require user confirmation before executing.`;

export const AGENT_TOOLS = [
  {
    name: "provision_workspace",
    description: "Propose provisioning a new isolated FileFlow processing workspace with dedicated database, processing runtime, public endpoint, and console.",
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
          description: "Geographic deployment region (e.g., Europe West, US East, US West, Asia East)",
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
    name: "get_workspace_status",
    description: "Check the status, health, and MCPx transaction state of an existing FileFlow processing workspace.",
    parameters: {
      type: "object",
      properties: {
        workspaceName: {
          type: "string",
          description: "Name of the workspace to inspect",
        },
        transactionId: {
          type: "string",
          description: "Optional specific MCPx transaction ID",
        },
      },
    },
  },
];

/**
 * Executes a completion request using Gemini, OpenAI, or Fallback.
 */
export async function callLLM({ messages, provider = process.env.LLM_PROVIDER || "gemini" }) {
  const geminiKey = process.env.GEMINI_API_KEY;
  const openaiKey = process.env.OPENAI_API_KEY;

  if ((provider === "gemini" || !openaiKey) && geminiKey) {
    try {
      return await callGemini({ messages, apiKey: geminiKey });
    } catch (err) {
      console.warn("[LLM] Gemini call failed, falling back to local adapter:", err.message);
    }
  }

  if (provider === "openai" && openaiKey) {
    try {
      return await callOpenAI({ messages, apiKey: openaiKey });
    } catch (err) {
      console.warn("[LLM] OpenAI call failed, falling back to local adapter:", err.message);
    }
  }

  // Development Fallback Adapter with rule-based function calling
  return callDevelopmentFallback({ messages });
}

/**
 * Google Gemini API integration using standard v1beta REST API.
 */
async function callGemini({ messages, apiKey }) {
  const model = process.env.GEMINI_MODEL || "gemini-1.5-flash";
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
    systemInstruction: {
      parts: [{ text: SYSTEM_PROMPT }],
    },
    tools: [{ functionDeclarations }],
    generationConfig: {
      temperature: 0.1,
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
  const candidate = data.candidates?.[0]?.content?.parts || [];

  let textContent = "";
  let toolCalls = [];

  for (const part of candidate) {
    if (part.text) {
      textContent += part.text;
    }
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

/**
 * OpenAI API integration.
 */
async function callOpenAI({ messages, apiKey }) {
  const model = process.env.OPENAI_MODEL || "gpt-4o-mini";
  const url = "https://api.openai.com/v1/chat/completions";

  const formattedMessages = [
    { role: "system", content: SYSTEM_PROMPT },
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

/**
 * Robust Development/Local LLM Adapter.
 * Extracts intent and produces valid tool schemas when running without external API keys.
 */
function callDevelopmentFallback({ messages }) {
  const lastUserMessage = [...messages].reverse().find((m) => m.role === "user")?.content || "";
  const lower = lastUserMessage.toLowerCase();

  // Check for provision workspace intent
  if (lower.includes("provision") || lower.includes("create workspace") || lower.includes("new workspace")) {
    let name = "invoices-prod";
    const namedMatch = lastUserMessage.match(/(?:called|named)\s+([a-zA-Z0-9_-]+)/i);
    const workspaceMatch = lastUserMessage.match(/workspace\s+(?:called\s+|named\s+)?([a-zA-Z0-9_-]+)/i);
    const candidateName = namedMatch?.[1] || workspaceMatch?.[1];

    if (candidateName && !["a", "the", "new", "workspace", "called", "named", "production", "staging", "dev"].includes(candidateName.toLowerCase())) {
      name = candidateName;
    }

    let environment = "Production";
    if (lower.includes("staging")) environment = "Staging";
    else if (lower.includes("development") || lower.includes("dev")) environment = "Development";

    let region = "Europe West";
    if (lower.includes("us east") || lower.includes("us-east")) region = "US East";
    else if (lower.includes("us west") || lower.includes("us-west")) region = "US West";
    else if (lower.includes("asia")) region = "Asia Pacific";
    else if (lower.includes("europe") || lower.includes("eu")) region = "Europe West";

    let workerConcurrency = 4;
    const concurrencyMatch = lastUserMessage.match(/(\d+)\s*workers?/i) || lastUserMessage.match(/concurrency\s*(?:of\s*)?(\d+)/i);
    if (concurrencyMatch) {
      workerConcurrency = parseInt(concurrencyMatch[1], 10);
    } else if (lower.includes("four")) {
      workerConcurrency = 4;
    } else if (lower.includes("two")) {
      workerConcurrency = 2;
    } else if (lower.includes("eight")) {
      workerConcurrency = 8;
    }

    return {
      provider: "development-fallback",
      model: "local-operator-adapter",
      text: `I have prepared the provisioning plan for workspace **${name}** in the **${environment}** environment (${region}) with **${workerConcurrency} workers**.\n\nPlease review the configuration and confirm execution below.`,
      toolCalls: [
        {
          id: `call_${Date.now()}`,
          name: "provision_workspace",
          arguments: {
            name,
            environment,
            region,
            workerConcurrency,
          },
        },
      ],
    };
  }

  // Check for status check intent
  if (lower.includes("status") || lower.includes("check") || lower.includes("what's happening") || lower.includes("whats happening")) {
    let workspaceName = "invoices-prod";
    const nameMatch = lastUserMessage.match(/(?:of|for|with)\s+([a-zA-Z0-9_-]+)/i);
    if (nameMatch && nameMatch[1]) {
      workspaceName = nameMatch[1];
    }

    return {
      provider: "development-fallback",
      model: "local-operator-adapter",
      text: `Checking the status of workspace **${workspaceName}**...`,
      toolCalls: [
        {
          id: `call_${Date.now()}`,
          name: "get_workspace_status",
          arguments: {
            workspaceName,
          },
        },
      ],
    };
  }

  // Generic conversational response
  return {
    provider: "development-fallback",
    model: "local-operator-adapter",
    text: "I am the FileFlow Operations Agent. I can help you provision isolated processing workspaces and monitor transaction workflows.\n\nTry asking:\n• *\"Provision a production processing workspace called invoices-prod with four workers.\"*\n• *\"Check the status of invoices-prod.\"*",
    toolCalls: [],
  };
}
