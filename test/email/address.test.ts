import { describe, expect, it } from "vitest";
import { parseAddress, prepareRecipients } from "../../src/email/address";

describe("parseAddress", () => {
  it("parses a bare address", () => {
    expect(parseAddress("alice@example.com")).toEqual({ address: "alice@example.com" });
  });

  it("parses name and address with angle brackets", () => {
    expect(parseAddress("Alice <alice@example.com>")).toEqual({
      name: "Alice",
      address: "alice@example.com",
    });
  });

  it("parses a CJK display name", () => {
    expect(parseAddress("文明霖 <wenminglin@infility.cn>")).toEqual({
      name: "文明霖",
      address: "wenminglin@infility.cn",
    });
  });

  it("allows an empty display name", () => {
    expect(parseAddress("<alice@example.com>")).toEqual({ address: "alice@example.com" });
  });

  it("trims whitespace around the input and inner parts", () => {
    expect(parseAddress("  Alice   <  alice@example.com >  ")).toEqual({
      name: "Alice",
      address: "alice@example.com",
    });
  });

  it("rejects empty or whitespace-only input", () => {
    expect(parseAddress("")).toBeNull();
    expect(parseAddress("   ")).toBeNull();
  });

  it("rejects a missing @ or a single-label domain", () => {
    expect(parseAddress("alice")).toBeNull();
    expect(parseAddress("alice@example")).toBeNull();
  });

  it("rejects domain labels starting or ending with a hyphen", () => {
    expect(parseAddress("a@-example.com")).toBeNull();
    expect(parseAddress("a@example-.com")).toBeNull();
  });

  it("rejects multiple bracket pairs or trailing garbage after the bracket", () => {
    expect(parseAddress("A <a@b.com> <c@d.com>")).toBeNull();
    expect(parseAddress("A <a@b.com> tail")).toBeNull();
  });

  it("rejects control characters or a closing bracket in the display name", () => {
    expect(parseAddress("Bad\u0007Name <a@b.com>")).toBeNull();
    expect(parseAddress("Bad> Name <a@b.com>")).toBeNull();
  });

  it("rejects whitespace inside the address", () => {
    expect(parseAddress("alice smith@example.com")).toBeNull();
  });
});

describe("prepareRecipients", () => {
  const A = (address: string, name?: string) =>
    name === undefined ? { address } : { name, address };

  it("dedupes within each group keeping the first occurrence with its name", () => {
    const out = prepareRecipients([A("a@x.com", "First"), A("A@X.COM")], [], []);
    expect(out.to).toEqual([{ name: "First", address: "a@x.com" }]);
  });

  it("removes cc/bcc entries that already appear in to", () => {
    const out = prepareRecipients(
      [A("a@x.com")],
      [A("a@x.com", "Dupe"), A("b@x.com")],
      [A("a@x.com"), A("b@x.com"), A("c@x.com")],
    );
    expect(out.to).toEqual([A("a@x.com")]);
    expect(out.cc).toEqual([A("b@x.com")]);
    expect(out.bcc).toEqual([A("c@x.com")]);
  });

  it("removes bcc entries that already appear in cc", () => {
    const out = prepareRecipients([A("a@x.com")], [A("b@x.com")], [A("b@x.com"), A("c@x.com")]);
    expect(out.bcc).toEqual([A("c@x.com")]);
  });

  it("compares addresses case-insensitively but keeps distinct names apart in order", () => {
    const out = prepareRecipients([A("A@X.com", "X")], [A("a@x.com", "Y")], []);
    expect(out.to).toEqual([{ name: "X", address: "A@X.com" }]);
    expect(out.cc).toEqual([]);
  });
});
