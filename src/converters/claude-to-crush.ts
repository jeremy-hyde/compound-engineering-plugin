import { formatFrontmatter } from "../utils/frontmatter"
import { sanitizePathName } from "../utils/files"
import type { ClaudeAgent, ClaudeCommand, ClaudeMcpServer, ClaudePlugin, ClaudeSkill } from "../types/claude"
import type {
  CrushBundle,
  CrushCommandFile,
  CrushConfig,
  CrushGeneratedSkill,
  CrushMcpServer,
} from "../types/crush"
import type { ClaudeToOpenCodeOptions } from "./claude-to-opencode"

export type ClaudeToCrushOptions = ClaudeToOpenCodeOptions

export function convertClaudeToCrush(
  plugin: ClaudePlugin,
  _options: ClaudeToCrushOptions,
): CrushBundle {
  const usedSkillNames = new Set<string>()

  // Skills are copied as-is (already valid agentskills.io format).
  // Skills with a description also get a slash-invocable command file so users
  // can trigger them directly via /ce-work, /ce-plan, etc. Skills marked
  // disable-model-invocation are excluded from the command surface.
  const skillDirs = plugin.skills.map((skill) => {
    usedSkillNames.add(sanitizePathName(skill.name))
    return { name: skill.name, sourceDir: skill.sourceDir }
  })

  const skillCommandFiles: CrushCommandFile[] = plugin.skills
    .filter((skill) => skill.description && !skill.disableModelInvocation)
    .map((skill) => convertSkillToCommandFile(skill))

  const agentSkills = plugin.agents.map((agent) =>
    convertAgentToSkill(agent, usedSkillNames),
  )

  // Explicit plugin commands (rare in this repo) also get a command + skill pair.
  const commandPairs = plugin.commands
    .filter((command) => !command.disableModelInvocation)
    .map((command) => convertCommand(command, usedSkillNames))

  const commandFiles: CrushCommandFile[] = [
    ...skillCommandFiles,
    ...commandPairs.map((p) => p.commandFile),
  ]
  const commandSkills: CrushGeneratedSkill[] = commandPairs.map((p) => p.skill)

  const generatedSkills = [...agentSkills, ...commandSkills]

  const mcp = convertMcpServers(plugin.mcpServers)

  const config: CrushConfig = {
    $schema: "https://charm.land/crush.json",
    mcp: mcp && Object.keys(mcp).length > 0 ? mcp : undefined,
  }

  if (plugin.hooks && Object.keys(plugin.hooks.hooks).length > 0) {
    console.warn("Warning: Crush does not support hooks. Hooks were skipped during conversion.")
  }

  return { config, commandFiles, generatedSkills, skillDirs }
}

function convertAgentToSkill(
  agent: ClaudeAgent,
  usedNames: Set<string>,
): CrushGeneratedSkill {
  const name = uniqueName(normalizeName(agent.name), usedNames)
  const description = agent.description ?? `Converted from Claude agent ${agent.name}`

  const frontmatter: Record<string, unknown> = {
    name,
    description,
  }

  let body = transformContentForCrush(agent.body.trim())
  if (agent.capabilities && agent.capabilities.length > 0) {
    const capabilities = agent.capabilities.map((c) => `- ${c}`).join("\n")
    body = `## Capabilities\n${capabilities}\n\n${body}`.trim()
  }
  if (body.length === 0) {
    body = `Instructions converted from the ${agent.name} agent.`
  }

  const content = formatFrontmatter(frontmatter, body)
  return { name, content }
}

function convertSkillToCommandFile(skill: ClaudeSkill): CrushCommandFile {
  const name = skill.name
  const skillName = normalizeName(skill.name)
  const frontmatter: Record<string, unknown> = {
    description: skill.description,
  }
  if (skill.argumentHint) {
    frontmatter["argument-hint"] = skill.argumentHint
  }
  const body = `Use the ${skillName} skill for this command and follow its instructions.`
  return { name, content: formatFrontmatter(frontmatter, body) }
}

