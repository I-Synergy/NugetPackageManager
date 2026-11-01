const { defineConfig } = require('@vscode/test-cli');

module.exports = defineConfig([
	{
		label: 'unitTests',
		files: 'out/tests/**/*.test.js',
		version: 'stable',
		workspaceFolder: '.',
		mocha: {
			ui: 'tdd',
			timeout: 20000,
			require: ['./test-path-register.cjs']
		},
		coverage: {
			include: ['src/**/*.ts'],
			exclude: ['**/Fixtures/**'],
			includeAll: true
		},
		launchArgs: [
			'--disable-gpu',
			'--disable-workspace-trust',
			'--disable-telemetry'
		],
		env: {
			VSCODE_NUGET_GALLERY_TEST: 'true',
			OTEL_TRACES_EXPORTER: 'none'
		}
	},
	// Real-process suite: the actual sidecar and the actual `dotnet` CLI write to a fixture
	// project. Opt-in — needs `npm run build:core` and dotnet on PATH.
	{
		label: 'e2eTests',
		files: 'out/tests/**/*.e2e.js',
		version: 'stable',
		workspaceFolder: '.',
		mocha: {
			ui: 'tdd',
			timeout: 180000,
			require: ['./test-path-register.cjs']
		},
		launchArgs: [
			'--disable-gpu',
			'--disable-workspace-trust',
			'--disable-telemetry'
		],
		env: {
			OTEL_TRACES_EXPORTER: 'none'
		}
	}
]);
