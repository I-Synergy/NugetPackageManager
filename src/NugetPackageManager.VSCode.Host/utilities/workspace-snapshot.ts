import * as vscode from "vscode";

/**
 * One parsed copy of the workspace, shared by every tab.
 *
 * Every view used to discover and parse the whole repository for itself: the project tree, the
 * Updates scan, the inconsistencies report, the vulnerability scan and the cleanup report each
 * ran their own `getProjects` sequence. On a large workspace that is the same 463 projects parsed
 * five times. This module keeps a single snapshot and hands it to all of them.
 *
 * Discovery and parsing are injected by `host-api` (see {@link SnapshotRequest}) so this module
 * never imports it: `host-api` -> `workspace-snapshot` -> `host-api` would be a cycle.
 */

/** What one parse of the workspace produced. */
export type ParseBatchResult = {
  /** Projects the core returned. */
  projects: Project[];
  /** Discovered project files the core did not return, so a caller can refuse to act on a gap. */
  failedPaths: string[];
};

export type WorkspaceSnapshot = {
  /** Every project the core could parse. */
  projects: Project[];
  /** Every discovered project file, with the exclude globs already applied. */
  projectFiles: string[];
  /**
   * Project files the core could not parse: discovered paths that came back in no project model.
   * Callers that must not answer from incomplete data - the cleanup report, the CPM cleanup -
   * refuse to act when this is non-empty for the paths they asked about.
   */
  failedPaths: string[];
  parsedAt: number;
};

export type SnapshotRequest = {
  /** Full workspace discovery, with the exclude globs applied. */
  discover: () => Promise<string[]>;
  /** Parses every discovered path in one core call, forwarding the core's own progress. */
  parse: (
    paths: string[],
    signal?: AbortSignal,
    onProgress?: (completed: number, total: number) => void
  ) => Promise<ParseBatchResult>;
  /** Start a new generation instead of reusing the snapshot. */
  forceReload?: boolean;
  /** Detaches this caller only; the shared parse keeps running and still fills the cache. */
  signal?: AbortSignal;
  onProgress?: (completed: number, total: number) => void;
};

/** Project and props changes to watch: any of them can change what a project parses to. */
const WATCHER_GLOB = "**/*.{csproj,fsproj,vbproj,props,targets}";
/** A save usually touches several files; one invalidation per burst is enough. */
const WATCHER_DEBOUNCE_MS = 300;

/** Directory segments whose files are build output, dependencies or VCS metadata. */
const IGNORED_WATCH_SEGMENTS = new Set(["bin", "obj", "node_modules", ".git"]);

/**
 * True when a changed path lives under `bin/`, `obj/`, `node_modules/` or `.git/`.
 *
 * The watcher glob also matches `obj/*.nuget.g.props` and `obj/*.nuget.g.targets`, which a
 * `dotnet restore` rewrites for every project. On a large repository that would invalidate the
 * snapshot right after each restore and force a full re-parse, so those directories are skipped.
 * Matching is per path segment (not a substring) and case-insensitive, and accepts both `/` and
 * `\` separators so Windows URIs filter the same way.
 */
export function isIgnoredWatchPath(filePath: string): boolean {
  const segments = filePath.split(/[\\/]+/);
  return segments.some((segment) => IGNORED_WATCH_SEGMENTS.has(segment.toLowerCase()));
}

type ProgressSnapshot = { completed: number; total: number };
type ProgressListener = (completed: number, total: number) => void;

type ParseState = {
  /** Latest progress, so a caller that attaches mid-parse starts where the parse is. */
  progress: ProgressSnapshot | null;
};

type SharedParse = {
  /** Aborted only by `dispose()` - never by a caller detaching. */
  readonly controller: AbortController;
  readonly listeners: Set<ProgressListener>;
  readonly state: ParseState;
  /**
   * Project files `discover()` returned, recorded as soon as it resolved - before the core parse,
   * which may still be running. Lets a caller canonicalise a project scope without a parse.
   */
  readonly discovered: string[] | null;
  readonly promise: Promise<WorkspaceSnapshot>;
};

/** One parse's discovery result; `loadAsync` fills it, `SharedParse.discovered` reads it. */
type DiscoveryBox = { files: string[] | null };

function abortReason(signal: AbortSignal): Error {
  const reason: unknown = signal.reason;
  return reason instanceof Error ? reason : new Error("Workspace parsing was cancelled.");
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortReason(signal);
}

export class WorkspaceSnapshotCache {
  private cached: WorkspaceSnapshot | null = null;
  private inFlight: SharedParse | null = null;
  private generation = 0;
  private watcher: vscode.FileSystemWatcher | null = null;
  private watcherTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * Project files the workspace has, or `null` when nothing is known yet.
   *
   * Answers from the cached snapshot, else from the discovery of an in-flight parse, and never
   * starts a parse or a discovery itself: it is meant for deciding whether a request's project
   * list is the whole workspace (so it can share the unscoped scan) before the work begins.
   */
  public knownProjectFiles(): string[] | null {
    if (this.cached) return this.cached.projectFiles;
    return this.inFlight?.discovered ?? null;
  }

  /** The shared snapshot, parsed once for every concurrent caller. */
  public GetAsync(request: SnapshotRequest): Promise<WorkspaceSnapshot> {
    if (request.signal?.aborted) {
      return Promise.reject(abortReason(request.signal));
    }
    if (request.forceReload) {
      this.invalidate();
    }
    this.ensureWatcher();

    if (this.cached) return Promise.resolve(this.cached);

    const shared = this.inFlight ?? this.start(request);
    return this.waitAsync(shared, request);
  }

