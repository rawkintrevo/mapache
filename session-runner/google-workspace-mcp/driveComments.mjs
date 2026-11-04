import * as z from "zod/v4";
import {boundedItemLimit, pathSegment, queryParams} from "./tools.mjs";

export const commentReadSchema = {
  includeComments: z.boolean().optional(),
  maxComments: z.number().int().min(1).max(100).optional(),
  commentsPageToken: z.string().min(1).max(4096).optional(),
  maxCommentTextLength: z.number().int().min(1).max(500_000).optional(),
};

const MESSAGE_FIELDS = "id,content,createdTime,modifiedTime,author(displayName,me),deleted";
const COMMENT_FIELDS = `nextPageToken,comments(${MESSAGE_FIELDS},resolved,quotedFileContent(mimeType,value),replies(${MESSAGE_FIELDS},action))`;
const MAX_REPLIES = 100;

// Comments are Drive resources even when the document body comes from Docs.
// Both registered readers require drive.readonly in their service scope gates.
export async function readFileComments(client, fileId, input = {}) {
  if (input.includeComments === false) return {commentsStatus: {state: "disabled"}};
  try {
    const pageSize = boundedItemLimit(input.maxComments, 50, 100);
    const page = await client.request(`/drive/v3/files/${pathSegment(fileId, "fileId")}/comments?${queryParams({
      fields: COMMENT_FIELDS,
      includeDeleted: false,
      pageSize,
      pageToken: input.commentsPageToken,
    })}`, {maxResponseBytes: 2_000_000});
    const state = {remaining: boundedItemLimit(input.maxCommentTextLength, 50_000, 500_000), truncated: false};
    const threads = (page?.comments || []).filter((comment) => !comment.deleted);
    if (threads.length > pageSize) state.truncated = true;
    const comments = threads.slice(0, pageSize).map((comment) => {
      const replies = (comment.replies || []).filter((reply) => !reply.deleted);
      if (replies.length > MAX_REPLIES) state.truncated = true;
      return {
        ...compactMessage(comment, state),
        resolved: comment.resolved === true,
        quotedFileContent: comment.quotedFileContent ? {
          mimeType: comment.quotedFileContent.mimeType || null,
          value: boundedText(comment.quotedFileContent.value, state),
        } : null,
        replies: replies.slice(0, MAX_REPLIES).map((reply) => ({...compactMessage(reply, state), action: reply.action || null})),
        repliesTruncated: replies.length > MAX_REPLIES,
      };
    });
    const commentsNextPageToken = page?.nextPageToken || null;
    return {
      comments,
      commentsStatus: {state: "ok"},
      commentsNextPageToken,
      commentsTruncated: Boolean(commentsNextPageToken) || state.truncated,
      commentsContentTruncated: state.truncated,
    };
  } catch (error) {
    // Keep successful document reads usable; never imply an unreadable list is empty.
    // Use fixed diagnostics so provider errors cannot leak tokens into document data.
    return {commentsStatus: {
      state: "unavailable",
      code: /^google_[a-z0-9_]{1,100}$/.test(error?.code) ? error.code : "google_comments_failed",
      status: Number.isInteger(error?.status) ? error.status : null,
      retryable: error?.retryable === true,
      message: error?.status === 401 || error?.status === 403 ?
        "Comments could not be read. Check the connected account's Drive read access and file permissions." :
        "Comments could not be read; document content is still available.",
    }};
  }
}

function compactMessage(message, state) {
  return {
    id: message.id || null,
    content: boundedText(message.content, state),
    author: message.author ? {displayName: boundedText(message.author.displayName, state), me: message.author.me === true} : null,
    createdTime: message.createdTime || null,
    modifiedTime: message.modifiedTime || null,
  };
}

function boundedText(value, state) {
  const text = String(value || "");
  const result = text.slice(0, state.remaining);
  state.remaining -= result.length;
  if (result.length < text.length) state.truncated = true;
  return result;
}
