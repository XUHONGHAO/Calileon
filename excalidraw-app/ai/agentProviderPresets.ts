import type { AIAgentProvider, AIAgentType } from "./types";

export type AIAgentProviderPreset = {
  id: AIAgentProvider;
  name: string;
  description: string;
  baseURL: string;
  recommendedTextModel: string;
  recommendedVisionModel: string | null;
  apiFormat: "openai" | "anthropic" | "gemini";
  defaultSystemPrompts: Partial<Record<AIAgentType, string>>;
};

export const DEFAULT_TEXT_AGENT_SYSTEM_PROMPT = `# Role
你是一个顶级的资深架构师和 Mermaid 图表生成专家。你的唯一任务是将用户的自然语言描述，精准转化为标准、可运行的纯净 Mermaid.js 代码。

# Chart Selection Logic
在编写代码前，隐式分析用户需求，选择最合适的一种图表进行构建。如未明确指定，优先使用 flowchart：
- flowchart: 流程、业务流、决策逻辑或系统拓扑。
- sequenceDiagram: 多个参与者、系统、API之间的交互顺序和消息传递。
- classDiagram: 面向对象编程中的类结构、属性、方法及关系。
- stateDiagram-v2: 对象在不同条件下的状态机与状态流转。
- erDiagram: 数据库实体关系模型，包含实体、主外键及基数关系。
- gantt: 项目计划、里程碑、时间排期与任务依赖。
- pie: 比例分布、数据占比。
- mindmap: 发散性思维导图、层级归纳。
- timeline: 按时间顺序发生的历史事件或路线图。
- gitGraph: Git 分支操作、代码提交记录。
- journey: 用户旅程映射、体验分析。
- quadrantChart: 四象限图、基于两个维度的坐标轴数据分布。
- sankey-beta: 桑基图、资金/数据的流动路径与比重。
- requirementDiagram: 软件系统需求定义与用例追踪。

# Critical Security Constraints (Strictly Enforced)
由于渲染引擎运行在 strict 严格模式下[cite: 1]，你必须严格遵守以下防崩溃规则：
1. 【绝对禁用 HTML】严禁在节点或连线文本中使用 \`<br/>\`、\`<div>\`、\`<span>\` 等任何形式的 HTML 标签[cite: 1]。
2. 【单引号原则】如果文本包含特殊字符或空格需要包裹，必须且只能使用单引号（如 \`'文本'\`），绝对禁止使用双引号 \`"\`[cite: 1]。
3. 【换行规则】如果必须换行，请在单引号包裹的文本中使用转义换行符 \`\\n\`（例如：\`'第一行\\n第二行'\`）[cite: 1]。
4. 【节点定义】节点 ID 必须使用英文字母、数字或下划线，绝对不能包含空格或特殊符号。

# Output Format
1. 你的回答必须且只能是一段纯净的 Mermaid 代码文本，直接从图表类型声明（如 flowchart TD）开始输出。
2. 绝对禁止使用 \`\`\`mermaid 这样的 Markdown 代码块进行包裹。
3. 绝对禁止输出任何开场白、解释性文字、总结或标点符号。

# Few-Shot Examples
用户：画一个简单的系统登录校验流程。
flowchart TD
    A[用户输入信息] --> B{'校验账号密码'}
    B -- 正确 --> C['进入\\n系统首页']
    B -- 错误 --> D[返回登录页]`;

export const DEFAULT_VISION_AGENT_SYSTEM_PROMPT =
  "You are an expert at converting wireframes to clean, semantic HTML and CSS code. Generate complete, working code.";

export const AI_AGENT_PROVIDER_PRESETS: AIAgentProviderPreset[] = [
  {
    id: "openai",
    name: "OpenAI",
    description: "Official OpenAI API.",
    baseURL: "https://api.openai.com/v1",
    recommendedTextModel: "gpt-4o-mini",
    recommendedVisionModel: "gpt-4o",
    apiFormat: "openai",
    defaultSystemPrompts: {
      text: DEFAULT_TEXT_AGENT_SYSTEM_PROMPT,
      vision: DEFAULT_VISION_AGENT_SYSTEM_PROMPT,
    },
  },
  {
    id: "anthropic",
    name: "Claude (Anthropic)",
    description: "Official Anthropic Messages API.",
    baseURL: "https://api.anthropic.com",
    recommendedTextModel: "claude-3-5-sonnet-20241022",
    recommendedVisionModel: "claude-3-5-sonnet-20241022",
    apiFormat: "anthropic",
    defaultSystemPrompts: {
      text: DEFAULT_TEXT_AGENT_SYSTEM_PROMPT,
      vision: DEFAULT_VISION_AGENT_SYSTEM_PROMPT,
    },
  },
  {
    id: "gemini",
    name: "Gemini (Google)",
    description: "Official Gemini API.",
    baseURL: "https://generativelanguage.googleapis.com/v1beta",
    recommendedTextModel: "gemini-1.5-flash",
    recommendedVisionModel: "gemini-1.5-pro",
    apiFormat: "gemini",
    defaultSystemPrompts: {
      text: DEFAULT_TEXT_AGENT_SYSTEM_PROMPT,
      vision: DEFAULT_VISION_AGENT_SYSTEM_PROMPT,
    },
  },
  {
    id: "deepseek",
    name: "DeepSeek",
    description: "DeepSeek OpenAI-compatible chat API.",
    baseURL: "https://api.deepseek.com/v1",
    recommendedTextModel: "deepseek-chat",
    recommendedVisionModel: null,
    apiFormat: "openai",
    defaultSystemPrompts: {
      text: DEFAULT_TEXT_AGENT_SYSTEM_PROMPT,
      vision: DEFAULT_VISION_AGENT_SYSTEM_PROMPT,
    },
  },
  {
    id: "openai-compatible",
    name: "OpenAI-Compatible",
    description: "For NewAPI, API2D, OneAPI, and compatible proxy APIs.",
    baseURL: "",
    recommendedTextModel: "",
    recommendedVisionModel: "",
    apiFormat: "openai",
    defaultSystemPrompts: {
      text: DEFAULT_TEXT_AGENT_SYSTEM_PROMPT,
      vision: DEFAULT_VISION_AGENT_SYSTEM_PROMPT,
    },
  },
];

export const getAIAgentProviderPreset = (provider: AIAgentProvider) => {
  return AI_AGENT_PROVIDER_PRESETS.find((preset) => preset.id === provider);
};
