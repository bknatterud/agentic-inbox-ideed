// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { Button } from "@cloudflare/kumo";
import { PaperclipIcon, XIcon } from "@phosphor-icons/react";
import { useRef } from "react";
import { formatBytes } from "~/lib/utils";

export interface ComposeAttachment {
	id: string;
	file: File;
}

interface ComposeAttachmentsProps {
	attachments: ComposeAttachment[];
	onAdd: (files: FileList | File[]) => void;
	onRemove: (id: string) => void;
	disabled?: boolean;
}

/** Paperclip button that opens the file picker. */
export function AttachButton({
	onAdd,
	disabled,
}: Pick<ComposeAttachmentsProps, "onAdd" | "disabled">) {
	const inputRef = useRef<HTMLInputElement>(null);
	return (
		<>
			<input
				ref={inputRef}
				type="file"
				multiple
				hidden
				onChange={(e) => {
					if (e.target.files?.length) onAdd(e.target.files);
					e.target.value = ""; // allow re-selecting the same file
				}}
			/>
			<Button
				type="button"
				variant="ghost"
				size="sm"
				icon={<PaperclipIcon size={16} />}
				disabled={disabled}
				onClick={() => inputRef.current?.click()}
				aria-label="Attach files"
			>
				Attach
			</Button>
		</>
	);
}

/** List of files queued to send, each with a remove button. */
export function AttachmentChips({
	attachments,
	onRemove,
	disabled,
}: Pick<ComposeAttachmentsProps, "attachments" | "onRemove" | "disabled">) {
	if (attachments.length === 0) return null;
	return (
		<div className="flex flex-wrap gap-2">
			{attachments.map(({ id, file }) => (
				<div
					key={id}
					className="flex items-center gap-2 rounded-md border border-kumo-line bg-kumo-fill/40 px-2 py-1 text-xs max-w-full"
				>
					<PaperclipIcon size={12} className="shrink-0 text-kumo-subtle" />
					<span className="truncate text-kumo-default">{file.name}</span>
					<span className="shrink-0 text-kumo-subtle">{formatBytes(file.size)}</span>
					<button
						type="button"
						onClick={() => onRemove(id)}
						disabled={disabled}
						className="shrink-0 text-kumo-subtle hover:text-kumo-default"
						aria-label={`Remove ${file.name}`}
					>
						<XIcon size={12} />
					</button>
				</div>
			))}
		</div>
	);
}
