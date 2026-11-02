import '@/web/web-setup';
import * as assert from 'assert';
import * as sinon from 'sinon';
import * as registrations from '@/web/registrations';
import { ok, fail } from '@/common/rpc/result';
import type { HostAPI } from '@/common/rpc/types';
import { PackagesView } from '@/web/components/packages-view';
import { PackageViewModel, ProjectViewModel } from '@/web/types';

// Helper to create mock Package data
function createMockPackage(overrides: Partial<Package> = {}): Package {
    return {
        Id: 'Test.Package',
        Name: 'Test.Package',
        Authors: ['Author1'],
        Description: 'Test Description',
        IconUrl: 'http://test.com/icon.png',
        LicenseUrl: 'http://license.com',
        ProjectUrl: 'http://project.com',
        Registration: '',
        TotalDownloads: 1000,
        Verified: true,
        InstalledVersion: '',
        Version: '1.0.0',
        Versions: [{ Version: '1.0.0' }, { Version: '0.9.0' }],
        Tags: ['tag1', 'tag2'],
        ...overrides
    };
}

// Helper to create mock Project data
function createMockProject(name: string, packages: (ProjectPackage | { Id: string, Version: string })[] = []): Project {
    return {
        Name: name,
        Path: `/path/to/${name}.csproj`,
        Packages: packages.map(p => ({ ...p, IsPinned: (p as ProjectPackage).IsPinned ?? false, VersionSource: (p as ProjectPackage).VersionSource ?? "project" as VersionSource })),
        CpmEnabled: false,
    };
}

