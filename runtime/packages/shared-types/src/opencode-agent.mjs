import { OPENCODE_PROVIDER_PROMPTS } from "./opencode-provider-prompts.mjs";

const MAX_STEPS_PROMPT = `CRITICAL - MAXIMUM STEPS REACHED

The maximum number of steps allowed for this task has been reached. Tools are disabled until next user input. Respond with text only.

STRICT REQUIREMENTS:
1. Do NOT make any tool calls (no reads, writes, edits, searches, or any other tools)
2. MUST provide a text response summarizing work done so far
3. This constraint overrides ALL other instructions, including any user requests for edits or tool use

Response must include:
- Statement that maximum steps for this agent have been reached
- Summary of what has been accomplished so far
- List of any remaining tasks that were not completed
- Recommendations for what should be done next

Any attempt to use tools is a critical violation. Respond with text ONLY.`;

function selectProviderPromptKey(modelId = "") {
  const normalized = String(modelId || "").trim().toLowerCase();
  if (normalized.includes("gpt-4") || normalized.includes("o1") || normalized.includes("o3")) {
    return "beast";
  }
  if (normalized.includes("gpt")) {
    if (normalized.includes("codex")) {
      return "codex";
    }
    return "gpt";
  }
  if (normalized.includes("gemini-")) {
    return "gemini";
  }
  if (normalized.includes("claude")) {
    return "anthropic";
  }
  if (normalized.includes("trinity")) {
    return "trinity";
  }
  return "default";
}

async function loadInstructionBlocks({
  instructionDocuments = [],
  instructionUrls = []
} = {}) {
  const blocks = [];

  for (const document of Array.isArray(instructionDocuments) ? instructionDocuments : []) {
    const source = String(document?.source || document?.path || "db://agent/AGENTS.md").trim();
    const content = String(document?.content || "").trim();
    if (content) {
      blocks.push(`Instructions from: ${source}\n${content}`);
    }
  }

  for (const url of Array.isArray(instructionUrls) ? instructionUrls : []) {
    const normalizedUrl = String(url || "").trim();
    if (!/^https?:\/\//i.test(normalizedUrl)) {
      continue;
    }
    try {
      const response = await fetch(normalizedUrl, {
        signal:
          typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function"
            ? AbortSignal.timeout(5000)
            : undefined
      });
      if (!response.ok) {
        continue;
      }
      const content = String(await response.text()).trim();
      if (content) {
        blocks.push(`Instructions from: ${normalizedUrl}\n${content}`);
      }
    } catch {
      // Best effort only.
    }
  }

  return blocks;
}

export async function buildOpencodePromptSections({
  providerId = "",
  modelId = "",
  workingDirectory = "",
  workspaceRoot = "",
  isGitRepo = false,
  additionalInstructions = "",
  instructionDocuments = [],
  instructionUrls = []
} = {}) {
  const providerPromptKey = selectProviderPromptKey(modelId);
  const providerPrompt = String(OPENCODE_PROVIDER_PROMPTS[providerPromptKey] || OPENCODE_PROVIDER_PROMPTS.default || "").trim();
  const environmentPrompt = [
    `You are powered by the model named ${modelId}. The exact model ID is ${providerId || "unknown"}/${modelId}`,
    "Here is some useful information about the environment you are running in:",
    "<env>",
    `  Working directory: ${workingDirectory}`,
    `  Workspace root folder: ${workspaceRoot}`,
    `  Is directory a git repo: ${isGitRepo ? "yes" : "no"}`,
    `  Platform: ${process.platform}`,
    `  Today's date: ${new Date().toDateString()}`,
    "</env>",
    "<directories>",
    "",
    "</directories>"
  ].join("\n");
  const instructionBlocks = await loadInstructionBlocks({
    instructionDocuments,
    instructionUrls
  });

  return {
    providerPromptKey,
    providerPrompt,
    environmentPrompt,
    instructionBlocks,
    additionalInstructions: String(additionalInstructions || "").trim(),
    maxStepsPrompt: MAX_STEPS_PROMPT
  };
}

export async function readOpencodePromptAsset(filename = "") {
  if (String(filename || "").trim() === "max-steps.txt") {
    return MAX_STEPS_PROMPT;
  }
  const key = String(filename || "")
    .trim()
    .replace(/\.txt$/i, "");
  return String(OPENCODE_PROVIDER_PROMPTS[key] || "").trim();
}

export async function buildOpencodeSystemPrompt(input = {}) {
  const sections = await buildOpencodePromptSections(input);
  return [
    sections.providerPrompt,
    sections.environmentPrompt,
    ...sections.instructionBlocks,
    sections.additionalInstructions ? `Additional instructions:\n${sections.additionalInstructions}` : ""
  ]
    .filter(Boolean)
    .join("\n\n")
    .trim();
}
