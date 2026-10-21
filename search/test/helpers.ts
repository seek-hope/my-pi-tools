import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

export interface RecordedRequest {
	method: string;
	path: string;
	headers: IncomingMessage["headers"];
	body: string;
}

export interface MockServer {
	url: string;
	requests: RecordedRequest[];
	close: () => Promise<void>;
}

type Handler = (request: RecordedRequest, response: ServerResponse) => void | Promise<void>;

export async function startMockServer(handler: Handler): Promise<MockServer> {
	const requests: RecordedRequest[] = [];
	const server: Server = createServer(async (req, res) => {
		const chunks: Buffer[] = [];
		for await (const chunk of req) chunks.push(Buffer.from(chunk));
		const recorded: RecordedRequest = {
			method: req.method ?? "GET",
			path: req.url ?? "/",
			headers: req.headers,
			body: Buffer.concat(chunks).toString("utf8"),
		};
		requests.push(recorded);
		try {
			await handler(recorded, res);
		} catch (error) {
			res.statusCode = 500;
			res.end(JSON.stringify({ error: { message: String(error) } }));
		}
	});

	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => resolve());
	});
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("mock server did not bind to a port");
	const url = `http://127.0.0.1:${address.port}`;

	return {
		url,
		requests,
		close: () =>
			new Promise<void>((resolve, reject) => {
				server.closeAllConnections();
				server.close((error) => (error ? reject(error) : resolve()));
			}),
	};
}

export function json(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
	res.writeHead(status, { "content-type": "application/json", ...headers });
	res.end(JSON.stringify(body));
}

export function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
