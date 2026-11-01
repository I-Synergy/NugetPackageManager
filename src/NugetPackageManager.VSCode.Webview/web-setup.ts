import { JSDOM } from 'jsdom';
import * as path from 'node:path';
import * as tsConfigPaths from 'tsconfig-paths';
import * as Module from 'node:module';

type RequireFunction = (id: string) => unknown;

// Hook require to ignore pure CSS files but allow .css.ts/.css.js modules through.
// Components import styles like `@/web/styles/codicon.css` which resolve to `.css.js`
// files after compilation. We must let those through so Lit gets CSSResult objects.
const originalRequire = (Module as unknown as { prototype: { require: RequireFunction } }).prototype.require;
(Module as unknown as { prototype: { require: RequireFunction } }).prototype.require = function(id: string) {
    if (typeof id === 'string' && id.endsWith('.css')) {
        // Try loading the module normally first (handles .css.js compiled from .css.ts)
        try {
            return originalRequire.call(this, id);
        } catch {
            // Pure .css file with no .js counterpart — return empty string
            return '';
        }
    }
    return originalRequire.call(this, id);
};

// Register paths to point to 'out' directory
const baseUrl = path.resolve(__dirname, '../..'); // Repo root
tsConfigPaths.register({
    baseUrl,
    paths: {
        "@/*": ["out/*"]
    }
});

// Setup JSDOM
const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
    url: 'http://localhost/',
    pretendToBeVisual: true
});

const g = global as unknown as Record<string, unknown>;
g.window = dom.window;
g.document = dom.window.document;
g.HTMLElement = dom.window.HTMLElement;
g.customElements = dom.window.customElements;
g.Node = dom.window.Node;
g.Event = dom.window.Event;
g.InputEvent = dom.window.InputEvent;
g.KeyboardEvent = dom.window.KeyboardEvent;
g.MouseEvent = dom.window.MouseEvent;
g.CustomEvent = dom.window.CustomEvent;
g.MutationObserver = dom.window.MutationObserver;
g.HTMLStyleElement = dom.window.HTMLStyleElement; // Required for Lit element styles

// Polyfill window.matchMedia
const gWindow = dom.window as unknown as Record<string, unknown>;
gWindow.matchMedia = gWindow.matchMedia || function() {
    return {
        matches: false,
        addListener: function() {},
        removeListener: function() {}
    };
};

// Polyfill acquireVsCodeApi
gWindow.acquireVsCodeApi = () => ({
    postMessage: () => {},
    setState: () => {},
    getState: () => {}
});
g.acquireVsCodeApi = gWindow.acquireVsCodeApi;

// Polyfill navigator (for Axios)
Object.defineProperty(global, 'navigator', {
    value: dom.window.navigator,
    writable: true
});

// RequestAnimationFrame polyfill (LitElement uses it)
g.requestAnimationFrame = (callback: FrameRequestCallback) => setTimeout(callback, 0);
g.cancelAnimationFrame = (id: number) => clearTimeout(id);
