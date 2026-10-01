import * as vscode from "vscode";
import { SecretStorage } from "./secretStorage";
import { CursorAuthError } from "./cursorAuthError";
import { SECRET_KEYS, deleteSecret, readSecret } from "../shared/storageKeys";

export class CursorAuthProvider implements vscode.AuthenticationProvider {
  private readonly emitter = new vscode.EventEmitter<vscode.AuthenticationProviderAuthenticationSessionsChangeEvent>();

  readonly onDidChangeSessions = this.emitter.event;

  private sessions: vscode.AuthenticationSession[] = [];

  constructor(private readonly secretStorage: SecretStorage) {}

  async getSessions(_scopes: readonly string[] | undefined): Promise<vscode.AuthenticationSession[]> {
    return [...this.sessions];
  }

  async createSession(
    scopes: readonly string[],
    _options: vscode.AuthenticationProviderSessionOptions,
  ): Promise<vscode.AuthenticationSession> {
    const token = await readSecret(this.secretStorage, SECRET_KEYS.cursorApiKey);

    if (!token) {
      throw new CursorAuthError("No Cursor API key found", 401);
    }

    const session: vscode.AuthenticationSession = {
      id: crypto.randomUUID(),
      accessToken: token,
      account: { id: "codevia", label: "Spider" },
      scopes,
    };

    this.sessions.push(session);
    await this.secretStorage.store(SECRET_KEYS.cursorSession.current, JSON.stringify(session));
    this.emitter.fire({ added: [session], removed: undefined, changed: undefined });
    return session;
  }

  async getSession(sessionId: string): Promise<vscode.AuthenticationSession | undefined> {
    return this.sessions.find((session) => session.id === sessionId);
  }

  async removeSession(sessionId: string): Promise<void> {
    const index = this.sessions.findIndex((session) => session.id === sessionId);
    if (index === -1) {
      throw new CursorAuthError(`Session not found: ${sessionId}`, 401);
    }

    const [removed] = this.sessions.splice(index, 1);
    await deleteSecret(this.secretStorage, SECRET_KEYS.cursorSession);
    this.emitter.fire({ added: undefined, removed: [removed], changed: undefined });
  }

  dispose(): void {
    this.emitter.dispose();
  }
}
