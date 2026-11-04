import assert from "node:assert/strict";
import {test} from "node:test";
import {readFileComments} from "./driveComments.mjs";
import {createGoogleRestClient} from "./restClient.mjs";
import {createGoogleWorkspaceConfig} from "./config.mjs";
import {registerDocsReadTools} from "./docs.mjs";
import {registerDriveWriteTools} from "./driveWrites.mjs";

const thread = {
  id: "comment-1", content: "Please clarify", resolved: true,
  author: {displayName: "Reviewer", me: false},
  createdTime: "2026-11-01T10:00:00Z", modifiedTime: "2026-11-02T10:00:00Z",
  quotedFileContent: {mimeType: "text/plain", value: "Original sentence"},
  replies: [{id: "reply-1", content: "Done", author: {displayName: "Writer", me: true}, action: "resolve"}],
};

function reader(service, fetchImpl, scopes = "drive.readonly,documents.readonly") {
  const config = createGoogleWorkspaceConfig({env: {
    GOOGLE_MCP_ENABLED_SERVICES: service,
    GOOGLE_MCP_GRANTED_SCOPES: scopes.split(",").map((scope) => `https://www.googleapis.com/auth/${scope}`).join(","),
  }});
  const tools = new Map();
  const server = {registerTool: (name, schema, handler) => tools.set(name, {schema, handler})};
  const client = createGoogleRestClient({env: {GOOGLE_MCP_ACCESS_TOKEN: "test-secret"}, fetchImpl});
  if (service === "docs") registerDocsReadTools(server, {client, config});
  else registerDriveWriteTools(server, {client, config});
  return tools.get(service === "docs" ? "docs_read_document" : "drive_read_file");
}

