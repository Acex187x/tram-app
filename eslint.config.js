// https://docs.expo.dev/guides/using-eslint/
const { defineConfig } = require('eslint/config');
const expoConfig = require("eslint-config-expo/flat");

module.exports = defineConfig([
  expoConfig,
  {
    // convex/_generated is codegen output (`npx convex codegen`) — committed so
    // the project typechecks, but never hand-edited and not ours to lint.
    ignores: ["dist/*", "convex/_generated/*"],
  }
]);
