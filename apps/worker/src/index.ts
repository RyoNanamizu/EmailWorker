/**
 * Cloudflare Email Worker that delivers each raw message to a VPS first and
 * uses R2 as the durable fallback when direct delivery cannot be confirmed.
 *
 * Delivery is intentionally at-least-once: a message may reach both the VPS
 * and R2 when the VPS stores it but its success response is lost in transit.
 */

// R2 object names are derived exclusively from validated SHA-256 mail IDs.
const PENDING_PREFIX = "pending/";
const MAX_LIST_LIMIT = 100;
const MAX_CONFIRM_IDS = 100;
const PUSH_TIMEOUT_MS = 10_000;
const SHA256_ID_PATTERN = /^[0-9a-f]{64}$/i;

/** Runtime bindings and secrets configured through Wrangler or the dashboard. */
export interface WorkerEnv {
	/** The only persistent store for messages awaiting VPS confirmation. */
	MAIL_BUCKET: R2Bucket;
	/** HTTPS base URL of the VPS daemon; `/push` is appended by the Worker. */
	VPS_BASE_URL: string;
	/** Bearer token used by the Worker when calling the VPS. */
	VPS_PUSH_TOKEN: string;
	/** Bearer token required by the Worker's recovery APIs. */
	WORKER_API_TOKEN: string;
}

// Fetch is injectable so delivery failures and timeouts can be tested without
// making real network requests.
type Fetcher = (
	input: RequestInfo | URL,
	init?: RequestInit,
) => Promise<Response>;

interface EmailHandlerOptions {
	fetcher?: Fetcher;
	timeoutMs?: number;
}

function pendingKey(id: string): string {
	return `${PENDING_PREFIX}${id}.eml`;
}

// API responses are never cacheable because they expose live pending state.
function jsonResponse(value: unknown, status = 200): Response {
	return Response.json(value, {
		status,
		headers: { "Cache-Control": "no-store" },
	});
}

function textResponse(body: string, status: number, allow?: string): Response {
	const headers = new Headers({
		"Cache-Control": "no-store",
		"Content-Type": "text/plain; charset=utf-8",
	});
	if (allow) {
		headers.set("Allow", allow);
	}
	return new Response(body, { status, headers });
}

function isAuthorized(request: Request, token: string): boolean {
	return (
		typeof token === "string" &&
		token.length > 0 &&
		request.headers.get("Authorization") === `Bearer ${token}`
	);
}

function normalizeMailId(value: string | null): string | null {
	if (value === null || !SHA256_ID_PATTERN.test(value)) {
		return null;
	}
	return value.toLowerCase();
}

function toHex(bytes: Uint8Array): string {
	let result = "";
	for (const byte of bytes) {
		result += byte.toString(16).padStart(2, "0");
	}
	return result;
}

/** Computes both forms needed by the protocol and R2 integrity validation. */
async function sha256(raw: ArrayBuffer): Promise<{
	id: string;
	digest: ArrayBuffer;
}> {
	const digest = await crypto.subtle.digest("SHA-256", raw);
	return { id: toHex(new Uint8Array(digest)), digest };
}

/**
 * Builds the daemon endpoint while rejecting plaintext HTTP and URLs that
 * embed credentials. Existing base paths are preserved.
 */
function pushUrl(baseUrl: string): URL | null {
	try {
		const base = new URL(baseUrl);
		if (base.protocol !== "https:" || base.username || base.password) {
			return null;
		}

		if (!base.pathname.endsWith("/")) {
			base.pathname += "/";
		}
		base.search = "";
		base.hash = "";
		return new URL("push", base);
	} catch {
		return null;
	}
}

/**
 * Attempts direct delivery. Every configuration, network, timeout, and HTTP
 * failure is represented as `false` so the caller can continue to R2.
 */
