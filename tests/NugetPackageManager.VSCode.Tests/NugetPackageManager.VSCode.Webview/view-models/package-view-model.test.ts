// File: tests/NugetPackageManager.VSCode.Tests/NugetPackageManager.VSCode.Webview/view-models/package-view-model.test.ts
// Traces: #45 — a package known only by id must not pretend its metadata is zero.

import * as assert from 'assert';
import { PackageViewModel } from '@/web/types';

suite('PackageViewModel', () => {
    test('Empty leaves popularity unknown instead of zero', () => {
        const pkg = PackageViewModel.Empty('Contoso.Sdk');

        assert.strictEqual(pkg.Id, 'Contoso.Sdk');
        assert.strictEqual(pkg.Name, 'Contoso.Sdk');
        assert.strictEqual(pkg.Status, 'MissingDetails');
        assert.strictEqual(pkg.TotalDownloads, null);
        assert.strictEqual(pkg.Verified, null);
    });

    test('Empty keeps the caller-supplied status and a distinct id per package', () => {
        const detailed = PackageViewModel.Empty('Contoso.Sdk', 'Detailed');

        assert.strictEqual(detailed.Status, 'Detailed');
        assert.notStrictEqual(PackageViewModel.Empty('A'), PackageViewModel.Empty('B'));
    });

    test('copies the source that returned the package', () => {
        const pkg = new PackageViewModel({
            Id: 'Contoso.Sdk',
            Name: 'Contoso.Sdk',
            Authors: [],
            Description: '',
            IconUrl: '',
            LicenseUrl: '',
            ProjectUrl: '',
            Registration: '',
            TotalDownloads: null,
            Verified: null,
            InstalledVersion: '',
            Version: '1.0.0',
            Versions: [],
            Tags: [],
            SourceUrl: 'https://api.nuget.org/v3/index.json',
        });

        assert.strictEqual(pkg.SourceUrl, 'https://api.nuget.org/v3/index.json');
    });

    test('UpdatePackage copies the popularity metadata from the lookup', () => {
        const pkg = PackageViewModel.Empty('Contoso.Sdk');

        pkg.UpdatePackage({
            Id: 'Contoso.Sdk',
            Name: 'Contoso.Sdk',
            Authors: ['Contoso'],
            Description: 'A package',
            IconUrl: '',
            LicenseUrl: '',
            ProjectUrl: '',
            Registration: '',
            TotalDownloads: 1234,
            Verified: true,
            InstalledVersion: '',
            Version: '1.0.0',
            Versions: [{ Version: '1.0.0' }],
            Tags: [],
        });

        assert.strictEqual(pkg.TotalDownloads, 1234);
        assert.strictEqual(pkg.Verified, true);
        assert.strictEqual(pkg.Id, 'Contoso.Sdk');
    });

    test('keeps the per-version download counts the feed published', () => {
        const pkg = new PackageViewModel({
            Id: 'Contoso.Sdk',
            Name: 'Contoso.Sdk',
            Authors: [],
            Description: '',
            IconUrl: '',
            LicenseUrl: '',
            ProjectUrl: '',
            Registration: '',
            TotalDownloads: 5000,
            Verified: null,
            InstalledVersion: '',
            Version: '2.0.0',
            Versions: [
                { Version: '1.0.0', Downloads: 1234 },
                { Version: '2.0.0', Downloads: null },
                { Version: '3.0.0' },
            ],
            Tags: [],
        });

        assert.strictEqual(pkg.DownloadsForVersion('1.0.0'), 1234);
        // Published-but-null and not-published-at-all both read as unknown, never 0.
        assert.strictEqual(pkg.DownloadsForVersion('2.0.0'), null);
        assert.strictEqual(pkg.DownloadsForVersion('3.0.0'), null);
        assert.strictEqual(pkg.DownloadsForVersion('9.9.9'), null);
        assert.strictEqual(pkg.DownloadsForVersion(''), null);
        // The version list itself is unchanged for existing callers.
        assert.deepStrictEqual(pkg.Versions, ['3.0.0', '2.0.0', '1.0.0']);
    });

    test('UpdatePackage replaces the version download lookup', () => {
        const pkg = new PackageViewModel({
            Id: 'Contoso.Sdk',
            Name: 'Contoso.Sdk',
            Authors: [],
            Description: '',
            IconUrl: '',
            LicenseUrl: '',
            ProjectUrl: '',
            Registration: '',
            TotalDownloads: null,
            Verified: null,
            InstalledVersion: '',
            Version: '1.0.0',
            Versions: [{ Version: '1.0.0', Downloads: 10 }],
            Tags: [],
        });

        pkg.UpdatePackage({
            Id: 'Contoso.Sdk',
            Name: 'Contoso.Sdk',
            Authors: [],
            Description: '',
            IconUrl: '',
            LicenseUrl: '',
            ProjectUrl: '',
            Registration: '',
            TotalDownloads: 99,
            Verified: true,
            InstalledVersion: '',
            Version: '1.0.0',
            Versions: [{ Version: '1.0.0', Downloads: 42 }],
            Tags: [],
        });

        assert.strictEqual(pkg.DownloadsForVersion('1.0.0'), 42);
    });

    test('Empty has no version download counts', () => {
        const pkg = PackageViewModel.Empty('Contoso.Sdk');

        assert.strictEqual(pkg.VersionDownloads.size, 0);
        assert.strictEqual(pkg.DownloadsForVersion('1.0.0'), null);
    });
});
