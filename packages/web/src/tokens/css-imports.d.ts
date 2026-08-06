/**
 * Ambient module declaration for plain (non-CSS-modules) `.css` side-effect
 * imports, e.g. `import "./tokens.css";`. Vite handles these at bundle time;
 * `tsc --noEmit` needs this declared somewhere in the program or it can't
 * resolve the import. No `vite-env.d.ts` exists yet at the package root
 * (outside this issue's allowed paths), so it lives here instead — any
 * `.d.ts` included via tsconfig's `"include": ["src"]` applies to the whole
 * compilation, regardless of which subfolder it sits in.
 */
declare module "*.css";
