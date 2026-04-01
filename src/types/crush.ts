export type CrushMcpServer = {
  type: "stdio" | "http" | "sse"
  command?: string
  args?: string[]
  url?: string
  timeout?: number
  env?: Record<string, string>
  headers?: Record<string, string>
  disabled?: boolean
}

export type CrushConfig = {
  $schema?: string
  mcp?: Record<string, CrushMcpServer>
}

export type CrushCommandFile = {
  name: string
  content: string
}

export type CrushGeneratedSkill = {
  name: string
  content: string
}

export type CrushSkillDir = {
  name: string
  sourceDir: string
}

export type CrushBundle = {
  config: CrushConfig
  commandFiles: CrushCommandFile[]
  generatedSkills: CrushGeneratedSkill[]
  skillDirs: CrushSkillDir[]
}
