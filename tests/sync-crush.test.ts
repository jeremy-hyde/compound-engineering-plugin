import { describe, expect, test } from "bun:test"
import { promises as fs } from "fs"
import path from "path"
import os from "os"
import { syncToCrush } from "../src/sync/crush"
import type { ClaudeHomeConfig } from "../src/parsers/claude-home"

const emptyConfig: ClaudeHomeConfig = {
  skills: [],
  commands: [],
  mcpServers: {},
}

describe("syncToCrush", () => {
  test("creates skills directory and syncs skills", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "sync-crush-"))

    // Create a real skill directory to symlink
    const skillDir = path.join(tempRoot, "source-skills", "my-skill")
    await fs.mkdir(skillDir, { recursive: true })
    await fs.writeFile(path.join(skillDir, "SKILL.md"), "---\nname: my-skill\ndescription: Test\n---\n\nContent.")

    const config: ClaudeHomeConfig = {
      ...emptyConfig,
      skills: [
        {
          name: "my-skill",
          description: "Test skill",
          sourceDir: skillDir,
          skillPath: path.join(skillDir, "SKILL.md"),
        },
      ],
    }

    const outputRoot = path.join(tempRoot, "crush-output")
    await syncToCrush(config, outputRoot)

    const skillsDir = path.join(outputRoot, "skills")
    const stat = await fs.lstat(path.join(skillsDir, "my-skill"))
    expect(stat.isSymbolicLink()).toBe(true)
  })

  test("skips skills with invalid names", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "sync-crush-invalid-"))

    const config: ClaudeHomeConfig = {
      ...emptyConfig,
      skills: [
        {
          name: "--invalid--",
          description: "Invalid name",
          sourceDir: path.join(tempRoot, "invalid-skill"),
          skillPath: path.join(tempRoot, "invalid-skill", "SKILL.md"),
        },
      ],
    }

    const outputRoot = path.join(tempRoot, "crush-output")
    // Should not throw
    await syncToCrush(config, outputRoot)
  })

  test("writes MCP servers to crush.json", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "sync-crush-mcp-"))

    const config: ClaudeHomeConfig = {
      ...emptyConfig,
      mcpServers: {
        context7: {
          url: "https://mcp.context7.com/mcp",
        },
      },
    }

    const outputRoot = path.join(tempRoot, "crush-output")
    await syncToCrush(config, outputRoot)

    const configPath = path.join(outputRoot, "crush.json")
    const written = JSON.parse(await fs.readFile(configPath, "utf8"))
    expect(written.mcp.context7.type).toBe("http")
    expect(written.mcp.context7.url).toBe("https://mcp.context7.com/mcp")
  })

  test("maps stdio MCP servers correctly", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "sync-crush-stdio-"))

    const config: ClaudeHomeConfig = {
      ...emptyConfig,
      mcpServers: {
        playwright: {
          command: "npx",
          args: ["-y", "@anthropic/mcp-playwright"],
          env: { DISPLAY: ":0" },
        },
      },
    }

    const outputRoot = path.join(tempRoot, "crush-output")
    await syncToCrush(config, outputRoot)

    const written = JSON.parse(
      await fs.readFile(path.join(outputRoot, "crush.json"), "utf8"),
    )
    expect(written.mcp.playwright.type).toBe("stdio")
    expect(written.mcp.playwright.command).toBe("npx")
    expect(written.mcp.playwright.args).toEqual(["-y", "@anthropic/mcp-playwright"])
    expect(written.mcp.playwright.env).toEqual({ DISPLAY: ":0" })
  })

  test("merges MCP servers into existing crush.json (user keys win)", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "sync-crush-mergemcp-"))
    const outputRoot = path.join(tempRoot, "crush-output")
    await fs.mkdir(outputRoot, { recursive: true })

    const existing = {
      mcp: { my_server: { type: "stdio", command: "my-cmd" } },
    }
    await fs.writeFile(path.join(outputRoot, "crush.json"), JSON.stringify(existing))

    const config: ClaudeHomeConfig = {
      ...emptyConfig,
      mcpServers: {
        new_server: { url: "https://new.example.com" },
      },
    }

    await syncToCrush(config, outputRoot)

    const merged = JSON.parse(
      await fs.readFile(path.join(outputRoot, "crush.json"), "utf8"),
    )
    expect(merged.mcp.my_server.command).toBe("my-cmd")
    expect(merged.mcp.new_server.url).toBe("https://new.example.com")
  })

  test("does not write crush.json when no MCP servers", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "sync-crush-nomcp-"))

    const outputRoot = path.join(tempRoot, "crush-output")
    await syncToCrush(emptyConfig, outputRoot)

    const configExists = await fs.access(path.join(outputRoot, "crush.json")).then(() => true).catch(() => false)
    expect(configExists).toBe(false)
  })

  test("syncs commands as both command files and skill files", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "sync-crush-cmds-"))

    const config: ClaudeHomeConfig = {
      ...emptyConfig,
      commands: [
        {
          name: "ce:work",
          description: "Do the work",
          body: "Work instructions.",
          sourcePath: "/tmp/commands/ce-work.md",
        },
      ],
    }

    const outputRoot = path.join(tempRoot, "crush-output")
    await syncToCrush(config, outputRoot)

    // Command file: slash-invocable as /ce-work
    const cmdPath = path.join(outputRoot, "commands", "ce-work.md")
    const cmdExists = await fs.access(cmdPath).then(() => true).catch(() => false)
    expect(cmdExists).toBe(true)

    // Skill file: backing instructions for the agent
    const skillPath = path.join(outputRoot, "skills", "ce-work", "SKILL.md")
    const skillExists = await fs.access(skillPath).then(() => true).catch(() => false)
    expect(skillExists).toBe(true)
  })
})
