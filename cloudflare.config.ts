import { bindings, defineConfig } from "cf/config";

/**
 * Secret-like files were detected but not read or migrated: .env, .env.example. Only `secrets.required` entries are migrated.
 * @see https://developers.cloudflare.com/workers/configuration/secrets/
 */

export default defineConfig({
	accountId: "bb52c0e5f3a93fc72779915d7dc6982b",
	worker: {
		name: "photos-api",
		compatibilityDate: "2025-05-24",
		compatibilityFlags: [
			"nodejs_compat_v2",
		],
		entrypoint: "src/index.tsx",
		workersDev: true,
		observability: {
			enabled: true,
			logs: { enabled: true },
			traces: { enabled: true },
		},
		env: {
			ALLOWED_WIDTHS: bindings.text("200,400,800,1600"),
			CF_ACCESS_TEAM_DOMAIN: bindings.secret(),
			CF_ACCESS_AUD: bindings.secret(),
			DB: bindings.d1({
				name: "photos-db",
				id: "cb953cd1-3de2-4eb1-9769-b1b1d817b59d",
			}),
			PHOTOS_BUCKET: bindings.r2({
				name: "photos-bucket",
			}),
			IMAGES: bindings.images({}),
			AI: bindings.ai(),
		},
	},
});
