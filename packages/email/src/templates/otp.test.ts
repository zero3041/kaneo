import { render } from "@react-email/render";
import { createElement } from "react";
import { describe, expect, it } from "vitest";
import OtpEmail from "./otp";

describe("OtpEmail", () => {
  it("renders OTP and verification copy in HTML", async () => {
    const html = await render(createElement(OtpEmail, { otp: "123456" }));
    expect(html).toContain("123456");
    expect(html).toContain("verification code");
  });

  it("renders Vietnamese copy for Vietnamese locales", async () => {
    const html = await render(
      createElement(OtpEmail, { otp: "123456", locale: "vi-VN" }),
    );

    expect(html).toContain("123456");
    expect(html).toContain("mã xác minh Kaneo");
  });
});
