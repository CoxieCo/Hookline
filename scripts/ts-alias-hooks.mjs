// Lets plain `node` run the app's TypeScript modules from a script:
// resolves "@/..." to src/, adds missing .ts extensions, and stubs
// "server-only" (which throws outside React Server Components).
// Used with: node --experimental-transform-types --import ./scripts/ts-alias-hooks.mjs <script>
import { existsSync } from "node:fs";
import { registerHooks } from "node:module";

const SRC = new URL("../src/", import.meta.url);
const SERVER_ONLY_STUB = new URL("../tests/stubs/server-only.ts", import.meta.url);

registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "server-only") return { url: SERVER_ONLY_STUB.href, shortCircuit: true };

    let base = null;
    if (specifier.startsWith("@/")) base = new URL(specifier.slice(2), SRC);
    else if (/^\.\.?\//.test(specifier) && context.parentURL?.startsWith("file:")) base = new URL(specifier, context.parentURL);

    if (base && !existsSync(base)) {
      for (const ext of [".ts", ".tsx", "/index.ts"]) {
        const candidate = new URL(base.href + ext);
        if (existsSync(candidate)) return { url: candidate.href, shortCircuit: true };
      }
    }
    return next(specifier, context);
  },
});
