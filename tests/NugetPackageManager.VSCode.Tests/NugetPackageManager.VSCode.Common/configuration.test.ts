import * as assert from 'assert';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import {
    CONFIG_KEYS,
    CONFIG_NS,
    getSetting,
    isConfigAffected,
} from '@/common/configuration';

function makeConfig(values: Record<string, unknown> = {}) {
    return {
        get: (key: string, defaultValue?: unknown) => values[key] ?? defaultValue,
        inspect: () => undefined,
        update: sinon.stub().resolves(),
    };
}

suite('configuration', () => {
    let sandbox: sinon.SinonSandbox;

    setup(() => {
        sandbox = sinon.createSandbox();
    });

    teardown(() => {
        sandbox.restore();
    });

    function stubConfiguration(config: ReturnType<typeof makeConfig>): void {
        sandbox.stub(vscode.workspace, 'getConfiguration').returns(
            config as unknown as vscode.WorkspaceConfiguration
        );
    }

    test('reads a setting from the current namespace', () => {
        stubConfiguration(makeConfig({ prerelease: true }));

        assert.strictEqual(getSetting<boolean>('prerelease', false), true);
    });

    test('returns the supplied default when the setting is unset', () => {
        stubConfiguration(makeConfig());

        assert.deepStrictEqual(getSetting<string[]>('excludeGlobs', ['**/bin/**']), ['**/bin/**']);
    });

    test('detects changes in the current namespace only', () => {
        const affected = (key: string) => ({
            affectsConfiguration: (candidate: string) => candidate === key,
        } as unknown as vscode.ConfigurationChangeEvent);

        assert.strictEqual(isConfigAffected(affected(`${CONFIG_NS}.logLevel`), 'logLevel'), true);
        assert.strictEqual(isConfigAffected(affected(`${CONFIG_NS}.prerelease`), 'logLevel'), false);
        assert.strictEqual(isConfigAffected(affected('i-synergy-nugetpackagemanager.logLevel'), 'logLevel'), false);
    });

    test('exposes the complete key list used by the manifest', () => {
        assert.strictEqual(CONFIG_KEYS.length, 13);
        assert.ok(CONFIG_KEYS.includes('allowMajorVersionOverride'));
        assert.ok(CONFIG_KEYS.includes('sources'));
        assert.ok(CONFIG_KEYS.includes('updateCheckConcurrency'));
    });
});
