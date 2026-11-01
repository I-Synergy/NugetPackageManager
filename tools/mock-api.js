/**
 * Mock acquireVsCodeApi() for the dev server / screenshot harness.
 *
 * Project references (which projects exist and which packages are installed
 * in each) are mocked locally. All NuGet package data — search results,
 * available versions, updates, and vulnerabilities — is fetched live from
 * nuget.org via the dev server's /nuget-proxy endpoint.
 */
(function () {
  'use strict';

  // Readiness flags — polled by Playwright waitForFunction()
  window.__mockState = {
    configDone: false,
    projectsDone: false,
    packagesDone: false,
    outdatedDone: false,
    inconsistentDone: false,
    vulnerableDone: false,
  };

  // ── Mock project data ──────────────────────────────────────────────────────
  // These represent .csproj files and their installed package references.
  // Newtonsoft.Json is intentionally installed at different versions across
  // projects so the Consolidate view has something to show.

  var PROJECTS = [
    {
      Name: 'MyApp.csproj',
      Path: '/workspace/MyApp/MyApp.csproj',
      CpmEnabled: true,
      Packages: [
        { Id: 'Newtonsoft.Json', Version: '12.0.3', IsPinned: false, VersionSource: 'central' },
        { Id: 'Serilog', Version: '2.11.0', IsPinned: false, VersionSource: 'central' },
        { Id: 'AutoMapper', Version: '11.0.1', IsPinned: false, VersionSource: 'central' },
        // framework-conditional packages
        { Id: 'Microsoft.Extensions.Http', Version: '8.0.0', IsPinned: false, VersionSource: 'central', CpmFramework: 'net8.0' },
        { Id: 'Microsoft.AspNetCore.OpenApi', Version: '8.0.4', IsPinned: false, VersionSource: 'central', CpmFramework: 'net8.0' },
        { Id: 'Microsoft.Extensions.Http', Version: '9.0.0', IsPinned: false, VersionSource: 'central', CpmFramework: 'net9.0' },
        { Id: 'Microsoft.AspNetCore.OpenApi', Version: '9.0.0', IsPinned: false, VersionSource: 'central', CpmFramework: 'net9.0' },
      ],
    },
    {
      Name: 'MyApp.Tests.csproj',
      Path: '/workspace/MyApp/MyApp.Tests.csproj',
      CpmEnabled: true,
      Packages: [
        { Id: 'Newtonsoft.Json', Version: '13.0.1', IsPinned: false, VersionSource: 'central' },
        { Id: 'Microsoft.NET.Test.Sdk', Version: '17.0.0', IsPinned: false, VersionSource: 'central' },
        { Id: 'Microsoft.Extensions.Http', Version: '8.0.1', IsPinned: false, VersionSource: 'central', CpmFramework: 'net8.0' },
      ],
    },
    {
      Name: 'MyApp.Core.csproj',
      Path: '/workspace/MyApp/MyApp.Core.csproj',
      CpmEnabled: true,
      Packages: [
        { Id: 'AutoMapper', Version: '11.0.1', IsPinned: false, VersionSource: 'central' },
        { Id: 'MediatR', Version: '10.0.0', IsPinned: false, VersionSource: 'central' },
        { Id: 'Microsoft.Extensions.Logging', Version: '8.0.0', IsPinned: false, VersionSource: 'central', CpmFramework: 'net8.0' },
        { Id: 'Microsoft.Extensions.Logging', Version: '9.0.0', IsPinned: false, VersionSource: 'central', CpmFramework: 'net9.0' },
      ],
    },
  ];

  // ── Helpers ────────────────────────────────────────────────────────────────

  function delay(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
  }

  // ── Job-backed mutations ───────────────────────────────────────────────────
  // The real host runs every write as a job (start → poll getJobAsync → cancel).
  // These mocks mirror that, so the progress bar, completion and cancel paths are
  // reachable in the browser too.

  var mockJobs = new Map();
  var mockJobSeq = 0;

  function applyProjectMutation(params) {
    var project = PROJECTS.find(function (p) { return p.Path === params.ProjectPath; });
    if (!project) return null;
    if (params.Type === 'INSTALL') {
      project.Packages.push({ Id: params.PackageId, Version: params.Version, IsPinned: false, VersionSource: 'project' });
    } else if (params.Type === 'UPDATE') {
      var pkg = project.Packages.find(function (p) { return p.Id === params.PackageId; });
      if (pkg) pkg.Version = params.Version;
    } else if (params.Type === 'UNINSTALL') {
      project.Packages = project.Packages.filter(function (p) { return p.Id !== params.PackageId; });
    }
    return project;
  }

  function applyBatchMutation(params) {
    (params.Updates || []).forEach(function (update) {
      (update.ProjectPaths || []).forEach(function (path) {
        var project = PROJECTS.find(function (p) { return p.Path === path; });
        if (!project) return;
        var pkg = project.Packages.find(function (p) { return p.Id === update.PackageId; });
        if (pkg) pkg.Version = update.Version;
      });
    });
  }

  function startMockJob(kind, stage, response, mutate) {
    mockJobSeq += 1;
    var jobId = 'mock-job-' + mockJobSeq;
    mockJobs.set(jobId, {
      Kind: kind,
      Stage: stage,
      State: 'running',
      Percent: 40,
      FinishAt: Date.now() + 600,
      Response: response,
      Mutate: mutate,
    });
    return { ok: true, value: { JobId: jobId } };
  }

  function jobSnapshot(job) {
    if (job.State === 'running' && Date.now() >= job.FinishAt) {
      if (job.Mutate) job.Mutate();
      job.State = 'completed';
    }
    var done = job.State !== 'running';
    var snapshot = {
      Kind: job.Kind,
      State: job.State,
      Stage: done ? 'Completed' : job.Stage,
      Percent: done ? 100 : job.Percent,
    };
    if (done && job.State !== 'cancelled') {
      snapshot.Response = typeof job.Response === 'function' ? job.Response() : job.Response;
    }
    if (job.Error) snapshot.Error = job.Error;
    return snapshot;
  }

  function cleanupResponse() {
    return {
      Report: {
        PropsFiles: [{ Path: '/mock/Directory.Packages.props', Defined: ['AutoMapper', 'MediatR', 'Newtonsoft.Json', 'Serilog'], Unused: [] }],
        Used: ['Newtonsoft.Json', 'Serilog'],
        Missing: [],
        Unused: [],
      },
      Removed: ['AutoMapper', 'MediatR'],
      Backups: ['/mock/Directory.Packages.props.backup.mock'],
      Errors: [],
    };
  }

  /** Semver-aware version comparison. Returns negative/0/positive. */
  function compareVersions(a, b) {
    var aParts = (a || '').split('-'), bParts = (b || '').split('-');
    var aNum = (aParts[0] || '').split('.').map(function(n) { return parseInt(n, 10) || 0; });
    var bNum = (bParts[0] || '').split('.').map(function(n) { return parseInt(n, 10) || 0; });
    for (var i = 0; i < Math.max(aNum.length, bNum.length); i++) {
      var diff = (aNum[i] || 0) - (bNum[i] || 0);
      if (diff !== 0) return diff;
    }
    // release > prerelease per semver
    var aPre = aParts.length > 1 ? aParts.slice(1).join('-') : null;
    var bPre = bParts.length > 1 ? bParts.slice(1).join('-') : null;
    if (aPre === null && bPre !== null) return 1;
    if (aPre !== null && bPre === null) return -1;
    if (aPre !== null && bPre !== null) return aPre.localeCompare(bPre);
    return 0;
  }

  /**
   * Collect all unique installed packages across projects, grouped by ID.
   * For packages installed at different versions, uses the minimum (oldest).
   * Each entry includes the list of projects it's installed in.
   */
  function getInstalledPackages() {
    var byId = {};
    PROJECTS.forEach(function (project) {
      project.Packages.forEach(function (pkg) {
        if (!byId[pkg.Id]) {
          byId[pkg.Id] = { id: pkg.Id, version: pkg.Version, projects: [] };
        } else {
          // Keep the lowest installed version for the outdated check (semver-aware)
          if (compareVersions(pkg.Version, byId[pkg.Id].version) < 0) {
            byId[pkg.Id].version = pkg.Version;
          }
        }
        byId[pkg.Id].projects.push({ Name: project.Name, Path: project.Path, Version: pkg.Version });
      });
    });
    return Object.values(byId);
  }

  /**
   * Compute version inconsistencies directly from mock project data.
   * Returns the same shape as InconsistentPackage[].
   */
  function computeInconsistencies() {
    // Group by "id\0framework" so framework-scoped packages are only compared
    // within the same framework group, not across net8.0 vs net9.0.
    var byKey = {};
    PROJECTS.forEach(function (project) {
      project.Packages.forEach(function (pkg) {
        var framework = pkg.CpmFramework || '';
        var key = framework ? (pkg.Id + '\0' + framework) : pkg.Id;
        if (!byKey[key]) byKey[key] = { id: pkg.Id, framework: framework, versions: {} };
        if (!byKey[key].versions[pkg.Version]) byKey[key].versions[pkg.Version] = [];
        byKey[key].versions[pkg.Version].push({ Name: project.Name, Path: project.Path });
      });
    });

    var result = [];
    Object.keys(byKey).forEach(function (key) {
      var entry = byKey[key];
      var versions = Object.keys(entry.versions);
      if (versions.length > 1) {
        var sorted = versions.slice().sort((a, b) => a.localeCompare(b)).reverse();
        result.push({
          Id: entry.id,
          Versions: versions.map(function (v) {
            var versionEntry = { Version: v, Projects: entry.versions[v] };
            if (entry.framework) versionEntry.CpmFramework = entry.framework;
            return versionEntry;
          }),
          LatestInstalledVersion: sorted[0],
          CpmManaged: true,
        });
      }
    });
    return result;
  }

  // ── NuGet proxy call ───────────────────────────────────────────────────────

  // ── Mock outdated packages (CPM multi-framework demo) ─────────────────────
  // Includes unconditional packages + net8.0 and net9.0 framework-scoped
  // packages so the framework filter dropdown is visible in the Updates tab.

  var NET8_CONDITION = "$(TargetFramework.StartsWith('net8.0'))";
  var NET9_CONDITION = "$(TargetFramework.StartsWith('net9.0'))";

  var MOCK_OUTDATED = [
    // Unconditional (no framework scope)
    {
      Id: 'Newtonsoft.Json',
      InstalledVersion: '12.0.3',
      LatestVersion: '13.0.3',
      Projects: [
        { Name: 'MyApp.csproj', Path: '/workspace/MyApp/MyApp.csproj', Version: '12.0.3' },
      ],
      SourceUrl: 'https://api.nuget.org/v3/index.json',
      SourceName: 'nuget.org',
    },
    {
      Id: 'Serilog',
      InstalledVersion: '2.11.0',
      LatestVersion: '4.2.0',
      Projects: [
        { Name: 'MyApp.csproj', Path: '/workspace/MyApp/MyApp.csproj', Version: '2.11.0' },
        { Name: 'MyApp.Core.csproj', Path: '/workspace/MyApp/MyApp.Core.csproj', Version: '2.11.0' },
      ],
      SourceUrl: 'https://api.nuget.org/v3/index.json',
      SourceName: 'nuget.org',
    },
    {
      Id: 'AutoMapper',
      InstalledVersion: '11.0.1',
      LatestVersion: '13.0.1',
      Projects: [
        { Name: 'MyApp.csproj', Path: '/workspace/MyApp/MyApp.csproj', Version: '11.0.1' },
        { Name: 'MyApp.Core.csproj', Path: '/workspace/MyApp/MyApp.Core.csproj', Version: '11.0.1' },
      ],
      SourceUrl: 'https://api.nuget.org/v3/index.json',
      SourceName: 'nuget.org',
    },
    // net8.0-scoped packages
    {
      Id: 'Microsoft.Extensions.Http',
      InstalledVersion: '8.0.0',
      LatestVersion: '9.0.5',
      Projects: [
        { Name: 'MyApp.csproj', Path: '/workspace/MyApp/MyApp.csproj', Version: '8.0.0' },
      ],
      SourceUrl: 'https://api.nuget.org/v3/index.json',
      SourceName: 'nuget.org',
      CpmCondition: NET8_CONDITION,
      CpmFramework: 'net8.0',
    },
    {
      Id: 'Microsoft.Extensions.Logging',
      InstalledVersion: '8.0.0',
      LatestVersion: '9.0.5',
      Projects: [
        { Name: 'MyApp.Core.csproj', Path: '/workspace/MyApp/MyApp.Core.csproj', Version: '8.0.0' },
      ],
      SourceUrl: 'https://api.nuget.org/v3/index.json',
      SourceName: 'nuget.org',
      CpmCondition: NET8_CONDITION,
      CpmFramework: 'net8.0',
    },
    {
      Id: 'Microsoft.AspNetCore.OpenApi',
      InstalledVersion: '8.0.4',
      LatestVersion: '8.0.15',
      Projects: [
        { Name: 'MyApp.csproj', Path: '/workspace/MyApp/MyApp.csproj', Version: '8.0.4' },
      ],
      SourceUrl: 'https://api.nuget.org/v3/index.json',
      SourceName: 'nuget.org',
      CpmCondition: NET8_CONDITION,
      CpmFramework: 'net8.0',
    },
    // net9.0-scoped packages
    {
      Id: 'Microsoft.Extensions.Http',
      InstalledVersion: '9.0.0',
      LatestVersion: '9.0.5',
      Projects: [
        { Name: 'MyApp.csproj', Path: '/workspace/MyApp/MyApp.csproj', Version: '9.0.0' },
      ],
      SourceUrl: 'https://api.nuget.org/v3/index.json',
      SourceName: 'nuget.org',
      CpmCondition: NET9_CONDITION,
      CpmFramework: 'net9.0',
    },
    {
      Id: 'Microsoft.Extensions.Logging',
      InstalledVersion: '9.0.0',
      LatestVersion: '9.0.5',
      Projects: [
        { Name: 'MyApp.Core.csproj', Path: '/workspace/MyApp/MyApp.Core.csproj', Version: '9.0.0' },
      ],
      SourceUrl: 'https://api.nuget.org/v3/index.json',
      SourceName: 'nuget.org',
      CpmCondition: NET9_CONDITION,
      CpmFramework: 'net9.0',
    },
    {
      Id: 'Microsoft.AspNetCore.OpenApi',
      InstalledVersion: '9.0.0',
      LatestVersion: '9.0.5',
      Projects: [
        { Name: 'MyApp.csproj', Path: '/workspace/MyApp/MyApp.csproj', Version: '9.0.0' },
      ],
      SourceUrl: 'https://api.nuget.org/v3/index.json',
      SourceName: 'nuget.org',
      CpmCondition: NET9_CONDITION,
      CpmFramework: 'net9.0',
    },
  ];

  var NUGET_PROXY_METHODS = [
    'getPackagesAsync',
    'getPackageAsync',
    'getPackageDetailsAsync',
    'getVulnerablePackagesAsync',
  ];

  function callNugetProxy(msg) {
    var params = Object.assign({}, msg.params);

    // Inject installed packages for methods that need to compare against NuGet
    if (msg.method === 'getOutdatedPackagesAsync' || msg.method === 'getVulnerablePackagesAsync') {
      params._installedPackages = getInstalledPackages();
    }

    fetch('/nuget-proxy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ method: msg.method, params: params }),
    })
      .then(function (r) { return r.json(); })
      .then(function (result) {
        // Update readiness flags for the Playwright harness
        if (msg.method === 'getPackagesAsync') window.__mockState.packagesDone = true;
        if (msg.method === 'getOutdatedPackagesAsync') window.__mockState.outdatedDone = true;
        if (msg.method === 'getVulnerablePackagesAsync') window.__mockState.vulnerableDone = true;

        window.dispatchEvent(new MessageEvent('message', {
          origin: window.location.origin,
          data: { type: 'rpc-response', id: msg.id, result: result },
        }));
      })
      .catch(function (err) {
        window.dispatchEvent(new MessageEvent('message', {
          origin: window.location.origin,
          data: { type: 'rpc-response', id: msg.id, result: { ok: false, error: err.message } },
        }));
      });
  }

  // ── Local mock handlers ────────────────────────────────────────────────────

  function getMockResponse(method, params) {
    switch (method) {
      case 'getConfigurationAsync':
        window.__mockState.configDone = true;
        return {
          ok: true,
          value: {
            Configuration: {
              SkipRestore: false,
              EnablePackageVersionInlineInfo: false,
              Prerelease: false,
              Sources: [{ Name: 'nuget.org', Url: 'https://api.nuget.org/v3/index.json' }],
              StatusBarLoadingIndicator: false,
            },
          },
        };

      case 'getProjectsAsync':
        window.__mockState.projectsDone = true;
        return { ok: true, value: { Projects: PROJECTS } };

      case 'getOutdatedPackagesAsync':
        window.__mockState.outdatedDone = true;
        return delay(600).then(function () {
          // Compute current installed versions from PROJECTS so that updates
          // made via the project-row (or batch update) are reflected here.
          var current = MOCK_OUTDATED.map(function(outdated) {
            var versions = [];
            outdated.Projects.forEach(function(p) {
              var project = PROJECTS.find(function(proj) { return proj.Path === p.Path; });
              if (!project) return;
              // Match by package Id only, to stay consistent with the mock
              // batchUpdatePackagesAsync behavior.
              var pkg = project.Packages.find(function(pk) {
                return pk.Id === outdated.Id;
              });
              if (pkg) versions.push(pkg.Version);
            });
            if (versions.length === 0) return null;
            versions.sort(compareVersions);
            var minVersion = versions[0];
            // Package is up-to-date — remove from list
            if (compareVersions(outdated.LatestVersion, minVersion) <= 0) return null;
            return Object.assign({}, outdated, { InstalledVersion: minVersion });
          }).filter(Boolean);
          return { ok: true, value: { Packages: current } };
        });

      case 'getInconsistentPackagesAsync':
        window.__mockState.inconsistentDone = true;
        return { ok: true, value: { Packages: computeInconsistencies() } };

      case 'updateProjectAsync':
        return delay(1500).then(function () {
          var project = PROJECTS.find(function (p) { return p.Path === params.ProjectPath; });
          if (!project) return { ok: false, error: 'Project not found' };
          if (params.Type === 'INSTALL') {
            project.Packages.push({ Id: params.PackageId, Version: params.Version, IsPinned: false, VersionSource: 'project' });
          } else if (params.Type === 'UPDATE') {
            var pkg = project.Packages.find(function (p) { return p.Id === params.PackageId; });
            if (pkg) pkg.Version = params.Version;
          } else if (params.Type === 'UNINSTALL') {
            project.Packages = project.Packages.filter(function (p) { return p.Id !== params.PackageId; });
          }
          return { ok: true, value: { Project: project, IsCpmEnabled: false } };
        });

      case 'batchUpdatePackagesAsync':
        return delay(2000).then(function () {
          var updatedIds = [];
          (params.Updates || []).forEach(function (update) {
            updatedIds.push(update.PackageId);
            (update.ProjectPaths || []).forEach(function (path) {
              var project = PROJECTS.find(function (p) { return p.Path === path; });
              if (project) {
                var pkg = project.Packages.find(function (p) { return p.Id === update.PackageId; });
                if (pkg) pkg.Version = update.Version;
              }
            });
          });
          return {
            ok: true,
            value: { Results: updatedIds.map(function (id) { return { PackageId: id, Success: true }; }) },
          };
        });

      case 'getCleanupReportAsync':
        return {
          ok: true,
          value: {
            PropsFiles: [{
              Path: '/mock/Directory.Packages.props',
              Defined: ['AutoMapper', 'MediatR', 'Newtonsoft.Json', 'Serilog'],
              Unused: ['AutoMapper', 'MediatR'],
            }],
            Used: ['Newtonsoft.Json', 'Serilog'],
            Missing: [],
            Unused: ['AutoMapper', 'MediatR'],
          },
        };

      case 'cleanupUnusedPackagesAsync':
        return delay(800).then(function () {
          return {
            ok: true,
            value: {
              Report: {
                PropsFiles: [{ Path: '/mock/Directory.Packages.props', Defined: ['AutoMapper', 'MediatR', 'Newtonsoft.Json', 'Serilog'], Unused: [] }],
                Used: ['Newtonsoft.Json', 'Serilog'],
                Missing: [],
                Unused: [],
              },
              Removed: ['AutoMapper', 'MediatR'],
              Backups: ['/mock/Directory.Packages.props.backup.mock'],
              Errors: [],
            },
          };
        });

      case 'consolidatePackagesAsync':
        return delay(1500).then(function () {
          (params.ProjectPaths || []).forEach(function (path) {
            var project = PROJECTS.find(function (p) { return p.Path === path; });
            if (project) {
              var pkg = project.Packages.find(function (p) { return p.Id === params.PackageId; });
              if (pkg) pkg.Version = params.TargetVersion;
            }
          });
          return { ok: true, value: undefined };
        });

      case 'restoreProjectsAsync':
        return delay(800).then(function () { return { ok: true, value: undefined }; });

      case 'getToolchainHealthAsync':
        return delay(400).then(function () {
          return {
            ok: true,
            value: {
              Health: {
                DotnetFound: true,
                SdkVersion: '10.0.403',
                GlobalJsonPath: '/mock/global.json',
                PinnedSdkVersion: '10.0.403',
                SdkMatchesPin: true,
                ProjectEvaluationFailed: false,
                CheckedAt: new Date().toISOString(),
                InstalledSdks: [
                  { Version: '11.0.100-rc.3.26522.148', Path: 'C:/Program Files/dotnet/sdk', Source: 'system' },
                  { Version: '10.0.403', Path: 'C:/Program Files/dotnet/sdk', Source: 'system' },
                  { Version: '9.0.320', Path: 'C:/Program Files/dotnet/sdk', Source: 'system' },
                ],
                Issues: [],
              },
            },
          };
        });

      case 'runToolchainDiagnosticsAsync':
        return { ok: true, value: { Report: '--- NuGet Package Manager toolchain diagnostics (mock) ---' } };

      case 'setWorkspaceSdkAsync':
        return {
          ok: true,
          value: { GlobalJsonPath: '/mock/global.json', Version: params.Version, Notes: [] },
        };

      case 'installSdkAsync':
        return delay(1200).then(function () {
          return {
            ok: true,
            value: {
              Installed: true,
              InstallRoot: '~/.dotnet',
              DotnetPath: '~/.dotnet/dotnet',
              SdkVersion: params.Version,
            },
          };
        });

      case 'runWorkloadCommandAsync':
        return delay(1200).then(function () {
          return {
            ok: true,
            value: { Action: params.Action, Succeeded: true, ExitCode: 0, Output: 'mock output', NeedsElevation: false },
          };
        });

      case 'getDependencyIssuesAsync':
        return delay(400).then(function () {
          return {
            ok: true,
            value: { Issues: [], ProjectsScanned: PROJECTS.length, ProjectsSkipped: 0, SkippedProjectPaths: [] },
          };
        });

      case 'fixRestoreConflictAsync':
        return delay(800).then(function () { return { ok: true, value: { Applied: true } }; });

      case 'updateCentralVersionsAsync':
        return delay(600).then(function () {
          return {
            ok: true,
            value: {
              Applied: (params.Updates || []).map(function (u) { return u.PackageId; }),
              Skipped: [],
              PropsFile: '/mock/Directory.Packages.props',
            },
          };
        });

      case 'updateConfigurationAsync':
        return { ok: true, value: undefined };

      case 'updateStatusBarAsync':
      case 'openUrlAsync':
        return { ok: true, value: undefined };

      case 'startBatchUpdateAsync':
        return startMockJob(
          'batchUpdate',
          'Applying versions…',
          function () {
            return {
              Results: (params.Updates || []).map(function (update) {
                return { PackageId: update.PackageId, Success: true };
              }),
            };
          },
          function () { applyBatchMutation(params); });

      case 'startProjectUpdateAsync':
        return startMockJob(
          'projectUpdate',
          'Updating project…',
          function () {
            var project = PROJECTS.find(function (p) { return p.Path === params.ProjectPath; });
            return { Project: project, IsCpmEnabled: false };
          },
          function () { applyProjectMutation(params); });

      case 'startConsolidateAsync':
        return startMockJob(
          'consolidate',
          'Consolidating versions…',
          undefined,
          function () {
            (params.ProjectPaths || []).forEach(function (path) {
              var project = PROJECTS.find(function (p) { return p.Path === path; });
              if (!project) return;
              var pkg = project.Packages.find(function (p) { return p.Id === params.PackageId; });
              if (pkg) pkg.Version = params.TargetVersion;
            });
          });

      case 'startCleanupAsync':
        return startMockJob('cleanup', 'Removing unused packages…', cleanupResponse, function () {
          window.__mockState.vulnerableDone = true;
        });

      case 'getJobAsync':
        var job = mockJobs.get(params.JobId);
        return job
          ? { ok: true, value: jobSnapshot(job) }
          : { ok: false, error: 'Unknown job: ' + params.JobId };

      case 'cancelJobAsync':
        var cancellable = mockJobs.get(params.JobId);
        if (cancellable) {
          cancellable.State = 'cancelled';
          cancellable.Response = undefined;
        }
        return { ok: true, value: undefined };

      case 'getOutdatedScanProgressAsync':
        return {
          ok: true,
          value: { Stage: 'Preparing results', Percent: 100, Completed: 3, Total: 3, Active: false },
        };

      case 'updateBadgeAsync':
        return { ok: true, value: undefined };

      case 'showConfirmationAsync':
        return { ok: true, value: { Confirmed: true } };

      case 'getOperationProgressAsync':
        return { ok: true, value: { Stage: 'Installing...', Percent: 50, Active: false } };

      default:
        console.warn('[mock-api] Unhandled RPC method:', method);
        return { ok: false, error: 'Unhandled method: ' + method };
    }
  }

  // ── acquireVsCodeApi stub ──────────────────────────────────────────────────

  window.acquireVsCodeApi = function () {
    return {
      postMessage: function (msg) {
        if (!msg || msg.type !== 'rpc-request') return;

        // Route NuGet data methods to the live proxy
        if (NUGET_PROXY_METHODS.includes(msg.method)) {
          callNugetProxy(msg);
          return;
        }

        // Handle everything else locally
        Promise.resolve(getMockResponse(msg.method, msg.params)).then(function (result) {
          window.dispatchEvent(new MessageEvent('message', {
            origin: window.location.origin,
            data: { type: 'rpc-response', id: msg.id, result: result },
          }));
        });
      },
      getState: function () { return {}; },
      setState: function () {},
    };
  };
})();
