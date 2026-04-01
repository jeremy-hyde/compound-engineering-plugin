import path from "path"
import { backupFile, copySkillDir, ensureDir, sanitizePathName, writeJson, writeText } from "../utils/files"
import { transformContentForCrush } from "../converters/claude-to-crush"
import type { CrushBundle, CrushConfig } from "../types/crush"

export async function writeCrushBundle(outputRoot: string, bundle: CrushBundle): Promise<void> {
  const paths = resolveCrushPaths(outputRoot)
  await ensureDir(paths.configDir)
  await ensureDir(paths.commandsDir)
  await ensureDir(paths.skillsDir)

  const hadExistingConfig = await import("../utils/files").then(({ pathExists }) => pathExists(paths.configPath))
  const backupPath = await backupFile(paths.configPath)
  if (backupPath) {
    console.log(`Backed up existing config to ${backupPath}`)
  }
  const merged = await mergeCrushConfig(paths.configPath, bundle.config)
  await writeJson(paths.configPath, merged)
  if (hadExistingConfig) {
    console.log("Merged plugin config into existing crush.json (user settings preserved)")
  }

  if (bundle.commandFiles.length > 0) {
    const commandsDir = paths.commandsDir
    for (const cmd of bundle.commandFiles) {
      const cmdPath = cmd.name.replace(/:/g, "/")
      await writeText(path.join(commandsDir, `${cmdPath}.md`), cmd.content + "\n")
    }
  }

  if (bundle.generatedSkills.length > 0) {
    const skillsDir = paths.skillsDir
    for (const skill of bundle.generatedSkills) {
      await writeText(path.join(skillsDir, sanitizePathName(skill.name), "SKILL.md"), skill.content + "\n")
    }
  }

  if (bundle.skillDirs.length > 0) {
    const skillsDir = paths.skillsDir
    for (const skill of bundle.skillDirs) {
      await copySkillDir(skill.sourceDir, path.join(skillsDir, sanitizePathName(skill.name)), transformContentForCrush)
    }
  }
}

async function mergeCrushConfig(
  configPath: string,
  incoming: CrushConfig,
): Promise<CrushConfig> {
  const { pathExists, readJson } = await import("../utils/files")

  if (!(await pathExists(configPath))) return incoming

  let existing: CrushConfig
  try {
    existing = await readJson<CrushConfig>(configPath)
  } catch {
    console.warn(
      `Warning: existing ${configPath} is not valid JSON. Writing plugin config without merging.`
    )
    return incoming
  }

  // User config wins on conflict
  const mergedMcp = {
    ...(incoming.mcp ?? {}),
    ...(existing.mcp ?? {}),
  }

  return {
    ...existing,
    $schema: incoming.$schema ?? existing.$schema,
    mcp: Object.keys(mergedMcp).length > 0 ? mergedMcp : undefined,
  }
}

function resolveCrushPaths(outputRoot: string) {
  const base = path.basename(outputRoot)
  // Global install: ~/.config/crush (basename is "crush")
  // Project install: .crush (basename is ".crush")
  if (base === "crush" || base === ".crush") {
    return {
      configDir: outputRoot,
      configPath: path.join(outputRoot, "crush.json"),
      commandsDir: path.join(outputRoot, "commands"),
      skillsDir: path.join(outputRoot, "skills"),
    }
  }

  // Custom output directory - nest under .crush subdirectory
  return {
    configDir: path.join(outputRoot, ".crush"),
    configPath: path.join(outputRoot, ".crush", "crush.json"),
    commandsDir: path.join(outputRoot, ".crush", "commands"),
    skillsDir: path.join(outputRoot, ".crush", "skills"),
  }
}
