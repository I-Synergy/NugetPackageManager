import * as assert from 'assert';
import {
    AddUnconditionalPackageVersions,
    InspectPackageReference,
    RemoveInlinePackageVersion,
} from '@/host/utilities/cpm-definitions';

const PROPS = `<Project>
  <ItemGroup>
    <PackageVersion Include="Newtonsoft.Json" Version="13.0.3" />
  </ItemGroup>
</Project>
`;

suite('cpm-definitions', () => {
    suite('AddUnconditionalPackageVersions', () => {
        test('inserts into the existing unconditional group', () => {
            const result = AddUnconditionalPackageVersions(PROPS, [
                { PackageId: 'Serilog', Version: '3.1.0' },
            ]);

            assert.strictEqual(result.Changed, true);
            assert.strictEqual(result.CreatedGroup, false);
            assert.match(result.Content, /<ItemGroup>\s*<PackageVersion Include="Newtonsoft\.Json" Version="13\.0\.3" \/>\s*<PackageVersion Include="Serilog" Version="3\.1\.0" \/>\s*<\/ItemGroup>/);
        });

        test('creates a group after the Project tag when none exists', () => {
            const noGroup = `<Project>
  <PropertyGroup>
    <ManagePackageVersionsCentrally>true</ManagePackageVersionsCentrally>
  </PropertyGroup>
</Project>
`;
            const result = AddUnconditionalPackageVersions(noGroup, [
                { PackageId: 'Serilog', Version: '3.1.0' },
            ]);

            assert.strictEqual(result.Changed, true);
            assert.strictEqual(result.CreatedGroup, true);
            // The new group sits right after <Project>, before PropertyGroup.
            const groupIndex = result.Content.indexOf('<ItemGroup>');
            const propIndex = result.Content.indexOf('<PropertyGroup>');
            assert.ok(groupIndex >= 0 && groupIndex < propIndex, 'group precedes the existing children');
            assert.match(result.Content, /<ItemGroup>\s*<PackageVersion Include="Serilog" Version="3\.1\.0" \/>\s*<\/ItemGroup>/);
        });

        test('is idempotent when the id is already declared', () => {
            const once = AddUnconditionalPackageVersions(PROPS, [
                { PackageId: 'Serilog', Version: '3.1.0' },
            ]);
            const twice = AddUnconditionalPackageVersions(once.Content, [
                { PackageId: 'Serilog', Version: '3.1.0' },
            ]);

            assert.strictEqual(twice.Changed, false);
            assert.strictEqual(twice.Content, once.Content);
        });

        test('skips an id declared only in a conditional group', () => {
            const conditional = `<Project>
  <ItemGroup Condition="'$(TargetFramework)' == 'net11.0'">
    <PackageVersion Include="Serilog" Version="4.0.0" />
  </ItemGroup>
  <ItemGroup>
    <PackageVersion Include="Newtonsoft.Json" Version="13.0.3" />
  </ItemGroup>
</Project>
`;
            const result = AddUnconditionalPackageVersions(conditional, [
                { PackageId: 'Serilog', Version: '3.1.0' },
            ]);

            assert.strictEqual(result.Changed, false);
            assert.strictEqual(result.Content, conditional);
        });

        test('preserves CRLF line endings', () => {
            const crlf = `<Project>\r\n  <ItemGroup>\r\n    <PackageVersion Include="Newtonsoft.Json" Version="13.0.3" />\r\n  </ItemGroup>\r\n</Project>\r\n`;
            const result = AddUnconditionalPackageVersions(crlf, [
                { PackageId: 'Serilog', Version: '3.1.0' },
            ]);

            assert.strictEqual(result.Changed, true);
            assert.ok(!/[^\r]\n/.test(result.Content.replace(/\r\n/g, '\r\n')), 'every newline stays CRLF');
            assert.ok(result.Content.includes('\r\n    <PackageVersion Include="Serilog" Version="3.1.0" />'));
        });

        test('escapes XML in id and version', () => {
            const result = AddUnconditionalPackageVersions(PROPS, [
                { PackageId: 'A&B', Version: '1.0.0<beta>' },
            ]);

            assert.match(result.Content, /Include="A&amp;B" Version="1\.0\.0&lt;beta&gt;"/);
        });
    });

    suite('InspectPackageReference', () => {
        test('reads a literal inline version', () => {
            const project = '<Project><ItemGroup><PackageReference Include="Serilog" Version="3.1.0" /></ItemGroup></Project>';
            const inspection = InspectPackageReference(project, 'serilog');
            assert.strictEqual(inspection.Found, true);
            assert.strictEqual(inspection.HasCondition, false);
            assert.strictEqual(inspection.Version, '3.1.0');
            assert.strictEqual(inspection.VersionOverride, null);
        });

        test('reports a condition and single quotes', () => {
            const project = "<Project><ItemGroup><PackageReference Include='Serilog' Condition=\"true\" Version='3.1.0' /></ItemGroup></Project>";
            const inspection = InspectPackageReference(project, 'Serilog');
            assert.strictEqual(inspection.HasCondition, true);
            assert.strictEqual(inspection.Version, '3.1.0');
        });
    });

    suite('RemoveInlinePackageVersion', () => {
        test('removes a literal Version attribute and nothing else', () => {
            const project = '<Project><ItemGroup><PackageReference Include="Serilog" Version="3.1.0" /></ItemGroup></Project>';
            const result = RemoveInlinePackageVersion(project, 'Serilog');

            assert.strictEqual(result.Changed, true);
            assert.strictEqual(result.Content, '<Project><ItemGroup><PackageReference Include="Serilog" /></ItemGroup></Project>');
        });

        test('refuses a conditional reference', () => {
            const project = '<Project><ItemGroup><PackageReference Include="Serilog" Condition="true" Version="3.1.0" /></ItemGroup></Project>';
            const result = RemoveInlinePackageVersion(project, 'Serilog');

            assert.strictEqual(result.Changed, false);
            assert.strictEqual(result.Reason, 'conditionalReference');
            assert.strictEqual(result.Content, project);
        });

        test('refuses a property version', () => {
            const project = '<Project><ItemGroup><PackageReference Include="Serilog" Version="$(SerilogVersion)" /></ItemGroup></Project>';
            const result = RemoveInlinePackageVersion(project, 'Serilog');

            assert.strictEqual(result.Changed, false);
            assert.strictEqual(result.Reason, 'propertyVersion');
        });

        test('reports a missing reference', () => {
            const project = '<Project></Project>';
            const result = RemoveInlinePackageVersion(project, 'Serilog');
            assert.strictEqual(result.Changed, false);
            assert.strictEqual(result.Reason, 'notFound');
        });

        test('reports a reference without a version', () => {
            const project = '<Project><ItemGroup><PackageReference Include="Serilog" /></ItemGroup></Project>';
            const result = RemoveInlinePackageVersion(project, 'Serilog');
            assert.strictEqual(result.Changed, false);
            assert.strictEqual(result.Reason, 'noVersionAttribute');
        });
    });
});
