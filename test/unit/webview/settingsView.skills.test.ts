// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { renderSettingsView, type SettingsHandlers } from "../../../gui/src/views/settingsView";
import { createInitialState } from "../../../gui/src/state";

describe("SettingsView - Agent Skills Section", () => {
  const dummyHandlers: SettingsHandlers = {
    onProvider: vi.fn(),
    onCursorConnect: vi.fn(),
    onCursorDisconnect: vi.fn(),
    onOpenRouterConnect: vi.fn(),
    onOpenRouterDisconnect: vi.fn(),
    onRefreshOpenRouter: vi.fn(),
    onOpenRouterModel: vi.fn(),
    onOpenRouterSearch: vi.fn(),
    onLocalProvider: vi.fn(),
    onRefreshLocal: vi.fn(),
    onLocalConnect: vi.fn(),
    onLocalModel: vi.fn(),
    onMock: vi.fn(),
    onSelectSection: vi.fn(),
    onToggleAutoApprove: vi.fn(),
    onSetPermissionRule: vi.fn(),
    onToggleSkill: vi.fn(),
    onReloadSkills: vi.fn(),
    onSkillsSearch: vi.fn(),
  };

  it("renders the skills section with empty state", () => {
    const root = document.createElement("div");
    const feedback = document.createElement("div");
    const state = createInitialState();
    state.settingsSection = "skills";

    renderSettingsView(root, feedback, state, dummyHandlers);

    const heading = root.querySelector("h2");
    expect(heading?.textContent).toBe("Agent Skills");

    const empty = root.querySelector(".skills-empty");
    expect(empty?.textContent).toContain("No agent skills discovered");

    const searchInput = root.querySelector<HTMLInputElement>(".skills-search-input");
    expect(searchInput).not.toBeNull();
    expect(searchInput?.placeholder).toContain("Search skills");

    const reloadBtn = root.querySelector<HTMLButtonElement>(".skills-reload-btn");
    expect(reloadBtn).not.toBeNull();
    expect(reloadBtn?.textContent).toBe("Reload Skills");
  });

  it("renders skills list with scope badges and pills", () => {
    const root = document.createElement("div");
    const feedback = document.createElement("div");
    const state = createInitialState();
    state.settingsSection = "skills";
    state.skills = [
      {
        name: "test-workspace-skill",
        description: "A test workspace skill",
        scope: "workspace",
        enabled: true,
        resourceCount: 2,
        scriptCount: 1,
        skillDir: "/path/to/test-workspace-skill",
        license: "Apache-2.0",
      },
      {
        name: "test-global-skill",
        description: "A test global skill",
        scope: "global",
        enabled: false,
        resourceCount: 0,
        scriptCount: 0,
        skillDir: "/path/to/test-global-skill",
        compatibility: "node >= 18",
      },
    ];

    renderSettingsView(root, feedback, state, dummyHandlers);

    const cards = root.querySelectorAll(".skill-card");
    expect(cards.length).toBe(2);

    // Workspace skill card
    const firstCard = cards[0];
    expect(firstCard?.classList.contains("is-enabled")).toBe(true);
    expect(firstCard?.querySelector(".skill-name")?.textContent).toBe("test-workspace-skill");
    expect(firstCard?.querySelector(".skill-scope-badge")?.textContent).toBe("workspace");
    expect(firstCard?.querySelector(".skill-scope-badge")?.classList.contains("scope-workspace")).toBe(true);
    expect(firstCard?.textContent).toContain("2 resources");
    expect(firstCard?.textContent).toContain("1 script");
    expect(firstCard?.textContent).toContain("License: Apache-2.0");

    const firstToggleBtn = firstCard?.querySelector<HTMLButtonElement>(".skill-toggle-btn");
    expect(firstToggleBtn?.textContent).toBe("Disable");

    // Click toggle button
    firstToggleBtn?.click();
    expect(dummyHandlers.onToggleSkill).toHaveBeenCalledWith("test-workspace-skill");

    // Global skill card
    const secondCard = cards[1];
    expect(secondCard?.classList.contains("is-disabled")).toBe(true);
    expect(secondCard?.querySelector(".skill-name")?.textContent).toBe("test-global-skill");
    expect(secondCard?.querySelector(".skill-scope-badge")?.textContent).toBe("global");
    expect(secondCard?.textContent).toContain("Compat: node >= 18");

    const secondToggleBtn = secondCard?.querySelector<HTMLButtonElement>(".skill-toggle-btn");
    expect(secondToggleBtn?.textContent).toBe("Enable");
  });

  it("renders precedence conflict alert notice when conflicts exist", () => {
    const root = document.createElement("div");
    const feedback = document.createElement("div");
    const state = createInitialState();
    state.settingsSection = "skills";
    state.skillConflicts = [
      {
        skillName: "git-commit",
        activeScope: "workspace",
        activeDir: "/ws/.spider/skills/git-commit",
        shadowedScope: "global",
        shadowedDir: "/global/.agentskills/git-commit",
        reason: "Workspace shadow",
      },
    ];

    renderSettingsView(root, feedback, state, dummyHandlers);

    const conflictNotice = root.querySelector(".skills-conflict-notice");
    expect(conflictNotice).not.toBeNull();
    expect(conflictNotice?.getAttribute("role")).toBe("alert");
    expect(conflictNotice?.querySelector(".skills-conflict-title")?.textContent).toContain("Skill Precedence Conflicts (1)");
    expect(conflictNotice?.textContent).toContain('"git-commit": Active in workspace (/ws/.spider/skills/git-commit)');
  });

  it("filters skills by search query", () => {
    const root = document.createElement("div");
    const feedback = document.createElement("div");
    const state = createInitialState();
    state.settingsSection = "skills";
    state.skills = [
      {
        name: "git-commit",
        description: "Creates git commits",
        scope: "workspace",
        enabled: true,
        resourceCount: 0,
        scriptCount: 0,
        skillDir: "/dir1",
      },
      {
        name: "docker-build",
        description: "Builds docker containers",
        scope: "global",
        enabled: true,
        resourceCount: 0,
        scriptCount: 0,
        skillDir: "/dir2",
      },
    ];
    state.skillsFilter = "docker";

    renderSettingsView(root, feedback, state, dummyHandlers);

    const cards = root.querySelectorAll(".skill-card");
    expect(cards.length).toBe(1);
    expect(cards[0]?.querySelector(".skill-name")?.textContent).toBe("docker-build");
  });

  it("handles search input and reload button clicks", () => {
    const root = document.createElement("div");
    const feedback = document.createElement("div");
    const state = createInitialState();
    state.settingsSection = "skills";

    renderSettingsView(root, feedback, state, dummyHandlers);

    const searchInput = root.querySelector<HTMLInputElement>(".skills-search-input")!;
    searchInput.value = "my-query";
    searchInput.dispatchEvent(new Event("input"));
    expect(dummyHandlers.onSkillsSearch).toHaveBeenCalledWith("my-query");

    const reloadBtn = root.querySelector<HTMLButtonElement>(".skills-reload-btn")!;
    reloadBtn.click();
    expect(dummyHandlers.onReloadSkills).toHaveBeenCalled();
  });
});
