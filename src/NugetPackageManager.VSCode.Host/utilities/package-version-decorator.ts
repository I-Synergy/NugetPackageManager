import * as vscode from 'vscode';
import { Logger } from '@/common/logger';
import { getSetting, isConfigAffected } from '@/common/configuration';
import NuGetConfigResolver, { type SourceWithCredentials } from './nuget-config-resolver';
import nugetApiFactory from '../nuget/api-factory';

type PackagePosition = { start: vscode.Position; end: vscode.Position; version: string };
type PackagePositions = Map<string, PackagePosition[]>;

function isSupportedDocument(fileName: string): boolean {
    return fileName.endsWith('Directory.Packages.props')
        || fileName.endsWith('.csproj')
        || fileName.endsWith('.fsproj')
        || fileName.endsWith('.vbproj');
}

function isPinnedVersion(version: string): boolean {
    return version.startsWith('[') && version.endsWith(']') && !version.includes(',');
}

export class PackageVersionDecorator implements vscode.Disposable {
    private readonly _disposables: vscode.Disposable[] = [];
    private readonly _decorationType: vscode.TextEditorDecorationType;
    private readonly _failedCache: Set<string> = new Set(); // PackageIds that failed to fetch
    private _isEnabled: boolean = false;
    private _prerelease: boolean = false;

    constructor() {
        Logger.debug('PackageVersionDecorator.constructor: Initialized');
        this._decorationType = vscode.window.createTextEditorDecorationType({
            after: {
                margin: '0 0 0 1em',
                color: new vscode.ThemeColor('editorCodeLens.foreground'),
            }
        });

        this.updateConfiguration();

        // Listen for configuration changes, active editor changes and document changes.
        this._disposables.push(
            vscode.workspace.onDidChangeConfiguration(e => {
                if (isConfigAffected(e, 'enablePackageVersionInlineInfo') ||
                    isConfigAffected(e, 'prerelease')) {
                    this.updateConfiguration();
                    if (vscode.window.activeTextEditor) {
                        this.triggerUpdateDecorations(vscode.window.activeTextEditor);
                    }
                }
            }),
            vscode.window.onDidChangeActiveTextEditor(editor => {
                if (editor) {
                    Logger.debug(`PackageVersionDecorator.constructor: Active editor changed to ${editor.document.fileName}`);
                    this.triggerUpdateDecorations(editor);
                }
            }),
            vscode.workspace.onDidChangeTextDocument(event => {
                if (vscode.window.activeTextEditor && event.document === vscode.window.activeTextEditor.document) {
                    this.triggerUpdateDecorations(vscode.window.activeTextEditor);
                }
            })
        );

        if (vscode.window.activeTextEditor) {
            this.triggerUpdateDecorations(vscode.window.activeTextEditor);
        }
    }

    private updateConfiguration() {
        this._isEnabled = getSetting<boolean>('enablePackageVersionInlineInfo', false);
        this._prerelease = getSetting<boolean>('prerelease', false);
        Logger.debug(`PackageVersionDecorator.updateConfiguration: Configuration updated, enabled=${this._isEnabled}, prerelease=${this._prerelease}`);
    }

    private _timeout: NodeJS.Timeout | undefined = undefined;

    private triggerUpdateDecorations(editor: vscode.TextEditor) {
        if (this._timeout) {
            clearTimeout(this._timeout);
            this._timeout = undefined;
        }
        this._timeout = setTimeout(() => {
            void this.updateDecorationsAsync(editor).catch((err) => {
                Logger.error("PackageVersionDecorator: Failed to update decorations", err);
            });
        }, 500);
    }

    private async updateDecorationsAsync(editor: vscode.TextEditor) {
        if (!editor || editor.document.isClosed) {
            return;
        }

        if (!this._isEnabled) {
            editor.setDecorations(this._decorationType, []);
            return;
        }

        const doc = editor.document;
        if (!isSupportedDocument(doc.fileName)) {
            return;
        }

        Logger.debug(`PackageVersionDecorator.updateDecorations: Processing ${doc.fileName}`);

        const { packagePositions, packagesToFetch } = this.collectPackagePositions(doc, doc.getText());
        if (packagesToFetch.size > 0) {
            await this.fetchAndDecorateAsync(packagesToFetch, packagePositions, editor);
        }
    }

