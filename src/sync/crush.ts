import path from "path"
import type { ClaudeHomeConfig } from "../parsers/claude-home"
import type { ClaudeMcpServer } from "../types/claude"
import type { CrushMcpServer } from "../types/crush"
import { syncCrushCommands } from "./commands"
import { mergeJsonConfigAtKey } from "./json-config"
import { syncSkills } from "./skills"

export async function syncToCrush(
  config: ClaudeHomeConfig,
  outputRoot: string,
): Promise<void> {
  await syncSkills(config.skills, path.join(outputRoot, "skills"))
  await syncCrushCommands(config, outputRoot)

  if (Object.keys(config.mcpServers).length > 0) {
    const configPath = path.join(outputRoot, "crush.json")
    const converted = convertMcpForCrush(config.mcpServers)
    await mergeJsonConfigAtKey({
      configPath,
      key: "mcp",
      incoming: converted,
    })
  }
}

function convertMcpForCrush(
  servers: Record<string, ClaudeMcpServer>,
): Record<string, CrushMcpServer> {
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
