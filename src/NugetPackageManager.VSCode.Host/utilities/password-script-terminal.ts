import * as vscode from "vscode";
import { spawn } from "node:child_process";

/**
 * Pseudoterminal that runs a password script and captures what it prints.
 * Only the extensions the executor allowlists are launched; anything else
 * closes the terminal with exit code 1.
 */
export class PasswordScriptTerminal implements vscode.Pseudoterminal {
  private readonly writeEmitter = new vscode.EventEmitter<string>();
  onDidWrite = this.writeEmitter.event;
  
  private readonly closeEmitter = new vscode.EventEmitter<number>();
  onDidClose = this.closeEmitter.event;

  private output: string = '';
  private errorOutput: string = '';
  
  constructor(
    private readonly scriptPath: string,
    private readonly encodedPassword: string,
    private readonly spawnFn: typeof spawn = spawn
  ) {}

  open(_initialDimensions: vscode.TerminalDimensions | undefined): void {
    const scriptPath_lower = this.scriptPath.toLowerCase();
    let command: string;
    let args: string[];

    if (scriptPath_lower.endsWith('.ps1')) {
      command = 'powershell.exe';
      args = [
        '-NoProfile',
        '-File',
        this.scriptPath,
        this.encodedPassword
      ];
    } else if (scriptPath_lower.endsWith('.bat') || scriptPath_lower.endsWith('.cmd')) {
      command = 'cmd.exe';
      args = ['/c', this.scriptPath, this.encodedPassword];
    } else if (scriptPath_lower.endsWith('.sh')) {
      command = 'sh';
      args = [this.scriptPath, this.encodedPassword];
    } else {
      this.writeEmitter.fire(`\x1b[31mUnsupported script type. Allowed: .ps1, .bat, .cmd, .sh\x1b[0m\r\n`);
      this.closeEmitter.fire(1);
      return;
    }

    const proc = this.spawnFn(command, args, {
      cwd: process.cwd(),
      env: process.env,
    });

    proc.stdout.on('data', (data: Buffer) => {
      const text = data.toString();
      this.output += text;
      this.writeEmitter.fire(text);
    });

    proc.stderr.on('data', (data: Buffer) => {
      const text = data.toString();
      this.errorOutput += text;
      this.writeEmitter.fire(`\x1b[31m${text}\x1b[0m`);
    });

    proc.on('error', (error) => {
      this.writeEmitter.fire(`\x1b[31mFailed to start process: ${error.message}\x1b[0m\r\n`);
      this.closeEmitter.fire(1);
    });

    proc.on('close', (code: number | null) => {
      this.closeEmitter.fire(code ?? 0);
    });
  }

  close(): void {
    // Nothing to stop: the spawned process closes itself and fires onDidClose.
  }

  getOutput(): string {
    return this.output.trim();
  }

  getErrorOutput(): string {
    return this.errorOutput.trim();
  }
}
