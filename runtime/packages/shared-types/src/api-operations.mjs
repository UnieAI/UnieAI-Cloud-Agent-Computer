import { createError, textPreview } from "./index.mjs";

export const OPENAPI_DISCOVERY_PATH = "openapi.json";

function normalizeMethod(method) {
  const normalized = String(method || "GET").trim().toUpperCase();
  return ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"].includes(normalized) ? normalized : "GET";
}

function normalizeRequestMode(mode) {
  const normalized = String(mode || "auto").trim().toLowerCase();
  return ["auto", "query", "body"].includes(normalized) ? normalized : "auto";
}

function normalizeObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function normalizeStringArray(value) {
  return Array.isArray(value) ? value.map((item) => String(item || "").trim()).filter(Boolean) : [];
}

function normalizeApiPath(value, fallback = "/") {
  const normalized = String(value || fallback).trim();
  if (!normalized) {
    return fallback;
  }
  return normalized.startsWith("/") ? normalized : `/${normalized}`;
}

function normalizeTimeoutSec(value) {
  if (value === "" || value === null || value === undefined) {
    return null;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return null;
  }
  return Math.max(1, Math.min(Math.floor(parsed), 600));
}

export function sanitizeFunctionName(name, fallback = "tool") {
  const normalized = String(name || "")
    .trim()
    .replace(/[^a-zA-Z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 64);
  return normalized || fallback;
}

export function normalizeApiToolConfig(tool = {}, index = 0) {
  const modeRaw = String(tool.mode ?? tool.toolMode ?? tool.sourceType ?? "").trim().toLowerCase();
  const hasManualHints = Boolean(tool.manualRoutePrompt || tool.routePrompt || tool.manualPath || tool.manualMethod);
  const mode =
    modeRaw.includes("manual")
      ? "manual"
      : modeRaw.includes("openapi")
        ? "openapi"
        : hasManualHints
          ? "manual"
          : "openapi";

  return {
    id: String(tool.id || "").trim() || `cm_api_tool_${index + 1}`,
    name: String(tool.name || "").trim() || `Tool ${index + 1}`,
    mode,
    url: String(tool.url || tool.baseUrl || tool.baseURL || "").trim().replace(/\/+$/, ""),
    path:
      mode === "openapi"
        ? OPENAPI_DISCOVERY_PATH
        : String(tool.path || tool.openapiPath || tool.specPath || OPENAPI_DISCOVERY_PATH).trim().replace(/^\/+/, "") ||
          OPENAPI_DISCOVERY_PATH,
    apiKey: String(tool.apiKey || "").trim(),
    isActive: tool.isActive !== false,
    manualRoutePrompt: String(tool.manualRoutePrompt || tool.routePrompt || tool.routingHint || tool.routingPrompt || "").trim(),
    manualPath: normalizeApiPath(tool.manualPath || tool.endpointPath || tool.routePath || "/"),
    method: normalizeMethod(tool.method || tool.manualMethod || tool.httpMethod || "GET"),
    requestMode: normalizeRequestMode(tool.requestMode || tool.manualRequestMode || "auto"),
    argsSchema: normalizeObject(tool.argsSchema || tool.parametersSchema || tool.inputSchema),
    requiredArgs: normalizeStringArray(tool.requiredArgs || tool.required || tool.requiredParameters),
    payloadTemplate: normalizeObject(tool.payloadTemplate || tool.requestTemplate || tool.bodyTemplate),
    timeoutSec: normalizeTimeoutSec(tool.timeoutSec)
  };
}

function resolveSchema(schema, components = {}) {
  if (!schema || typeof schema !== "object") {
    return {};
  }

  if (schema.$ref && typeof schema.$ref === "string") {
    const pathParts = schema.$ref.replace(/^#\/components\//, "").split("/");
    let cursor = components;
    for (const part of pathParts) {
      cursor = cursor?.[part];
      if (!cursor) {
        break;
      }
    }
    return resolveSchema(cursor, components);
  }

  return schema;
}

function buildOperationDescription(operation = {}, method = "", routePath = "") {
  const parts = [];
  const summary = String(operation?.summary || "").trim();
  const description = String(operation?.description || "").trim();

  if (summary) {
    parts.push(summary);
  }
  if (description && description !== summary) {
    parts.push(description);
  }
  if (Array.isArray(operation?.tags) && operation.tags.length > 0) {
    const tags = operation.tags.map((tag) => String(tag || "").trim()).filter(Boolean);
    if (tags.length > 0) {
      parts.push(`Tags: ${tags.join(", ")}`);
    }
  }
  if (parts.length === 0) {
    parts.push(`${String(method || "GET").toUpperCase()} ${String(routePath || "/")}`);
  }

  return parts.join(" | ");
}

function convertOpenApiToOperations(spec, baseTool) {
  const operations = [];
  const paths = spec?.paths || {};
  const components = spec?.components || {};
  const supportedMethods = new Set(["get", "post", "put", "patch", "delete", "head", "options"]);

  for (const routePath of Object.keys(paths)) {
    const route = paths[routePath] || {};
    for (const method of Object.keys(route)) {
      if (!supportedMethods.has(String(method || "").toLowerCase())) {
        continue;
      }

      const operation = route[method];
      if (!operation || typeof operation !== "object") {
        continue;
      }

      const operationName =
        String(operation.operationId || "").trim() ||
        `${method.toLowerCase()}_${routePath.replace(/[{}]/g, "").replace(/[^a-zA-Z0-9_]+/g, "_")}`;
      const functionName = sanitizeFunctionName(`api_${baseTool.id}_${operationName}`, `api_${baseTool.id}`);
      const parameters = {
        type: "object",
        properties: {},
        required: []
      };

      const allParameters = [
        ...(Array.isArray(route.parameters) ? route.parameters : []),
        ...(Array.isArray(operation.parameters) ? operation.parameters : [])
      ];

      for (const parameter of allParameters) {
        const schema = resolveSchema(parameter?.schema || {}, components);
        const name = String(parameter?.name || "").trim();
        if (!name) {
          continue;
        }
        parameters.properties[name] = {
          type: schema?.type || "string",
          description: String(parameter?.description || schema?.description || "").trim()
        };
        if (parameter?.required) {
          parameters.required.push(name);
        }
      }

      const jsonSchema = resolveSchema(operation?.requestBody?.content?.["application/json"]?.schema || null, components);
      if (jsonSchema?.type === "object" && jsonSchema?.properties && typeof jsonSchema.properties === "object") {
        for (const [fieldName, fieldSchema] of Object.entries(jsonSchema.properties)) {
          const resolvedField = resolveSchema(fieldSchema, components);
          parameters.properties[fieldName] = {
            type: resolvedField?.type || "string",
            description: String(resolvedField?.description || "").trim()
          };
        }
        if (Array.isArray(jsonSchema.required)) {
          parameters.required = Array.from(new Set([...(parameters.required || []), ...jsonSchema.required]));
        }
      }

      operations.push({
        kind: "api_operation",
        functionName,
        displayName: operationName,
        description: buildOperationDescription(operation, method, routePath),
        method: method.toUpperCase(),
        path: routePath,
        requestMode: "auto",
        payloadTemplate: {},
        baseTool,
        parameters: {
          type: "object",
          properties: normalizeObject(parameters.properties),
          required: normalizeStringArray(parameters.required)
        }
      });
    }
  }

  return operations;
}

function buildManualOperation(baseTool) {
  const hasRootSchema =
    baseTool.argsSchema &&
    typeof baseTool.argsSchema === "object" &&
    !Array.isArray(baseTool.argsSchema) &&
    baseTool.argsSchema.type === "object" &&
    baseTool.argsSchema.properties &&
    typeof baseTool.argsSchema.properties === "object";

  const schema = hasRootSchema
    ? {
        type: "object",
        properties: normalizeObject(baseTool.argsSchema.properties),
        required: normalizeStringArray(baseTool.argsSchema.required)
      }
    : {
        type: "object",
        properties: normalizeObject(baseTool.argsSchema),
        required: normalizeStringArray(baseTool.requiredArgs)
      };

  return {
    kind: "api_operation",
    functionName: sanitizeFunctionName(`api_manual_${baseTool.id}`, `api_manual_${Date.now()}`),
    displayName: baseTool.name,
    description: baseTool.manualRoutePrompt || `${baseTool.method} ${baseTool.manualPath}`,
    method: baseTool.method,
    path: baseTool.manualPath,
    requestMode: baseTool.requestMode,
    payloadTemplate: normalizeObject(baseTool.payloadTemplate),
    baseTool,
    parameters: {
      type: "object",
      properties: normalizeObject(schema.properties),
      required: normalizeStringArray(schema.required)
    }
  };
}

/**
 * Discover every configured tool's operations.
 *
 * WHAT THE USER SAW. A failed spec fetch — the tool's host down, a rotated API
 * key answering 401, the 8s timeout — used to return `[]` for that tool, which
 * is byte-for-byte what a spec with no paths returns. The MCP tool was then
 * registered with ZERO callable operations, and the agent told the user the
 * tool had nothing it could do. Confidently, about a tool that worked an hour
 * earlier, with nothing in any log to contradict it.
 *
 * WHAT IT COST. Silent capability loss dressed as a fact about the tool.
 *
 * So `unavailable` exists: `operations` is still only the operations we could
 * actually enumerate, but a tool that could not be read is NAMED there rather
 * than folded into the same emptiness as a tool that genuinely exposes none.
 * A caller that presents tools to a model can then withhold — or annotate —
 * the ones it could not enumerate, instead of publishing a hollow tool.
 *
 * @returns {Promise<{operations: Array, unavailable: Array<{toolId: string, toolName: string, url: string, status: number|null, reason: string}>}>}
 */
export async function fetchApiOperationsFromConfigDetailed(tools = [], { log = console } = {}) {
  const unavailable = [];
  const operationLists = await Promise.all(
    tools.map(async (tool) => {
      if (tool.mode === "manual") {
        return [buildManualOperation(tool)];
      }

      const specUrl = `${tool.url}/${OPENAPI_DISCOVERY_PATH}`;
      /** Record the loss and contribute nothing — as opposed to claiming there is nothing. */
      const lost = (status, reason) => {
        unavailable.push({
          toolId: String(tool.id ?? ""),
          toolName: String(tool.name ?? tool.id ?? ""),
          url: specUrl,
          status,
          reason
        });
        // Loud on purpose: without this line an operator has no way to connect
        // "the agent says the CRM tool can't do anything" to the CRM being down.
        log.error(
          `[api-operations] TOOL NOT ENUMERATED: ${tool.name || tool.id} (${specUrl}) — ${reason}` +
            ` — its operations are UNKNOWN, which is not the same as it having none`
        );
        return [];
      };

      let response;
      try {
        const headers = { "content-type": "application/json" };
        if (tool.apiKey) {
          headers.authorization = `Bearer ${tool.apiKey}`;
        }

        response = await fetch(specUrl, {
          method: "GET",
          headers,
          signal:
            typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function"
              ? AbortSignal.timeout(8000)
              : undefined
        });
      } catch (error) {
        return lost(null, `spec request failed: ${error instanceof Error ? error.message : String(error)}`);
      }

      if (!response.ok) {
        return lost(response.status, `spec request answered HTTP ${response.status}`);
      }

      const spec = await response.json().catch(() => null);
      if (!spec || typeof spec !== "object") {
        // A 200 whose body is not an object is a proxy page, not a spec.
        return lost(response.status, "response was not an OpenAPI document");
      }

      try {
        return convertOpenApiToOperations(spec, tool);
      } catch (error) {
        return lost(response.status, `spec could not be converted: ${error instanceof Error ? error.message : String(error)}`);
      }
    })
  );

  const flattened = operationLists.flat();
  const seen = new Set();
  const operations = flattened.filter((operation) => {
    const key = String(operation?.functionName || "").trim();
    if (!key || seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
  return { operations, unavailable };
}

/**
 * The operations only. Kept as-is for existing callers — but the losses are no
 * longer invisible, because the detailed variant logs each one as it happens.
 */
export async function fetchApiOperationsFromConfig(tools = [], options = {}) {
  const { operations } = await fetchApiOperationsFromConfigDetailed(tools, options);
  return operations;
}

export function buildApiToolDefinitions(operations = []) {
  return (Array.isArray(operations) ? operations : []).map((operation) => ({
    type: "function",
    function: {
      name: operation.functionName,
      description: operation.description,
      parameters: operation.parameters
    }
  }));
}

export async function executeApiOperation(operation = {}, args = {}) {
  const toolName = String(operation?.functionName || operation?.displayName || "unknown_tool").trim();
  const normalizedArgs = args && typeof args === "object" && !Array.isArray(args) ? args : {};
  const baseTool = operation?.baseTool || {};
  const method = normalizeMethod(operation?.method || "GET");
  const requestMode = normalizeRequestMode(operation?.requestMode || "auto");
  const payloadTemplate = normalizeObject(operation?.payloadTemplate);
  const templatePath = String(operation?.path || "/").trim() || "/";
  const pathWithLeadingSlash = templatePath.startsWith("/") ? templatePath : `/${templatePath}`;

  let resolvedPath = pathWithLeadingSlash;
  for (const [key, value] of Object.entries(normalizedArgs)) {
    if (resolvedPath.includes(`{${key}}`)) {
      resolvedPath = resolvedPath.replaceAll(`{${key}}`, encodeURIComponent(String(value)));
    }
  }

  let requestUrl = `${String(baseTool?.url || "").replace(/\/+$/, "")}${resolvedPath}`;
  const headers = { "content-type": "application/json" };
  if (baseTool?.apiKey) {
    headers.authorization = `Bearer ${baseTool.apiKey}`;
  }

  const fetchOptions = {
    method,
    headers
  };

  const shouldUseQuery = method === "GET" || method === "HEAD" || requestMode === "query";
  if (shouldUseQuery) {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(normalizedArgs)) {
      if (!templatePath.includes(`{${key}}`)) {
        query.set(key, String(value));
      }
    }
    const queryString = query.toString();
    if (queryString) {
      requestUrl += `?${queryString}`;
    }
  } else {
    fetchOptions.body = JSON.stringify({
      ...payloadTemplate,
      ...normalizedArgs
    });
  }

  try {
    const response = await fetch(requestUrl, fetchOptions);
    const rawText = await response.text();
    let parsedResult = rawText;
    try {
      parsedResult = rawText ? JSON.parse(rawText) : {};
    } catch {
      // Keep raw text.
    }

    if (!response.ok) {
      throw createError(
        "api_operation_failed",
        `API operation failed with status ${response.status}`,
        {
          toolName,
          status: response.status,
          body: typeof parsedResult === "string" ? textPreview(parsedResult, 2000) : parsedResult
        },
        502
      );
    }

    return {
      result: parsedResult,
      preview:
        typeof parsedResult === "string" ? textPreview(parsedResult, 6000) : textPreview(JSON.stringify(parsedResult), 6000)
    };
  } catch (error) {
    if (error?.code) {
      throw error;
    }
    throw createError("api_operation_failed", String(error?.message || error || "Unknown API call error"), { toolName }, 502);
}

}
