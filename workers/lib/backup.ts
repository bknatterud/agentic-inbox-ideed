// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Backs up every email to R2 as a standard .eml file.
 *
 *   backups/{mailbox}/{folder}/{YYYY}/{YYYY-MM-DD}_{emailId}.eml
 *
 * - Inbound emails received after this feature was deployed are copied
 *   byte-for-byte from the original message saved at `raw/{emailId}.eml`.
 * - Sent emails and older inbound emails are rebuilt as MIME from the
 *   mailbox database plus their attachments in R2.
 *
 * Each email is backed up once (tracked by `emails.backed_up_at`), so the
 * job is incremental and cheap to run often. Drafts are skipped. Backups are
 * never deleted, so they survive deleting an email or mailbox in the app.
 */
import type { Env } from "../types";
import { listMailboxes } from "./email-helpers";

const BATCH_SIZE = 100;
// Keep a single run well inside Worker limits; leftovers go in the next run.
const MAX_EMAILS_PER_RUN = 500;

export interface BackupEmail {
	id: string;
	folder_id: string;
	subject: string | null;
	sender: string | null;
	recipient: string | null;
	cc: string | null;
	bcc: string | null;
	date: string | null;
	body: string | null;
	in_reply_to: string | null;
	email_references: string | null;
	message_id: string | null;
	raw_headers: string | null;
	attachments: {
		id: string;
		filename: string;
		mimetype: string;
		content_id: string | null;
		disposition: string | null;
	}[];
}

interface BackupStub {
	getEmailsToBackUp(limit: number): Promise<BackupEmail[]>;
	markBackedUp(ids: string[]): Promise<void>;
	countEmailsToBackUp(): Promise<number>;
}

export interface BackupResult {
	mailbox: string;
	backedUp: number;
	failed: number;
	remaining: number;
}

export async function runBackup(env: Env): Promise<BackupResult[]> {
	const mailboxes = await listMailboxes(env.BUCKET);
	const results: BackupResult[] = [];
	let budget = MAX_EMAILS_PER_RUN;

	for (const { id: mailboxId } of mailboxes) {
		const stub = env.MAILBOX.get(env.MAILBOX.idFromName(mailboxId)) as unknown as BackupStub;
		let backedUp = 0;
		let failed = 0;

		while (budget > 0) {
			const batch = await stub.getEmailsToBackUp(Math.min(BATCH_SIZE, budget));
			if (batch.length === 0) break;
			budget -= batch.length;

			const done: string[] = [];
			for (const email of batch) {
				try {
					const eml = await buildEml(env, email);
					await env.BUCKET.put(backupKey(mailboxId, email), eml, {
						httpMetadata: { contentType: "message/rfc822" },
					});
					done.push(email.id);
				} catch (e) {
					failed++;
					console.error(`Backup failed for ${mailboxId}/${email.id}:`, (e as Error).message);
				}
			}
			if (done.length) await stub.markBackedUp(done);
			backedUp += done.length;
			// Every email in this batch failed; stop rather than loop on them.
			if (done.length === 0) break;
		}

		const remaining = await stub.countEmailsToBackUp();
		results.push({ mailbox: mailboxId, backedUp, failed, remaining });
	}

	console.log("Email backup complete:", JSON.stringify(results));
	return results;
}

function backupKey(mailboxId: string, email: BackupEmail) {
	const d = email.date ? new Date(email.date) : new Date();
	const iso = Number.isNaN(d.getTime()) ? "unknown-date" : d.toISOString().slice(0, 10);
	const year = iso.slice(0, 4);
	return `backups/${mailboxId}/${email.folder_id}/${year}/${iso}_${email.id}.eml`;
}

async function buildEml(env: Env, email: BackupEmail): Promise<ArrayBuffer | string> {
	const raw = await env.BUCKET.get(`raw/${email.id}.eml`);
	if (raw) return raw.arrayBuffer();
	return buildMime(email, async (att) => {
		const obj = await env.BUCKET.get(`attachments/${email.id}/${att.id}/${att.filename}`);
		return obj ? new Uint8Array(await obj.arrayBuffer()) : null;
	});
}

// -- MIME construction ------------------------------------------------

type AttachmentLoader = (att: BackupEmail["attachments"][number]) => Promise<Uint8Array | null>;