for (const service of ["docs", "drive"]) {
  test(`${service} reader includes comment threads by default through the real REST client`, async () => {
    const calls = [];
    const tool = reader(service, async (url) => {
      calls.push(new URL(url));
      if (url.includes("/comments?")) return Response.json({comments: [thread]});
      if (url.includes("/export?")) return new Response("Document body");
      if (url.includes("docs.googleapis.com")) return Response.json({documentId: "doc-1", title: "Document body"});
      return Response.json({id: "doc-1", mimeType: "application/vnd.google-apps.document"});
    });
    const result = (await tool.handler({documentId: "doc-1", fileId: "doc-1"})).structuredContent;
    assert.equal(result.commentsStatus.state, "ok");
    assert.equal(result.comments[0].content, thread.content);
    assert.deepEqual(result.comments[0].author, thread.author);
    assert.equal(result.comments[0].createdTime, thread.createdTime);
    assert.equal(result.comments[0].modifiedTime, thread.modifiedTime);
    assert.equal(result.comments[0].resolved, true);
    assert.deepEqual(result.comments[0].quotedFileContent, thread.quotedFileContent);
    assert.equal(result.comments[0].replies[0].content, "Done");
    assert.equal(result.comments[0].replies[0].action, "resolve");
    assert.equal(result.commentsTruncated, false);
    const commentUrl = calls.find((url) => url.pathname.endsWith("/comments"));
    assert.equal(commentUrl.origin, "https://www.googleapis.com");
    assert.equal(commentUrl.pathname, "/drive/v3/files/doc-1/comments");
    assert.equal(commentUrl.searchParams.get("includeDeleted"), "false");
    assert.match(commentUrl.searchParams.get("fields"), /replies\(id,content/);
    assert.equal(service === "docs" ? result.title : result.contentText, "Document body");
  });

  test(`${service} reader preserves document content when comments fail and honors opt-out`, async () => {
    let commentCalls = 0;
    const tool = reader(service, async (url) => {
      if (url.includes("/comments?")) {
        commentCalls++;
        return Response.json({error: {message: "denied test-secret"}}, {status: 403});
      }
      if (url.includes("/export?")) return new Response("Body");
      return Response.json({id: "doc-1", documentId: "doc-1", title: "Body", mimeType: "application/vnd.google-apps.document"});
    });
    const input = {documentId: "doc-1", fileId: "doc-1"};
    const result = await tool.handler(input);
    assert.ok(!result.isError);
    assert.equal(result.structuredContent.commentsStatus.state, "unavailable");
    assert.equal(result.structuredContent.commentsStatus.status, 403);
    assert.equal(result.structuredContent.comments, undefined);
    assert.equal(service === "docs" ? result.structuredContent.title : result.structuredContent.contentText, "Body");
    assert.ok(!JSON.stringify(result).includes("test-secret"));
    const disabled = (await tool.handler({...input, includeComments: false})).structuredContent;
    assert.equal(disabled.commentsStatus.state, "disabled");
    assert.equal(commentCalls, 1);
  });
}

test("readers remain gated by enabled service and Drive read grant", () => {
  assert.equal(reader("docs", async () => {}, "documents.readonly"), undefined);
  assert.equal(reader("drive", async () => {}, "documents.readonly"), undefined);
  assert.ok(reader("docs", async () => {})); // Docs-only enabled service already grants Drive read access.
});

test("comment pages expose a continuation token even for empty pages", async () => {
  const calls = [];
  const client = {request: async (url, options) => {
    calls.push({url: new URL(url, "https://www.googleapis.com"), options});
    return calls.length === 1 ? {comments: [], nextPageToken: "page+2"} : {comments: [thread]};
  }};
  const first = await readFileComments(client, "doc/id", {maxComments: 1});
  assert.equal(first.commentsNextPageToken, "page+2");
  assert.equal(first.commentsTruncated, true);
  assert.equal(first.commentsContentTruncated, false);
  const second = await readFileComments(client, "doc/id", {commentsPageToken: first.commentsNextPageToken});
  assert.equal(second.comments.length, 1);
  assert.equal(second.commentsNextPageToken, null);
  assert.equal(calls[0].url.pathname, "/drive/v3/files/doc%2Fid/comments");
  assert.equal(calls[0].url.searchParams.get("pageSize"), "1");
  assert.equal(calls[1].url.searchParams.get("pageToken"), "page+2");
  assert.equal(calls[0].options.maxResponseBytes, 2_000_000);
});

test("bounds comment text and replies and excludes deleted entries", async () => {
  const client = {request: async () => ({comments: [
    {id: "deleted", deleted: true, content: "Gone"},
    {...thread, replies: [{deleted: true, content: "Gone"}, ...Array.from({length: 101}, (_, id) => ({id: String(id), content: "Reply"}))]},
  ]})};
  const result = await readFileComments(client, "doc-1", {maxCommentTextLength: 3});
  assert.equal(result.comments.length, 1);
  assert.equal(result.comments[0].content, "Ple");
  assert.equal(result.comments[0].quotedFileContent.value, "");
  assert.equal(result.comments[0].replies.length, 100);
  assert.equal(result.comments[0].repliesTruncated, true);
  assert.equal(result.commentsContentTruncated, true);
  assert.equal(result.commentsTruncated, true);
});

test("successful empty comments differ from unavailable comments", async () => {
  const empty = await readFileComments({request: async () => ({})}, "doc-1");
  assert.deepEqual(empty.comments, []);
  assert.equal(empty.commentsStatus.state, "ok");
  assert.equal(empty.commentsTruncated, false);
  const failed = await readFileComments({request: async () => {throw Object.assign(new Error("secret"), {status: 503, retryable: true});}}, "doc-1");
  assert.equal(failed.comments, undefined);
  assert.equal(failed.commentsStatus.retryable, true);
  assert.equal(failed.commentsStatus.status, 503);
  assert.ok(!JSON.stringify(failed).includes("secret"));
});

test("comment options are validated by both tool schemas", () => {
  for (const service of ["docs", "drive"]) {
    const schema = reader(service, async () => {}).schema.inputSchema;
    const input = {documentId: "doc-1", fileId: "doc-1"};
    assert.equal(schema.safeParse({...input, maxComments: 101}).success, false);
    assert.equal(schema.safeParse({...input, maxCommentTextLength: 500_001}).success, false);
    assert.equal(schema.safeParse({...input, includeComments: false, commentsPageToken: "next"}).success, true);
  }
});

test("oversized comment responses do not fail the document read", async () => {
  const tool = reader("docs", async (url) => url.includes("/comments?") ?
    Response.json({comments: [{content: "x".repeat(2_000_000)}]}) : Response.json({documentId: "doc-1"}));
  const result = await tool.handler({documentId: "doc-1"});
  assert.ok(!result.isError);
  assert.equal(result.structuredContent.documentId, "doc-1");
  assert.equal(result.structuredContent.commentsStatus.code, "google_response_too_large");
});

test("non-Docs Drive reads do not request comments", async () => {
  for (const mimeType of ["text/plain", "application/octet-stream", "application/vnd.google-apps.spreadsheet", "application/vnd.google-apps.presentation"]) {
    const calls = [];
    const tool = reader("drive", async (url) => {
      calls.push(url);
      return calls.length === 1 ? Response.json({id: "file-1", mimeType}) : new Response("Body");
    });
    const result = await tool.handler({fileId: "file-1"});
    assert.ok(!result.isError);
    assert.equal(calls.length, 2);
    assert.equal(result.structuredContent.commentsStatus, undefined);
  }
});
