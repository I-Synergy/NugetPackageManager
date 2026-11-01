import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * The repository root, found by walking up from the compiled test file.
 *
 * Tests must not rely on `process.cwd()`: inside the extension host it is the
 * VS Code installation directory, not the workspace being tested.
 */
export function repositoryRoot(): string {
    let directory = __dirname;

    while (!fs.existsSync(path.join(directory, 'package.json'))) {
        const parent = path.dirname(directory);
        if (parent === directory) {
            throw new Error('repository root not found: no package.json above the test file');
        }

        directory = parent;
    }

    return directory;
}

/** A path inside the repository, resolved from the root. */
export function repositoryPath(...segments: Array<string>): string {
    return path.join(repositoryRoot(), ...segments);
}
