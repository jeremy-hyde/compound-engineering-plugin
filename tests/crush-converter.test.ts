import { describe, expect, test, spyOn } from "bun:test"
import { convertClaudeToCrush, transformContentForCrush } from "../src/converters/claude-to-crush"
import { parseFrontmatter } from "../src/utils/frontmatter"
import type { ClaudePlugin } from "../src/types/claude"

const fixturePlugin: ClaudePlugin = {
  root: "/tmp/plugin",
  manifest: { name: "fixture", version: "1.0.0" },
  agents: [
    {
      name: "Security Reviewer",
      description: "Security-focused code review agent",
      capabilities: ["Threat modeling", "OWASP"],
      model: "claude-sonnet-4-20250514",
      body: "Focus on vulnerabilities.",
      sourcePath: "/tmp/plugin/agents/security-reviewer.md",
    },
  ],
  commands: [
    {
      name: "workflows:plan",
      description: "Planning command",
      argumentHint: "[FOCUS]",
      model: "inherit",
      allowedTools: ["Read"],
      body: "Plan the work.",
      sourcePath: "/tmp/plugin/commands/workflows/plan.md",
    },
  ],
  skills: [
    {
      name: "existing-skill",
      description: "Existing skill",
      sourceDir: "/tmp/plugin/skills/existing-skill",
      skillPath: "/tmp/plugin/skills/existing-skill/SKILL.md",
    },
  ],
  hooks: undefined,
  mcpServers: undefined,
}

const defaultOptions = {
  agentMode: "subagent" as const,
  inferTemperature: false,
  permissions: "none" as const,
}

