import * as assert from 'assert';
import { IsScopedProject, ScopeProjectFiles } from './project-scope';

suite('project-scope', () => {
    const files = [
        { fsPath: 'D:\\ws\\src\\App\\App.csproj' },
        { fsPath: 'D:\\ws\\.ai\\tmp\\catalog-cache\\maui\\samples\\Sample.csproj' },
        { fsPath: 'D:\\ws\\tools\\Generator\\Generator.csproj' },
    ];

    test('keeps every file when no solution was found', () => {
        assert.strictEqual(ScopeProjectFiles(files, null).length, 3);
        assert.strictEqual(IsScopedProject(files[1]!.fsPath, null), true);
    });

    test('keeps only the projects a solution references', () => {
        const solutionProjects = new Set(['D:\\ws\\src\\App\\App.csproj', 'D:\\ws\\tools\\Generator\\Generator.csproj']);

        assert.deepStrictEqual(
            ScopeProjectFiles(files, solutionProjects).map((file) => file.fsPath),
            ['D:\\ws\\src\\App\\App.csproj', 'D:\\ws\\tools\\Generator\\Generator.csproj']
        );
        assert.strictEqual(IsScopedProject(files[1]!.fsPath, solutionProjects), false);
    });

});
