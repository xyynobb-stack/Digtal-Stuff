import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import ProfileAvatar from "./ProfileAvatar";

describe("ProfileAvatar", () => {
  it("uses the JingYuAI logo as every profile's default avatar", () => {
    // @lat: [[sidebar-navigation#Profile switch and active chat#Default profile avatar]]
    const { container } = render(
      <ProfileAvatar name="employee-123" avatar={null} />,
    );

    expect(container.querySelector(".profile-avatar-logo img")).not.toBeNull();
    expect(container.querySelector(".profile-avatar-letter")).toBeNull();
  });

  it("keeps an explicitly configured custom avatar", () => {
    const { container } = render(
      <ProfileAvatar
        name="employee-123"
        avatar="data:image/png;base64,custom"
      />,
    );

    expect(container.querySelector(".profile-avatar-img")).not.toBeNull();
    expect(container.querySelector(".profile-avatar-logo")).toBeNull();
  });
});