describe("convertClaudeToCrush", () => {
  test("converts agents to SKILL.md with name and description", () => {
    const bundle = convertClaudeToCrush(fixturePlugin, defaultOptions)

    const agentSkill = bundle.generatedSkills.find((s) => s.name === "security-reviewer")
    expect(agentSkill).toBeDefined()

    const parsed = parseFrontmatter(agentSkill!.content)
    expect(parsed.data.name).toBe("security-reviewer")
    expect(parsed.data.description).toBe("Security-focused code review agent")
    expect(parsed.body).toContain("Capabilities")
    expect(parsed.body).toContain("Threat modeling")
    expect(parsed.body).toContain("Focus on vulnerabilities.")
  })

  test("commands produce both a command file and a backing skill", () => {
    const bundle = convertClaudeToCrush(fixturePlugin, defaultOptions)

    // fixturePlugin has 1 skill (existing-skill, with description) + 1 command (workflows:plan)
    expect(bundle.commandFiles).toHaveLength(2)
    const cmd = bundle.commandFiles.find((c) => c.name === "workflows:plan")!
    expect(cmd).toBeDefined()

    const cmdParsed = parseFrontmatter(cmd.content)
    expect(cmdParsed.data.description).toBe("Planning command")
    expect(cmdParsed.data["argument-hint"]).toBe("[FOCUS]")
    expect(cmdParsed.body).toContain("Use the workflows-plan skill")

    const skill = bundle.generatedSkills.find((s) => s.name === "workflows-plan")
    expect(skill).toBeDefined()
    const skillParsed = parseFrontmatter(skill!.content)
    expect(skillParsed.body).toContain("Plan the work.")
  })

  test("command file name preserves colons for subdirectory nesting (ce:work -> commands/ce/work.md)", () => {
    const plugin: ClaudePlugin = {
      ...fixturePlugin,
      agents: [],
      commands: [
        {
          name: "ce:work",
          description: "Do the work",
          body: "Work instructions.",
          sourcePath: "/tmp/plugin/commands/ce-work.md",
        },
      ],
      skills: [],
    }

    const bundle = convertClaudeToCrush(plugin, defaultOptions)
    expect(bundle.commandFiles[0].name).toBe("ce:work")
  })

  test("commands with disableModelInvocation are excluded", () => {
    const plugin: ClaudePlugin = {
      ...fixturePlugin,
      agents: [],
      commands: [
        {
          name: "hidden",
          description: "No model",
          body: "Hidden.",
          disableModelInvocation: true,
          sourcePath: "/tmp/plugin/commands/hidden.md",
        },
      ],
      skills: [],
    }

    const bundle = convertClaudeToCrush(plugin, defaultOptions)
    expect(bundle.commandFiles).toHaveLength(0)
    expect(bundle.generatedSkills).toHaveLength(0)
  })

  test("agent description fallback generated if missing", () => {
    const plugin: ClaudePlugin = {
      ...fixturePlugin,
      agents: [
        {
          name: "basic-agent",
          body: "Do things.",
          sourcePath: "/tmp/plugin/agents/basic.md",
        },
      ],
      commands: [],
      skills: [],
    }

    const bundle = convertClaudeToCrush(plugin, defaultOptions)
    const parsed = parseFrontmatter(bundle.generatedSkills[0].content)
    expect(parsed.data.description).toBe("Converted from Claude agent basic-agent")
  })

  test("agent with empty body gets default body", () => {
    const plugin: ClaudePlugin = {
      ...fixturePlugin,
      agents: [
        {
          name: "empty-agent",
          description: "Empty agent",
          body: "",
          sourcePath: "/tmp/plugin/agents/empty.md",
        },
      ],
      commands: [],
      skills: [],
    }

    const bundle = convertClaudeToCrush(plugin, defaultOptions)
    const parsed = parseFrontmatter(bundle.generatedSkills[0].content)
    expect(parsed.body).toContain("Instructions converted from the empty-agent agent.")
  })

  test("agent capabilities are prepended to body", () => {
    const bundle = convertClaudeToCrush(fixturePlugin, defaultOptions)
    const agentSkill = bundle.generatedSkills.find((s) => s.name === "security-reviewer")!
    const parsed = parseFrontmatter(agentSkill.content)
    expect(parsed.body).toMatch(/## Capabilities\n- Threat modeling\n- OWASP/)
  })

  test("command with argument-hint gets it in command file frontmatter and Arguments section in skill", () => {
    const bundle = convertClaudeToCrush(fixturePlugin, defaultOptions)

    const cmd = bundle.commandFiles.find((c) => c.name === "workflows:plan")!
    const cmdParsed = parseFrontmatter(cmd.content)
    expect(cmdParsed.data["argument-hint"]).toBe("[FOCUS]")

    const skill = bundle.generatedSkills.find((s) => s.name === "workflows-plan")!
    expect(skill.content).toContain("## Arguments")
    expect(skill.content).toContain("[FOCUS]")
  })

  test("passes through skill directories", () => {
    const bundle = convertClaudeToCrush(fixturePlugin, defaultOptions)
    expect(bundle.skillDirs).toHaveLength(1)
    expect(bundle.skillDirs[0].name).toBe("existing-skill")
    expect(bundle.skillDirs[0].sourceDir).toBe("/tmp/plugin/skills/existing-skill")
  })

  test("skill and generated skill name collision is deduplicated", () => {
    const plugin: ClaudePlugin = {
      ...fixturePlugin,
      agents: [],
      commands: [
        {
          name: "existing-skill",
          description: "Colliding command",
          body: "This collides with skill name.",
          sourcePath: "/tmp/plugin/commands/existing-skill.md",
        },
      ],
    }

    const bundle = convertClaudeToCrush(plugin, defaultOptions)
    expect(bundle.generatedSkills[0].name).toBe("existing-skill-2")
    expect(bundle.skillDirs[0].name).toBe("existing-skill")
  })

  test("agent and command name collision after normalization is deduplicated", () => {
    const plugin: ClaudePlugin = {
      ...fixturePlugin,
      agents: [
        {
          name: "plan",
          description: "Plan agent",
          body: "Plan agent body.",
          sourcePath: "/tmp/plugin/agents/plan.md",
        },
      ],
      commands: [
        {
          name: "workflows:plan",
          description: "Plan command",
          body: "Plan command body.",
          sourcePath: "/tmp/plugin/commands/workflows/plan.md",
        },
      ],
      skills: [],
    }

    const bundle = convertClaudeToCrush(plugin, defaultOptions)
    const skillNames = bundle.generatedSkills.map((s) => s.name)
    expect(skillNames[0]).toBe("plan")
    expect(skillNames[1]).toBe("workflows-plan")
  })

  test("converts stdio MCP servers", () => {
    const plugin: ClaudePlugin = {
      ...fixturePlugin,
      agents: [],
      commands: [],
      skills: [],
      mcpServers: {
        playwright: {
          command: "npx",
          args: ["-y", "@anthropic/mcp-playwright"],
          env: { DISPLAY: ":0" },
        },
      },
    }

    const bundle = convertClaudeToCrush(plugin, defaultOptions)
    expect(bundle.config.mcp).toBeDefined()
    expect(bundle.config.mcp!.playwright.type).toBe("stdio")
    expect(bundle.config.mcp!.playwright.command).toBe("npx")
    expect(bundle.config.mcp!.playwright.args).toEqual(["-y", "@anthropic/mcp-playwright"])
    expect(bundle.config.mcp!.playwright.env).toEqual({ DISPLAY: ":0" })
  })

  test("converts http MCP servers", () => {
    const plugin: ClaudePlugin = {
      ...fixturePlugin,
      agents: [],
      commands: [],
      skills: [],
      mcpServers: {
        context7: {
          url: "https://mcp.context7.com/mcp",
          headers: { "x-api-key": "${CONTEXT7_API_KEY:-}" },
        },
      },
    }

    const bundle = convertClaudeToCrush(plugin, defaultOptions)
    expect(bundle.config.mcp!.context7.type).toBe("http")
    expect(bundle.config.mcp!.context7.url).toBe("https://mcp.context7.com/mcp")
    expect(bundle.config.mcp!.context7.headers).toEqual({ "x-api-key": "${CONTEXT7_API_KEY:-}" })
  })

  test("config has schema URL", () => {
    const bundle = convertClaudeToCrush(fixturePlugin, defaultOptions)
    expect(bundle.config.$schema).toBe("https://charm.land/crush.json")
  })

  test("config mcp is undefined when no MCP servers", () => {
    const bundle = convertClaudeToCrush(fixturePlugin, defaultOptions)
    expect(bundle.config.mcp).toBeUndefined()
  })

  test("warns when hooks are present", () => {
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {})

    const plugin: ClaudePlugin = {
      ...fixturePlugin,
      agents: [],
      commands: [],
      skills: [],
      hooks: {
        hooks: {
          PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "echo test" }] }],
        },
      },
    }

    convertClaudeToCrush(plugin, defaultOptions)
    expect(warnSpy).toHaveBeenCalledWith(
      "Warning: Crush does not support hooks. Hooks were skipped during conversion.",
    )

    warnSpy.mockRestore()
  })

  test("no warning when hooks are absent", () => {
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {})
    convertClaudeToCrush(fixturePlugin, defaultOptions)
    expect(warnSpy).not.toHaveBeenCalled()
    warnSpy.mockRestore()
  })

  test("plugin with zero agents and commands produces empty generatedSkills; skills with descriptions still get command files", () => {
    const plugin: ClaudePlugin = { ...fixturePlugin, agents: [], commands: [] }
    const bundle = convertClaudeToCrush(plugin, defaultOptions)
    expect(bundle.generatedSkills).toHaveLength(0)
    // existing-skill has a description so it gets a command file
    expect(bundle.commandFiles).toHaveLength(1)
    expect(bundle.commandFiles[0].name).toBe("existing-skill")
  })

  test("skills with disable-model-invocation are excluded from command files", () => {
    const plugin: ClaudePlugin = {
      ...fixturePlugin,
      agents: [],
      commands: [],
      skills: [
        {
          name: "changelog",
          description: "Create changelogs",
          disableModelInvocation: true,
          sourceDir: "/tmp/plugin/skills/changelog",
          skillPath: "/tmp/plugin/skills/changelog/SKILL.md",
        },
      ],
    }
    const bundle = convertClaudeToCrush(plugin, defaultOptions)
    expect(bundle.commandFiles).toHaveLength(0)
  })

  test("skill command file carries description and argument-hint from skill frontmatter", () => {
    const plugin: ClaudePlugin = {
      ...fixturePlugin,
      agents: [],
      commands: [],
      skills: [
        {
          name: "ce:work",
          description: "Execute work efficiently",
          argumentHint: "[Plan doc path]",
          sourceDir: "/tmp/plugin/skills/ce-work",
          skillPath: "/tmp/plugin/skills/ce-work/SKILL.md",
        },
      ],
    }
    const bundle = convertClaudeToCrush(plugin, defaultOptions)
    expect(bundle.commandFiles).toHaveLength(1)
    const cmd = bundle.commandFiles[0]
    expect(cmd.name).toBe("ce:work")
    const parsed = parseFrontmatter(cmd.content)
    expect(parsed.data.description).toBe("Execute work efficiently")
    expect(parsed.data["argument-hint"]).toBe("[Plan doc path]")
    expect(parsed.body).toContain("Use the ce-work skill")
  })
})

