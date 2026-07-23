import { describe, expect, it } from "vitest";
import { hasSshIdentification } from "../src/index";

describe("SSH identification", () => {
  it("accepts an SSH 2.0 greeting", () => {
    expect(hasSshIdentification("SSH-2.0-OpenSSH_10.0\r\n")).toBe(true);
  });

  it("accepts an SSH greeting after a server preamble", () => {
    expect(
      hasSshIdentification(
        "Authorized access only\r\nSSH-1.99-example-server\r\n",
      ),
    ).toBe(true);
  });

  it("does not mistake an Access page or partial greeting for SSH", () => {
    expect(hasSshIdentification("<html>Cloudflare Access</html>")).toBe(false);
    expect(hasSshIdentification("SSH-2.0-OpenSSH_10.0")).toBe(false);
  });
});
