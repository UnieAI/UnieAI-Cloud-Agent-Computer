/**
 * 評估提示詞系統
 * 提供平台預設和用戶自訂的 LLM Judge 提示詞
 */

export const DEFAULT_PROMPTS = {
  hallucination: {
    name: "Hallucination Detection",
    description: "Detect if the response contains factually incorrect information not supported by the reference",
    template: `You are an expert fact-checker. Your task is to evaluate whether the assistant's response contains hallucinations (claims not supported by the reference material).

Question: {question}

Reference Material:
{reference}

Assistant's Response:
{response}

Please analyze the response and provide:
1. A hallucination score from 0 to 1 (0 = no hallucinations, 1 = severe hallucinations)
2. Specific hallucinated claims if any
3. A brief explanation

Return your evaluation in JSON format:
{
  "hallucination_score": <number between 0 and 1>,
  "hallucinated_claims": [<list of hallucinated claims>],
  "explanation": "<brief explanation>"
}`
  },

  accuracy: {
    name: "Accuracy Evaluation",
    description: "Assess factual correctness of the response",
    template: `You are an expert evaluator of factual accuracy. Your task is to assess whether the assistant's response is correct.

Question: {question}

Reference Material:
{reference}

Assistant's Response:
{response}

Please evaluate:
1. Factual correctness of key claims
2. Whether important details are correct and not misleading
3. Any factual mistakes or unsupported claims

Provide:
1. An accuracy score from 0 to 1 (0 = inaccurate, 1 = fully accurate)
2. Identified factual issues (if any)
3. A brief explanation

Return your evaluation in JSON format:
{
  "accuracy_score": <number between 0 and 1>,
  "factual_issues": [<list of factual errors>],
  "explanation": "<brief explanation>"
}`
  },
  
  helpfulness: {
    name: "Helpfulness Evaluation",
    description: "Assess how well the response addresses the user's question and provides useful information",
    template: `You are an expert evaluator of response quality. Your task is to assess how helpful the assistant's response is in answering the user's question.

Question: {question}

Assistant's Response:
{response}

Please evaluate the response based on:
1. Whether it directly addresses the user's question
2. The completeness and accuracy of information provided
3. The clarity and usefulness of the explanation
4. Any limitations or gaps in the response

Provide:
1. A helpfulness score from 0 to 1 (0 = not helpful, 1 = very helpful)
2. Key strengths of the response
3. Areas for improvement (if any)
4. A brief overall assessment

Return your evaluation in JSON format:
{
  "helpfulness_score": <number between 0 and 1>,
  "strengths": [<list of key strengths>],
  "improvements": [<suggestions for improvement>],
  "assessment": "<brief overall assessment>"
}`
  },
  
  answer_relevance: {
    name: "Answer Relevance",
    description: "Measure how directly the answer addresses the question",
    template: `You are an expert in evaluating answer relevance. Your task is to assess how well the response answers the user's question.

Question: {question}

Assistant's Response:
{response}

Consider:
1. Topic relevance: Does the answer relate to the questioned topic?
2. Directness: Does it directly answer what was asked?
3. Completeness: Does it cover all aspects of the question?
4. Coherence: Is the answer logical and well-organized?

Provide:
1. A relevance score from 0 to 1 (0 = completely irrelevant, 1 = highly relevant)
2. Whether the answer addresses the main question
3. Any off-topic content
4. A brief explanation

Return your evaluation in JSON format:
{
  "relevance_score": <number between 0 and 1>,
  "addresses_question": <boolean>,
  "off_topic_content": "<description of any off-topic content>",
  "explanation": "<brief explanation>"
}`
  },

  groundedness: {
    name: "Groundedness",
    description: "Ensure the answer is grounded in the provided reference material",
    template: `You are an expert at evaluating whether responses are grounded in source material. Assess how well the response stays grounded in the provided reference.

Question: {question}

Reference Material:
{reference}

Assistant's Response:
{response}

Evaluate:
1. Claim verification: Are all major claims verifiable from the reference?
2. Citation coverage: Are claims properly attributable to the reference?
3. Over-generalization: Does the response make unsupported inferences?
4. Missing context: Are important caveats or nuances from the reference missing?

Provide:
1. A grounded score from 0 to 1 (0 = ungrounded, 1 = fully grounded)
2. Ungrounded claims (if any)
3. Missing important context (if any)
4. A brief explanation

Return your evaluation in JSON format:
{
  "groundedness_score": <number between 0 and 1>,
  "ungrounded_claims": [<list of ungrounded claims>],
  "missing_context": "<important context missing from response>",
  "explanation": "<brief explanation>"
}`
  }
};

/**
 * Get default prompt template for a metric
 */
export function getDefaultPrompt(metric) {
  return DEFAULT_PROMPTS[metric]?.template || null;
}

/**
 * Get all available metric names
 */
export function getAvailableMetrics() {
  return Object.keys(DEFAULT_PROMPTS).map((key) => ({
    id: key,
    name: DEFAULT_PROMPTS[key].name,
    description: DEFAULT_PROMPTS[key].description
  }));
}

/**
 * Format a prompt template with variables
 */
export function formatPrompt(template, variables) {
  let result = template;
  for (const [key, value] of Object.entries(variables)) {
    result = result.replace(new RegExp(`{${key}}`, 'g'), value || '');
  }
  return result;
}

/**
 * Validate prompt template
 */
export function validatePromptTemplate(template, requiredVariables = []) {
  if (!template || typeof template !== 'string') {
    return { valid: false, error: 'Template must be a non-empty string' };
  }

  for (const variable of requiredVariables) {
    if (!template.includes(`{${variable}}`)) {
      return { 
        valid: false, 
        error: `Template must include {${variable}} placeholder` 
      };
    }
  }

  return { valid: true };
}

/**
 * Create custom eval config with validation
 */
export function createEvalConfig({
  enabledMetrics = ['hallucination'],
  customPrompts = {},
  judgeModel = 'gpt-4-turbo',
  dataset = []
}) {
  const config = {
    enabledMetrics,
    customPrompts: {},
    judgeModel,
    dataset
  };

  // Validate and merge custom prompts
  for (const [metric, prompt] of Object.entries(customPrompts)) {
    const requiredVars = metric === 'hallucination' || metric === 'groundedness'
      ? ['question', 'reference', 'response']
      : ['question', 'response'];

    const validation = validatePromptTemplate(prompt, requiredVars);
    if (validation.valid) {
      config.customPrompts[metric] = prompt;
    }
  }

  return config;
}

export const EVALUATION_CONFIG = {
  DEFAULT_PROMPTS,
  getDefaultPrompt,
  getAvailableMetrics,
  formatPrompt,
  validatePromptTemplate,
  createEvalConfig
};