describe("transformContentForCrush", () => {
  test("rewrites .claude/ paths to .crush/", () => {
    const input = "Read `.claude/compound-engineering.local.md` for config."
    const result = transformContentForCrush(input)
    expect(result).toContain(".crush/compound-engineering.local.md")
    expect(result).not.toContain(".claude/")
  })

  test("rewrites ~/.claude/ paths to ~/.config/crush/", () => {
    const input = "Global config at ~/.claude/settings.json"
    const result = transformContentForCrush(input)
    expect(result).toContain("~/.config/crush/settings.json")
    expect(result).not.toContain("~/.claude/")
  })

  test("transforms Task agent calls to skill references", () => {
    const input = `Run agents:

- Task repo-research-analyst(feature_description)
- Task learnings-researcher(feature_description)

Task best-practices-researcher(topic)`

    const result = transformContentForCrush(input)
    expect(result).toContain("Use the repo-research-analyst skill to: feature_description")
    expect(result).toContain("Use the learnings-researcher skill to: feature_description")
    expect(result).toContain("Use the best-practices-researcher skill to: topic")
    expect(result).not.toContain("Task repo-research-analyst(")
  })

  test("transforms namespaced Task agent calls using final segment", () => {
    const input = `- Task compound-engineering:research:repo-research-analyst(feature_description)
- Task compound-engineering:review:security-reviewer(code_diff)`

    const result = transformContentForCrush(input)
    expect(result).toContain("Use the repo-research-analyst skill to: feature_description")
    expect(result).toContain("Use the security-reviewer skill to: code_diff")
    expect(result).not.toContain("compound-engineering:")
  })

  test("transforms zero-argument Task calls", () => {
    const input = `- Task compound-engineering:review:code-simplicity-reviewer()`
    const result = transformContentForCrush(input)
    expect(result).toContain("Use the code-simplicity-reviewer skill")
    expect(result).not.toContain("compound-engineering:")
    expect(result).not.toContain("skill to:")
  })

  test("replaces colons with hyphens in slash commands", () => {
    const input = `1. Run /todo-resolve to enhance
2. Start /workflows:work to implement
3. File at /tmp/output.md`

    const result = transformContentForCrush(input)
    expect(result).toContain("/todo-resolve")
    expect(result).toContain("/workflows-work")
    expect(result).not.toContain("/workflows:work")
    expect(result).toContain("/tmp/output.md")
  })

  test("transforms @agent references to skill references", () => {
    const input = "Have @security-sentinel and @dhh-rails-reviewer check the code."
    const result = transformContentForCrush(input)
    expect(result).toContain("the security-sentinel skill")
    expect(result).toContain("the dhh-rails-reviewer skill")
    expect(result).not.toContain("@security-sentinel")
  })
})
