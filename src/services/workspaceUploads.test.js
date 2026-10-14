import {describe, expect, it, vi} from "vitest";
import {uploadWorkspaceFile} from "./workspaceUploads.js";
const response = (status, range) => ({status, ok: status >= 200 && status < 300, headers: {get: () => range || null}});
const upload = {uploadUrl: "https://example.test/upload", path: "/uploads/data.bin"};
describe("resumable workspace uploads", () => {
  it("queries the offset and sends bounded chunks, including after a lost response", async () => {
    const file = new File([new Uint8Array(10 * 1024 * 1024)], "data.bin");
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(response(308))
      .mockRejectedValueOnce(new TypeError("offline"))
      .mockResolvedValueOnce(response(308, `bytes=0-${8 * 1024 * 1024 - 1}`))
      .mockResolvedValueOnce(response(200));
    const onProgress = vi.fn();
    expect(await uploadWorkspaceFile(file, upload, {fetchImpl, onProgress})).toEqual({path: upload.path});
    expect(fetchImpl.mock.calls[1][1].body.size).toBe(8 * 1024 * 1024);
    expect(fetchImpl.mock.calls[3][1].headers["Content-Range"]).toBe(`bytes ${8 * 1024 * 1024}-${file.size - 1}/${file.size}`);
    expect(onProgress).toHaveBeenLastCalledWith(100);
  });
  it("recovers completion after a lost final response without reuploading", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(response(200));
    await uploadWorkspaceFile(new File(["a"], "a"), upload, {fetchImpl});
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0][1].headers["Content-Range"]).toBe("bytes */1");
  });
  it("stops on conflicts and bounds network retries", async () => {
    const file = new File(["a"], "a");
    await expect(uploadWorkspaceFile(file, upload, {fetchImpl: vi.fn().mockResolvedValue(response(412))})).rejects.toThrow("already exists");
    const fetchImpl = vi.fn().mockRejectedValue(new Error("offline"));
    await expect(uploadWorkspaceFile(file, upload, {fetchImpl})).rejects.toThrow("Retry");
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });
  it("bounds repeated incomplete final acknowledgements", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(response(308, "bytes=0-0"));
    await expect(uploadWorkspaceFile(new File(["a"], "a"), upload, {fetchImpl})).rejects.toThrow("stalled");
    expect(fetchImpl).toHaveBeenCalledTimes(5);
  });
  it("aborts before sending bytes", async () => {
    const controller = new AbortController(); controller.abort();
    const fetchImpl = vi.fn();
    await expect(uploadWorkspaceFile(new File(["a"], "a"), upload, {signal: controller.signal, fetchImpl})).rejects.toThrow();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
