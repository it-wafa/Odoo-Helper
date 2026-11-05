import { describe, expect, it } from "vitest";

import { bookingDate, buyerUsername, contactName, odooDatetime, splitPrice } from "../src/core/rules";

describe("splitPrice", () => {
  it("membagi sebanding Harga Combo, sama seperti SO manual 6575", () => {
    expect(splitPrice(130000, [12000, 12000, 12000, 12000, 12000])).toEqual([
      26000, 26000, 26000, 26000, 26000,
    ]);
  });

  it("memasukkan selisih pembulatan ke grup terakhir", () => {
    const shares = splitPrice(100000, [1, 1, 1]);
    expect(shares).toEqual([33333, 33333, 33334]);
    expect(shares.reduce((a, b) => a + b, 0)).toBe(100000);
  });

  it("mengikuti bobot Harga Combo yang berbeda", () => {
    expect(splitPrice(72000, [62000, 10000])).toEqual([62000, 10000]);
    expect(splitPrice(87000, [62000, 10000, 0])).toEqual([74917, 12083, 0]);
  });

  it("membagi rata bila semua Harga Combo 0", () => {
    expect(splitPrice(72500, [0, 0])).toEqual([36250, 36250]);
  });
});

describe("nama kontak", () => {
  it("memakai format entri manual", () => {
    expect(contactName("261029UKGR4Y2Y", "miellaiklimanooriftitah")).toBe(
      "S-261029UKGR4Y2Y (miellaiklimanooriftitah)",
    );
  });

  it("tidak menumpuk prefix untuk pembeli yang memesan lagi", () => {
    expect(buyerUsername("S-261029UKGR4Y2Y (miella.iklima)")).toBe("miella.iklima");
    expect(contactName("261101ABCDEF12", "S-261029UKGR4Y2Y (miella.iklima)")).toBe(
      "S-261101ABCDEF12 (miella.iklima)",
    );
  });

  it("memakai awalan T untuk TikTok, juga bila nama sudah berformat", () => {
    expect(contactName("586937938589943642", "Budi Santoso", "T")).toBe("T-586937938589943642 (Budi Santoso)");
    expect(contactName("586999999999999999", "T-586937938589943642 (Budi (Ibu))", "T")).toBe(
      "T-586999999999999999 (Budi (Ibu))",
    );
  });

  it("membiarkan username yang kebetulan berawalan S", () => {
    expect(buyerUsername("S-hop_official")).toBe("S-hop_official");
  });
});

describe("odooDatetime", () => {
  it("menulis UTC tanpa zona", () => {
    expect(odooDatetime(new Date("2026-10-30T03:05:09.123Z"))).toBe("2026-10-30 03:05:09");
  });
});

describe("bookingDate", () => {
  // Waktu dalam UTC; WIB = UTC+7.
  const at = (s: string) => odooDatetime(bookingDate(new Date(`${s.replace(" ", "T")}Z`)));

  it("memindahkan pembayaran Sabtu WIB ke Senin 00:00 WIB", () => {
    expect(at("2026-11-07 03:00:00")).toBe("2026-11-08 17:00:00"); // Sabtu 10:00 WIB
    expect(at("2026-11-06 17:00:00")).toBe("2026-11-08 17:00:00"); // Sabtu 00:00 WIB
    expect(at("2026-11-07 16:59:59")).toBe("2026-11-08 17:00:00"); // Sabtu 23:59:59 WIB
  });

  it("memindahkan pembayaran Minggu WIB ke Senin 00:01 WIB", () => {
    expect(at("2026-11-07 17:00:00")).toBe("2026-11-08 17:01:00"); // Minggu 00:00 WIB
    expect(at("2026-11-08 16:59:59")).toBe("2026-11-08 17:01:00"); // Minggu 23:59:59 WIB
  });

  it("membiarkan hari kerja, termasuk Jumat malam dan Senin dini hari WIB", () => {
    expect(at("2026-11-06 16:59:59")).toBe("2026-11-06 16:59:59"); // Jumat 23:59:59 WIB
    expect(at("2026-11-08 17:00:00")).toBe("2026-11-08 17:00:00"); // Senin 00:00 WIB
    expect(at("2026-11-04 05:00:00")).toBe("2026-11-04 05:00:00"); // Rabu
  });
});
