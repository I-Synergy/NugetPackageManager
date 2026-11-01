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
});
