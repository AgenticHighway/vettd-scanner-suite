import tsParser from "@typescript-eslint/parser";
import tsPlugin from "@typescript-eslint/eslint-plugin";

const vitestGlobals = {
	describe: "readonly",
	it: "readonly",
	test: "readonly",
	suite: "readonly",
	expect: "readonly",
	vi: "readonly",
	beforeAll: "readonly",
	afterAll: "readonly",
	beforeEach: "readonly",
	afterEach: "readonly"
};

export default [
	{
		ignores: ["dist/**", "node_modules/**", "**/__tests__/fixtures/**"]
	},
	{
		files: ["src/**/*.ts"],
		languageOptions: {
			parser: tsParser,
			ecmaVersion: 2022,
			sourceType: "module",
			globals: {
				console: "readonly",
				process: "readonly",
				Buffer: "readonly",
				URL: "readonly",
				URLSearchParams: "readonly",
				fetch: "readonly",
				setTimeout: "readonly",
				clearTimeout: "readonly",
				setInterval: "readonly",
				clearInterval: "readonly",
				globalThis: "readonly",
				Response: "readonly",
				Request: "readonly",
				Headers: "readonly",
				FormData: "readonly",
				Blob: "readonly",
				crypto: "readonly",
				TextEncoder: "readonly",
				TextDecoder: "readonly",
				AbortController: "readonly",
				AbortSignal: "readonly",
				ReadableStream: "readonly"
			}
		},
		plugins: {
			"@typescript-eslint": tsPlugin
		},
		rules: {
			...tsPlugin.configs.recommended.rules,
			"@typescript-eslint/no-unused-vars": ["error", {
				"varsIgnorePattern": "^_",
				"argsIgnorePattern": "^_"
			}]
		}
	},
	{
		files: ["src/**/__tests__/**/*.ts"],
		languageOptions: {
			globals: vitestGlobals
		},
		rules: {
			"@typescript-eslint/no-explicit-any": "off",
			"@typescript-eslint/no-unused-vars": "off"
		}
	}
];
