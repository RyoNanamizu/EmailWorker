import { env, createExecutionContext } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import worker, { handleEmail, type WorkerEnv } from "../src/index";

const RAW_TEXT = [
	"From: Sender <sender@example.org>",
	"To: User <user@example.com>",
	"Subject: raw bytes test",
	"Content-Type: text/plain; charset=utf-8",
	"",
	"Hello, 世界!",
].join("\r\n");
const TOKEN = "test-worker-token";
const PUSH_TOKEN = "test-push-token";
const encoder = new TextEncoder();

function testEnv(): WorkerEnv {
	return {
		MAIL_BUCKET: env.MAIL_BUCKET,
		VPS_BASE_URL: "https://mail.example.net/daemon",
		VPS_PUSH_TOKEN: PUSH_TOKEN,
		WORKER_API_TOKEN: TOKEN,
	};
}

function messageFromBytes(bytes: Uint8Array = encoder.encode(RAW_TEXT)): ForwardableEmailMessage {
	const raw = new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(bytes);
			controller.close();
		},
	});

	return {
		from: "sender@example.org",
		to: "user@example.com",
		headers: new Headers(),
		raw,
		rawSize: bytes.byteLength,
		setReject: vi.fn(),
		forward: vi.fn(),
		reply: vi.fn(),
	};
}

async function mailId(bytes: Uint8Array = encoder.encode(RAW_TEXT)): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", bytes);
	return [...new Uint8Array(digest)]
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("");
}

function apiRequest(path: string, init: RequestInit = {}): Request {
	const headers = new Headers(init.headers);
	headers.set("Authorization", `Bearer ${TOKEN}`);
	return new Request(`https://worker.example${path}`, { ...init, headers });
}

async function clearBucket(): Promise<void> {
	let cursor: string | undefined;
	do {
		const listed = await env.MAIL_BUCKET.list({ prefix: "pending/", cursor });
		if (listed.objects.length > 0) {
			await env.MAIL_BUCKET.delete(listed.objects.map((object) => object.key));
		}
		cursor = listed.truncated ? listed.cursor : undefined;
	} while (cursor);
}

async function expectFallback(
	fetcher: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
): Promise<void> {
	const bytes = encoder.encode(RAW_TEXT);
	const id = await mailId(bytes);
	await handleEmail(messageFromBytes(bytes), testEnv(), createExecutionContext(), {
		fetcher,
	});

	const object = await env.MAIL_BUCKET.get(`pending/${id}.eml`);
	expect(object).not.toBeNull();
	expect(new Uint8Array(await object!.arrayBuffer())).toEqual(bytes);
	expect(object!.customMetadata).toMatchObject({
		"mail-id": id,
		"mail-from": "sender@example.org",
		"mail-to": "user@example.com",
	});
	const receivedAt = object!.customMetadata?.["received-at"];
	expect(receivedAt).toBeDefined();
	expect(new Date(receivedAt!).toISOString()).toBe(receivedAt);
}

beforeEach(async () => {
	await clearBucket();
});

