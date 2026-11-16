import type { Context } from "@earendil-works/chord";
import type { ToolExecutionApi } from "@earendil-works/pi-durable";
import { requireUserOrigin } from "@assistant/runtime";
import { splitUserContent } from "./attachments/index.js";

/** Provenance is necessary, but is not an action/resource permission grant. */
export async function requireUserInstruction(api: ToolExecutionApi, context: Context) {
	await requireUserOrigin(api, context, content => splitUserContent(content).text);
}
