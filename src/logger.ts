import pino from "pino";

import {SERVICE_NAME} from "./consts.js";

export const logger = pino({
	base: {service: SERVICE_NAME},
	level: process.env.LOG_LEVEL ?? "info",
	formatters: {
		level: (label: string) => ({level: label}),
	},
	// pino resolves the transport lazily in a worker thread only when enabled,
	// so pino-pretty can stay a devDependency.
	...(process.env.LOG_PRETTY === "true"
		? {transport: {target: "pino-pretty", options: {colorize: true}}}
		: {}),
});
