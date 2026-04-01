import { describe, expect, test } from "bun:test"
import { promises as fs } from "fs"
import path from "path"
import os from "os"
import { writeCrushBundle } from "../src/targets/crush"
import type { CrushBundle } from "../src/types/crush"

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath)
    return true
  } catch {
    return false
  }
}

describe("writeCrushBundle", () => {
  test("writes command files, generated skills, copied skills, and MCP config", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "crush-test-"))
    const bundle: CrushBundle = {
      config: {
        $schema: "https://charm.land/crush.json",
        mcp: {
          playwright: {
            type: "stdio",
            command: "npx",
            args: ["-y", "@anthropic/mcp-playwright"],
          },
        },
      },
      commandFiles: [
        {
          name: "ce-work",
          content: "---\ndescription: Do the work\n---\n\nUse the ce-work skill.",
        },
      ],
      generatedSkills: [
        {
          name: "ce-work",
          content: "---\nname: ce-work\ndescription: Work instructions\n---\n\nWork instructions.",
        },
      ],
      skillDirs: [
        {
          name: "skill-one",
          sourceDir: path.join(import.meta.dir, "fixtures", "sample-plugin", "skills", "skill-one"),
        },
      ],
    }

    await writeCrushBundle(tempRoot, bundle)

    expect(await exists(path.join(tempRoot, ".crush", "crush.json"))).toBe(true)
    expect(await exists(path.join(tempRoot, ".crush", "commands", "ce-work.md"))).toBe(true)
    expect(await exists(path.join(tempRoot, ".crush", "skills", "ce-work", "SKILL.md"))).toBe(true)
    expect(await exists(path.join(tempRoot, ".crush", "skills", "skill-one", "SKILL.md"))).toBe(true)

    const config = JSON.parse(
      await fs.readFile(path.join(tempRoot, ".crush", "crush.json"), "utf8"),
    )
    expect(config.mcp.playwright.command).toBe("npx")

    const cmdContent = await fs.readFile(
      path.join(tempRoot, ".crush", "commands", "ce-work.md"), "utf8",
    )
    expect(cmdContent).toContain("Use the ce-work skill.")
  })

  test("command files are .md and slash-invocable by filename", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "crush-cmd-"))
    const bundle: CrushBundle = {
      config: {},
      commandFiles: [{ name: "ce-plan", content: "---\ndescription: Plan\n---\n\nPlan." }],
      generatedSkills: [],
      skillDirs: [],
    }

    await writeCrushBundle(tempRoot, bundle)

    expect(await exists(path.join(tempRoot, ".crush", "commands", "ce-plan.md"))).toBe(true)
  })

  test("writes directly into crush output root without double-nesting", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "crush-home-"))
    const crushRoot = path.join(tempRoot, ".crush")
    const bundle: CrushBundle = {
      config: { $schema: "https://charm.land/crush.json" },
      commandFiles: [{ name: "plan", content: "Plan." }],
      generatedSkills: [{ name: "plan", content: "Plan skill." }],
      skillDirs: [],
    }

    await writeCrushBundle(crushRoot, bundle)

    expect(await exists(path.join(crushRoot, "crush.json"))).toBe(true)
    expect(await exists(path.join(crushRoot, "commands", "plan.md"))).toBe(true)
    expect(await exists(path.join(crushRoot, "skills", "plan", "SKILL.md"))).toBe(true)
    // Should NOT double-nest under .crush/.crush
    expect(await exists(path.join(crushRoot, ".crush"))).toBe(false)
  })

  test("writes to ~/.config/crush when basename is crush", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "crush-config-"))
    const crushConfigRoot = path.join(tempRoot, "crush")
    const bundle: CrushBundle = {
      config: {},
      commandFiles: [{ name: "work", content: "Work." }],
      generatedSkills: [],
      skillDirs: [],
    }

    await writeCrushBundle(crushConfigRoot, bundle)

    expect(await exists(path.join(crushConfigRoot, "crush.json"))).toBe(true)
    expect(await exists(path.join(crushConfigRoot, "commands", "work.md"))).toBe(true)
  })

  test("handles empty bundles gracefully", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "crush-empty-"))
    const bundle: CrushBundle = {
      config: { $schema: "https://charm.land/crush.json" },
      commandFiles: [],
      generatedSkills: [],
      skillDirs: [],
    }

    await writeCrushBundle(tempRoot, bundle)
    expect(await exists(path.join(tempRoot, ".crush", "crush.json"))).toBe(true)
  })

  test("always creates commands/ and skills/ directories even with empty bundle", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "crush-dirs-"))
    const bundle: CrushBundle = {
      config: {},
      commandFiles: [],
      generatedSkills: [],
      skillDirs: [],
    }

    await writeCrushBundle(tempRoot, bundle)

    expect(await exists(path.join(tempRoot, ".crush", "commands"))).toBe(true)
    expect(await exists(path.join(tempRoot, ".crush", "skills"))).toBe(true)
  })

  test("merges MCP config into existing crush.json (user keys win)", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "crush-merge-"))
    const crushDir = path.join(tempRoot, ".crush")
    await fs.mkdir(crushDir, { recursive: true })

    await fs.writeFile(path.join(crushDir, "crush.json"), JSON.stringify({
      mcp: { my_server: { type: "stdio", command: "my-cmd" } },
    }))

    const bundle: CrushBundle = {
      config: { mcp: { plugin_server: { type: "http", url: "https://mcp.example.com" } } },
      commandFiles: [],
      generatedSkills: [],
      skillDirs: [],
    }

    await writeCrushBundle(tempRoot, bundle)

    const merged = JSON.parse(await fs.readFile(path.join(crushDir, "crush.json"), "utf8"))
    expect(merged.mcp.plugin_server.url).toBe("https://mcp.example.com")
    expect(merged.mcp.my_server.command).toBe("my-cmd")
  })

  test("user MCP entry wins over plugin entry on conflict", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "crush-win-"))
    const crushDir = path.join(tempRoot, ".crush")
    await fs.mkdir(crushDir, { recursive: true })

    await fs.writeFile(path.join(crushDir, "crush.json"), JSON.stringify({
      mcp: { context7: { type: "http", url: "https://user-overridden.example.com" } },
    }))

    const bundle: CrushBundle = {
      config: { mcp: { context7: { type: "http", url: "https://mcp.context7.com/mcp" } } },
      commandFiles: [],
      generatedSkills: [],
      skillDirs: [],
    }

    await writeCrushBundle(tempRoot, bundle)

    const merged = JSON.parse(await fs.readFile(path.join(crushDir, "crush.json"), "utf8"))
    expect(merged.mcp.context7.url).toBe("https://user-overridden.example.com")
  })

  test("backs up existing crush.json before writing", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "crush-backup-"))
    const crushDir = path.join(tempRoot, ".crush")
    await fs.mkdir(crushDir, { recursive: true })
    await fs.writeFile(path.join(crushDir, "crush.json"), JSON.stringify({ mcp: {} }))

    const bundle: CrushBundle = {
      config: { mcp: { new_server: { type: "stdio", command: "new-cmd" } } },
      commandFiles: [],
      generatedSkills: [],
      skillDirs: [],
    }

    await writeCrushBundle(tempRoot, bundle)

    const files = await fs.readdir(crushDir)
    const backupFiles = files.filter((f) => f.startsWith("crush.json.bak."))
    expect(backupFiles.length).toBeGreaterThanOrEqual(1)
  })

  test("transforms Task calls in copied SKILL.md files", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "crush-transform-"))
    const sourceSkillDir = path.join(tempRoot, "source-skill")
    await fs.mkdir(sourceSkillDir, { recursive: true })
    await fs.writeFile(
      path.join(sourceSkillDir, "SKILL.md"),
      `---
name: ce:plan
description: Planning workflow
---

- Task compound-engineering:research:repo-research-analyst(feature_description)
- Task compound-engineering:review:code-simplicity-reviewer()
`,
    )

    const bundle: CrushBundle = {
      config: {},
      commandFiles: [],
      generatedSkills: [],
      skillDirs: [{ name: "ce:plan", sourceDir: sourceSkillDir }],
    }

    await writeCrushBundle(tempRoot, bundle)

    const installed = await fs.readFile(
      path.join(tempRoot, ".crush", "skills", "ce-plan", "SKILL.md"), "utf8",
    )
    expect(installed).toContain("Use the repo-research-analyst skill to: feature_description")
    expect(installed).toContain("Use the code-simplicity-reviewer skill")
    expect(installed).not.toContain("Task compound-engineering:")
  })
})