async function pushToVps(
	raw: ArrayBuffer,
	id: string,
	from: string,
	to: string,
	env: WorkerEnv,
	fetcher: Fetcher,
	timeoutMs: number,
): Promise<boolean> {
	const url = pushUrl(env.VPS_BASE_URL);
	if (!url || !env.VPS_PUSH_TOKEN) {
		console.warn("Email push skipped due to invalid VPS configuration", {
			mailId: id,
			recipient: to,
		});
		return false;
	}

	const controller = new AbortController();
	// Bound the network wait so an unavailable daemon cannot hold email
	// processing open indefinitely.
	const timeout = setTimeout(() => controller.abort(), timeoutMs);

	try {
		const response = await fetcher(url, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${env.VPS_PUSH_TOKEN}`,
				"Content-Type": "message/rfc822",
				"X-Mail-ID": id,
				"X-Mail-From": from,
				"X-Mail-To": to,
			},
			body: raw,
			signal: controller.signal,
		});

		if (!response.ok) {
			console.warn("Email push returned a non-success status", {
				mailId: id,
				recipient: to,
				status: response.status,
			});
			return false;
		}

		console.log("Email push succeeded", { mailId: id, recipient: to });
		return true;
	} catch {
		console.warn("Email push failed", { mailId: id, recipient: to });
		return false;
	} finally {
		clearTimeout(timeout);
	}
}

/**
 * Handles one incoming message without parsing or rebuilding its MIME data.
 * The function returns only after direct delivery or a durable R2 write.
 */
export async function handleEmail(
	message: ForwardableEmailMessage,
	env: WorkerEnv,
	_ctx: ExecutionContext,
	options: EmailHandlerOptions = {},
): Promise<void> {
	// message.raw is a one-shot stream. Keep one byte-for-byte copy available for
	// both the push attempt and a possible R2 fallback.
	const raw = await new Response(message.raw).arrayBuffer();
	const { id, digest } = await sha256(raw);
	const fetcher = options.fetcher ?? fetch;
	const timeoutMs = options.timeoutMs ?? PUSH_TIMEOUT_MS;

	if (
		await pushToVps(
			raw,
			id,
			message.from,
			message.to,
			env,
			fetcher,
			timeoutMs,
		)
	) {
		// A confirmed 2xx push must not create fallback state.
		return;
	}

	try {
		// Object existence is the authoritative pending-delivery state. Rewriting
		// the same key is safe because identical raw bytes produce the same ID.
		const stored = await env.MAIL_BUCKET.put(pendingKey(id), raw, {
			sha256: digest,
			httpMetadata: { contentType: "message/rfc822" },
			customMetadata: {
				"mail-id": id,
				"mail-from": message.from,
				"mail-to": message.to,
				"received-at": new Date().toISOString(),
			},
		});
		if (stored === null) {
			throw new Error("R2 did not persist the object");
		}
		console.log("Email stored in R2 fallback", {
			mailId: id,
			recipient: message.to,
		});
	} catch {
		console.error("Email R2 fallback failed", {
			mailId: id,
			recipient: message.to,
		});
		// Propagate the failure so Cloudflare does not treat a lost email as handled.
		throw new Error(`Unable to preserve email ${id}`);
	}
}

/** Lists one page of pending mail IDs without reading message bodies. */
async function listPending(request: Request, env: WorkerEnv): Promise<Response> {
	const limit = Number(new URL(request.url).searchParams.get("limit"));
	if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIST_LIMIT) {
		return textResponse(
			`limit must be an integer between 1 and ${MAX_LIST_LIMIT}`,
			400,
		);
	}

	const listed = await env.MAIL_BUCKET.list({
		prefix: PENDING_PREFIX,
		limit,
	});
	const ids = listed.objects.flatMap((object) => {
		const filename = object.key.slice(PENDING_PREFIX.length);
		const id = filename.endsWith(".eml")
			? normalizeMailId(filename.slice(0, -4))
			: null;
		return id ? [id] : [];
	});

	return jsonResponse({ ids, completed: !listed.truncated });
}

/** Streams one raw RFC822 object directly from R2 without deleting it. */
async function getMail(request: Request, env: WorkerEnv): Promise<Response> {
	const id = normalizeMailId(new URL(request.url).searchParams.get("id"));
	if (!id) {
		return textResponse("id must be a 64-character SHA-256 hexadecimal value", 400);
	}

	const object = await env.MAIL_BUCKET.get(pendingKey(id));
	if (!object) {
		return textResponse("Not Found", 404);
	}

	const headers = new Headers({
		"Cache-Control": "no-store",
		"Content-Length": object.size.toString(),
		"Content-Type": "message/rfc822",
		"X-Content-Type-Options": "nosniff",
		"X-Mail-ID": id,
	});
	const from = object.customMetadata?.["mail-from"];
	const to = object.customMetadata?.["mail-to"];
	const receivedAt = object.customMetadata?.["received-at"];
	if (from) headers.set("X-Mail-From", from);
	if (to) headers.set("X-Mail-To", to);
	if (receivedAt) headers.set("X-Mail-Received-At", receivedAt);

	return new Response(object.body, { headers });
}

/**
 * Confirms durable VPS storage by deleting pending keys in one idempotent R2
 * operation. No other code path is allowed to delete pending messages.
 */
async function handleConfirm(request: Request, env: WorkerEnv): Promise<Response> {
	const contentType = request.headers.get("Content-Type") ?? "";
	if (!/^application\/json(?:\s*;|$)/i.test(contentType)) {
		return textResponse("Content-Type must be application/json", 415);
	}

	let value: unknown;
	try {
		value = await request.json();
	} catch {
		return textResponse("Request body must be valid JSON", 400);
	}

	if (
		typeof value !== "object" ||
		value === null ||
		!("ids" in value) ||
		!Array.isArray(value.ids)
	) {
		return textResponse("Request body must contain an ids array", 400);
	}
	if (value.ids.length > MAX_CONFIRM_IDS) {
		return textResponse(`A maximum of ${MAX_CONFIRM_IDS} ids may be confirmed`, 400);
	}

	const ids: string[] = [];
	for (const candidate of value.ids) {
		const id = typeof candidate === "string" ? normalizeMailId(candidate) : null;
		if (!id) {
			return textResponse("Every id must be a 64-character SHA-256 hexadecimal value", 400);
		}
		ids.push(id);
	}

	const uniqueIds = [...new Set(ids)];
	if (uniqueIds.length > 0) {
		// R2 delete treats missing objects as already deleted, preserving idempotency.
		await env.MAIL_BUCKET.delete(uniqueIds.map(pendingKey));
	}
	console.log("Pending emails confirmed", { count: uniqueIds.length });
	return jsonResponse({ ok: true, confirmed: uniqueIds.length });
}

/** Authenticated HTTP entry point for the VPS recovery protocol. */
export async function handleHttp(request: Request, env: WorkerEnv): Promise<Response> {
	try {
		const path = new URL(request.url).pathname;
		if (!isAuthorized(request, env.WORKER_API_TOKEN)) {
			return textResponse("Unauthorized", 401);
		}

		if (path === "/list") {
			if (request.method !== "GET") {
				return textResponse("Method Not Allowed", 405, "GET");
			}
			return await listPending(request, env);
		}

		if (path === "/mail") {
			if (request.method !== "GET") {
				return textResponse("Method Not Allowed", 405, "GET");
			}
			return await getMail(request, env);
		}

		if (path === "/confirm") {
			if (request.method !== "POST") {
				return textResponse("Method Not Allowed", 405, "POST");
			}
			return await handleConfirm(request, env);
		}

		return textResponse("Not Found", 404);
	} catch {
		// Keep storage errors and stack traces out of public API responses.
		return textResponse("Internal Server Error", 500);
	}
}

// Module Worker entry points for HTTP requests and Email Routing deliveries.
export default {
	fetch: handleHttp,
	email: handleEmail,
} satisfies ExportedHandler<WorkerEnv>;