describe("email delivery", () => {
	it("pushes the exact RFC822 bytes and does not write R2 after a 2xx response", async () => {
		const bytes = encoder.encode(RAW_TEXT);
		const id = await mailId(bytes);
		const fetcher = vi.fn(
			async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(null, { status: 204 }),
		);

		await handleEmail(messageFromBytes(bytes), testEnv(), createExecutionContext(), {
			fetcher,
		});

		expect(fetcher).toHaveBeenCalledOnce();
		const [input, init] = fetcher.mock.calls[0];
		expect(input.toString()).toBe("https://mail.example.net/daemon/push");
		expect(init?.method).toBe("POST");
		const headers = new Headers(init?.headers);
		expect(headers.get("Authorization")).toBe(`Bearer ${PUSH_TOKEN}`);
		expect(headers.get("Content-Type")).toBe("message/rfc822");
		expect(headers.get("X-Mail-ID")).toBe(id);
		expect(headers.get("X-Mail-From")).toBe("sender@example.org");
		expect(headers.get("X-Mail-To")).toBe("user@example.com");
		expect(new Uint8Array(init?.body as ArrayBuffer)).toEqual(bytes);
		expect(await env.MAIL_BUCKET.head(`pending/${id}.eml`)).toBeNull();
	});

	it("falls back to R2 after a network error", async () => {
		await expectFallback(async () => {
			throw new TypeError("simulated network error");
		});
	});

	it("falls back to R2 after a non-2xx response", async () => {
		await expectFallback(async () => new Response(null, { status: 500 }));
	});

	it("aborts a timed-out push and falls back to R2", async () => {
		const fetcher = (_input: RequestInfo | URL, init?: RequestInit) =>
			new Promise<Response>((_resolve, reject) => {
				init?.signal?.addEventListener(
					"abort",
					() => reject(new Error("simulated abort")),
					{ once: true },
				);
			});

		await handleEmail(messageFromBytes(), testEnv(), createExecutionContext(), {
			fetcher,
			timeoutMs: 5,
		});
		expect((await env.MAIL_BUCKET.list({ prefix: "pending/" })).objects).toHaveLength(1);
	});

	it("preserves at-least-once delivery if the response is lost after VPS persistence", async () => {
		await expectFallback(async () => {
			// From the Worker, this race is indistinguishable from any other fetch failure.
			throw new TypeError("response connection closed");
		});
	});

	it("falls back when the VPS URL is not HTTPS", async () => {
		const configured = testEnv();
		configured.VPS_BASE_URL = "http://mail.example.net";
		const fetcher = vi.fn(
			async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(null, { status: 200 }),
		);
		await handleEmail(messageFromBytes(), configured, createExecutionContext(), { fetcher });
		expect(fetcher).not.toHaveBeenCalled();
		expect((await env.MAIL_BUCKET.list({ prefix: "pending/" })).objects).toHaveLength(1);
	});

	it("throws if both push and durable fallback fail", async () => {
		const configured = testEnv();
		configured.MAIL_BUCKET = {
			put: vi.fn(async () => {
				throw new Error("simulated R2 error");
			}),
		} as unknown as R2Bucket;

		await expect(
			handleEmail(messageFromBytes(), configured, createExecutionContext(), {
				fetcher: async () => {
					throw new TypeError("simulated network error");
				},
			}),
		).rejects.toThrow("Unable to preserve email");
	});
});

