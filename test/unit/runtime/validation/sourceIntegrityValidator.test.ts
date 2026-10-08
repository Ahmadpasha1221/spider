import { describe, expect, it } from "vitest";
import { validateSourceIntegrity } from "../../../../src/runtime/validation/sourceIntegrityValidator";

describe("SourceIntegrityValidator", () => {
  it("passes for valid TypeScript / TSX code", () => {
    const code = `
      import React from "react";
      export interface Props {
        readonly title: string;
      }
      export const Card: React.FC<Props> = ({ title }) => {
        return <div className="card-class"><h1>{title}</h1></div>;
      };
    `;
    const result = validateSourceIntegrity("src/Card.tsx", code);
    expect(result.valid).toBe(true);
    expect(result.diagnostics).toHaveLength(0);
  });

  it("passes for valid JSON", () => {
    const code = JSON.stringify({ name: "spider", version: "1.0.0", active: true }, null, 2);
    const result = validateSourceIntegrity("package.json", code);
    expect(result.valid).toBe(true);
    expect(result.diagnostics).toHaveLength(0);
  });

  it("detects malformed JSON with syntax errors", () => {
    const code = `{ "name": "spider", "trailing":, }`;
    const result = validateSourceIntegrity("config.json", code);
    expect(result.valid).toBe(false);
    expect(result.failureCategory).toBe("json_parse_error");
    expect(result.diagnostics.length).toBeGreaterThan(0);
  });

  it("detects forbidden ASCII control characters in source", () => {
    const code = "const message = 'Hello\u0000World';";
    const result = validateSourceIntegrity("src/hello.ts", code);
    expect(result.valid).toBe(false);
    expect(result.failureCategory).toBe("control_characters");
    expect(result.diagnostics[0]?.message).toContain("Forbidden ASCII control character");
  });

  it("detects accidental markdown code fence leakage inside source code", () => {
    const code = "```tsx\nexport const App = () => <div>Hello</div>;\n```";
    const result = validateSourceIntegrity("src/App.tsx", code);
    expect(result.valid).toBe(false);
    expect(result.failureCategory).toBe("markdown_fence_leak");
    expect(result.diagnostics[0]?.message).toContain("markdown code fence");
  });

  describe("Real-world regression patterns", () => {
    it("detects random tokens inserted into source: 'some text'*,*", () => {
      const code = `const messages = [\n  "Nice try",\n  "You can't escape this question."*,*\n];`;
      const result = validateSourceIntegrity("src/dialog.ts", code);
      expect(result.valid).toBe(false);
      expect(result.diagnostics.length).toBeGreaterThan(0);
    });

    it("detects broken JSX expressions: className={\\destination-card \\}", () => {
      const code = `export const Card = () => <div className={\\destination-card \\}>Content</div>;`;
      const result = validateSourceIntegrity("src/Card.tsx", code);
      expect(result.valid).toBe(false);
      expect(result.diagnostics.length).toBeGreaterThan(0);
    });

    it("detects broken template literals/expressions: className={\\ \\n}", () => {
      const code = `export const Card = () => <div className={\\\n}>Content</div>;`;
      const result = validateSourceIntegrity("src/Card.tsx", code);
      expect(result.valid).toBe(false);
      expect(result.diagnostics.length).toBeGreaterThan(0);
    });

    it("detects broken JSX attributes: aria-labelledby={\\vibe-title-\\}", () => {
      const code = `export const Button = () => <button aria-labelledby={\\vibe-title-\\}>Click</button>;`;
      const result = validateSourceIntegrity("src/Button.tsx", code);
      expect(result.valid).toBe(false);
      expect(result.diagnostics.length).toBeGreaterThan(0);
    });

    it("detects empty or truncated files", () => {
      const result = validateSourceIntegrity("src/empty.ts", "   \n  ");
      expect(result.valid).toBe(false);
      expect(result.failureCategory).toBe("empty_or_truncated");
    });

    it("detects unbalanced delimiters in CSS/HTML", () => {
      const css = `.header { font-size: 14px; .footer { color: red; }`;
      const result = validateSourceIntegrity("src/styles.css", css);
      expect(result.valid).toBe(false);
      expect(result.failureCategory).toBe("unbalanced_delimiters");
    });
  });
});