  /** Drops the snapshot; the next `GetAsync` parses the workspace again. */
  public invalidate(): void {
    this.generation += 1;
    this.cached = null;
    // A parse that started before the change would answer with the old workspace and then be
    // cached as if it were current, so it stops being the snapshot callers attach to.
    this.inFlight = null;
  }

  /** Debounces file-watcher bursts into one invalidation. */
  public scheduleInvalidate(): void {
    if (this.watcherTimer !== null) clearTimeout(this.watcherTimer);
    this.watcherTimer = setTimeout(() => {
      this.watcherTimer = null;
      this.invalidate();
    }, WATCHER_DEBOUNCE_MS);
  }

  public dispose(): void {
    if (this.watcherTimer !== null) {
      clearTimeout(this.watcherTimer);
      this.watcherTimer = null;
    }
    const running = this.inFlight;
    this.inFlight = null;
    this.cached = null;
    running?.controller.abort(new Error("The NuGet extension was deactivated."));
    this.watcher?.dispose();
    this.watcher = null;
  }

  /** Test seam: drop the snapshot, the in-flight parse and the watcher. */
  public Reset(): void {
    this.dispose();
    this.generation += 1;
  }

  private start(request: SnapshotRequest): SharedParse {
    this.generation += 1;
    const controller = new AbortController();
    const listeners = new Set<ProgressListener>();
    const state: ParseState = { progress: null };
    const discovery: DiscoveryBox = { files: null };

    const shared: SharedParse = {
      controller,
      listeners,
      state,
      get discovered(): string[] | null {
        return discovery.files;
      },
      promise: this.loadAsync(
        this.generation,
        state,
        listeners,
        controller,
        request,
        discovery
      ),
    };
    this.inFlight = shared;
    return shared;
  }

  private async loadAsync(
    generation: number,
    state: ParseState,
    listeners: Set<ProgressListener>,
    controller: AbortController,
    request: SnapshotRequest,
    discovery: DiscoveryBox
  ): Promise<WorkspaceSnapshot> {
    try {
      const projectFiles = await request.discover();
      // Recorded before the parse: a caller that only needs to know which files exist must not
      // wait for the whole workspace to be parsed.
      discovery.files = projectFiles;
      throwIfAborted(controller.signal);

      const result = await request.parse(projectFiles, controller.signal, (completed, total) => {
        state.progress = { completed, total };
        for (const listener of listeners) listener(completed, total);
      });

      const snapshot: WorkspaceSnapshot = {
        projects: result.projects,
        projectFiles,
        failedPaths: result.failedPaths,
        parsedAt: Date.now(),
      };
      // Only the generation that is still current may populate the cache: an invalidation
      // (mutation or file save) means this parse describes a workspace that no longer exists.
      if (generation === this.generation) this.cached = snapshot;
      return snapshot;
    } finally {
      // Release the slot so the next caller starts a fresh parse instead of joining a dead one.
      if (this.inFlight?.controller === controller) this.inFlight = null;
    }
  }

  /**
   * Follows a shared parse. A caller that aborts stops waiting and stops receiving progress; the
   * parse itself is untouched.
   */
  private waitAsync(shared: SharedParse, request: SnapshotRequest): Promise<WorkspaceSnapshot> {
    const listener = request.onProgress;
    if (listener) {
      shared.listeners.add(listener);
      if (shared.state.progress) {
        listener(shared.state.progress.completed, shared.state.progress.total);
      }
    }
    const stopListening = (): void => {
      if (listener) shared.listeners.delete(listener);
    };

    const signal = request.signal;
    if (!signal) {
      return shared.promise.then(
        (snapshot) => {
          stopListening();
          return snapshot;
        },
        (error: unknown) => {
          stopListening();
          throw error instanceof Error ? error : new Error(String(error));
        }
      );
    }

    return new Promise<WorkspaceSnapshot>((resolve, reject) => {
      if (signal.aborted) {
        stopListening();
        reject(abortReason(signal));
        return;
      }

      const onAbort = (): void => {
        stopListening();
        reject(abortReason(signal));
      };
      signal.addEventListener("abort", onAbort, { once: true });

      shared.promise.then(
        (snapshot) => {
          signal.removeEventListener("abort", onAbort);
          stopListening();
          resolve(snapshot);
        },
        (error: unknown) => {
          signal.removeEventListener("abort", onAbort);
          stopListening();
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      );
    });
  }

  private ensureWatcher(): void {
    if (this.watcher) return;
    // Mocked test environments and headless hosts may not implement the watcher factory.
    if (typeof vscode.workspace.createFileSystemWatcher !== "function") return;

    const watcher = vscode.workspace.createFileSystemWatcher(WATCHER_GLOB);
    // `obj/` and `bin/` churn (`dotnet restore` rewrites `obj/*.nuget.g.*`) must not invalidate
    // the snapshot: the debounce is only for real project/props/targets edits.
    const onChange = (uri: vscode.Uri): void => {
      if (isIgnoredWatchPath(uri.fsPath)) return;
      this.scheduleInvalidate();
    };
    watcher.onDidChange(onChange);
    watcher.onDidCreate(onChange);
    watcher.onDidDelete(onChange);
    this.watcher = watcher;
  }
}

/** One snapshot for the whole extension: every `createHostAPI()` caller shares it. */
export const workspaceSnapshot = new WorkspaceSnapshotCache();