    private collectPackagePositions(
        doc: vscode.TextDocument,
        text: string
    ): { packagePositions: PackagePositions; packagesToFetch: Set<string> } {
        const regex = /<(?:PackageReference|PackageVersion)\s[^>]*>/g;
        const packagesToFetch = new Set<string>();
        const packagePositions: PackagePositions = new Map();

        let match;
        while ((match = regex.exec(text))) {
            const tag = match[0];
            const includeMatch = /Include="([^"]+)"/.exec(tag);
            const versionMatch = /Version="([^"]+)"/.exec(tag);
            if (!includeMatch || !versionMatch) continue;

            const packageId = includeMatch[1] ?? "";
            const currentVersion = versionMatch[1] ?? "";
            if (isPinnedVersion(currentVersion)) continue;

            const versionAttrIndex = tag.indexOf(versionMatch[0]);
            if (versionAttrIndex === -1) continue;

            const absoluteIndex = match.index + versionAttrIndex + 'Version="'.length;
            const startPos = doc.positionAt(absoluteIndex);
            const endPos = doc.positionAt(absoluteIndex + currentVersion.length);

            const positions = packagePositions.get(packageId) ?? [];
            positions.push({ start: startPos, end: endPos, version: currentVersion });
            packagePositions.set(packageId, positions);

            if (!this._failedCache.has(packageId)) {
                packagesToFetch.add(packageId);
            }
        }

        return { packagePositions, packagesToFetch };
    }

    private async fetchAndDecorateAsync(
        packageIds: Set<string>,
        packagePositions: PackagePositions,
        editor: vscode.TextEditor
    ) {
        Logger.debug(`PackageVersionDecorator.fetchAndDecorate: Fetching versions for ${Array.from(packageIds).join(', ')}`);

        const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        const sources = await NuGetConfigResolver.GetSourcesAndDecodePasswordsAsync(workspaceRoot);

        const decorationLists = await Promise.all(
            Array.from(packageIds).map((packageId) =>
                this.decoratePackageAsync(packageId, packagePositions.get(packageId), sources)
            )
        );
        const decorations = decorationLists.flat();

        if (editor && !editor.document.isClosed) {
            editor.setDecorations(this._decorationType, decorations);
        }
    }

    private async decoratePackageAsync(
        packageId: string,
        positions: PackagePosition[] | undefined,
        sources: SourceWithCredentials[]
    ): Promise<vscode.DecorationOptions[]> {
        if (this._failedCache.has(packageId)) return [];

        try {
            const latestVersion = await this.findLatestVersionAsync(packageId, sources);
            if (!latestVersion) {
                this._failedCache.add(packageId);
                return [];
            }
            if (!positions) return [];

            return positions
                .filter((pos) => pos.version !== latestVersion)
                .map((pos) => ({
                    range: new vscode.Range(pos.start, pos.end),
                    renderOptions: {
                        after: { contentText: ` (Latest: ${latestVersion})` }
                    }
                }));
        } catch (error) {
            Logger.error(`PackageVersionDecorator.fetchAndDecorate: Failed to fetch version for ${packageId}`, error);
            this._failedCache.add(packageId);
            return [];
        }
    }

    private async findLatestVersionAsync(
        packageId: string,
        sources: SourceWithCredentials[]
    ): Promise<string | null> {
        for (const source of sources) {
            try {
                const api = await nugetApiFactory.GetSourceApiAsync(source.Url);
                const result = await api.GetPackageAsync(packageId, this._prerelease);
                if (!result.isError && result.data) return result.data.Version;
            } catch {
                // Try the next source.
            }
        }
        return null;
    }

    dispose() {
        if (this._timeout) {
            clearTimeout(this._timeout);
            this._timeout = undefined;
        }
        this._disposables.forEach(d => d.dispose());
        this._decorationType.dispose();
    }
}
