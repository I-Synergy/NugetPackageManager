import * as assert from 'assert';
import { ApplyConditionalPackageVersions } from '@/host/utilities/cpm-conditional';

const PROPS = `<Project>
  <PropertyGroup>
    <ManagePackageVersionsCentrally>true</ManagePackageVersionsCentrally>
  </PropertyGroup>
  <ItemGroup>
    <PackageVersion Include="Microsoft.Extensions.Hosting" Version="10.0.13" />
    <PackageVersion Include="NodaTime" Version="3.3.7" />
  </ItemGroup>
</Project>
`;

suite('cpm-conditional', () => {
    test('creates a conditional group when none exists', () => {
        const result = ApplyConditionalPackageVersions(PROPS, [
            { PackageId: 'Microsoft.Extensions.Hosting', Version: '11.0.0-rc.3', Condition: "'$(TargetFramework)' == 'net11.0'" },
        ]);

        assert.strictEqual(result.Changed, true);
        assert.deepStrictEqual(result.CreatedGroups, ["'$(TargetFramework)' == 'net11.0'"]);
        assert.match(
            result.Content,
            /<ItemGroup Condition="'<ItemGroup Condition="|'|'">/
        );
        assert.match(result.Content, /Include="Microsoft.Extensions.Hosting" Version="11.0.0-rc.3"/);
        // The unconditional entry is untouched.
        assert.match(result.Content, /<PackageVersion Include="Microsoft.Extensions.Hosting" Version="10.0.13" \/>/);
    });

    test('updates an existing conditional group and adds missing entries', () => {
        const withGroup = PROPS.replace(
            '</Project>',
            `  <ItemGroup Condition="'$(TargetFramework)' == 'net11.0'">
    <PackageVersion Include="NodaTime" Version="3.3.7" />
  </ItemGroup>
</Project>`
        );

        const result = ApplyConditionalPackageVersions(withGroup, [
            { PackageId: 'NodaTime', Version: '3.3.8', Condition: "'$(TargetFramework)' == 'net11.0'" },
            { PackageId: 'Microsoft.Extensions.Hosting', Version: '11.0.0-rc.3', Condition: "'$(TargetFramework)' == 'net11.0'" },
        ]);

        assert.strictEqual(result.CreatedGroups.length, 0);
        assert.match(result.Content, /Include="NodaTime" Version="3.3.8"/);
        assert.match(result.Content, /Include="Microsoft.Extensions.Hosting" Version="11.0.0-rc.3"/);
    });

    test('replaces an unconditional entry when versions diverge per TFM', () => {
        const result = ApplyConditionalPackageVersions(
            PROPS,
            [
                { PackageId: 'NodaTime', Version: '3.3.7', Condition: "'$(TargetFramework)' == 'net10.0'" },
                { PackageId: 'NodaTime', Version: '3.3.8', Condition: "'$(TargetFramework)' == 'net11.0'" },
            ],
            { ReplaceUnconditional: ['NodaTime'] }
        );

        // The unconditional entry is gone, so NuGet cannot silently prefer it.
        assert.strictEqual(/<ItemGroup>\s*<PackageVersion Include="NodaTime"/.test(result.Content), false);
        assert.match(result.Content, /Condition="'\$\(TargetFramework\)' == 'net10\.0'">\s*<PackageVersion Include="NodaTime" Version="3\.3\.7"/);
        assert.match(result.Content, /Condition="'\$\(TargetFramework\)' == 'net11\.0'">\s*<PackageVersion Include="NodaTime" Version="3\.3\.8"/);
    });

    test('is idempotent when the version is already written', () => {
        const first = ApplyConditionalPackageVersions(PROPS, [
            { PackageId: 'NodaTime', Version: '3.3.8', Condition: "'$(TargetFramework)' == 'net10.0'" },
        ]);
        const second = ApplyConditionalPackageVersions(first.Content, [
            { PackageId: 'NodaTime', Version: '3.3.8', Condition: "'$(TargetFramework)' == 'net10.0'" },
        ]);

        assert.strictEqual(second.Changed, false);
        assert.strictEqual(second.Content, first.Content);
    });
});
