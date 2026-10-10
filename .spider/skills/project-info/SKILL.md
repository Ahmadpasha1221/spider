---
name: project-info
description: Provides repository architecture guidelines, testing conventions, and health checks for Spider.
compatibility: Spider >= 0.1.0
license: MIT
---
# Spider Project Info Skill

This skill provides key architectural guidelines and quick health checks for the Spider codebase.

## Guidelines
- When the user asks about coding conventions, consult `references/conventions.md` using `read_skill_resource`.
- When the user requests a health check or test summary, execute `scripts/health_check.py` using `run_skill_script`.
