import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import i18n from "@/i18n";
import { InfoButton } from "./InfoButton";

describe("InfoButton", () => {
  beforeAll(() => void i18n.changeLanguage("en"));

  it("opens localized app information from the accessible button", async () => {
    const user = userEvent.setup();
    render(<InfoButton />);

    await user.click(screen.getByRole("button", { name: "About Einring" }));

    expect(screen.getByRole("dialog", { name: "About Einring" })).toBeInTheDocument();
    expect(screen.getByText("Version 0.1.0")).toBeInTheDocument();
  });
});
