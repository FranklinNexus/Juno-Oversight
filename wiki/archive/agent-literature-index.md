# Agent 文献索引 — 100 篇

**Mission**：`juno-agent-literature-2026`
**最后更新**：2026-06-01

本表为 [`papers/batch-*.yaml`](../../AgentWorkbench/missions/juno-agent-literature-2026/papers/) 的只读汇总；主题 slug 定义见 mission [`taxonomy.md`](../../AgentWorkbench/missions/juno-agent-literature-2026/taxonomy.md)。

架构归纳见 [juno-agent-architecture.md](./juno-agent-architecture.md)。

---

| # | 标题 | 主题 | Juno hook | URL |
|---|------|------|-----------|-----|
| 1 | ReAct: Synergizing Reasoning and Acting in Language Models | tools, planning | Implement slots mirror ReAct cycles—manifest injects context, agent acts on repo, feedback loops via events. | [link](https://arxiv.org/abs/2210.03629) |
| 2 | Reflexion: Language Agents with Verbal Reinforcement Learning | self-improvement, memory | REVIEW_VERDICT REVISE → prepend fix implement slot parallels verbal RL from failed attempts. | [link](https://arxiv.org/abs/2303.11366) |
| 3 | Generative Agents: Interactive Simulacra of Human Behavior | memory, multi-agent, environment | External memory + reflection maps to checkpoint.md as sole cross-slot memory vs chat history. | [link](https://arxiv.org/abs/2304.03442) |
| 4 | Toolformer: Language Models Can Teach Themselves to Use Tools | tools | MCP/CLI tool boundaries in executor slots echo Toolformer-style gated tool invocation. | [link](https://arxiv.org/abs/2302.04761) |
| 5 | AutoGen: Enabling Next-Gen LLM Applications via Multi-Agent Conversation | multi-agent, communication, orchestration | Multi runKind (implement/review/verify) agents with structured handoffs resemble AutoGen group chat patterns. | [link](https://arxiv.org/abs/2308.08155) |
| 6 | MetaGPT: Meta Programming for A Multi-Agent Collaborative Framework | multi-agent, planning, orchestration | Mission phase queue + north-star decomposition mirrors MetaGPT SOP-driven role pipeline. | [link](https://arxiv.org/abs/2308.00352) |
| 7 | Voyager: An Open-Ended Embodied Agent with Large Language Models | self-improvement, tools, environment | Accumulated mission artifacts (papers yaml, checkpoint CHANGES) act like Voyager's persistent skill library. | [link](https://arxiv.org/abs/2305.16291) |
| 8 | SWE-agent: Agent-Computer Interfaces Enable Automated Software Engineering | tools, environment | Repo cwd + scope-lock paths are Juno's ACI—tools shaped for LM agents, not raw shell UX. | [link](https://arxiv.org/abs/2405.15793) |
| 9 | AgentBench: Evaluating LLMs as Agents | evaluation, environment | verify slot + pnpm test/ui:smoke compose Juno's agent eval harness analogous to AgentBench suites. | [link](https://arxiv.org/abs/2308.03688) |
| 10 | WebArena: A Realistic Web Environment for Building Autonomous Agents | evaluation, environment | Desktop HUD + Tauri shell provides a controlled environment like WebArena for repeatable agent runs. | [link](https://arxiv.org/abs/2307.13854) |
| 11 | Tree of Thoughts: Deliberate Problem Solving with Large Language Models | planning | Scheduler queue with review hold/revise branches resembles ToT search over implement→review decision paths. | [link](https://arxiv.org/abs/2305.10601) |
| 12 | Self-Refine: Iterative Refinement with Self-Feedback | verification, self-improvement | Review slot critic loop formalizes Self-Refine with external REVIEW_VERDICT instead of inline self-critique. | [link](https://arxiv.org/abs/2303.17651) |
| 13 | CRITIC: Large Language Models Can Self-Correct with Tool-Interactive Critiquing | verification, tools | executor_verify runs tests/lint as external critic—LLM cannot self-verify without tool feedback, per CRITIC. | [link](https://arxiv.org/abs/2305.11738) |
| 14 | CAMEL: Communicative Agents for Mind Exploration of Large Language Model Society | multi-agent, communication | Implement vs review role separation with injected prompts parallels CAMEL role-playing agent pairs. | [link](https://arxiv.org/abs/2303.17760) |
| 15 | HuggingGPT: Solving AI Tasks with ChatGPT and its Friends in Hugging Face | orchestration, multi-agent, tools | Orchestrator manifest builder routes runKind to repo targets like HuggingGPT's planner→expert dispatch. | [link](https://arxiv.org/abs/2303.17580) |
| 16 | MemGPT: Towards LLMs as Operating Systems | memory | checkpoint.md + events.jsonl tail injection implement MemGPT-style externalized working memory. | [link](https://arxiv.org/abs/2310.08560) |
| 17 | AgentVerse: Facilitating Multi-Agent Collaboration and Exploring Emergent Behaviors | multi-agent, orchestration | Mission phases spawn specialized implement/review/verify slots akin to AgentVerse dynamic group assembly. | [link](https://arxiv.org/abs/2308.10848) |
| 18 | ChatDev: Communicative Agents for Software Development | multi-agent, orchestration | Phase queue (papers→review→synthesis→verify) mirrors ChatDev's staged multi-role software pipeline. | [link](https://arxiv.org/abs/2307.07924) |
| 19 | DSPy: Compiling Declarative Language Model Calls into Self-Improving Pipelines | self-improvement, evaluation | Prompt templates (executor_*.md) + verify metrics echo DSPy's declarative compile-and-improve loop. | [link](https://arxiv.org/abs/2310.03714) |
| 20 | SWE-bench: Can Language Models Resolve Real-World GitHub Issues? | evaluation | cargo check + pnpm test gates in verify slot are Juno's execution-based acceptance tests like SWE-bench. | [link](https://arxiv.org/abs/2310.06770) |
| 21 | Language Agent Tree Search Unifies Reasoning, Acting, and Planning in Language Models | planning, orchestration | Scheduler idempotent skip/retry over run branches resembles LATS tree search over slot outcomes. | [link](https://arxiv.org/abs/2310.04402) |
| 22 | Mind2Web: Towards a Generalist Agent for the Web | environment, tools | Long-horizon web-like tasks in HUD stress-test agent persistence similar to Mind2Web generalization goals. | [link](https://arxiv.org/abs/2306.06070) |
| 23 | ToolLLM: Facilitating Large Language Models to Master 16000+ Real-world APIs | tools, evaluation | MCP tool catalog + scope-lock allowed paths constrain tool surface area like ToolLLM's API routing. | [link](https://arxiv.org/abs/2307.16789) |
| 24 | AgentTuning: Enabling Generalized Agent Abilities in LLMs | evaluation, self-improvement | Repeated mission runs across phases accumulate agent-like behavior patterns without model fine-tuning. | [link](https://arxiv.org/abs/2310.12811) |
| 25 | WebGPT: Browser-assisted Question-answering with Human Feedback | tools, human-in-loop | Human-in-loop Promote panel and IDE review before vault export mirror WebGPT's preference-gated actions. | [link](https://arxiv.org/abs/2112.09332) |
| 26 | MRKL Systems: A modular, neuro-symbolic architecture that combines large language models, external knowledge sources and discrete reasoning | tools, orchestration | Orchestrator manifest routing runKind to repo targets mirrors MRKL's planner dispatching to expert modules. | [link](https://arxiv.org/abs/2205.00445) |
| 27 | Gorilla: Large Language Model Connected with Massive APIs | tools, retrieval | MCP tool catalog + scope-lock allowed paths constrain the API surface like Gorilla's retrieval-grounded tool selection. | [link](https://arxiv.org/abs/2305.15334) |
| 28 | Executable Code Actions Elicit Better LLM Agents | tools, environment | Implement slots running shell/pnpm in repo cwd parallel CodeAct—code-as-action with multi-turn observation loops. | [link](https://arxiv.org/abs/2402.01030) |
| 29 | TaskWeaver: A Code-First Agent Framework | orchestration, tools, planning | Planner→code generator→executor split maps to manifest builder→implement slot→verify executor pipeline. | [link](https://arxiv.org/abs/2311.17541) |
| 30 | OpenHands: An Open Platform for AI Software Developers as Generalist Agents | environment, multi-agent, evaluation | Sandboxed repo execution + SWE-bench/WebArena eval integration mirrors OpenHands' generalist dev-agent platform model. | [link](https://arxiv.org/abs/2407.16741) |
| 31 | ExpeL: LLM Agents Are Experiential Learners | memory, self-improvement | events.jsonl + checkpoint CHANGES accumulate cross-slot experiential knowledge like ExpeL's experience pool. | [link](https://arxiv.org/abs/2308.10144) |
| 32 | FireAct: Toward Language Agent Fine-tuning | self-improvement, tools | Repeated mission phases with mixed implement/review trajectories could seed fine-tuning data akin to FireAct diversity. | [link](https://arxiv.org/abs/2310.05915) |
| 33 | Plan-and-Solve Prompting: Improving Zero-Shot Chain-of-Thought Reasoning by Large Language Models | planning | north-star.md defines plan; phase queue executes sub-batches—explicit plan-then-solve decomposition for long missions. | [link](https://arxiv.org/abs/2305.04091) |
| 34 | AppAgent: Multimodal Agents as Smartphone Users | environment, tools | Tauri desktop HUD as controlled GUI environment parallels AppAgent's app-level action grounding in a sandbox. | [link](https://arxiv.org/abs/2312.13771) |
| 35 | Mobile-Agent: Autonomous Multi-Modal Mobile Device Agent with Visual Perception | environment, planning | Multi-phase mission decomposition with visual HUD feedback resembles Mobile-Agent's subgoal planning loop. | [link](https://arxiv.org/abs/2401.16158) |
| 36 | OSWorld: Benchmarking Multimodal Agents for Open-Ended Tasks in Real Computer Environments | evaluation, environment | verify:desktop + Tauri shell eval in real OS context aligns with OSWorld's live desktop environment testing. | [link](https://arxiv.org/abs/2404.07972) |
| 37 | VisualWebArena: Evaluating Multimodal Agents on Realistic Visual Web Tasks | evaluation, environment | ui:smoke visual regression tests extend text-only verify gates like VisualWebArena adds vision to WebArena. | [link](https://arxiv.org/abs/2404.05919) |
| 38 | ScienceWorld: Is your Agent Smarter than a 5th Grader? | environment, evaluation | Multi-step mission phases with varying successCriteria resemble ScienceWorld's procedurally varied task instances. | [link](https://arxiv.org/abs/2203.07504) |
| 39 | ALFWorld: Align Text and Embodied Environments for Interactive Learning | environment, planning | Workbench file-based tasks (yaml/md) as text proxy for repo implement slots mirror ALFWorld's text-to-action alignment. | [link](https://arxiv.org/abs/2010.03768) |
| 40 | WebShop: Towards Scalable Real-World Web Interaction with Grounded Language Agents | environment, evaluation | Large-scale repeatable agent task suites in Workbench queue echo WebShop's scalable simulated interaction benchmark. | [link](https://arxiv.org/abs/2207.01206) |
| 41 | OS-Copilot: Towards Generalist Computer Agents with Self-Improvement | self-improvement, environment, tools | Mission artifact accumulation (papers yaml, wiki drafts) as persistent skill library mirrors OS-Copilot's self-improv... | [link](https://arxiv.org/abs/2402.07469) |
| 42 | Ghost in the Minecraft: Generally Capable Agents for Open-World Environments via Large Language Models with Text-based Knowledge and Memory | memory, environment, planning | checkpoint.md as text-based world state + north-star goal tree parallels Ghost's knowledge-memory planning stack. | [link](https://arxiv.org/abs/2305.15191) |
| 43 | Teaching Large Language Models to Self-Debug | verification, self-improvement | REVIEW_VERDICT REVISE → fix implement slot formalizes Self-Debug's detect-fix loop with external critic gate. | [link](https://arxiv.org/abs/2304.05181) |
| 44 | LUMOS: Unified and Modular Training for Open-Source Language Agents | orchestration, planning, tools | Implement/review/verify runKinds as modular planning→grounding→execution pipeline mirrors Lumos architecture. | [link](https://arxiv.org/abs/2311.05657) |
| 45 | AutoAct: Automatic Agent Learning from Scratch for QA via Self-Planning | self-improvement, multi-agent, planning | Orchestrator spawning specialized implement/review slots from self-generated plans parallels AutoAct's sub-agent diff... | [link](https://arxiv.org/abs/2401.05268) |
| 46 | WorkArena: How Capable Are Web Agents at Solving Common Knowledge Work Tasks? | evaluation, environment | Enterprise-style Workbench mission tasks (yaml criteria, phase gates) stress agents like WorkArena's knowledge-work f... | [link](https://arxiv.org/abs/2403.07718) |
| 47 | AndroidWorld: A Dynamic Benchmarking Environment for Autonomous Agents | evaluation, resilience | Dynamic successCriteria per phase + device-state verify gates mirror AndroidWorld's procedurally varied eval instances. | [link](https://arxiv.org/abs/2405.14573) |
| 48 | API-Bank: A Comprehensive Benchmark for Tool-Augmented LLMs | tools, evaluation | MCP tool schemas + verify slot tool-call checks compose Juno's API-Bank-style tool-use eval harness. | [link](https://arxiv.org/abs/2304.08244) |
| 49 | RAP: Retrieval-Augmented Planning with Contextual Memory for Multimodal LLM Agents | memory, planning, retrieval | events.jsonl tail injected into manifest provides RAP-style retrieval of prior run context for current slot planning. | [link](https://arxiv.org/abs/2402.03610) |
| 50 | AgentStudio: A Toolkit for Building General Virtual Agents | evaluation, environment, observability | Workbench mission file tree + online task auto-eval + CriticBench-style success detection align with AgentStudio tool... | [link](https://arxiv.org/abs/2403.17918) |
| 51 | SeeAct: GPT-4V(ision) is a Generalist Web Agent, if Grounded | environment, tools | HUD market/web widgets + ui:smoke ground agent outputs in a live Next shell like SeeAct grounding. | [link](https://arxiv.org/abs/2401.01614) |
| 52 | WebVoyager: Building an End-to-End Web Agent with Large Multimodal Models | environment, planning | Long-horizon mission queue + checkpoint resume parallels WebVoyager's multi-step web task chains. | [link](https://arxiv.org/abs/2401.13919) |
| 53 | UFO: A UI-Focused Agent for Windows OS Interaction | environment, tools | Tauri desktop shell + Overseer panels mirror UFO's OS-level agent controlling a host application. | [link](https://arxiv.org/abs/2402.07939) |
| 54 | CogAgent: A Visual Language Model for GUI Agents | environment, tools | Future Juno GUI-agent slot would need CogAgent-style screen grounding; today scope-lock limits to repo/HUD. | [link](https://arxiv.org/abs/2312.08914) |
| 55 | Set-of-Marks Prompting Unleashes Extraordinary Visual Grounding in GPT-4V | tools, environment | Manifest prompt could inject Set-of-Marks-style structured anchors when agents operate HUD dev/component pages. | [link](https://arxiv.org/abs/2310.11441) |
| 56 | AgentGym: Evolving Language Agents with Interactive Environments | evaluation, self-improvement | Smoke/meta loop missions are Juno's AgentGym-style curriculum for orchestrator regression. | [link](https://arxiv.org/abs/2406.04108) |
| 57 | Agent Q: Advanced Reasoning and Learning for Autonomous AI Agents | planning, self-improvement | Review REVISE + re-queue fix slot approximates Agent Q's search over alternative implement trajectories. | [link](https://arxiv.org/abs/2408.07199) |
| 58 | MAGIS: LLM-Based Multi-Agent Collaboration Framework for GitHub Issue Resolution | multi-agent, orchestration | implement/review/verify run kinds map to MAGIS role split with shared checkpoint/events bus. | [link](https://arxiv.org/abs/2404.07738) |
| 59 | τ-bench: A Benchmark for Tool-Agent-User Interaction in Real-World Domains | evaluation, human-in-loop | Promote human gate + verify slot without code fixes mirrors τ-bench's user-in-the-loop tool agents. | [link](https://arxiv.org/abs/2406.08844) |
| 60 | AgentDojo: A Dynamic Environment to Evaluate Prompt Injection Attacks and Defenses for LLM Agents | safety, evaluation | destructive-ops-gate + vault-gate are Juno's AgentDojo-style defenses on shell/file/tool actions. | [link](https://arxiv.org/abs/2406.13353) |
| 61 | ToolEmu: Evaluating Tool-Use Agents in Emulated Tool-Management Systems | tools, safety | Dry-run spawn + simulate-smoke-loop emulate ToolEmu's safe sandbox before live scheduler slots. | [link](https://arxiv.org/abs/2409.03241) |
| 62 | AFlow: Automating Agentic Workflow Generation | orchestration, self-improvement | Meta loop self-optimizes Overseer workflow (runner + gate + queue-io)—AFlow-style search over our own loop. | [link](https://arxiv.org/abs/2410.10762) |
| 63 | Agent Laboratory: Using LLM Agents as Research Assistants | multi-agent, human-in-loop | This literature mission + synthesis wiki is a scoped Agent Laboratory; Juno Overseer generalizes the pattern. | [link](https://arxiv.org/abs/2501.04227) |
| 64 | MLAgentBench: Evaluating Language Agents on Machine Learning Experimentation | evaluation, environment | verify:desktop + orchestrator:build is Juno's MLAgentBench-lite for repo/agent stack changes. | [link](https://arxiv.org/abs/2310.03302) |
| 65 | DiscoveryWorld: A Virtual Environment for Developing and Evaluating Automated Scientific Discovery Agents | environment, evaluation | Mission north-star + phased queue emulate DiscoveryWorld's structured scientific task decomposition. | [link](https://arxiv.org/abs/2406.10880) |
| 66 | DyLAN: A Dynamic LLM-Powered Agent Network for Task-Oriented Agent Collaboration | multi-agent, orchestration | Scheduler picks next queue head; future DyLAN-style routing could rank among backlog candidates. | [link](https://arxiv.org/abs/2310.05585) |
| 67 | OpenAgents: An Open Platform for Language Agents in the Wild | tools, environment | Juno HUD + Workbench + orchestrator is an OpenAgents-style platform narrowed to long-horizon dev missions. | [link](https://arxiv.org/abs/2310.10628) |
| 68 | XAgent: An Autonomous Agent for Complex Task Solving | planning, tools | spawn-run dispatches Composer slots with manifest-defined tools—XAgent dispatcher pattern at mission scale. | [link](https://arxiv.org/abs/2312.03253) |
| 69 | GuardAgent: Safeguard LLM Agents by a Guard Agent via Knowledge-Enabled Reasoning | safety, verification | executor_review + destructive-ops hook + loop-gate form a GuardAgent layer over implement slots. | [link](https://arxiv.org/abs/2406.09139) |
| 70 | CollabLLM: From Passive Responders to Active Collaborators | human-in-loop, communication | Promote panel + REVISE must_fix lists implement CollabLLM-style human-agent co-construction. | [link](https://arxiv.org/abs/2412.01153) |
| 71 | MacNet: Multi-Agent Collaboration Networks for Software Development | multi-agent, orchestration | events.jsonl as message bus + queue phases scale toward MacNet-style SDE agent graphs within missions. | [link](https://arxiv.org/abs/2406.11856) |
| 72 | A Survey on Evaluation of LLM-based Agents | evaluation, observability | Juno's verify stack (test/lint/build/ui:smoke/loop:smoke) maps to survey §2–§6 eval dimensions. | [link](https://arxiv.org/abs/2503.16416) |
| 73 | Beyond Self-Talk: A Communication-Centric Survey of LLM-Based Multi-Agent Systems | multi-agent, communication | checkpoint + REVIEW_VERDICT + events tail are Juno's structured inter-agent communication protocol. | [link](https://arxiv.org/abs/2502.14321) |
| 74 | Cradle: Empowering Foundation Agents Towards General Computer Control | environment, planning | Overseer loop (implement→review→verify) is Cradle's skill loop specialized for software repos. | [link](https://arxiv.org/abs/2403.03181) |
| 75 | Chain-of-Agents: End-to-End Agent Foundation Models via Multi-Agent Distillation and Agent Embedding | multi-agent, orchestration | Fixed implement/review/verify chain is a hand-crafted Chain-of-Agents prior over Juno mission slots. | [link](https://arxiv.org/abs/2406.02830) |
| 76 | Lemur: Harmonizing Natural Language and Code for Language Agents | tools, planning | Implement slots in juno-overseer repo target Lemur-style code+NL action in scoped paths. | [link](https://arxiv.org/abs/2310.04703) |
| 77 | ReWOO: Decoupling Reasoning from Observations for Efficient Augmented Language Models | planning, efficiency | Review slot reads-only plans verdict; implement slot executes—ReWOO-style planner/worker split. | [link](https://arxiv.org/abs/2305.18323) |
| 78 | Retroformer: Retrospective Large Language Agents with Policy Gradient Optimization | self-improvement, planning | events.jsonl + REVISE loops provide retrospective traces without online RL—Retroformer-inspired feedback. | [link](https://arxiv.org/abs/2308.02248) |
| 79 | G-Retriever: Retrieval-Augmented Generation for Textual Graph Understanding and Question Answering | retrieval, memory | Mission wiki + taxonomy + batch YAML form a graph RAG corpus for synthesis slots. | [link](https://arxiv.org/abs/2402.07622) |
| 80 | AutoWebGLM: A Large Language Model-based Web Navigating Agent | environment, planning | ui:smoke navigates simplified Next HTML output—AutoWebGLM-style lightweight web observation. | [link](https://arxiv.org/abs/2404.03648) |
| 81 | AgentBoard: An Analytical Evaluation Board of Multi-turn LLM Agents | evaluation, observability | Mission Board + events tail + VERIFY_REPORT compose an AgentBoard for Overseer runs. | [link](https://arxiv.org/abs/2401.03565) |
| 82 | VisualAgentBench: Towards Large Multimodal Models as Visual Foundation Agents | evaluation, environment | Future Juno eval could add VisualAgentBench-style HUD screenshot regression alongside ui:smoke. | [link](https://arxiv.org/abs/2407.08574) |
| 83 | OmniACT: A Dataset and Benchmark for Enabling Multimodal Generalist Autonomous Agents for Desktop and Web | environment, evaluation | Tauri desktop + browser dev URL gives Juno a mini OmniACT surface for agent eval expansion. | [link](https://arxiv.org/abs/2402.17507) |
| 84 | EvoAgent: Toward Automatic Multi-Agent Generation via Evolutionary Algorithms | multi-agent, self-improvement | AFlow + meta loop suggest evolving queue templates/prompts—EvoAgent for Overseer mission graphs. | [link](https://arxiv.org/abs/2407.04050) |
| 85 | MultiAgentBench: Evaluating the Collaboration and Competition of LLM Agents | multi-agent, evaluation | implement/review/verify trio is MultiAgentBench-style cooperative team with shared mission reward. | [link](https://arxiv.org/abs/2503.01983) |
| 86 | AgentHarm: A Benchmark for Measuring Harmfulness of LLM Agents | safety, evaluation | destructive-ops-gate + scope-lock + BLOCK verdict align with AgentHarm-style harmful action prevention. | [link](https://arxiv.org/abs/2501.01843) |
| 87 | AutoGuide: Automated Generation and Selection of Context-Dependent Instructions for LLM Agents | retrieval, planning | buildUserPrompt injects mission scope-lock + quality doctrine—AutoGuide for Overseer prompts. | [link](https://arxiv.org/abs/2405.05025) |
| 88 | PaperBench: Evaluating AI Agents on Replicating AI Research | evaluation, environment | Literature mission + synthesis wiki is inverse PaperBench—curate knowledge then map to Juno architecture. | [link](https://arxiv.org/abs/2504.01848) |
| 89 | ST-WebAgentBench: A Benchmark for Evaluating Safety and Trustworthiness of Web Agents | safety, evaluation | Vault-gate + destructive hook are ST-WebAgentBench-style trust constraints on agent file/shell access. | [link](https://arxiv.org/abs/2410.06790) |
| 90 | OctoTools: An Agentic Framework with Extensible Tools for Complex Reasoning | tools, orchestration | Manifest provider routing (Composer vs api_token) + MCP tools mirror OctoTools manager/planner split. | [link](https://arxiv.org/abs/2502.11276) |
| 91 | SafeAgentBench: A Benchmark for Safe Task Planning of Embodied LLM Agents | safety, planning | scope-lock forbidden paths + BLOCK on destructive events are SafeAgentBench-style plan safety checks. | [link](https://arxiv.org/abs/2412.03568) |
| 92 | Agent-FLAN: Designing Data and Methods for Effective Agent Tuning | tools, self-improvement | Curated prompts/ in Workbench are Agent-FLAN-style task templates for specialized run kinds. | [link](https://arxiv.org/abs/2407.01476) |
| 93 | Voyager Skill Library (follow-on): Automatic Skill Discovery in Minecraft | memory, self-improvement | Completed mission checkpoints + wiki artifacts form a reusable skill library for future Juno missions. | [link](https://arxiv.org/abs/2405.04217) |
| 94 | Agents: An Open-source Framework for Autonomous Language Agents | orchestration, tools | Juno Overseer stack (Workbench + orchestrator + HUD) is a domain-specific Agents framework. | [link](https://arxiv.org/abs/2309.07870) |
| 95 | MetaAgents: Simulating Interactions of Human Behaviors for LLM-based Task-Oriented Coordination | multi-agent, planning | Run kind personas (implement/review/verify) are MetaAgents-style role simulation without social fluff. | [link](https://arxiv.org/abs/2310.06500) |
| 96 | ToolChain*: Efficient Action Space Navigation in Large Language Model with A* Search | planning, tools | Queue ordering + review gates prune bad tool/action branches—ToolChain* over mission action space. | [link](https://arxiv.org/abs/2310.13227) |
| 97 | Automated Design of Agentic Systems | orchestration, self-improvement | Meta loop optimizes Overseer control flow—ADAS-style meta-design of implement/review/verify graphs. | [link](https://arxiv.org/abs/2407.08007) |
| 98 | Large Language Models as Optimizers | self-improvement, planning | Meta loop + AFlow analogy: Overseer prompts/queue templates are OPRO-optimizable artifacts. | [link](https://arxiv.org/abs/2309.03409) |
| 99 | Flow: Modularized Agentic Workflow Automation | orchestration, efficiency | Implement/review/verify slots are Flow-style modules; meta loop searches better phase graphs. | [link](https://arxiv.org/abs/2407.07151) |
| 100 | A Survey on Large Language Model based Autonomous Agents | orchestration, memory, evaluation | taxonomy.md + this mission's 16 dimensions operationalize the survey's agent component stack for Juno. | [link](https://arxiv.org/abs/2309.07864) |

---

## 主题分布（篇次，可重复计数）

| 主题 | 篇次 |
|------|------|
| `environment` | 32 |
| `tools` | 30 |
| `evaluation` | 29 |
| `planning` | 25 |
| `self-improvement` | 19 |
| `orchestration` | 19 |
| `multi-agent` | 18 |
| `memory` | 9 |
| `safety` | 6 |
| `communication` | 4 |
| `verification` | 4 |
| `human-in-loop` | 4 |
| `retrieval` | 4 |
| `observability` | 3 |
| `efficiency` | 2 |
| `resilience` | 1 |

**合计**：100 篇