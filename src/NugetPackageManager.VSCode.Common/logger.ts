import * as vscode from 'vscode';
import * as util from 'node:util';
import * as os from 'node:os';
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { BasicTracerProvider, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import {
    ATTR_DEPLOYMENT_ENVIRONMENT_NAME,
    ATTR_SERVICE_NAME,
    ATTR_SERVICE_VERSION,
} from "@opentelemetry/semantic-conventions";
import type { Attributes, TimeInput, Tracer } from "@opentelemetry/api";
import { getSetting, isConfigAffected } from "./configuration";

// `os.type` is still an incubating semantic convention. Importing it from the
// `/incubating` entry point cannot be resolved by the Node10 module resolution
// used by tsconfig.test.json, so the attribute key is kept here instead.
const ATTR_OS_TYPE = "os.type";

export class Logger {
    private static _outputChannel: vscode.OutputChannel;
    private static _isEnabled: boolean = false;
    private static _provider: BasicTracerProvider;
    private static _tracer: Tracer;
    private static _logLevel: number = 1;

    private static readonly _logLevels: { [key: string]: number } = {
        'DEBUG': 0,
        'INFO': 1,
        'WARN': 2,
        'ERROR': 3
    };

    public static configure(context: vscode.ExtensionContext): void {
        this._outputChannel = vscode.window.createOutputChannel("NuGet Package Manager for Visual Studio Code");
        context.subscriptions.push(this._outputChannel);

        this.updateLogLevel();
        context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(e => {
            if (isConfigAffected(e, 'logLevel')) {
                this.updateLogLevel();
            }
        }));

        const telemetryAddress = process.env.TELEMETRY_ADDRESS;
        const telemetryEnabled = getSetting<boolean>("enableTelemetry", false);
        if (telemetryEnabled && telemetryAddress && vscode.env.isTelemetryEnabled) {
            this._isEnabled = true;
            const traceExporter = new OTLPTraceExporter({
                url: telemetryAddress,
            });

            this._provider = new BasicTracerProvider({
                resource: resourceFromAttributes({
                    [ATTR_SERVICE_NAME]: "nugetpackagemanager",
                    [ATTR_SERVICE_VERSION]: context.extension.packageJSON.version,
                    [ATTR_DEPLOYMENT_ENVIRONMENT_NAME]: process.env.ENVIRONMENT ?? "",
                    [ATTR_OS_TYPE]: os.platform(),
                    "extension.id": context.extension.id,
                    language: vscode.env.language,
                    "vscode.edition": vscode.env.appName,
                    "vscode.version": vscode.version,
                    "vscode.host": vscode.env.appHost,
                    "vscode.remoteName": vscode.env.remoteName ?? "",
                    "vscode.uiKind": vscode.env.uiKind,
                }),
                spanProcessors: [new SimpleSpanProcessor(traceExporter)],
            });
            this._tracer = this._provider.getTracer(context.extension.id);

            context.subscriptions.push(new vscode.Disposable(() => {
                this._provider.shutdown();
            }));
        }
    }

    public static log(level: string, message: string, ...args: unknown[]): void {
        const levelValue = this._logLevels[level] ?? 1;
        if (levelValue < this._logLevel) {
            return;
        }

        const formattedMessage = util.format(message, ...args);
        if (this._outputChannel) {
            const timestamp = new Date().toISOString();
            this._outputChannel.appendLine(`${timestamp} [${level}] ${formattedMessage}`);
        }
        this.sendEvent('log', { level, message: formattedMessage });
    }

    private static updateLogLevel(): void {
        const logLevel = getSetting<string>('logLevel', 'INFO');
        this._logLevel = this._logLevels[logLevel] ?? 1;
    }

    public static info(message: string, ...args: unknown[]): void {
        this.log('INFO', message, ...args);
    }

    public static warn(message: string, ...args: unknown[]): void {
        this.log('WARN', message, ...args);
    }

    public static error(message: string, ...args: unknown[]): void {
        this.log('ERROR', message, ...args);
    }

    public static debug(message: string, ...args: unknown[]): void {
        this.log('DEBUG', message, ...args);
    }

    private static sendEvent(name: string, data?: Attributes, startTime?: TimeInput, endTime?: TimeInput): void {
        if (!this._isEnabled || !this._tracer) return;

        const span = this._tracer.startSpan(name, {
            startTime: startTime ?? Date.now(),
        });
        if (data != undefined) {
            span.setAttributes(data);
        }
        span.end(endTime);
    }
}