describe("HTTP API", () => {
	it("lists an empty bucket as completed", async () => {
		const response = await worker.fetch(apiRequest("/list?limit=100"), testEnv());
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ ids: [], completed: true });
	});

	it("lists pending IDs without reading or deleting their messages", async () => {
		const ids = ["a".repeat(64), "b".repeat(64)];
		await Promise.all(ids.map((id) => env.MAIL_BUCKET.put(`pending/${id}.eml`, "mail")));

		const first = await worker.fetch(apiRequest("/list?limit=2"), testEnv());
		expect(await first.json()).toEqual({ ids, completed: true });
		const second = await worker.fetch(apiRequest("/list?limit=2"), testEnv());
		expect(await second.json()).toEqual({ ids, completed: true });
		expect(await env.MAIL_BUCKET.head(`pending/${ids[0]}.eml`)).not.toBeNull();
		expect(await env.MAIL_BUCKET.head(`pending/${ids[1]}.eml`)).not.toBeNull();
	});

	it("streams the same raw message repeatedly until it is confirmed", async () => {
		const id = "c".repeat(64);
		const bytes = new Uint8Array([0, 1, 2, 127, 128, 255]);
		await env.MAIL_BUCKET.put(`pending/${id}.eml`, bytes, {
			customMetadata: {
				"mail-from": "sender@example.org",
				"mail-to": "recipient@example.org",
				"received-at": "2026-09-21T14:00:00.000Z",
			},
		});

		for (let attempt = 0; attempt < 2; attempt += 1) {
			const response = await worker.fetch(
				apiRequest(`/mail?id=${id.toUpperCase()}`),
				testEnv(),
			);
			expect(response.status).toBe(200);
			expect(response.headers.get("Content-Type")).toBe("message/rfc822");
			expect(response.headers.get("X-Mail-ID")).toBe(id);
			expect(response.headers.get("X-Mail-From")).toBe("sender@example.org");
			expect(response.headers.get("X-Mail-To")).toBe("recipient@example.org");
			expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
		}
		expect(await env.MAIL_BUCKET.head(`pending/${id}.eml`)).not.toBeNull();
	});

	it("passes the requested list limit through and reports more pages", async () => {
		const id = "d".repeat(64);
		const list = vi.fn(async () => ({
			objects: [{ key: `pending/${id}.eml` }],
			truncated: true,
			cursor: "next-page",
		}));
		const configured = testEnv();
		configured.MAIL_BUCKET = { list } as unknown as R2Bucket;

		const response = await worker.fetch(apiRequest("/list?limit=25"), configured);
		expect(await response.json()).toEqual({ ids: [id], completed: false });
		expect(list).toHaveBeenCalledOnce();
		expect(list).toHaveBeenCalledWith({
			prefix: "pending/",
			limit: 25,
		});
	});

	it("confirms in batches and repeated confirms remain successful", async () => {
		const ids = ["c".repeat(64), "d".repeat(64)];
		await Promise.all(ids.map((id) => env.MAIL_BUCKET.put(`pending/${id}.eml`, "mail")));
		const request = () =>
			apiRequest("/confirm", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ ids }),
			});

		const first = await worker.fetch(request(), testEnv());
		expect(await first.json()).toEqual({ ok: true, confirmed: 2 });
		expect(await env.MAIL_BUCKET.head(`pending/${ids[0]}.eml`)).toBeNull();
		expect(await env.MAIL_BUCKET.head(`pending/${ids[1]}.eml`)).toBeNull();

		const second = await worker.fetch(request(), testEnv());
		expect(second.status).toBe(200);
		expect(await second.json()).toEqual({ ok: true, confirmed: 2 });
	});

	it("rejects unauthorized requests", async () => {
		const response = await worker.fetch(
			new Request("https://worker.example/list?limit=100"),
			testEnv(),
		);
		expect(response.status).toBe(401);
		expect(await response.text()).toBe("Unauthorized");

		const unknownPath = await worker.fetch(
			new Request("https://worker.example/unknown"),
			testEnv(),
		);
		expect(unknownPath.status).toBe(401);
	});

	it("rejects invalid SHA-256 IDs when downloading or confirming", async () => {
		const mailResponse = await worker.fetch(
			apiRequest("/mail?id=not-a-sha256"),
			testEnv(),
		);
		expect(mailResponse.status).toBe(400);

		const confirmResponse = await worker.fetch(
			apiRequest("/confirm", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ ids: ["not-a-sha256"] }),
			}),
			testEnv(),
		);
		expect(confirmResponse.status).toBe(400);
	});

	it("enforces list limits, methods, and known paths", async () => {
		for (const path of ["/list", "/list?limit=0", "/list?limit=101"]) {
			const response = await worker.fetch(apiRequest(path), testEnv());
			expect(response.status).toBe(400);
		}

		const wrongListMethod = await worker.fetch(
			apiRequest("/list?limit=10", { method: "POST" }),
			testEnv(),
		);
		expect(wrongListMethod.status).toBe(405);
		expect(wrongListMethod.headers.get("Allow")).toBe("GET");

		const wrongMailMethod = await worker.fetch(
			apiRequest(`/mail?id=${"e".repeat(64)}`, { method: "POST" }),
			testEnv(),
		);
		expect(wrongMailMethod.status).toBe(405);
		expect(wrongMailMethod.headers.get("Allow")).toBe("GET");

		const removedFetch = await worker.fetch(apiRequest("/fetch"), testEnv());
		expect(removedFetch.status).toBe(404);

		const unknown = await worker.fetch(
			apiRequest("/unknown"),
			testEnv(),
		);
		expect(unknown.status).toBe(404);
	});
});