export async function buildMime(email: BackupEmail, loadAttachment: AttachmentLoader): Promise<string> {
	const headers = parseRawHeaders(email.raw_headers);
	const isSent = email.folder_id === "sent";

	const lines: string[] = [];
	const add = (name: string, value: string | null | undefined) => {
		if (value) lines.push(`${name}: ${clean(value)}`);
	};

	// Prefer the original From (keeps the display name), else the stored address.
	add("From", headers.get("from") || email.sender);
	add("To", headers.get("to") || email.recipient);
	add("Cc", headers.get("cc") || email.cc);
	if (isSent) add("Bcc", headers.get("bcc") || email.bcc);
	add("Subject", encodeHeaderWord(email.subject || ""));
	add("Date", rfc2822Date(email.date));
	if (email.message_id) add("Message-ID", `<${email.message_id.replace(/^<|>$/g, "")}>`);
	if (email.in_reply_to) add("In-Reply-To", `<${email.in_reply_to.replace(/^<|>$/g, "")}>`);
	const refs = parseJsonArray(email.email_references);
	if (refs.length) add("References", refs.map((r) => `<${r.replace(/^<|>$/g, "")}>`).join(" "));
	add("X-Agentic-Inbox-Folder", email.folder_id);
	add("X-Agentic-Inbox-Id", email.id);
	lines.push("MIME-Version: 1.0");

	const body = email.body || "";
	const isHtml = /<[a-z][\s\S]*>/i.test(body);
	const textPart = textLeaf("text/plain", isHtml ? htmlToText(body) : body);
	const bodyPart = isHtml
		? multipart("alternative", [textPart, textLeaf("text/html", body)])
		: textPart;

	const inline: string[] = [];
	const regular: string[] = [];
	for (const att of email.attachments) {
		const bytes = await loadAttachment(att);
		if (!bytes) continue;
		const isInline = att.disposition === "inline" && !!att.content_id;
		const part = attachmentLeaf(att, bytes, isInline);
		(isInline ? inline : regular).push(part);
	}

	let root = bodyPart;
	if (inline.length) root = multipart("related", [root, ...inline]);
	if (regular.length) root = multipart("mixed", [root, ...regular]);

	return `${lines.join("\r\n")}\r\n${root}`;
}

function textLeaf(type: string, content: string) {
	return [
		`Content-Type: ${type}; charset=utf-8`,
		"Content-Transfer-Encoding: base64",
		"",
		wrap76(base64(new TextEncoder().encode(content))),
	].join("\r\n");
}

function attachmentLeaf(att: BackupEmail["attachments"][number], bytes: Uint8Array, inline: boolean) {
	const name = encodeHeaderWord(att.filename).replace(/"/g, "'");
	const lines = [
		`Content-Type: ${clean(att.mimetype || "application/octet-stream")}; name="${name}"`,
		"Content-Transfer-Encoding: base64",
		`Content-Disposition: ${inline ? "inline" : "attachment"}; filename="${name}"`,
	];
	if (att.content_id) lines.push(`Content-ID: <${clean(att.content_id).replace(/^<|>$/g, "")}>`);
	lines.push("", wrap76(base64(bytes)));
	return lines.join("\r\n");
}

function multipart(subtype: string, parts: string[]) {
	const boundary = `----=_Part_${crypto.randomUUID().replace(/-/g, "")}`;
	return [
		`Content-Type: multipart/${subtype}; boundary="${boundary}"`,
		"",
		...parts.flatMap((p) => [`--${boundary}`, p]),
		`--${boundary}--`,
		"",
	].join("\r\n");
}

// -- helpers ----------------------------------------------------------

function parseRawHeaders(raw: string | null): Map<string, string> {
	const map = new Map<string, string>();
	if (!raw) return map;
	try {
		const arr = JSON.parse(raw) as { key?: string; value?: string }[];
		for (const h of arr) {
			if (h?.key && typeof h.value === "string" && !map.has(h.key.toLowerCase())) {
				map.set(h.key.toLowerCase(), h.value);
			}
		}
	} catch {
		/* ignore malformed headers */
	}
	return map;
}

function parseJsonArray(s: string | null): string[] {
	if (!s) return [];
	try {
		const v = JSON.parse(s);
		return Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];
	} catch {
		return [];
	}
}

/** Strip CR/LF so stored values can't inject extra headers. */
function clean(v: string) {
	return v.replace(/[\r\n]+/g, " ").trim();
}

function encodeHeaderWord(v: string) {
	const s = clean(v);
	// biome-ignore lint/suspicious/noControlCharactersInRegex: ASCII check
	if (/^[\x20-\x7e]*$/.test(s)) return s;
	return `=?UTF-8?B?${base64(new TextEncoder().encode(s))}?=`;
}

function rfc2822Date(date: string | null) {
	const d = date ? new Date(date) : new Date();
	return (Number.isNaN(d.getTime()) ? new Date() : d).toUTCString().replace("GMT", "+0000");
}

function htmlToText(html: string) {
	return html
		.replace(/<(script|style)[\s\S]*?<\/\1>/gi, "")
		.replace(/<br\s*\/?>/gi, "\n")
		.replace(/<\/(p|div|li|tr|h[1-6])>/gi, "\n")
		.replace(/<[^>]+>/g, "")
		.replace(/&nbsp;/g, " ")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/&amp;/g, "&")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

function base64(bytes: Uint8Array) {
	let binary = "";
	const chunk = 0x8000;
	for (let i = 0; i < bytes.length; i += chunk) {
		binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
	}
	return btoa(binary);
}

function wrap76(s: string) {
	return s.replace(/.{1,76}/g, "$&\r\n").trimEnd();
}
