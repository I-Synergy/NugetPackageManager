import * as assert from 'assert';
import * as fs from 'node:fs';
import { repositoryPath } from '../test-paths';

type Manifest = {
    name: string;
    displayName: string;
    publisher: string;
    activationEvents: string[];
    contributes: {
        commands: Array<{ command: string }>;
        viewsContainers: { activitybar: Array<{ id: string }> };
        views: Record<string, Array<{ id: string }>>;
        configuration: { properties: Record<string, unknown> };
    };
};

function readManifest(): Manifest {
    const manifestPath = repositoryPath('package.json');
    return JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as Manifest;
}

suite('manifest identity', () => {
    const manifest = readManifest();

    test('uses the renamed extension identity', () => {
        assert.strictEqual(manifest.name, 'nugetpackagemanager');
        assert.strictEqual(manifest.displayName, 'NuGet Package Manager for Visual Studio Code');
        assert.strictEqual(manifest.publisher, 'I-Synergy');
    });

    test('contributes only the new command IDs', () => {
        const ids = manifest.contributes.commands.map((command) => command.command);
        assert.ok(ids.length > 0);
        for (const id of ids) {
            assert.ok(id.startsWith('nugetpackagemanager.'), `unexpected command id: ${id}`);
        }
        assert.ok(ids.includes('nugetpackagemanager.open'));
    });

    test('uses the renamed view and panel IDs', () => {
        const container = manifest.contributes.viewsContainers.activitybar[0]!;
        assert.strictEqual(container.id, 'nugetpackagemanager');
        assert.deepStrictEqual(
            manifest.contributes.views['nugetpackagemanager']?.map((view) => view.id),
            ['nugetpackagemanager.launcherView']
        );
        assert.ok(
            manifest.activationEvents.includes('onWebviewPanel:nugetpackagemanager.panel'),
            'the webview panel activation event must use the new ID'
        );
    });

    test('contributes the new settings namespace without legacy keys', () => {
        const keys = Object.keys(manifest.contributes.configuration.properties);
        const newKeys = keys.filter((key) => key.startsWith('nugetpackagemanager.'));
        const legacyKeys = keys.filter((key) => key.startsWith('i-synergy-nugetpackagemanager.'));

        assert.strictEqual(newKeys.length, 13);
        assert.ok(newKeys.includes('nugetpackagemanager.allowMajorVersionOverride'));
        assert.strictEqual(legacyKeys.length, 0);
        assert.ok(newKeys.includes('nugetpackagemanager.updateCheckConcurrency'));
    });

    test('does not register legacy activation events', () => {
        assert.ok(!manifest.activationEvents.includes('onWebviewPanel:nugetpackage.panel'));
    });
});