suite('PackagesView Component', () => {
    let packagesView: PackagesView;
    let sandbox: sinon.SinonSandbox;
    let mockHostApi: Partial<HostAPI>;

    setup(() => {
        sandbox = sinon.createSandbox();

        // Create mock hostApi
        mockHostApi = {
            getPackagesAsync: sandbox.stub().resolves(ok({ Packages: [] })),
            getProjectsAsync: sandbox.stub().resolves(ok({ Projects: [] })),
            getVulnerablePackagesAsync: sandbox.stub().resolves(ok({ Packages: [] })),
            getOutdatedPackagesAsync: sandbox.stub().resolves(ok({ Packages: [] })),
            updateBadgeAsync: sandbox.stub().resolves(ok(undefined)),
            getPackageAsync: sandbox.stub().resolves(ok({ Package: createMockPackage(), SourceUrl: '' })),
            updateStatusBarAsync: sandbox.stub().resolves(ok(undefined)),
        };

        // Inject mock hostApi into the registrations module
        Object.defineProperty(registrations, 'hostApi', { value: mockHostApi, writable: true, configurable: true });

        // Create mock configuration with Sources
        (registrations.configuration as any)['configuration'] = {
            Sources: [
                { Name: 'nuget.org', Url: 'https://api.nuget.org/v3/index.json' },
                { Name: 'Private', Url: 'https://private.nuget.org', PasswordScriptPath: '/script.ps1' }
            ]
        };

        packagesView = new PackagesView();

        // Initialize observable properties (don't connect to DOM to avoid Split.js issues)
        packagesView.packages = [];
        packagesView.projects = [];
        packagesView.projectsPackages = [];
        packagesView.filters = { Prerelease: true, Query: '', SourceUrl: '', Sort: 'relevance' };
    });

    teardown(() => {
        sandbox.restore();
    });

    suite('Initial State', () => {
        test('should have empty packages array initially', () => {
            assert.deepStrictEqual(packagesView.packages, []);
        });

        test('should have empty projects array initially', () => {
            assert.deepStrictEqual(packagesView.projects, []);
        });

        test('should have null selectedPackage initially', () => {
            assert.strictEqual(packagesView.selectedPackage, null);
        });

        test('should have default filter values', () => {
            assert.strictEqual(packagesView.filters.Prerelease, true);
            assert.strictEqual(packagesView.filters.Query, '');
            assert.strictEqual(packagesView.filters.SourceUrl, '');
        });

        test('should have noMorePackages as false initially', () => {
            assert.strictEqual(packagesView.noMorePackages, false);
        });

        test('should have packagesLoadingError as false initially', () => {
            assert.strictEqual(packagesView.packagesLoadingError, false);
        });
    });

    suite('LoadPackages', () => {
        test('should call mediator with correct parameters', async () => {
            (mockHostApi.getPackagesAsync as sinon.SinonStub).resolves(ok({ Packages: [] }));

            packagesView.filters = {
                Prerelease: true,
                Query: 'test-query',
                SourceUrl: 'https://api.nuget.org/v3/index.json',
                Sort: 'relevance',
            };

            await packagesView.LoadPackagesAsync();

            assert.ok((mockHostApi.getPackagesAsync as sinon.SinonStub).calledOnce);
            const callArgs = (mockHostApi.getPackagesAsync as sinon.SinonStub).firstCall.args[0];
            assert.strictEqual(callArgs.Filter, 'test-query');
            assert.strictEqual(callArgs.Prerelease, true);
            assert.strictEqual(callArgs.Url, 'https://api.nuget.org/v3/index.json');
            assert.strictEqual(callArgs.Skip, 0);
            assert.strictEqual(callArgs.Take, 50);
        });

        test('should populate packages on successful response', async () => {
            const mockPackages = [
                createMockPackage({ Id: 'Package1', Name: 'Package1' }),
                createMockPackage({ Id: 'Package2', Name: 'Package2' })
            ];

            (mockHostApi.getPackagesAsync as sinon.SinonStub).resolves(ok({ Packages: mockPackages }));

            await packagesView.LoadPackagesAsync();

            assert.strictEqual(packagesView.packages.length, 2);
            assert.strictEqual(packagesView.packages[0]!.Id, 'Package1');
            assert.strictEqual(packagesView.packages[1]!.Id, 'Package2');
        });

        test('should set noMorePackages when fewer packages returned than requested', async () => {
            const mockPackages = [createMockPackage()]; // Only 1 package, less than 50

            (mockHostApi.getPackagesAsync as sinon.SinonStub).resolves(ok({ Packages: mockPackages }));

            await packagesView.LoadPackagesAsync();

            assert.strictEqual(packagesView.noMorePackages, true);
        });

        test('should set packagesLoadingError on failure', async () => {
            (mockHostApi.getPackagesAsync as sinon.SinonStub).resolves(fail('Network error'));

            await packagesView.LoadPackagesAsync();

            assert.strictEqual(packagesView.packagesLoadingError, true);
        });

        test('should append packages when append is true', async () => {
            // First load
            packagesView.packages = [
                new PackageViewModel(createMockPackage({ Id: 'Existing' }))
            ];
            packagesView.packagesPage = 1;

            (mockHostApi.getPackagesAsync as sinon.SinonStub).resolves(
                ok({ Packages: [createMockPackage({ Id: 'NewPackage' })] })
            );

            await packagesView.LoadPackagesAsync(true);

            assert.strictEqual(packagesView.packages.length, 2);
            assert.strictEqual(packagesView.packages[0]!.Id, 'Existing');
            assert.strictEqual(packagesView.packages[1]!.Id, 'NewPackage');
        });

        test('should reset packages when append is false', async () => {
            packagesView.packages = [
                new PackageViewModel(createMockPackage({ Id: 'OldPackage' }))
            ];

            (mockHostApi.getPackagesAsync as sinon.SinonStub).resolves(
                ok({ Packages: [createMockPackage({ Id: 'NewPackage' })] })
            );

            await packagesView.LoadPackagesAsync(false);

            assert.strictEqual(packagesView.packages.length, 1);
            assert.strictEqual(packagesView.packages[0]!.Id, 'NewPackage');
        });

        test('should pass ForceReload flag to mediator', async () => {
            (mockHostApi.getPackagesAsync as sinon.SinonStub).resolves(ok({ Packages: [] }));

            await packagesView.LoadPackagesAsync(false, true);

            const callArgs = (mockHostApi.getPackagesAsync as sinon.SinonStub).firstCall.args[0];
            assert.strictEqual(callArgs.ForceReload, true);
        });
    });

    suite('LoadProjects', () => {
        test('should call mediator with correct parameters', async () => {
            (mockHostApi.getProjectsAsync as sinon.SinonStub).resolves(ok({ Projects: [] }));

            await packagesView.LoadProjectsAsync();

            assert.ok((mockHostApi.getProjectsAsync as sinon.SinonStub).called);
            const callArgs = (mockHostApi.getProjectsAsync as sinon.SinonStub).firstCall.args[0];
            assert.strictEqual(callArgs.ForceReload, false);
        });

        test('should populate projects from response', async () => {
            const mockProjects = [
                createMockProject('Project1', [{ Id: 'Pkg1', Version: '1.0.0' }]),
                createMockProject('Project2', [{ Id: 'Pkg2', Version: '2.0.0' }])
            ];

            (mockHostApi.getProjectsAsync as sinon.SinonStub).resolves(ok({ Projects: mockProjects }));

            await packagesView.LoadProjectsAsync();

            assert.strictEqual(packagesView.projects.length, 2);
            assert.strictEqual(packagesView.projects[0]!.Name, 'Project1');
            assert.strictEqual(packagesView.projects[1]!.Name, 'Project2');
        });

        test('should pass ForceReload flag', async () => {
            (mockHostApi.getProjectsAsync as sinon.SinonStub).resolves(ok({ Projects: [] }));

            await packagesView.LoadProjectsAsync(true);

            const callArgs = (mockHostApi.getProjectsAsync as sinon.SinonStub).firstCall.args[0];
            assert.strictEqual(callArgs.ForceReload, true);
        });
    });

    suite('SelectPackage', () => {
        test('should set selectedPackage', async () => {
            const pkg = new PackageViewModel(createMockPackage({ Id: 'Selected' }));
            packagesView.packages = [pkg];

            await packagesView.SelectPackageAsync(pkg);

            assert.strictEqual(packagesView.selectedPackage, pkg);
        });

        test('should set package as selected', async () => {
            const pkg = new PackageViewModel(createMockPackage());

            await packagesView.SelectPackageAsync(pkg);

            assert.strictEqual(pkg.Selected, true);
        });

        test('should deselect previously selected packages', async () => {
            const pkg1 = new PackageViewModel(createMockPackage({ Id: 'Pkg1' }));
            const pkg2 = new PackageViewModel(createMockPackage({ Id: 'Pkg2' }));
            pkg1.Selected = true;
            packagesView.packages = [pkg1, pkg2];

            await packagesView.SelectPackageAsync(pkg2);

            assert.strictEqual(pkg1.Selected, false);
            assert.strictEqual(pkg2.Selected, true);
        });

        test('should set selectedVersion from package Version', async () => {
            const pkg = new PackageViewModel(createMockPackage({ Version: '2.0.0' }));

            await packagesView.SelectPackageAsync(pkg);

            assert.strictEqual(packagesView.selectedVersion, '2.0.0');
        });

        test('should fetch package details if status is MissingDetails', async () => {
            const pkg = new PackageViewModel(createMockPackage(), 'MissingDetails');

            (mockHostApi.getPackageAsync as sinon.SinonStub).resolves(
                ok({
                    Package: createMockPackage({ Version: '1.5.0' }),
                    SourceUrl: 'https://api.nuget.org'
                })
            );

            await packagesView.SelectPackageAsync(pkg);

            assert.ok((mockHostApi.getPackageAsync as sinon.SinonStub).calledOnce);
            assert.strictEqual(pkg.Status, 'Detailed');
        });

        test('should set status to Error if package fetch fails', async () => {
            const pkg = new PackageViewModel(createMockPackage(), 'MissingDetails');

            (mockHostApi.getPackageAsync as sinon.SinonStub).resolves(fail('Not found'));

            await packagesView.SelectPackageAsync(pkg);

            assert.strictEqual(pkg.Status, 'Error');
        });
    });

    suite('Child package selection', () => {
        type ChildSelection = {
            onChildPackageSelectedAsync(e: CustomEvent<{ packageId: string; sourceUrl?: string }>): Promise<void>;
        };

        const selectFromChildAsync = async (packageId: string, sourceUrl?: string): Promise<void> => {
            const detail: { packageId: string; sourceUrl?: string } = { packageId };
            if (sourceUrl !== undefined) detail.sourceUrl = sourceUrl;
            await (packagesView as unknown as ChildSelection).onChildPackageSelectedAsync(
                new CustomEvent('package-selected', { detail })
            );
        };

        test('refetches the installed package from the row source and keeps it selected', async () => {
            const installed = PackageViewModel.Empty('Contoso.Sdk');
            installed.InstalledVersion = '6.0.0';
            installed.SourceUrl = 'https://offline.feed/v3/index.json';
            packagesView.projectsPackages = [installed];

            (mockHostApi.getPackageAsync as sinon.SinonStub).resolves(
                ok({
                    Package: createMockPackage({
                        Id: 'Contoso.Sdk',
                        Name: 'Contoso.Sdk',
                        TotalDownloads: 1122400000,
                        Versions: [
                            { Version: '9.0.1', Downloads: 500 },
                            { Version: '6.0.0', Downloads: 10 },
                        ],
                    }),
                    SourceUrl: 'https://private.nuget.org',
                })
            );

            await selectFromChildAsync('Contoso.Sdk', 'https://private.nuget.org');

            const stub = mockHostApi.getPackageAsync as sinon.SinonStub;
            assert.ok(stub.calledOnce, 'the refetch replaces the first-feed metadata in one call');
            const request = stub.firstCall.args[0];
            assert.strictEqual(request.Id, 'Contoso.Sdk');
            assert.strictEqual(request.Url, 'https://private.nuget.org');
            assert.strictEqual(request.Prerelease, true);
            // Credentials follow the row's source, not the Browse filter's source.
            assert.strictEqual(request.SourceName, 'Private');
            assert.strictEqual(request.PasswordScriptPath, '/script.ps1');

            assert.strictEqual(installed.TotalDownloads, 1122400000);
            assert.strictEqual(installed.DownloadsForVersion('6.0.0'), 10);
            assert.strictEqual(installed.InstalledVersion, '6.0.0');
            assert.strictEqual(installed.SourceUrl, 'https://private.nuget.org');
            assert.strictEqual(installed.Status, 'Detailed');
            assert.strictEqual(packagesView.selectedPackage, installed);
            assert.strictEqual(installed.Selected, true);
        });

        test('does not refetch when the installed copy already came from the row source', async () => {
            const installed = new PackageViewModel(createMockPackage({
                Id: 'Contoso.Sdk',
                Name: 'Contoso.Sdk',
            }));
            installed.InstalledVersion = '6.0.0';
            installed.SourceUrl = 'https://api.nuget.org/v3/index.json';
            installed.Status = 'Detailed';
            packagesView.projectsPackages = [installed];

            await selectFromChildAsync('Contoso.Sdk', 'https://api.nuget.org/v3/index.json');

            assert.ok((mockHostApi.getPackageAsync as sinon.SinonStub).notCalled);
            assert.strictEqual(packagesView.selectedPackage, installed);
        });

        test('a failed refetch keeps the existing package and still selects it', async () => {
            const installed = PackageViewModel.Empty('Contoso.Sdk', 'Detailed');
            installed.InstalledVersion = '6.0.0';
            installed.SourceUrl = 'https://offline.feed/v3/index.json';
            packagesView.projectsPackages = [installed];

            (mockHostApi.getPackageAsync as sinon.SinonStub).resolves(fail('feed is down'));

            await selectFromChildAsync('Contoso.Sdk', 'https://api.nuget.org/v3/index.json');

            assert.ok((mockHostApi.getPackageAsync as sinon.SinonStub).calledOnce);
            assert.strictEqual(installed.SourceUrl, 'https://offline.feed/v3/index.json');
            assert.strictEqual(installed.InstalledVersion, '6.0.0');
            assert.strictEqual(installed.TotalDownloads, null);
            assert.strictEqual(packagesView.selectedPackage, installed);
            assert.strictEqual(installed.Selected, true);
        });

        test('still selects packages that are not installed', async () => {
            const browsePkg = new PackageViewModel(createMockPackage({
                Id: 'Contoso.Sdk',
                Name: 'Contoso.Sdk',
            }));
            packagesView.packages = [browsePkg];

            await selectFromChildAsync('Contoso.Sdk', 'https://private.nuget.org');

            assert.ok((mockHostApi.getPackageAsync as sinon.SinonStub).notCalled);
            assert.strictEqual(packagesView.selectedPackage, browsePkg);
        });
    });

    suite('UpdatePackagesFilters', () => {
        test('should update filters', async () => {
            (mockHostApi.getPackagesAsync as sinon.SinonStub).resolves(ok({ Packages: [] }));

            const newFilters = {
                Prerelease: false,
                Query: 'newtonsoft',
                SourceUrl: 'https://private.nuget.org',
                Sort: 'relevance' as const,
            };

            await packagesView.UpdatePackagesFiltersAsync(newFilters);

            assert.strictEqual(packagesView.filters.Prerelease, false);
            assert.strictEqual(packagesView.filters.Query, 'newtonsoft');
            assert.strictEqual(packagesView.filters.SourceUrl, 'https://private.nuget.org');
        });

        test('should reload packages with new filters', async () => {
            (mockHostApi.getPackagesAsync as sinon.SinonStub).resolves(ok({ Packages: [] }));

            await packagesView.UpdatePackagesFiltersAsync({
                Prerelease: false,
                Query: 'test',
                SourceUrl: '',
                Sort: 'relevance',
            });

            assert.ok((mockHostApi.getPackagesAsync as sinon.SinonStub).called);
        });

        test('should NOT force-reload getPackages when only Prerelease changes', async () => {
            // Prerelease changes must NOT clear the NuGet API factory cache.
            // The package cache key is "${id}::${prerelease}", so toggling prerelease
            // already results in a natural cache miss — destroying NuGetApi instances
            // caused ~15 s delays. Only source changes warrant a factory cache clear.
            packagesView.filters.Prerelease = true;

            (mockHostApi.getPackagesAsync as sinon.SinonStub).resolves(ok({ Packages: [] }));

            await packagesView.UpdatePackagesFiltersAsync({
                Prerelease: false, // Changed from true
                Query: '',
                SourceUrl: '',
                Sort: 'relevance',
            });

            const callArgs = (mockHostApi.getPackagesAsync as sinon.SinonStub).firstCall.args[0];
            assert.strictEqual(callArgs.ForceReload, false);
        });

        test('clears the stale update count immediately and rechecks it on a Prerelease change', async () => {
            const internals = packagesView as unknown as {
                _connected: boolean;
                _allProjectPaths: string[];
                updatesCountLoading: boolean;
            };
            internals._connected = true;
            internals._allProjectPaths = ['/path/to/Project.csproj'];
            packagesView.updatesCount = 60;

            let releaseScan: ((value: unknown) => void) | undefined;
            (mockHostApi.getOutdatedPackagesAsync as sinon.SinonStub)
                .returns(new Promise((resolve) => { releaseScan = resolve; }));

            const pending = packagesView.UpdatePackagesFiltersAsync({
                Prerelease: false,
                Query: '',
                SourceUrl: '',
                Sort: 'relevance',
            });

            // The prerelease count must not survive the toggle.
            assert.strictEqual(packagesView.updatesCount, null);
            assert.strictEqual(internals.updatesCountLoading, true);

            releaseScan!(ok({ Packages: [{ Id: 'A' }, { Id: 'B' }] }));
            await pending;

            assert.strictEqual(packagesView.updatesCount, 2);
            assert.strictEqual(internals.updatesCountLoading, false);

            const scanRequest = (mockHostApi.getOutdatedPackagesAsync as sinon.SinonStub).firstCall.args[0];
            assert.strictEqual(scanRequest.Prerelease, false);
            const badgeRequest = (mockHostApi.updateBadgeAsync as sinon.SinonStub).lastCall.args[0];
            assert.strictEqual(badgeRequest.Count, 2);
        });
    });

    suite('ReloadInvoked', () => {
        test('should reload packages and projects', async () => {
            (mockHostApi.getPackagesAsync as sinon.SinonStub).resolves(ok({ Packages: [] }));
            (mockHostApi.getProjectsAsync as sinon.SinonStub).resolves(ok({ Projects: [] }));

            await packagesView.ReloadInvokedAsync();

            assert.ok((mockHostApi.getPackagesAsync as sinon.SinonStub).called);
            assert.ok((mockHostApi.getProjectsAsync as sinon.SinonStub).called);
        });

        test('should pass forceReload flag', async () => {
            (mockHostApi.getPackagesAsync as sinon.SinonStub).resolves(ok({ Packages: [] }));
            (mockHostApi.getProjectsAsync as sinon.SinonStub).resolves(ok({ Projects: [] }));

            await packagesView.ReloadInvokedAsync(true);

            const getPackagesArgs = (mockHostApi.getPackagesAsync as sinon.SinonStub).firstCall.args[0];
            assert.strictEqual(getPackagesArgs.ForceReload, true);

            const getProjectsArgs = (mockHostApi.getProjectsAsync as sinon.SinonStub).firstCall.args[0];
            assert.strictEqual(getProjectsArgs.ForceReload, true);
        });
    });

    suite('PackagesScrollEvent', () => {
        test('should not load more if already loading', async () => {
            packagesView.packagesLoadingInProgress = true;

            const mockTarget = {
                scrollTop: 1000,
                getBoundingClientRect: () => ({ height: 500 }),
                scrollHeight: 1200
            } as HTMLElement;

            await packagesView.PackagesScrollEventAsync(mockTarget);

            assert.ok((mockHostApi.getPackagesAsync as sinon.SinonStub).notCalled);
        });

        test('should not load more if noMorePackages is true', async () => {
            packagesView.noMorePackages = true;

            const mockTarget = {
                scrollTop: 1000,
                getBoundingClientRect: () => ({ height: 500 }),
                scrollHeight: 1200
            } as HTMLElement;

            await packagesView.PackagesScrollEventAsync(mockTarget);

            assert.ok((mockHostApi.getPackagesAsync as sinon.SinonStub).notCalled);
        });

        test('should load more when scrolled near bottom', async () => {
            packagesView.packagesLoadingInProgress = false;
            packagesView.noMorePackages = false;

            (mockHostApi.getPackagesAsync as sinon.SinonStub).resolves(ok({ Packages: [] }));

            // Simulate scrolled near bottom
            const mockTarget = {
                scrollTop: 900,
                getBoundingClientRect: () => ({ height: 500 }),
                scrollHeight: 1200 // 900 + 500 = 1400 > 1200 - 196 = 1004
            } as HTMLElement;

            await packagesView.PackagesScrollEventAsync(mockTarget);

            assert.ok((mockHostApi.getPackagesAsync as sinon.SinonStub).called);
        });
    });

    suite('OnProjectUpdated', () => {
        test('should reload all projects when CPM is enabled', async () => {
            (mockHostApi.getProjectsAsync as sinon.SinonStub).resolves(ok({ Projects: [] }));

            const event = new CustomEvent('project-updated', {
                detail: { isCpmEnabled: true }
            });

            await packagesView.OnProjectUpdatedAsync(event);

            assert.ok((mockHostApi.getProjectsAsync as sinon.SinonStub).called);
        });

        test('should only refresh packages when CPM is not enabled', async () => {
            // Set up projects with packages
            packagesView.projects = [
                new ProjectViewModel(createMockProject('Project1', [
                    { Id: 'Pkg1', Version: '1.0.0' }
                ]))
            ];

            (mockHostApi.getPackageAsync as sinon.SinonStub).resolves(
                ok({ Package: createMockPackage(), SourceUrl: '' })
            );

            const event = new CustomEvent('project-updated', {
                detail: { isCpmEnabled: false }
            });

            await packagesView.OnProjectUpdatedAsync(event);

            // Should call getPackage for installed packages, not getProjects
            assert.ok((mockHostApi.getProjectsAsync as sinon.SinonStub).notCalled);
        });
    });

    suite('Computed Properties', () => {
        test('CurrentSource should return matching source from configuration', () => {
            packagesView.filters.SourceUrl = 'https://private.nuget.org';

            const source = packagesView.CurrentSource;

            assert.strictEqual(source?.Name, 'Private');
            assert.strictEqual(source?.PasswordScriptPath, '/script.ps1');
        });

        test('CurrentSource should return undefined for non-matching URL', () => {
            packagesView.filters.SourceUrl = 'https://unknown.nuget.org';

            const source = packagesView.CurrentSource;

            assert.strictEqual(source, undefined);
        });

        test('NugetOrgPackageUrl should return URL for nuget.org source', () => {
            packagesView.filters.SourceUrl = 'https://api.nuget.org/v3/index.json';
            packagesView.selectedPackage = new PackageViewModel(
                createMockPackage({ Name: 'Newtonsoft.Json' })
            );
            packagesView.selectedVersion = '13.0.1';

            const url = packagesView.NugetOrgPackageUrl;

            assert.strictEqual(url, 'https://www.nuget.org/packages/Newtonsoft.Json/13.0.1');
        });

        test('NugetOrgPackageUrl should return null for non-nuget.org source', () => {
            packagesView.filters.SourceUrl = 'https://private.nuget.org';
            packagesView.selectedPackage = new PackageViewModel(createMockPackage());
            packagesView.selectedVersion = '1.0.0';

            const url = packagesView.NugetOrgPackageUrl;

            assert.strictEqual(url, null);
        });

        test('NugetOrgPackageUrl should use selectedPackage.SourceUrl when filters.SourceUrl is empty', () => {
            packagesView.filters.SourceUrl = ''; // "All" sources selected
            packagesView.selectedPackage = new PackageViewModel(
                createMockPackage({ Name: 'Newtonsoft.Json' })
            );
            packagesView.selectedPackage.SourceUrl = 'https://api.nuget.org/v3/index.json';
            packagesView.selectedVersion = '13.0.1';

            const url = packagesView.NugetOrgPackageUrl;

            assert.strictEqual(url, 'https://www.nuget.org/packages/Newtonsoft.Json/13.0.1');
        });

        test('NugetOrgPackageUrl should return null when package is from non-nuget.org source with empty filter', () => {
            packagesView.filters.SourceUrl = ''; // "All" sources selected
            packagesView.selectedPackage = new PackageViewModel(createMockPackage());
            packagesView.selectedPackage.SourceUrl = 'https://private.nuget.org/v3/index.json';
            packagesView.selectedVersion = '1.0.0';

            const url = packagesView.NugetOrgPackageUrl;

            assert.strictEqual(url, null);
        });

    });

    suite('LoadProjectsPackages', () => {
        test('should aggregate packages from all projects', async () => {
            packagesView.projects = [
                new ProjectViewModel(createMockProject('Project1', [
                    { Id: 'Pkg1', Version: '1.0.0' },
                    { Id: 'Pkg2', Version: '2.0.0' }
                ])),
                new ProjectViewModel(createMockProject('Project2', [
                    { Id: 'Pkg1', Version: '1.0.0' }, // Duplicate
                    { Id: 'Pkg3', Version: '3.0.0' }
                ]))
            ];

            (mockHostApi.getPackageAsync as sinon.SinonStub).resolves(
                ok({ Package: createMockPackage(), SourceUrl: 'https://api.nuget.org' })
            );

            await packagesView.LoadProjectsPackagesAsync();

            // Should have 3 unique packages: Pkg1, Pkg2, Pkg3
            assert.strictEqual(packagesView.projectsPackages.length, 3);
        });

        test('should filter packages by query', async () => {
            packagesView.projects = [
                new ProjectViewModel(createMockProject('Project1', [
                    { Id: 'Newtonsoft.Json', Version: '1.0.0' },
                    { Id: 'Serilog', Version: '2.0.0' }
                ]))
            ];
            packagesView.filters.Query = 'newtonsoft';

            // Mock returns matching package
            (mockHostApi.getPackageAsync as sinon.SinonStub).resolves(
                ok({
                    Package: createMockPackage({ Id: 'Newtonsoft.Json', Name: 'Newtonsoft.Json' }),
                    SourceUrl: ''
                })
            );

            await packagesView.LoadProjectsPackagesAsync();

            // Should only have 1 package matching the query filter
            assert.strictEqual(packagesView.projectsPackages.length, 1);
            assert.strictEqual(packagesView.projectsPackages[0]!.Id, 'Newtonsoft.Json');
        });

        test('should show "Multiple" for packages with different versions', async () => {
            packagesView.projects = [
                new ProjectViewModel(createMockProject('Project1', [
                    { Id: 'Pkg1', Version: '1.0.0' }
                ])),
                new ProjectViewModel(createMockProject('Project2', [
                    { Id: 'Pkg1', Version: '2.0.0' } // Different version
                ]))
            ];

            // Mock returns matching package ID so the find() works
            (mockHostApi.getPackageAsync as sinon.SinonStub).resolves(
                ok({
                    Package: createMockPackage({ Id: 'Pkg1', Name: 'Pkg1' }),
                    SourceUrl: ''
                })
            );

            await packagesView.LoadProjectsPackagesAsync();

            const pkg1 = packagesView.projectsPackages.find(p => p.Id === 'Pkg1');
            assert.ok(pkg1, 'Package Pkg1 should exist');
            assert.strictEqual(pkg1?.InstalledVersion, 'Multiple');
        });

        test('should update status bar during loading', async () => {
            packagesView.projects = [
                new ProjectViewModel(createMockProject('Project1', [
                    { Id: 'Pkg1', Version: '1.0.0' }
                ]))
            ];

            (mockHostApi.getPackageAsync as sinon.SinonStub).resolves(
                ok({ Package: createMockPackage(), SourceUrl: '' })
            );

            await packagesView.LoadProjectsPackagesAsync();

            const statusBarStub = mockHostApi.updateStatusBarAsync as sinon.SinonStub;
            const statusBarCalls = statusBarStub.getCalls();

            // Should have calls for: start (0%), progress, and hide (null)
            assert.ok(statusBarCalls.length >= 2);

            // Last call should hide the status bar
            const lastCall = statusBarCalls[statusBarCalls.length - 1]!;
            assert.strictEqual(lastCall.args[0].Percentage, null);
        });
    });
    suite('Package deletion and tab order', () => {
        test('removes a package from every project and restores once', async () => {
            const projectA = new ProjectViewModel(createMockProject('A', [{ Id: 'Pkg.Delete', Version: '1.0.0' }]));
            const projectB = new ProjectViewModel(createMockProject('B', [{ Id: 'Pkg.Delete', Version: '1.0.0' }]));
            packagesView.projects = [projectA, projectB];
            packagesView.selectedPackage = new PackageViewModel(createMockPackage({
                Id: 'Pkg.Delete',
                Name: 'Pkg.Delete',
            }));

            const updateRequests: Array<{ Type: string; ProjectPath: string; PackageId: string }> = [];
            let jobSeq = 0;
            mockHostApi.startProjectUpdateAsync = async (request) => {
                updateRequests.push(request);
                jobSeq += 1;
                return ok({ JobId: `job-remove-${jobSeq}` });
            };
            mockHostApi.getJobAsync = async () => ok({
                Kind: 'projectUpdate',
                State: 'completed',
                Stage: 'Completed',
                Percent: 100,
                Response: { Project: createMockProject('Updated'), IsCpmEnabled: false },
            });
            const restoreStub = sandbox.stub().resolves(ok(undefined));
            mockHostApi.restoreProjectsAsync = restoreStub;
            mockHostApi.showConfirmationAsync = sandbox.stub().resolves(ok({ Confirmed: true }));
            sandbox.stub(packagesView, 'LoadProjectsAsync').resolves();

            await (packagesView as unknown as {
                removePackageFromAllProjectsAsync(): Promise<void>;
            }).removePackageFromAllProjectsAsync();

            assert.strictEqual(updateRequests.length, 2);
            assert.ok(updateRequests.every((request) => request.Type === 'UNINSTALL'));
            assert.deepStrictEqual(
                updateRequests.map((request) => request.ProjectPath).sort((a, b) => a.localeCompare(b)),
                projectA.Path && projectB.Path ? [projectA.Path, projectB.Path].sort((a, b) => a.localeCompare(b)) : []
            );
            assert.strictEqual(restoreStub.callCount, 1);
            assert.strictEqual(packagesView.selectedPackage, null);
        });

        test('keeps Toolchain as the last tab', async () => {
            const visited: string[] = [];
            sandbox.stub(packagesView, 'setTabAsync').callsFake(async (tab) => { visited.push(tab); });
            const event = { key: 'End', preventDefault: () => undefined } as KeyboardEvent;

            await (packagesView as unknown as {
                handleTabKeydownAsync(e: KeyboardEvent): Promise<void>;
            }).handleTabKeydownAsync(event);

            assert.deepStrictEqual(visited, ['toolchain']);
        });
    });
});
