import * as assert from 'assert';
import {
    FormatRestoreConflicts,
    ParseRestoreConflicts,
    SummarizeRestoreFailure,
} from '@/host/utilities/restore-diagnostics';

const NU1107_OUTPUT = [
    'C:\\Projects\\App\\Sample.EventSourcing.Api.csproj : error NU1107: Version conflict detected for Microsoft.EntityFrameworkCore.Relational. Install/reference Microsoft.EntityFrameworkCore.Relational 11.0.0-rc.3.26522.148 directly to project Sample.EventSourcing.Api to resolve this issue. ',
    'C:\\Projects\\App\\Sample.EventSourcing.Api.csproj :  Sample.EventSourcing.Api -> I-Synergy.Framework.EventSourcing.EntityFramework -> Microsoft.EntityFrameworkCore.Relational (>= 11.0.0-rc.3.26522.148) ',
    'C:\\Projects\\App\\Sample.EventSourcing.Api.csproj :  Sample.EventSourcing.Api -> Npgsql.EntityFrameworkCore.PostgreSQL 11.0.0-rc.2 -> Microsoft.EntityFrameworkCore.Relational (= 11.0.0-rc.2.26504.105).',
].join('\n');

suite('restore-diagnostics', () => {
    suite('ParseRestoreConflicts', () => {
        test('parses the NU1107 chain from a prefixed MSBuild output', () => {
            const conflicts = ParseRestoreConflicts(NU1107_OUTPUT);

            assert.strictEqual(conflicts.length, 1);
            const conflict = conflicts[0]!;
            assert.strictEqual(conflict.code, 'NU1107');
            assert.strictEqual(conflict.packageId, 'Microsoft.EntityFrameworkCore.Relational');
            assert.strictEqual(conflict.suggestedVersion, '11.0.0-rc.3.26522.148');
            assert.strictEqual(conflict.projectName, 'Sample.EventSourcing.Api');
            assert.strictEqual(conflict.constraints.length, 2);
            assert.deepStrictEqual(
                conflict.constraints.map((constraint) => constraint.range),
                ['>= 11.0.0-rc.3.26522.148', '= 11.0.0-rc.2.26504.105']
            );
            assert.ok(conflict.constraints[1]!.chain.includes('Npgsql.EntityFrameworkCore.PostgreSQL'));
        });

        test('parses NU1107 without the project path prefix', () => {
            const conflicts = ParseRestoreConflicts(
                NU1107_OUTPUT.split('\n').map((line) => line.replace(/^.*? : /, '')).join('\n')
            );

            assert.strictEqual(conflicts.length, 1);
            assert.strictEqual(conflicts[0]!.constraints.length, 2);
        });

        test('parses NU1605 and keeps the required version', () => {
            const conflicts = ParseRestoreConflicts(
                'error NU1605: Detected package downgrade: Newtonsoft.Json from 13.0.3 to 13.0.1. Reference the package directly from the project to select a different version.'
            );

            assert.strictEqual(conflicts.length, 1);
            assert.strictEqual(conflicts[0]!.code, 'NU1605');
            assert.strictEqual(conflicts[0]!.packageId, 'Newtonsoft.Json');
            assert.strictEqual(conflicts[0]!.suggestedVersion, '13.0.3');
        });

        test('parses NU1102 as an unresolvable version', () => {
            const conflicts = ParseRestoreConflicts(
                'error NU1102: Unable to find package Foo.Bar with version (>= 9.0.0)'
            );

            assert.strictEqual(conflicts.length, 1);
            assert.strictEqual(conflicts[0]!.packageId, 'Foo.Bar');
        });

        test('parses multiple conflicts independently', () => {
            const output = [
                'error NU1107: Version conflict detected for Pkg.A. Install/reference Pkg.A 2.0.0 directly to project App to resolve this issue.',
                ' App -> Provider 1.0.0.0 -> Pkg.A (= 1.0.0)',
                'error NU1107: Version conflict detected for Pkg.B. Install/reference Pkg.B 3.0.0 directly to project App to resolve this issue.',
                ' App -> Other 1.0.0 -> Pkg.B (= 2.0.0)',
            ].join('\n');

            const conflicts = ParseRestoreConflicts(output);

            assert.strictEqual(conflicts.length, 2);
            assert.strictEqual(conflicts[0]!.packageId, 'Pkg.A');
            assert.strictEqual(conflicts[1]!.packageId, 'Pkg.B');
            assert.strictEqual(conflicts[1]!.constraints.length, 1);
        });

        test('returns nothing for a successful restore log', () => {
            assert.deepStrictEqual(
                ParseRestoreConflicts('Determining projects to restore...\nAll projects are up-to-date for restore.'),
                []
            );
        });
    });

    suite('FormatRestoreConflicts', () => {
        test('names the package and both constraints', () => {
            const text = FormatRestoreConflicts(ParseRestoreConflicts(NU1107_OUTPUT));

            assert.ok(text.includes('NU1107 Microsoft.EntityFrameworkCore.Relational'));
            assert.ok(text.includes('Npgsql.EntityFrameworkCore.PostgreSQL 11.0.0-rc.2'));
            assert.ok(text.includes('>= 11.0.0-rc.3.26522.148'));
            assert.ok(text.includes('= 11.0.0-rc.2.26504.105'));
        });
    });

    suite('SummarizeRestoreFailure', () => {
        test('uses parsed conflicts when available', () => {
            const summary = SummarizeRestoreFailure(NU1107_OUTPUT);
            assert.ok(summary?.includes('NU1107'));
        });

        test('falls back to error lines for unknown diagnostics', () => {
            const summary = SummarizeRestoreFailure([
                'C:\\ws\\App.csproj : error MSB4025: The project file could not be loaded.',
                'Build FAILED.',
            ].join('\n'));

            assert.strictEqual(summary, 'error MSB4025: The project file could not be loaded.');
        });

        test('falls back to the tail of the output', () => {
            assert.strictEqual(SummarizeRestoreFailure('line one\nline two'), 'line one | line two');
            assert.strictEqual(SummarizeRestoreFailure(''), null);
        });
    });
});