function convertCommand(
  command: ClaudeCommand,
  usedNames: Set<string>,
): { commandFile: CrushCommandFile; skill: CrushGeneratedSkill } {
  const skillName = uniqueName(normalizeName(command.name), usedNames)

  // Skill file: holds the full instructions for the agent
  const skillFrontmatter: Record<string, unknown> = {
    name: skillName,
  }
  if (command.description) {
    skillFrontmatter.description = command.description
  }

  const sections: string[] = []
  if (command.argumentHint) {
    sections.push(`## Arguments\n${command.argumentHint}`)
  }
  const transformedBody = transformContentForCrush(command.body.trim())
  sections.push(transformedBody)
  const skillBody = sections.filter(Boolean).join("\n\n").trim()
  const skill: CrushGeneratedSkill = {
    name: skillName,
    content: formatFrontmatter(skillFrontmatter, skillBody),
  }

  // Command file: the slash-invocable entry point that delegates to the skill
  const commandFrontmatter: Record<string, unknown> = {}
  if (command.description) {
    commandFrontmatter.description = command.description
  }
  if (command.argumentHint) {
    commandFrontmatter["argument-hint"] = command.argumentHint
  }
  const commandBody = `Use the ${skillName} skill for this command and follow its instructions.`
  const commandFile: CrushCommandFile = {
    name: command.name,
    content: formatFrontmatter(commandFrontmatter, commandBody),
  }

  return { commandFile, skill }
}

export function transformContentForCrush(body: string): string {
  let result = body

  // 1. Transform Task agent calls (supports namespaced names like compound-engineering:research:agent-name)
  const taskPattern = /^(\s*-?\s*)Task\s+([a-z][a-z0-9:-]*)\(([^)]*)\)/gm
  result = result.replace(taskPattern, (_match, prefix: string, agentName: string, args: string) => {
    const finalSegment = agentName.includes(":") ? agentName.split(":").pop()! : agentName
    const skillName = normalizeName(finalSegment)
    const trimmedArgs = args.trim()
    return trimmedArgs
      ? `${prefix}Use the ${skillName} skill to: ${trimmedArgs}`
      : `${prefix}Use the ${skillName} skill`
  })

  // 2. Transform slash command references (replace colons with hyphens)
  const slashCommandPattern = /(?<![:\w])\/([a-z][a-z0-9_:-]*?)(?=[\s,."')\]}`]|$)/gi
  result = result.replace(slashCommandPattern, (match, commandName: string) => {
    if (commandName.includes("/")) return match
    if (["dev", "tmp", "etc", "usr", "var", "bin", "home"].includes(commandName)) return match
    const normalized = normalizeName(commandName)
    return `/${normalized}`
  })

  // 3. Rewrite .claude/ paths to .crush/ and ~/.claude/ to ~/.config/crush/
  result = result
    .replace(/~\/\.claude\//g, "~/.config/crush/")
    .replace(/\.claude\//g, ".crush/")

  // 4. Transform @agent-name references
  const agentRefPattern =
    /@([a-z][a-z0-9-]*-(?:agent|reviewer|researcher|analyst|specialist|oracle|sentinel|guardian|strategist))/gi
  result = result.replace(agentRefPattern, (_match, agentName: string) => {
    return `the ${normalizeName(agentName)} skill`
  })

  return result
}

function convertMcpServers(
  servers?: Record<string, ClaudeMcpServer>,
): Record<string, CrushMcpServer> | undefined {
  if (!servers || Object.keys(servers).length === 0) return undefined

  const result: Record<string, CrushMcpServer> = {}
  for (const [name, server] of Object.entries(servers)) {
    if (server.command) {
      const entry: CrushMcpServer = {
        type: "stdio",
        command: server.command,
      }
      if (server.args && server.args.length > 0) entry.args = server.args
      if (server.env && Object.keys(server.env).length > 0) entry.env = server.env
      result[name] = entry
      continue
    }

    if (server.url) {
      const entry: CrushMcpServer = {
        type: "http",
        url: server.url,
      }
      if (server.headers && Object.keys(server.headers).length > 0) entry.headers = server.headers
      result[name] = entry
    }
  }
  return result
}

function normalizeName(value: string): string {
  const trimmed = value.trim()
  if (!trimmed) return "item"
  const normalized = trimmed
    .toLowerCase()
    .replace(/[\\/]+/g, "-")
    .replace(/[:\s]+/g, "-")
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
  return normalized || "item"
}

function uniqueName(base: string, used: Set<string>): string {
  if (!used.has(base)) {
    used.add(base)
    return base
  }
  let index = 2
  while (used.has(`${base}-${index}`)) {
    index += 1
  }
  const name = `${base}-${index}`
  used.add(name)
  return name
}
