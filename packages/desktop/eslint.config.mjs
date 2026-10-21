import { defineConfig, globalIgnores } from "eslint/config";
import typescriptEslint from "@typescript-eslint/eslint-plugin";
import tsParser from "@typescript-eslint/parser";
import path from "node:path";
import { fileURLToPath } from "node:url";
import js from "@eslint/js";
import { FlatCompat } from "@eslint/eslintrc";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const compat = new FlatCompat({
    baseDirectory: __dirname,
    recommendedConfig: js.configs.recommended,
    allConfig: js.configs.all
});

export default defineConfig([
    globalIgnores(["**/node_modules", "**/dist", "**/app", "**/flatpak", "**/xal-node/"]),
    {
        extends: compat.extends(
            // "plugin:@next/next/recommended",
            // "eslint:recommended",
            // "plugin:@typescript-eslint/eslint-recommended",
            // "plugin:@typescript-eslint/recommended",
        ),

        plugins: {
            "@typescript-eslint": typescriptEslint,
        },

        languageOptions: {
            parser: tsParser,
        },

        rules: {
            // // quotes: ["warn", "single"],

            // // indent: ["warn", 4, {
            // //     SwitchCase: 1,
            // // }],

            // semi: ["error", "never"],
            // "comma-dangle": ["warn", "always-multiline"],
            // "dot-notation": "off",
            // eqeqeq: "warn",
            // "brace-style": ["warn"],
            // "prefer-arrow-callback": ["warn"],
            // "no-non-null-assertion": ["off"],
            // "comma-spacing": ["error"],

            // "no-multi-spaces": ["warn", {
            //     ignoreEOLComments: true,
            // }],

            // "lines-between-class-members": ["warn", "always", {
            //     exceptAfterSingleLine: true,
            // }],

            // "@typescript-eslint/explicit-function-return-type": "off",
            // "@typescript-eslint/no-non-null-assertion": "off",
            // "@typescript-eslint/explicit-module-boundary-types": "off",
            // "@typescript-eslint/no-explicit-any": "off",
            // "@typescript-eslint/member-delimiter-style": ["warn"],
        },
    },
]);
